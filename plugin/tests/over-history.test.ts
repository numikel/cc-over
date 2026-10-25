// S-07 phase 3: each send leaves a preview under `history:<owner session id>`, a warning or an ack
// updates its status, and `/over --history [n]` lists them in `-p`. The pane section is covered in
// over-pane-history.test.ts.

import { expect, test } from "claude-code/testing";
import { ackMessage } from "../hooks/ack.js";
import {
	HISTORY_MAX_AGE_MS,
	type HistoryEntry,
	type HistoryLog,
	historyKey,
} from "../hooks/history.js";
import { PRUNE_MAX_AGE_MS } from "../hooks/registry.js";
import { heldText, NOW, noticeRow, over, SESSION_ID, type Seen, START, world } from "./support.js";

const MINUTE = 60_000;
const PEER = { kind: "peer" } as const;

const envelope = (body: string) =>
	String.raw`<cross-session-message from="uds:\\.\pipe\LOCAL\cc-msg-1" from-name="impl" from-mode="prompting">` +
	`\n${body}\n</cross-session-message>`;

// An entry as another session of the same (or another) project would have saved it.
function entryOf(over: Partial<HistoryEntry> & { bundleId: string }): HistoryEntry {
	return {
		project: "/proj",
		repo: "proj",
		branch: "main",
		composedAt: NOW - 3 * MINUTE,
		lastSentAt: NOW - 3 * MINUTE,
		intent: "earlier hand-off",
		summary: "Done before /clear.",
		instructions: "Carry on.",
		files: ["src/a.ts"],
		filesTotal: 1,
		targets: [
			{
				sendId: "aaaaaaa",
				target: "impl",
				sentAt: NOW - 3 * MINUTE,
				status: "held",
				updatedAt: NOW - 3 * MINUTE,
			},
		],
		targetsTotal: 1,
		...over,
	};
}

const logOf = (sessionId: string, entries: HistoryEntry[], updatedAt = NOW): HistoryLog => ({
	v: 1,
	sessionId,
	updatedAt,
	entries,
});

const saved = (seen: Seen, sessionId = SESSION_ID): HistoryEntry[] =>
	(seen.store[historyKey(sessionId)] as HistoryLog | undefined)?.entries ?? [];

const historyKeys = (seen: Seen): string[] =>
	Object.keys(seen.store).filter((key) => key.startsWith("history:"));

test("a send is saved under the session's history key with the preview and its target", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.settle();

	expect(seen.store[historyKey(SESSION_ID)]).toMatchObject({ v: 1, sessionId: SESSION_ID });
	expect(saved(seen)).toHaveLength(1);
	expect(saved(seen)[0]).toMatchObject({
		project: "/proj",
		repo: "proj",
		branch: "feat/x",
		lastSentAt: NOW,
		intent: "hand over",
		summary: "Review done, two findings.",
		instructions: "Fix the two findings.",
		targetsTotal: 1,
	});
	expect(saved(seen)[0]?.targets[0]).toMatchObject({ target: "impl", status: "passed-on" });
	const json = JSON.stringify(seen.store[historyKey(SESSION_ID)]);
	expect(json).not.toContain("See src/a.ts");
});

test("a second send of the same bundle adds a target to the one entry", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.advance(MINUTE);
	await over($, "--send repo-a | review");
	await seen.clock.settle();

	expect(saved(seen)).toHaveLength(1);
	const [first] = saved(seen);
	expect(first?.targets.map((t) => t.target)).toEqual(["impl", "repo-a | review"]);
	expect(first?.targetsTotal).toBe(2);
	expect(first?.lastSentAt).toBe(NOW + MINUTE);
});

test("a held warning changes the target's status in the entry", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await $.session.append(noticeRow(heldText("impl")));
	await seen.clock.settle();

	expect(saved(seen)[0]?.targets[0]?.status).toBe("held");
	expect(saved(seen)[0]?.lastSentAt).toBe(NOW);
});

test("a late acknowledgement drops an entry that is already older than 14 days", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.settle();
	const entry = saved(seen)[0];

	await seen.clock.advance(HISTORY_MAX_AGE_MS + 1);
	await $.session.receive({
		origin: PEER,
		text: envelope(ackMessage(entry?.bundleId ?? "", entry?.targets[0]?.sendId ?? "")),
	});
	await seen.clock.settle();

	expect(saved(seen)).toEqual([]);
});

test("an acknowledgement turns the target's status into received", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.settle();
	const entry = saved(seen)[0];
	const sendId = entry?.targets[0]?.sendId ?? "";

	await $.session.receive({
		origin: PEER,
		text: envelope(ackMessage(entry?.bundleId ?? "", sendId)),
	});
	await seen.clock.settle();

	expect(saved(seen)[0]?.targets[0]?.status).toBe("received");
});

test("with the switch off nothing is saved, nothing is updated and the command says so", async ($, on) => {
	const seen = world(on, [], { history: false });
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await $.session.append(noticeRow(heldText("impl")));
	await seen.clock.settle();
	expect(historyKeys(seen)).toEqual([]);

	await over($, "--history");
	expect(seen.logs.at(-1)).toBe("history is off: turn it on in /config (cc-over.history)");
});

test("with the switch row present and on the send is saved just the same", async ($, on) => {
	const seen = world(on, [], { history: true });
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.settle();
	expect(saved(seen)).toHaveLength(1);
});

test("--history lists the project's bundles with numbers and --history 1 opens the first", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "--history");
	expect(seen.logs.at(-1)).toBe("no bundles sent from this project in the last 14 days");

	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.advance(5 * MINUTE);
	await over($, "--history");
	expect(seen.logs.slice(-2)).toEqual([
		"History: proj (1)",
		"1. 5m ago · hand over · passed on to impl (queued)",
	]);

	await over($, "--history 1");
	const detail = seen.logs.slice(-11);
	expect(detail).toContain("Intent: hand over");
	expect(detail).toContain("From: proj (feat/x)");
	expect(detail).toContain("- passed on to impl (queued)");
	expect(detail).toContain("Summary: Review done, two findings.");
	expect(detail).toContain("Instructions: Fix the two findings.");

	await over($, "--history 2");
	expect(seen.logs.at(-1)).toBe("no history entry 2 (there are 1)");
});

test("entries of the project's other sessions show (a /clear), another project's do not", async ($, on) => {
	const seen = world(on, [], {
		entries: {
			[historyKey("before-clear")]: logOf("before-clear", [entryOf({ bundleId: "ovr-a-0001" })]),
			[historyKey("elsewhere")]: logOf("elsewhere", [
				entryOf({ bundleId: "ovr-b-0001", project: "/other", repo: "other" }),
			]),
		},
	});
	await $.session.start(START);
	await over($, "--history");

	expect(seen.logs.slice(-2)).toEqual([
		"History: proj (1)",
		"1. 3m ago · earlier hand-off · held: impl has not seen it yet, waiting for the recipient's approval",
	]);
});

test("pruning removes a history key untouched for 15 days, never this session's or one it cannot read", async ($, on) => {
	const old = NOW - PRUNE_MAX_AGE_MS - 1;
	const seen = world(on, [], {
		entries: {
			[historyKey("stale")]: logOf("stale", [entryOf({ bundleId: "ovr-a-0001" })], old),
			[historyKey("fresh")]: logOf("fresh", [], NOW - 1000),
			// Break-check start state: this session's own key is as old as the stale one.
			[historyKey(SESSION_ID)]: logOf(SESSION_ID, [entryOf({ bundleId: "ovr-b-0001" })], old),
			[historyKey("junk")]: "not a history log",
			[historyKey("newer")]: { v: 2, sessionId: "newer", updatedAt: old, entries: [] },
			[historyKey("misfiled")]: logOf("someone-else", [], old),
		},
	});
	await $.session.start(START);
	await seen.clock.settle();

	expect(seen.store[historyKey("stale")]).toBeUndefined();
	expect(seen.store[historyKey("fresh")]).toBeDefined();
	expect(seen.store[historyKey(SESSION_ID)]).toBeDefined();
	expect(seen.store[historyKey("junk")]).toBe("not a history log");
	expect(seen.store[historyKey("newer")]).toMatchObject({ v: 2 });
	expect(seen.store[historyKey("misfiled")]).toBeDefined();
});

test("a history key that cannot be read gives a message, not an exception", async ($, on) => {
	const seen = world(on, [], {
		historyReadFails: true,
		entries: { [historyKey("other")]: logOf("other", [entryOf({ bundleId: "ovr-a-0001" })]) },
	});
	await $.session.start(START);
	await over($, "--history");

	expect(seen.logs.at(-1)).toMatch(/^could not read the history \(.+\)$/);
});

test("after /clear the entry keeps its status: a later warning or ack of the old send changes nothing", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.settle();
	const entry = saved(seen)[0];

	await $.classic.SessionStart({ source: "clear", session_id: "fresh-session-after-clear" });
	await $.session.append(noticeRow(heldText("impl")));
	await $.session.receive({
		origin: PEER,
		text: envelope(ackMessage(entry?.bundleId ?? "", entry?.targets[0]?.sendId ?? "")),
	});
	await seen.clock.settle();

	// Still under the old key, still the status it had when the conversation was cleared.
	expect(saved(seen)[0]?.targets[0]?.status).toBe("passed-on");
	expect(saved(seen, "fresh-session-after-clear")).toEqual([]);
});

test("a store that refuses the save costs the entry, not the send", async ($, on) => {
	const seen = world(on, [], { storeFails: true });
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.settle();

	expect(seen.sent).toHaveLength(1);
	expect(seen.logs.some((line) => line.startsWith("history: save failed"))).toBe(true);
	expect(historyKeys(seen)).toEqual([]);
});
