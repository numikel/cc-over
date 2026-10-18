// S-01 phase 3: `/over` as a command. A `-p` run draws nothing, so the composed bundle and
// every report go to the transcript log, one line per call; nothing is ever sent unasked.

import { expect, test } from "claude-code/testing";
import { FORK_TEXT, GIT, over, ROWS, START, world } from "./support.js";

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

test("a bare /over, an unknown flag and --send without a target say how to use it, and compose nothing", async ($, on) => {
	const seen = world(on, []);
	await over($, "");
	await over($, "--send");
	await over($, "--bogus x");
	const log = seen.logs.join("\n");
	expect(log).toContain("Usage: /over");
	expect(log).toContain("--send needs a session name");
	expect(log).toContain("unknown flag: --bogus");
	expect(seen.forks).toEqual([]);
	expect(seen.sent).toEqual([]);
});

test("--list shows the local sessions and counts the hidden ones, with no model and no send", async ($, on) => {
	const seen = world(on, []);
	expect(await over($, "--list")).toEqual({});
	const log = seen.logs.join("\n");
	expect(log).toContain("impl · idle");
	expect(log).toContain("repo-a | review · busy");
	expect(log).not.toContain("cloud-1");
	expect(log).toContain("hidden: 1");
	expect(seen.forks).toEqual([]);
	expect(seen.sent).toEqual([]);
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
