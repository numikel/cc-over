// S-01 phase 3: `/over` as a command. A `-p` run draws nothing, so the composed bundle and
// every report go to the transcript log, one line per call; nothing is ever sent unasked.

import { expect, test } from "claude-code/testing";
import { entry, FORK_TEXT, GIT, NOW, over, ROOT, ROWS, START, stored, world } from "./support.js";

test("-p /over <intent> composes from the fork and git, logs the bundle and sends nothing", async ($, on) => {
	const seen = world(on, []);
	await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: false });

	expect(await over($, "hand this review to the implementer")).toEqual({});

	const log = seen.logs.join("\n");
	expect(log).toMatch(/\[claude-over hand-off ovr-[0-9a-z]+-[0-9a-z]{4}\]/);
	expect(log).toContain("## Summary");
	expect(log).toContain("Review done, two findings.");
	expect(log).toContain("Fix the two findings.");
	// Files come from git, not from the model: both uncommitted and branch changes.
	expect(log).toContain("src/a.ts");
	expect(log).toContain("src/b.ts");
	expect(seen.forks).toHaveLength(1);
	expect(seen.forks[0]).toContain("hand this review to the implementer");
	expect(seen.sent).toEqual([]);
	// One line per call: a newline would draw as a glyph.
	expect(seen.logs.every((line) => !line.includes("\n"))).toBe(true);
});

// ---- the model part of the bundle ----

test("when there is nothing to fork the bundle is the intent plus git, saying why", async ($, on) => {
	const seen = world(on, [], { fork: { isAnswered: false, reason: "nothing-to-fork" } });
	await over($, "smoke");
	const log = seen.logs.join("\n");
	expect(log).toContain("no conversation summary: nothing-to-fork");
	expect(log).toContain("src/a.ts");
	expect(seen.sent).toEqual([]);
});

test("an API error is said with its status", async ($, on) => {
	const seen = world(on, [], {
		fork: { isAnswered: false, reason: "api-error", status: 529, usage: {} },
	});
	await over($, "smoke");
	expect(seen.logs.join("\n")).toContain("no conversation summary: api-error 529");
});

test("--no-fork never calls the fork", async ($, on) => {
	const flagged = world(on, []);
	await over($, "--no-fork prepare the handoff");
	expect(flagged.forks).toEqual([]);
	expect(flagged.logs.join("\n")).toContain("no conversation summary: none mode");
	expect(flagged.logs.join("\n")).toContain("prepare the handoff");
});

test("the cc-over.compose setting 'none' also skips the fork", async ($, on) => {
	const seen = world(on, [], { compose: "none" });
	await over($, "smoke");
	expect(seen.forks).toEqual([]);
});

test("without git the files come from the model and are marked unverified", async ($, on) => {
	const git = Object.fromEntries(Object.keys(GIT).map((key) => [key, "reject" as const]));
	const seen = world(on, [], {
		git,
		fork: {
			isAnswered: true,
			text: `${FORK_TEXT}\n\n### FILES\nsrc/from-model.ts`,
			usage: {},
		},
	});
	await over($, "hand over");
	expect(seen.forks[0]).toContain("### FILES");
	const log = seen.logs.join("\n");
	expect(log).toContain("unverified");
	expect(log).toContain("src/from-model.ts");
});

// ---- usage, --list, --send ----

test("-p: a bare /over says there is no pane, lists nothing and composes nothing", async ($, on) => {
	const seen = world(on, []);
	await over($, "");
	await over($, "   ");
	expect(seen.logs).toEqual([
		"Usage: /over <intent> · /over --no-fork <intent> · /over --broadcast <intent> · /over --list · /over --send <session> · /over --send-repo · /over --status · /over --history [n] (no pane here: give the intent as an argument)",
		"Usage: /over <intent> · /over --no-fork <intent> · /over --broadcast <intent> · /over --list · /over --send <session> · /over --send-repo · /over --status · /over --history [n] (no pane here: give the intent as an argument)",
	]);
	expect(seen.listed).toBe(0);
	expect(seen.opened).toEqual([]);
	expect(seen.forks).toEqual([]);
	expect(seen.sent).toEqual([]);
});

test("a bare /over whose pane did not open says why, then the usage line", async ($, on) => {
	const seen = world(on, ["terminal"], { open: { isPlaced: false, reason: "no room" } });
	await over($, "");
	expect(seen.logs).toEqual([
		"the pane did not open (no room)",
		"Usage: /over <intent> · /over --no-fork <intent> · /over --broadcast <intent> · /over --list · /over --send <session> · /over --send-repo · /over --status · /over --history [n] (no pane here: give the intent as an argument)",
	]);
	expect(seen.listed).toBe(0);
	expect(seen.forks).toEqual([]);
});

test("an unknown flag and --send without a target say how to use it, and compose nothing", async ($, on) => {
	const seen = world(on, []);
	await over($, "--send");
	await over($, "--bogus x");
	const log = seen.logs.join("\n");
	expect(log).toContain("Usage: /over");
	expect(log).toContain("--send needs a session name");
	expect(log).toContain("unknown flag: --bogus");
	expect(seen.forks).toEqual([]);
	expect(seen.sent).toEqual([]);
});

test("--list prints every group unfolded, each row led by `● <address>`, and counts the hidden ones, with no model and no send", async ($, on) => {
	const seen = world(on, [], {
		entries: stored(
			entry({
				sessionId: "impl-id",
				ref: "c03940",
				repoRoot: ROOT,
				branch: "main",
				lastActivityAt: NOW - 5_000,
			}),
			entry({
				sessionId: "review-id",
				ref: "9f271c",
				root: "/other/lib",
				repoRoot: "/other/lib",
				branch: "dev",
				lastActivityAt: NOW - 120_000,
			}),
		),
		rows: [...ROWS, { name: "bare", ref: "bb0001", type: "interactive", status: "waiting" }],
	});
	expect(await over($, "--list")).toEqual({});
	expect(seen.logs).toEqual([
		"This project: proj",
		"● impl · main · idle · 5s ago",
		"Other sessions: lib",
		"● repo-a | review · dev · busy · 2m ago",
		"Other sessions: no details (mod not running there)",
		"● bare · waiting · waiting for the user",
		"hidden: 1 (not a local interactive session)",
	]);
	expect(seen.forks).toEqual([]);
	expect(seen.sent).toEqual([]);
});

test("--list says when nobody else works in this project, and shows sessions without the mod with their start", async ($, on) => {
	const seen = world(on, []);
	await over($, "--list");
	expect(seen.logs).toEqual([
		"This project: proj",
		"● (no other session in this project)",
		"Other sessions: no details (mod not running there)",
		"● impl · idle · started 12h ago",
		"● repo-a | review · busy · started 2h ago",
		"hidden: 1 (not a local interactive session)",
	]);
});

test("--send without a composed bundle sends nothing", async ($, on) => {
	const seen = world(on, []);
	await over($, "--send impl");
	expect(seen.sent).toEqual([]);
	expect(seen.logs.join("\n")).toContain("compose a bundle first");
});

test("--send hands the last bundle to the named session; the same bundle sent twice differs in its send id", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await over($, "--send impl");

	expect(seen.sent).toHaveLength(2);
	expect(seen.sent[0]?.to).toBe("impl");
	const [first, second] = seen.sent.map((sent) => sent.text);
	expect(first).toContain("Approved by the user");
	const id = (text: string | undefined) => /^Send: (\S+)$/m.exec(text ?? "")?.[1];
	const bundle = (text: string | undefined) =>
		/^\[claude-over hand-off (\S+)\]$/m.exec(text ?? "")?.[1];
	expect(id(first)).toMatch(/^[0-9a-f]{7}$/);
	expect(id(first)).not.toBe(id(second));
	expect(bundle(first)).toBe(bundle(second));
	// The acknowledgement the recipient is asked for names this very send, not the bundle alone.
	const ackAsked = (text: string | undefined) =>
		/`message` set to `over-ack (\S+) (\S+)`/.exec(text ?? "")?.slice(1);
	expect(ackAsked(first)).toEqual([bundle(first), id(first)]);
	expect(ackAsked(second)).toEqual([bundle(second), id(second)]);
	expect(seen.logs.join("\n")).toContain("passed on to impl (queued)");
});

test("--send to a name that is not on the fresh list sends nothing", async ($, on) => {
	const seen = world(on, []);
	await over($, "hand over");
	await over($, "--send nobody");
	await over($, "--send cloud-1"); // a hidden (non-local) session is no target
	expect(seen.sent).toEqual([]);
	expect(seen.logs.join("\n")).toContain("not passed on: no session named nobody");
});

test("--send takes a name with spaces and a pipe, and says why a refused send was not passed on", async ($, on) => {
	const seen = world(on, [], {
		send: {
			isDelivered: false,
			reason: "No agent named 'repo-a | review' is reachable.\nUse ListAgents",
		},
	});
	await over($, "hand over");
	await over($, "--send repo-a | review");
	expect(seen.sent[0]?.to).toBe("repo-a | review");
	const log = seen.logs.join("\n");
	expect(log).toContain("not passed on to repo-a | review: No agent named");
});

test("a duplicated name is addressed as name [ref] and the bare name is refused", async ($, on) => {
	const rows = [
		{ name: "impl", ref: "c03940", type: "interactive", status: "idle" },
		{ name: "impl", ref: "e417c4", type: "interactive", status: "busy" },
		...ROWS.slice(1, 2),
	];
	const seen = world(on, [], { rows });
	await over($, "hand over");
	await over($, "--send impl");
	expect(seen.sent).toEqual([]);
	expect(seen.logs.join("\n")).toContain("several sessions are named impl");
	await over($, "--send impl [e417c4]");
	expect(seen.sent[0]?.to).toBe("impl [e417c4]");
});

test("a session without the SendMessage tool is reported as not passed on", async ($, on) => {
	const seen = world(on, [], {
		send: {
			isDelivered: false,
			reason:
				"this session has no SendMessage tool (messaging between sessions and agents is not on here)",
		},
	});
	await over($, "hand over");
	await over($, "--send impl");
	expect(seen.logs.join("\n")).toContain(
		"not passed on to impl: this session has no SendMessage tool",
	);
});

test("/over registers its command with the argument hint at session start, and says out loud when it cannot", async ($, on) => {
	const seen = world(on, [], { refuseRegister: true });
	await $.session.start(START);
	expect(seen.registered).toEqual([]);
	expect(seen.toasts).toHaveLength(1);
	expect(seen.toasts[0]).toContain("/over is unavailable");
	expect(seen.logs).toEqual([seen.toasts[0]]);
});

test("when the bundle cannot be composed the command says why instead of failing silently", async ($, on) => {
	const seen = world(on, [], { listFails: true });
	expect(await over($, "hand over")).toEqual({});
	expect(seen.logs.join("\n")).toContain(
		"could not compose the bundle: ListAgents is not available",
	);
	expect(seen.sent).toEqual([]);
	await over($, "--send impl");
	expect(seen.logs.join("\n")).toContain("compose a bundle first");
});

// ---- broadcast ----

// impl and the worktree session are of this repo; the third interactive session is not.
const SAME_REPO = stored(
	entry({
		sessionId: "impl-id",
		ref: "c03940",
		repoRoot: ROOT,
		branch: "main",
		lastActivityAt: NOW - 5_000,
	}),
	entry({
		sessionId: "review-id",
		ref: "9f271c",
		root: `${ROOT}/.worktrees/wt-foo`,
		repoRoot: ROOT,
		branch: "feat/foo",
		lastActivityAt: NOW - 120_000,
	}),
);

const BROADCAST = "--broadcast heads-up: I am migrating the test database";
const sendId = (text: string | undefined) => /^Send: (\S+)$/m.exec(text ?? "")?.[1];
const bundleId = (text: string | undefined) =>
	/^\[claude-over broadcast (\S+)\]$/m.exec(text ?? "")?.[1];

test("--broadcast previews a broadcast with no fork and one git call, and sends nothing", async ($, on) => {
	const seen = world(on, []);
	expect(await over($, BROADCAST)).toEqual({});

	const log = seen.logs.join("\n");
	expect(log).toMatch(/\[claude-over broadcast ovr-[0-9a-z]+-[0-9a-z]{4}\]/);
	expect(log).toContain("message only · proj · feat/x");
	expect(log).toContain("## Message");
	expect(log).toContain("heads-up: I am migrating the test database");
	expect(log).not.toContain("## Summary");
	expect(seen.forks).toEqual([]);
	// Only the branch is read (by the broadcast and by the session's registry entry): no status, no diff, no log.
	expect(new Set(seen.ran)).toEqual(new Set(["git rev-parse --abbrev-ref HEAD"]));
	expect(seen.sent).toEqual([]);
	expect(seen.logs.every((line) => !line.includes("\n"))).toBe(true);
});

test("--broadcast without an intent, or with a second flag, says how to use it", async ($, on) => {
	const seen = world(on, []);
	await over($, "--broadcast");
	await over($, "--broadcast --no-fork x");
	const log = seen.logs.join("\n");
	expect(log).toContain("--broadcast needs an intent");
	expect(log).toContain("unknown flag: --no-fork");
	expect(seen.forks).toEqual([]);
});

test("each --send adds a target to the same broadcast: two sends, one bundle id, a send id each", async ($, on) => {
	const seen = world(on, []);
	await over($, BROADCAST);
	await over($, "--send impl");
	await over($, "--send repo-a | review");

	expect(seen.sent.map((sent) => sent.to)).toEqual(["impl", "repo-a | review"]);
	const [first, second] = seen.sent.map((sent) => sent.text);
	expect(first).toContain("[claude-over broadcast ovr-");
	expect(second).toContain("## Message\nheads-up: I am migrating the test database");
	expect(bundleId(first)).toMatch(/^ovr-/);
	expect(bundleId(first)).toBe(bundleId(second));
	expect(sendId(first)).not.toBe(sendId(second));
});

test("--send-repo sends the broadcast to the sessions of this repo and skips the ones that already have it", async ($, on) => {
	const seen = world(on, [], { entries: SAME_REPO });
	await over($, BROADCAST);
	await over($, "--send impl");
	seen.logs.length = 0;
	await over($, "--send-repo");

	expect(seen.sent.map((sent) => sent.to)).toEqual(["impl", "repo-a | review"]);
	expect(bundleId(seen.sent[0]?.text)).toBe(bundleId(seen.sent[1]?.text));
	expect(seen.logs).toEqual([
		"already sent to impl",
		"passed on to repo-a | review (queued)",
		"broadcast passed on to 1 of 1 sessions",
	]);

	// A repeat finds both targets done and sends nothing more.
	seen.logs.length = 0;
	await over($, "--send-repo");
	expect(seen.sent).toHaveLength(2);
	expect(seen.logs).toEqual(["already sent to impl", "already sent to repo-a | review"]);
});

test("--send-repo ticks only the sessions of this repo: one of another repo or without the mod gets nothing", async ($, on) => {
	const seen = world(on, [], {
		entries: SAME_REPO,
		rows: [...ROWS, { name: "lib-dev", ref: "d4d4d4", type: "interactive", status: "idle" }],
	});
	await over($, BROADCAST);
	await over($, "--send-repo");
	expect(seen.sent.map((sent) => sent.to)).toEqual(["impl", "repo-a | review"]);
});

test("--send-repo says so when no other session of this repo is listed", async ($, on) => {
	const seen = world(on, []);
	await over($, BROADCAST);
	await over($, "--send-repo");
	expect(seen.sent).toEqual([]);
	expect(seen.logs.at(-1)).toBe("no other sessions of this repo on the list");
});

test("--send-repo refuses after a hand-off, and with nothing composed", async ($, on) => {
	const seen = world(on, [], { entries: SAME_REPO });
	await over($, "--send-repo");
	expect(seen.logs.at(-1)).toContain("compose a bundle first");

	await over($, "hand over");
	await over($, "--send-repo");
	expect(seen.logs.at(-1)).toBe(
		"--send-repo sends a broadcast; compose one with /over --broadcast <intent>",
	);
	await over($, "--send-repo extra");
	expect(seen.logs.at(-1)).toContain("--send-repo takes no arguments");
	expect(seen.sent).toEqual([]);
});

test("--status heads a broadcast group with `broadcast:`, one line per target", async ($, on) => {
	const seen = world(on, [], { entries: SAME_REPO });
	await $.session.start(START);
	await over($, BROADCAST);
	await over($, "--send-repo");
	await over($, "--status");
	const [heading, ...lines] = seen.logs.slice(-3);
	expect(heading).toMatch(
		/^[0-9]{2}:[0-9]{2} broadcast: heads-up: I am migrating the test database$/,
	);
	// Both went out in the same millisecond of the mock clock, so only the set of lines is fixed.
	expect([...lines].sort()).toEqual([
		"  passed on to impl (queued)",
		"  passed on to repo-a | review (queued)",
	]);
});
