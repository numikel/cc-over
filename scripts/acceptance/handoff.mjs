// Live acceptance harness for S-01 (first-handoff-sent), Phase 4. Local and paid: it starts real
// `claude -p` processes and spends real money. It never runs in CI. Plain Node ESM, no deps.
//
// Needs a signed-in `claude` (>= 2.1.302) on PATH, or `--claude <path to claude.exe>`.
//
// Usage:
//   node scripts/acceptance/handoff.mjs                 the live run (Haiku, cap USD 2.5)
//   node scripts/acceptance/handoff.mjs --dry-run       print the plan, spawn nothing
//   node scripts/acceptance/handoff.mjs --selftest      pure-logic self checks, spawn nothing
//
// One run starts three throwaway receivers, `probe-handoff-accept` and `probe-handoff-note`
// (crossSessionInbound "accept") and `probe-handoff-hold` ("hold"), each looping on `sleep 15`,
// and ONE sender: a stream-json `claude -p` with the mod loaded, fed turn by turn. The sender:
//   1. runs an ordinary turn (the fork needs a finished turn, evidence E5);
//   2. waits until /over --list shows both receivers;
//   3. /over <intent>: the logged preview has the header, the sections and the changed file;
//   4. /over --send probe-handoff-accept, twice: the accept receiver sees the SAME bundle id with
//      two different `Send:` ids (a repeated identical text would be dropped, evidence E2). What a
//      receiver saw is read from its transcript on disk: the stream of a `-p` session carries
//      the events of the loop but not the text of an injected message;
//   4b. the accept receiver (the only one allowed SendMessage + ToolSearch) acknowledges as the
//      bundle asks: the mod logs `received by <receiver> (acknowledged)` and the sender's model
//      runs no turn (S-02, recipient-handles-handoff);
//   4c. /over --broadcast <intent>, then /over --send to the accept receiver and to the note
//      receiver (S-06, broadcast-fanout): both transcripts hold `[claude-over broadcast <id>]` with
//      `Send:`, a `## Message` with the intent and no hand-off section, and both acknowledge;
//   5. /over --no-fork <intent>, then /over --send probe-handoff-hold: the sender stream gets the
//      platform's "held" warning and the holding receiver never sees a bundle. (The compose
//      replaces the broadcast as the last bundle, so the send to the holder stays a hand-off.)
//   6. after the sender has exited, a second `-p` process resumes its session and runs
//      `/over --status` (no turn): the report, read from its `ui_log` lines, must show the sends of
//      the first process grouped by bundle (a header with the intent, `received by <accept>` or
//      `passed on to <accept>`, `passed on to <hold>`, no `not passed on`), which proves the
//      records persist in the plugin's `$.store` across processes.
// (The plan lists the re-send after the hold step. It is first here: the re-send must carry the
// bundle of step 3, and a second compose replaces it.)
//
// A message goes only to a session whose name starts with `probe-handoff-`, started by this
// script. Cost: the sender's `total_cost_usd` is cumulative; the three receivers are reserved at
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
	ackVerdict,
	broadcastVerdict,
	composeVerdict,
	deliveryVerdict,
	findHeaders,
	holdVerdict,
	isProbeTarget,
	noticeVerdict,
	resumeVerdict,
	sendVerdict,
	statusVerdict,
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
	statusArgs,
	tempBase,
	UsageError,
} from "./lib.mjs";
import { runSelftest } from "./selftest.mjs";

const TAG = "[acceptance]";
const ACCEPT = "probe-handoff-accept";
const HOLD = "probe-handoff-hold";
const NOTE = "probe-handoff-note";
const FILE = "greeting.txt";
const RECEIVER_COUNT = 3;
const RECEIVER_BUDGET = 0.4; // USD per receiver, a hard cap passed to claude
const RECEIVER_LOOPS = 30; // x ~18 s: outlives the longest path through the steps
const LIST_WAIT_MS = 60_000;
const DELIVERY_WAIT_MS = 60_000;
const ACK_WAIT_MS = 60_000;
const STATUS_BUDGET = 0.2; // USD ceiling of the step-6 process (`/over --status` takes no turn)
const MIN_STATUS_BUDGET = 0.05;
const INTENT = `przekaż handoff do sesji, która implementuje zmianę w ${FILE}`;
const BROADCAST_INTENT =
	"FYI: I'm migrating the test database now; it will be down for about 10 minutes";

// No `[claude-over hand-off` in here: the holding receiver must not be able to "see" a bundle
// from its own prompt. Nothing about the acknowledgement either: this run proves the wiring (the
// bundle asks, the mod intercepts), and how well models obey is what the control batch measures.
// The tools are limited by --allowedTools under --permission-mode default (receiverArgs), not by
// the prompt. And nothing about incoming messages
// either: the first live run (2026-10-19) had "state who sent it, then carry on with the loop",
// and Haiku obeyed that instead of the bundle's own acknowledgement line (no SendMessage call).
const RECEIVER_PROMPT =
	"This is an automated test loop. Use the Bash tool to run `sleep 15`, one call at a time, " +
	`${RECEIVER_LOOPS} times in a row, then stop.`;

const USAGE = `Usage: node scripts/acceptance/handoff.mjs [options]

  --model <m>           passed as-is to \`claude --model\` (default haiku)
  --max-cost <usd>      cost cap for the whole run, receivers included (default 2.5)
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
		`receivers  ${RECEIVER_COUNT}: ${ACCEPT} (accept), ${NOTE} (accept), ${HOLD} (hold): ${config.model}, sleep loop, USD ${RECEIVER_BUDGET} each`,
		`sender     stream-json, --plugin-dir ${pluginDirOf()}, ${config.model}`,
		`steps      warm-up turn, wait for all ${RECEIVER_COUNT} receivers on /over --list, /over <intent>,`,
		`           /over --send ${ACCEPT} x2, wait for the acknowledgement (the accepting receivers`,
		"           may use SendMessage + ToolSearch)",
		`broadcast  /over --broadcast <intent>, /over --send ${ACCEPT}, /over --send ${NOTE}: both`,
		"           transcripts hold the broadcast header, `## Message` with the intent and no `## Summary`,",
		"           and both acknowledge without a turn of the sender's model",
		`last       /over --no-fork <intent>, /over --send ${HOLD}, wait for the platform's held warning`,
		`step 6     after the sender exits: a second process resumes its session and runs /over --status`,
		`           (no turn, USD ${STATUS_BUDGET} ceiling): the report must list the bundle and both targets`,
		`cost cap   ${money(config.maxCost)} (receivers reserved: ${money(RECEIVER_COUNT * RECEIVER_BUDGET)} = ${RECEIVER_COUNT} * ${RECEIVER_BUDGET})`,
	].join("\n");
}

// Step 6: a second `-p` process resumes the finished sender's session and runs `/over --status`.
// The mod keeps its send records in `$.store`, so the report must show the sends of the first
// process, grouped by bundle. The command takes no turn; the budget is a ceiling, not a forecast.
// A missing or different session id is a failed check, not an exception: it says what the
// platform did with `--resume` in `-p`, and the report below would prove nothing.
async function statusStep({ claude, repo, root, env, config, sender, reserved, ackSeen }) {
	const spent = reserved + sender.cost;
	if (!shouldStartRun(spent, config.maxCost)) {
		throw new RunError("cap", `committed cost ${money(spent)} is over the cap before "status"`);
	}
	if (sender.sessionId === undefined) {
		record("status: the sender reported a session id", resumeVerdict(undefined, undefined));
		return;
	}
	const budget = Number(
		Math.min(STATUS_BUDGET, Math.max(config.maxCost - spent, MIN_STATUS_BUDGET)).toFixed(2),
	);
	const status = new Session({
		command: claude,
		args: statusArgs({
			pluginDir: pluginDirOf(),
			model: config.model,
			sessionId: sender.sessionId,
			budget,
		}),
		cwd: repo, // a session is resumed from the directory it ran in
		env,
		streamPath: path.join(root, "status.jsonl"),
		stderrPath: path.join(root, "status.stderr"),
		costGuard: (runCost) => capReason({ spent, runCost, cap: config.maxCost }),
		hasInput: false,
	});
	status.start();
	try {
		const isExited = await status.waitFor(() => status.closed, config.stepTimeoutMs);
		record("status: the /over --status process ended on its own", {
			ok: isExited,
			problems: [`still running after ${config.stepTimeoutMs / 1000} s`],
		});
	} finally {
		status.kill();
	}
	const lines = uiLogTexts(status.events);
	say(TAG, `status: cost=${money(status.cost)} ui_log lines=${lines.length}`);
	const resumed = resumeVerdict(sender.sessionId, status.sessionId);
	if (!record("status: --resume kept the sender's session id", resumed)) {
		say(TAG, `status log (not judged, another session): ${lines.join(" | ")}`);
		return;
	}
	const verdict = statusVerdict(lines, { intent: INTENT, accept: ACCEPT, hold: HOLD, ackSeen });
	if (
		!record("status: the report lists the sends of the first process, grouped by bundle", verdict)
	) {
		say(TAG, `status log: ${lines.join(" | ")}`);
	}
}

async function run(config) {
	const claude = resolveClaude(config.claude);
	const reserved = RECEIVER_COUNT * RECEIVER_BUDGET;
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
				ack: mode === "accept",
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
	const note = startReceiver(NOTE, "accept");
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
	let ackSeen = false;
	let isComplete = false;
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

		// 2. all receivers must be on the list before anything is sent
		const listDeadline = Date.now() + LIST_WAIT_MS;
		let listed = false;
		let lastList = [];
		while (!listed && Date.now() < listDeadline) {
			const turn = await step("list", "/over --list");
			lastList = uiLogTexts(turn.events);
			listed = [ACCEPT, NOTE, HOLD].every((name) =>
				lastList.some((line) => line.includes(`● ${name}`)),
			);
			if (!listed) await delay(4000);
		}
		if (
			!record("all three receivers are on the session list", {
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
		// The explicit sends are turns themselves: any result beyond this count is a turn the
		// sender's model took on its own, which is what an unconsumed acknowledgement would cause.
		const resultsAfterSends = sender.resultCount;
		await accept.waitFor(() => deliveryVerdict(seenBy(accept), bundleId).ok, DELIVERY_WAIT_MS);
		const delivered = deliveryVerdict(seenBy(accept), bundleId);
		const source = delivered.fromName === undefined ? "" : `, shown as "${delivered.fromName}"`;
		record(
			"accept receiver: one bundle id, two different send ids, approval block present",
			delivered,
			`${delivered.sendIds.join(", ")}${source}`,
		);

		// 4b. the acknowledgement the bundle asks for: the mod logs it and takes the message before
		// the sender's model. Before step 5: the hold step wakes the sender's model on its own (the
		// platform's warning), and that turn must not be taken for ours.
		const ackFor = () => ackVerdict(sender.events, ACCEPT, { before: resultsAfterSends });
		await sender.waitFor(() => ackFor().received > 0, ACK_WAIT_MS);
		await delay(3000); // a second acknowledgement may still be on its way
		const acked = ackFor();
		ackSeen = acked.received > 0;
		record(
			"accept receiver: the acknowledgement came back, the mod took it, the sender's model ran no turn",
			acked,
			`${acked.received} line(s) 'received by ${ACCEPT} (acknowledged)'`,
		);

		// 4c. a broadcast to two receivers (S-06), no model and no git: one bundle id, a `Send:` id
		// per receiver, and the acknowledgement of each. `broadcastFrom` fences off the events of
		// the hand-off above, whose acknowledgements for the same receiver would count again. This
		// stays before step 5 for the same reason as 4b: the hold step wakes the sender's model.
		const broadcastFrom = sender.events.length;
		const resultsBeforeBroadcast = sender.resultCount;
		const composedBroadcast = await step(
			"compose broadcast",
			`/over --broadcast ${BROADCAST_INTENT}`,
		);
		const [broadcastHeader] = findHeaders(uiLogTexts(composedBroadcast.events).join("\n"));
		const broadcastId = broadcastHeader?.bundleId;
		if (
			!record(
				"compose broadcast: the preview has the broadcast header",
				{
					ok:
						broadcastId !== undefined &&
						uiLogTexts(composedBroadcast.events).some((line) =>
							line.includes(`[claude-over broadcast ${broadcastId}]`),
						),
					problems: ["no [claude-over broadcast <id>] header in the log"],
				},
				broadcastId,
			)
		) {
			return;
		}
		for (const target of [ACCEPT, NOTE]) {
			const lines = await sendTo(target, `broadcast to ${target}`);
			record(`broadcast to ${target}: the mod reports it queued`, sendVerdict(lines, target));
		}
		// The compose and the two sends are turns themselves; see 4b.
		const broadcastTurns = sender.resultCount - resultsBeforeBroadcast;
		const seenBroadcast = () => ({ [ACCEPT]: seenBy(accept), [NOTE]: seenBy(note) });
		const broadcastOpts = {
			accept: ACCEPT,
			note: NOTE,
			bundleId: broadcastId,
			intent: BROADCAST_INTENT,
		};
		await accept.waitFor(
			() => broadcastVerdict(seenBroadcast(), broadcastOpts).ok,
			DELIVERY_WAIT_MS,
		);
		record(
			"broadcast: both receivers hold the header, `## Message` with the intent and no hand-off section",
			broadcastVerdict(seenBroadcast(), broadcastOpts),
			broadcastId,
		);
		const broadcastAckFor = (name) =>
			ackVerdict(sender.events.slice(broadcastFrom), name, { before: broadcastTurns });
		await sender.waitFor(
			() => [ACCEPT, NOTE].every((name) => broadcastAckFor(name).received > 0),
			ACK_WAIT_MS,
		);
		await delay(3000); // a second acknowledgement may still be on its way
		for (const name of [ACCEPT, NOTE]) {
			const acked = broadcastAckFor(name);
			record(
				`broadcast: ${name} acknowledged, the mod took it, the sender's model ran no turn`,
				acked,
				`${acked.received} line(s) 'received by ${name} (acknowledged)'`,
			);
		}

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
		isComplete = true;
	} finally {
		await sender.finish();
		accept.kill();
		note.kill();
		hold.kill();
		say(
			TAG,
			`cost: sender ${money(sender.cost)} + receivers up to ${money(reserved)} (their budget caps)`,
		);
		say(TAG, `streams kept in ${root}`);
	}

	// 6. only after the sender process is gone, and only when the steps above ran to the end
	if (isComplete) await statusStep({ claude, repo, root, env, config, sender, reserved, ackSeen });
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
