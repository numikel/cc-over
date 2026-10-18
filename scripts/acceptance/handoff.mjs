// Live acceptance harness for S-01 (first-handoff-sent), Phase 4. Local and paid: it starts real
// `claude -p` processes and spends real money. It never runs in CI. Plain Node ESM, no deps.
//
// Needs a signed-in `claude` (>= 2.1.302) on PATH, or `--claude <path to claude.exe>`.
//
// Usage:
//   node scripts/acceptance/handoff.mjs                 the live run (Haiku, cap USD 2)
//   node scripts/acceptance/handoff.mjs --dry-run       print the plan, spawn nothing
//   node scripts/acceptance/handoff.mjs --selftest      pure-logic self checks, spawn nothing
//
// One run starts two throwaway receivers, `probe-handoff-accept` (crossSessionInbound "accept")
// and `probe-handoff-hold` ("hold"), each looping on `sleep 15`, and ONE sender: a stream-json
// `claude -p` with the mod loaded, fed turn by turn. The sender:
//   1. runs an ordinary turn (the fork needs a finished turn, evidence E5);
//   2. waits until /over --list shows both receivers;
//   3. /over <intent>: the logged preview has the header, the sections and the changed file;
//   4. /over --send probe-handoff-accept, twice: the accept receiver sees the SAME bundle id with
//      two different `Send:` ids (a repeated identical text would be dropped, evidence E2). What a
//      receiver saw is read from its transcript on disk: the stream of a `-p` session carries
//      the events of the loop but not the text of an injected message;
//   5. /over --no-fork <intent>, then /over --send probe-handoff-hold: the sender stream gets the
//      platform's "held" warning and the holding receiver never sees a bundle.
// (The plan lists the re-send after the hold step. It is first here: the re-send must carry the
// bundle of step 3, and a second compose replaces it.)
//
// A message goes only to a session whose name starts with `probe-handoff-`, started by this
// script. Cost: the sender's `total_cost_usd` is cumulative; the two receivers are reserved at
// their --max-budget-usd. The run stops BEFORE a step when the committed cost is over --max-cost.
//
// Side effects: the sessions run in a fresh temp directory (never the repo, never the session
// scratchpad). `claude -p` leaves draft journals in the vault's `Sesje/` for those directories:
// delete them with their rows in `Sesje MOC.md` (CLAUDE.local.md). The streams are kept in the
// temp directory and hold the sessions' hook output, so do not share them blindly.
//
// Exit code: 0 every check passed; 1 a check failed; 2 usage error; 3 the cost cap or the
// environment stopped the run.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	composeVerdict,
	deliveryVerdict,
	holdVerdict,
	isProbeTarget,
	noticeVerdict,
	sendVerdict,
	transcriptStrings,
} from "./checks.mjs";
import {
	capReason,
	delay,
	killAll,
	money,
	parseCli,
	pluginDirOf,
	RunError,
	readTranscript,
	receiverArgs,
	resolveClaude,
	Session,
	say,
	senderArgs,
	shouldStartRun,
	tempBase,
	UsageError,
} from "./lib.mjs";
import { runSelftest } from "./selftest.mjs";

const TAG = "[acceptance]";
const ACCEPT = "probe-handoff-accept";
const HOLD = "probe-handoff-hold";
const FILE = "greeting.txt";
const RECEIVER_BUDGET = 0.4; // USD per receiver, a hard cap passed to claude
const RECEIVER_LOOPS = 30; // x ~18 s: outlives the longest path through the steps
const LIST_WAIT_MS = 60_000;
const DELIVERY_WAIT_MS = 60_000;
const INTENT = `przekaż handoff do sesji, która implementuje zmianę w ${FILE}`;

// No `[claude-over hand-off` in here: the holding receiver must not be able to "see" a bundle
// from its own prompt.
const RECEIVER_PROMPT =
	"This is an automated test loop. Use the Bash tool to run `sleep 15`, one call at a time, " +
	`${RECEIVER_LOOPS} times in a row, then stop. If a message from another session arrives ` +
	"meanwhile, state in one short sentence who sent it and what it asks, then carry on with the " +
	"loop. Use no other tool.";

const USAGE = `Usage: node scripts/acceptance/handoff.mjs [options]

  --model <m>           passed as-is to \`claude --model\` (default haiku)
  --max-cost <usd>      cost cap for the whole run, receivers included (default 2)
  --step-timeout <sec>  per-step timeout (default 180)
  --hold-wait <sec>     how long to wait for the "held" warning (default 120)
  --claude <path>       claude executable (default: claude.exe found on PATH)
  --dry-run             print the plan and spawn nothing
  --selftest            run the pure-logic self checks and spawn nothing
  -h, --help            this text`;

const uiLogTexts = (events) => events.filter((e) => e.kind === "ui_log").map((e) => e.text);

// What a receiver has seen: its stream, plus its transcript on disk. The stream of a `-p`
// session does not carry the text of an injected message (live run 1), the transcript does.
const seenBy = (session) => [
	...session.texts,
	...transcriptStrings(readTranscript(session.sessionId)),
];

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

function git(cwd, args) {
	const done = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	if (done.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${done.stderr.trim()}`);
}

// A repo with one commit and one uncommitted edit: the changed-file list has exactly FILE.
function makeFixtureRepo(dir) {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q", "-b", "main"]);
	fs.writeFileSync(path.join(dir, FILE), "hello\n");
	git(dir, ["add", FILE]);
	git(dir, [
		"-c",
		"user.name=cc-over acceptance",
		"-c",
		"user.email=acceptance@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"-m",
		"init",
	]);
	fs.writeFileSync(path.join(dir, FILE), "hello world\n");
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

const outcomes = [];

function record(name, verdict, info) {
	outcomes.push({ name, ok: verdict.ok });
	const detail = verdict.ok ? (info ?? "") : verdict.problems.join("; ");
	say(verdict.ok ? "[PASS]" : "[FAIL]", detail === "" ? name : `${name}: ${detail}`);
	return verdict.ok;
}

function planText(config) {
	return [
		`receivers  ${ACCEPT} (accept), ${HOLD} (hold): ${config.model}, sleep loop, USD ${RECEIVER_BUDGET} each`,
		`sender     stream-json, --plugin-dir ${pluginDirOf()}, ${config.model}`,
		"steps      warm-up turn, wait for both receivers on /over --list, /over <intent>,",
		`           /over --send ${ACCEPT} x2, /over --no-fork <intent>, /over --send ${HOLD},`,
		"           wait for the platform's held warning",
		`cost cap   ${money(config.maxCost)} (receivers reserved: ${money(2 * RECEIVER_BUDGET)})`,
	].join("\n");
}

async function run(config) {
	const claude = resolveClaude(config.claude);
	const reserved = 2 * RECEIVER_BUDGET;
	const senderBudget = Number((config.maxCost - reserved).toFixed(2));
	if (senderBudget < 0.2) {
		throw new UsageError(`--max-cost must be at least ${money(reserved + 0.2)}`);
	}
	const root = fs.mkdtempSync(path.join(tempBase(), "cc-over-handoff-"));
	const repo = path.join(root, "repo");
	makeFixtureRepo(repo);
	say(TAG, `workdir ${root}`);

	const env = { ...process.env };
	const startReceiver = (name, mode) => {
		const dir = path.join(root, name);
		fs.mkdirSync(dir, { recursive: true });
		const session = new Session({
			command: claude,
			args: receiverArgs({
				name,
				mode,
				model: config.model,
				budget: RECEIVER_BUDGET,
				prompt: RECEIVER_PROMPT,
			}),
			cwd: dir,
			env,
			streamPath: path.join(root, `${name}.jsonl`),
			stderrPath: path.join(root, `${name}.stderr`),
			hasInput: false,
		});
		session.start();
		return session;
	};
	const accept = startReceiver(ACCEPT, "accept");
	const hold = startReceiver(HOLD, "hold");

	const sender = new Session({
		command: claude,
		args: senderArgs({
			pluginDir: pluginDirOf(),
			model: config.model,
			debugFile: path.join(root, "sender-debug.log"),
			budget: senderBudget,
		}),
		cwd: repo,
		env,
		streamPath: path.join(root, "sender.jsonl"),
		stderrPath: path.join(root, "sender.stderr"),
		costGuard: (runCost) => capReason({ spent: reserved, runCost, cap: config.maxCost }),
		hasInput: true,
	});
	sender.start();

	let explicitTurns = 0;
	const step = async (name, text) => {
		const spent = reserved + sender.cost;
		if (!shouldStartRun(spent, config.maxCost)) {
			throw new RunError("cap", `committed cost ${money(spent)} is over the cap before "${name}"`);
		}
		const started = Date.now();
		const turn = await sender.turn(text, config.stepTimeoutMs, name);
		explicitTurns++;
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		say(
			TAG,
			`${name}: turns=${turn.result?.numTurns} error=${turn.result?.isError} cost=${money(sender.cost)} ${seconds}s`,
		);
		return turn;
	};
	// The one place a message leaves: refuse any name this script did not create.
	const sendTo = async (target, name) => {
		if (!isProbeTarget(target)) throw new Error(`refusing to send to "${target}"`);
		const turn = await step(name, `/over --send ${target}`);
		return uiLogTexts(turn.events);
	};

	try {
		await step("warm-up", "Reply with just the word OK.");

		// 2. both receivers must be on the list before anything is sent
		const listDeadline = Date.now() + LIST_WAIT_MS;
		let listed = false;
		let lastList = [];
		while (!listed && Date.now() < listDeadline) {
			const turn = await step("list", "/over --list");
			lastList = uiLogTexts(turn.events);
			listed = [ACCEPT, HOLD].every((name) => lastList.some((line) => line.includes(`● ${name}`)));
			if (!listed) await delay(4000);
		}
		if (
			!record("both receivers are on the session list", {
				ok: listed,
				problems: [
					`not listed within ${LIST_WAIT_MS / 1000} s; the log said: ${lastList.join(" | ")}`,
				],
			})
		) {
			return;
		}

		// 3. compose with the fork
		const composed = await step("compose", `/over ${INTENT}`);
		const composeCheck = composeVerdict(uiLogTexts(composed.events), { fileName: FILE });
		if (
			!record(
				"compose: preview has the header, the sections and the changed file",
				composeCheck,
				composeCheck.fallbackNote === undefined
					? composeCheck.bundleId
					: `${composeCheck.bundleId} (${composeCheck.fallbackNote})`,
			)
		) {
			return;
		}
		const bundleId = composeCheck.bundleId;

		// 4. send the same bundle twice to the accepting receiver
		for (const label of ["send 1", "send 2 (same bundle)"]) {
			const lines = await sendTo(ACCEPT, `${label} to ${ACCEPT}`);
			record(`${label}: the mod reports it queued`, sendVerdict(lines, ACCEPT));
		}
		await accept.waitFor(() => deliveryVerdict(seenBy(accept), bundleId).ok, DELIVERY_WAIT_MS);
		const delivered = deliveryVerdict(seenBy(accept), bundleId);
		const source = delivered.fromName === undefined ? "" : `, shown as "${delivered.fromName}"`;
		record(
			"accept receiver: one bundle id, two different send ids, approval block present",
			delivered,
			`${delivered.sendIds.join(", ")}${source}`,
		);

		// 5. compose again without the model, send to the holding receiver
		const second = await step("compose 2", `/over --no-fork ${INTENT}`);
		const secondCheck = composeVerdict(uiLogTexts(second.events), { fileName: FILE });
		record("compose 2 (--no-fork): preview is complete", secondCheck);
		record("compose 2 (--no-fork): the model was skipped", {
			ok: /none/.test(secondCheck.fallbackNote ?? ""),
			problems: [`no fallback note that names the none mode: ${secondCheck.fallbackNote}`],
		});
		const holdLines = await sendTo(HOLD, `send to ${HOLD}`);
		record("send to the holding receiver: the mod reports it queued", sendVerdict(holdLines, HOLD));
		// The platform now wakes the sender's model for its own turn, so no turn() is started after
		// this point: its result would be taken for ours.
		const isHeld = await sender.waitFor(
			() => noticeVerdict(sender.events).isHeld,
			config.holdWaitMs,
		);
		record("sender stream: the platform's held warning arrived", {
			ok: isHeld,
			problems: [`no held warning within ${config.holdWaitMs / 1000} s`],
		});
		await delay(3000);
		// A negative proves something only if the same method can see a bundle: the accept receiver
		// was read the same way above, and this one's transcript must exist and be readable.
		const holdTranscript = readTranscript(hold.sessionId);
		record("holding receiver: its transcript can be read (else the next check proves nothing)", {
			ok: holdTranscript !== "",
			problems: [`no transcript found for session ${hold.sessionId}`],
		});
		record("holding receiver: never saw a bundle", holdVerdict(seenBy(hold)));
		record("sender stream: no dropped-as-repeated warning", {
			ok: !noticeVerdict(sender.events).isDropped,
			problems: ["the platform dropped a repeated message"],
		});
		say(
			TAG,
			`info: the sender's model ran ${sender.resultCount - explicitTurns} turn(s) on its own after the warnings`,
		);
	} finally {
		await sender.finish();
		accept.kill();
		hold.kill();
		say(
			TAG,
			`cost: sender ${money(sender.cost)} + receivers up to ${money(reserved)} (their budget caps)`,
		);
		say(TAG, `streams kept in ${root}`);
	}
}

async function main(argv) {
	const config = parseCli(argv);
	if (config.help) {
		console.log(USAGE);
		return 0;
	}
	if (config.selftest) return runSelftest() ? 0 : 1;
	if (config.dryRun) {
		console.log(planText(config));
		return 0;
	}
	await run(config);
	const failed = outcomes.filter((o) => !o.ok);
	say(
		failed.length === 0 ? "[PASS]" : "[FAIL]",
		`${outcomes.length - failed.length}/${outcomes.length} checks passed`,
	);
	return failed.length === 0 ? 0 : 1;
}

process.on("SIGINT", () => {
	killAll();
	process.exit(130);
});

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	killAll();
	if (error instanceof UsageError) {
		console.error(`${error.message}\n\n${USAGE}`);
		process.exitCode = 2;
	} else if (error instanceof RunError && (error.kind === "cap" || error.kind === "spawn")) {
		say("[STOP]", error.message);
		process.exitCode = 3;
	} else if (error instanceof RunError) {
		say("[FAIL]", error.message);
		process.exitCode = 1;
	} else {
		console.error(error);
		process.exitCode = 1;
	}
}
killAll();
