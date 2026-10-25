// S-04 phase 3: each send's status is kept in the shared store under `sends:<owner session id>`,
// so it outlives a reload of the mod and a new process. `/over --status` reports it per bundle
// and per target; the pane block is covered in over-pane.test.ts.

import { expect, test } from "claude-code/testing";
import { ackMessage } from "../hooks/ack.js";
import { clockTime, type SendRecord } from "../hooks/notice.js";
import { PRUNE_MAX_AGE_MS } from "../hooks/registry.js";
import { type SendLog, sendLogKey } from "../hooks/sendlog.js";
import {
	expiredText,
	heldText,
	NOW,
	noticeRow,
	over,
	pluralText,
	releasedText,
	SESSION_ID,
	type Seen,
	START,
	world,
} from "./support.js";

const MINUTE = 60_000;
const PEER = { kind: "peer" } as const;
const BUNDLE = "ovr-mve4av3q-xngn";

const envelope = (body: string, name = "repo-a | review") =>
	String.raw`<cross-session-message from="uds:\\.\pipe\LOCAL\cc-msg-1" from-name="${name}" from-mode="prompting">` +
	`\n${body}\n</cross-session-message>`;

// A send as an earlier process of this session saved it.
function record(fields: Partial<SendRecord> & { sendId: string; target: string }): SendRecord {
	const sentAt = fields.sentAt ?? NOW - 40 * MINUTE;
	return {
		bundleId: BUNDLE,
		intent: "seeded hand-off",
		sentAt,
		updatedAt: sentAt,
		status: "passed-on",
		ownerSessionId: SESSION_ID,
		...fields,
	};
}

const sendLog = (sessionId: string, sends: SendRecord[], updatedAt = NOW): SendLog => ({
	v: 1,
	sessionId,
	updatedAt,
	sends,
});

const saved = (seen: Seen, sessionId = SESSION_ID): SendRecord[] =>
	(seen.store[sendLogKey(sessionId)] as SendLog | undefined)?.sends ?? [];

const savedOf = (seen: Seen, target: string) => saved(seen).find((r) => r.target === target);

test("a send is saved under the session's key, and held then released updates the saved copy", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.settle();

	expect(seen.store[sendLogKey(SESSION_ID)]).toMatchObject({ v: 1, sessionId: SESSION_ID });
	expect(saved(seen)).toHaveLength(1);
	expect(saved(seen)[0]).toMatchObject({
		target: "impl",
		intent: "hand over",
		ownerSessionId: SESSION_ID,
		status: "passed-on",
		sentAt: NOW,
	});

	await $.session.append(noticeRow(heldText("impl"), "informational", "r1"));
	await seen.clock.settle();
	expect(savedOf(seen, "impl")?.status).toBe("held");

	await seen.clock.advance(MINUTE);
	await $.session.append(noticeRow(releasedText("impl"), "informational", "r2"));
	await seen.clock.settle();
	expect(savedOf(seen, "impl")).toMatchObject({ status: "released", updatedAt: NOW + MINUTE });
	expect(seen.toasts.at(-1)).toBe("passed on to impl (approved by the recipient, queued)");
});

test("one batched denied line for two targets settles both saved sends as declined", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await over($, "--send repo-a | review");

	await $.session.append(noticeRow(pluralText("denied", ["impl", "repo-a | review"])));
	await seen.clock.settle();

	for (const target of ["impl", "repo-a | review"]) {
		expect(savedOf(seen, target)).toMatchObject({
			status: "not-passed-on",
			reason: "the recipient's user declined it",
		});
	}
	expect(seen.toasts).toContain("not passed on to impl: the recipient's user declined it");
	expect(seen.toasts).toContain(
		"not passed on to repo-a | review: the recipient's user declined it",
	);
});

test("after a reload the saved sends come back: --status shows them, a late warning and a late ack match them", async ($, on) => {
	const seen = world(on, [], {
		entries: {
			[sendLogKey(SESSION_ID)]: sendLog(SESSION_ID, [
				record({ sendId: "2a7b9c0", target: "repo-a | review", sentAt: NOW - 39 * MINUTE }),
				record({ sendId: "146c6fb", target: "impl", status: "held" }),
			]),
		},
	});
	await $.session.start(START);

	await over($, "--status");
	const report = seen.logs.slice(-3);
	expect(report[0]).toBe(`${clockTime(NOW - 40 * MINUTE)} seeded hand-off`);
	expect(report[1]).toMatch(/^ {2}held: impl has not seen it yet.*\(no news since /);
	expect(report[2]).toBe("  passed on to repo-a | review (queued)");

	await $.session.append(noticeRow(expiredText("impl")));
	expect(seen.toasts).toEqual([
		"expired: impl did not approve the message, nothing is waiting for them",
	]);

	const acked = await $.session.receive({
		origin: PEER,
		text: envelope(ackMessage(BUNDLE, "2a7b9c0")),
	});
	expect(acked.consumed).toEqual(expect.stringContaining("acknowledgement"));
	expect(seen.toasts.at(-1)).toBe("received by repo-a | review (acknowledged)");

	await seen.clock.settle();
	expect(savedOf(seen, "impl")?.status).toBe("expired");
	expect(savedOf(seen, "repo-a | review")?.status).toBe("received");
});

test("--status groups a bundle's sends under its intent, one line per target in sending order", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "--status");
	expect(seen.logs.at(-1)).toBe("no sends recorded for this session");

	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.advance(MINUTE);
	await over($, "--send repo-a | review");
	await over($, "--status");

	expect(seen.logs.slice(-3)).toEqual([
		`${clockTime(NOW)} hand over`,
		"  passed on to impl (queued)",
		"  passed on to repo-a | review (queued)",
	]);
});

test("a broadcast's kind is saved with each send, and a later status change keeps it", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "--broadcast heads-up");
	await over($, "--send impl");
	await seen.clock.settle();
	expect(savedOf(seen, "impl")?.kind).toBe("broadcast");

	await $.session.append(noticeRow(heldText("impl")));
	await seen.clock.settle();
	expect(savedOf(seen, "impl")).toMatchObject({ kind: "broadcast", status: "held" });
});

test("after a reload a saved broadcast heads --status with `broadcast:`, and a record from before kinds existed is a hand-off", async ($, on) => {
	const later = world(on, [], {
		entries: {
			[sendLogKey(SESSION_ID)]: sendLog(SESSION_ID, [
				record({
					sendId: "b1b1b1b",
					target: "impl",
					kind: "broadcast",
					intent: "seeded broadcast",
					bundleId: "ovr-bcast-1111",
				}),
				record({ sendId: "a0a0a0a", target: "repo-a | review", sentAt: NOW - 41 * MINUTE }),
			]),
		},
	});
	await $.session.start(START);
	await over($, "--status");
	expect(later.logs.slice(-4)).toEqual([
		`${clockTime(NOW - 40 * MINUTE)} broadcast: seeded broadcast`,
		expect.stringMatching(/^ {2}passed on to impl \(queued\)/),
		`${clockTime(NOW - 41 * MINUTE)} seeded hand-off`,
		"  passed on to repo-a | review (queued)",
	]);
});

test("pruning drops another session's stale send log, never this session's or a value it cannot read", async ($, on) => {
	const old = NOW - PRUNE_MAX_AGE_MS - 1;
	const seen = world(on, [], {
		entries: {
			[sendLogKey("stale")]: sendLog(
				"stale",
				[record({ sendId: "1111111", target: "impl", ownerSessionId: "stale" })],
				old,
			),
			[sendLogKey("fresh")]: sendLog("fresh", [], NOW - 1000),
			// Break-check start state: this session's own log is as old as the stale one.
			[sendLogKey(SESSION_ID)]: sendLog(
				SESSION_ID,
				[record({ sendId: "2222222", target: "impl" })],
				old,
			),
			[sendLogKey("junk")]: "not a send log",
			[sendLogKey("newer")]: { v: 2, sessionId: "newer", updatedAt: old, sends: [] },
			[sendLogKey("misfiled")]: sendLog("someone-else", [], old),
		},
	});
	await $.session.start(START);
	await seen.clock.settle();

	expect(seen.store[sendLogKey("stale")]).toBeUndefined();
	expect(seen.store[sendLogKey("fresh")]).toBeDefined();
	expect(seen.store[sendLogKey(SESSION_ID)]).toBeDefined();
	expect(seen.store[sendLogKey("junk")]).toBe("not a send log");
	expect(seen.store[sendLogKey("newer")]).toMatchObject({ v: 2 });
	expect(seen.store[sendLogKey("misfiled")]).toBeDefined();
});

test("a store that refuses the save costs the status its copy, not the send", async ($, on) => {
	const seen = world(on, [], { storeFails: true });
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.settle();

	expect(seen.sent).toHaveLength(1);
	expect(seen.logs).toContain("passed on to impl (queued)");
	expect(seen.logs.some((line) => line.startsWith("send status: save failed"))).toBe(true);
	expect(seen.store[sendLogKey(SESSION_ID)]).toBeUndefined();
});

test("/clear resets in-memory sends so the new session does not report them", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.settle();

	await $.classic.SessionStart({ source: "clear", session_id: "fresh-session-after-clear" });
	seen.logs.length = 0;
	await over($, "--status");

	expect(seen.logs).toEqual(["no sends recorded for this session"]);
});

test("a compaction keeps the composed bundle and the sends not saved yet", async ($, on) => {
	// Break-check start state: nothing reaches the store, so only the copy in memory has the send.
	const seen = world(on, [], { storeFails: true });
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.settle();

	await $.classic.SessionStart({ source: "compact", session_id: SESSION_ID });
	seen.logs.length = 0;
	await over($, "--status");
	expect(seen.logs).toContain("  passed on to impl (queued)");

	await over($, "--send repo-a | review");
	expect(seen.sent).toHaveLength(2);
});
