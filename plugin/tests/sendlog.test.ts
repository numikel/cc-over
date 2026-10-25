import { expect, test } from "claude-code/testing";
import type { SendRecord } from "../hooks/notice.js";
import { selectPrunable } from "../hooks/registry.js";
import {
	mergeRecords,
	parseSendLog,
	SENDLOG_PREFIX,
	SENDS_PER_SESSION,
	type SendLog,
	sendLogKey,
	sendLogPruneItem,
	upsertSend,
} from "../hooks/sendlog.js";

const NOW = 1_792_274_900_000;
const MINUTE = 60_000;

const record = (over: Partial<SendRecord> = {}): SendRecord => ({
	bundleId: "ovr-abc-0001",
	sendId: "send-1",
	target: "probe-one",
	sentAt: NOW - MINUTE,
	status: "passed-on",
	intent: "hand off the review",
	updatedAt: NOW - MINUTE,
	ownerSessionId: "owner-session",
	...over,
});

const log = (sends: unknown, over: Record<string, unknown> = {}) => ({
	v: 1,
	sessionId: "owner-session",
	updatedAt: NOW,
	sends,
	...over,
});

// `n` records, send-0 the oldest.
const many = (n: number): SendRecord[] =>
	Array.from({ length: n }, (_, i) => record({ sendId: `send-${i}`, sentAt: NOW + i * MINUTE }));

test("parseSendLog returns null for garbage, another version or a wrong overall shape", () => {
	const garbage: unknown[] = [
		null,
		undefined,
		"text",
		42,
		[],
		{},
		log([], { v: 2 }),
		log([], { v: "1" }),
	];
	for (const value of garbage) expect(parseSendLog(value)).toBeNull();
	expect(parseSendLog(log([], { sessionId: 7 }))).toBeNull();
	expect(parseSendLog(log([], { sessionId: undefined }))).toBeNull();
	expect(parseSendLog(log([], { updatedAt: "now" }))).toBeNull();
	expect(parseSendLog(log([], { updatedAt: Number.NaN }))).toBeNull();
	expect(parseSendLog(log("not an array"))).toBeNull();
	expect(parseSendLog(log([record()], { sends: undefined }))).toBeNull();
});

test("parseSendLog round-trips a valid log and keeps its records in order", () => {
	const first = record({ sendId: "a", sentAt: NOW });
	const second = record({ sendId: "b", sentAt: NOW - MINUTE, status: "received" });
	expect(parseSendLog(log([first, second]))).toEqual({
		v: 1,
		sessionId: "owner-session",
		updatedAt: NOW,
		sends: [first, second],
	});
});

test("parseSendLog skips a damaged record and a record with an unknown status, keeps the rest", () => {
	const good = record({ sendId: "good" });
	const { intent: _intent, ...noIntent } = record({ sendId: "no-intent" });
	const sends = [
		null,
		"junk",
		noIntent,
		record({ sendId: "bad-time", sentAt: Number.POSITIVE_INFINITY }),
		{ ...record({ sendId: "bad-owner" }), ownerSessionId: 5 },
		{ ...record({ sendId: "bad-reason" }), reason: 5 },
		{ ...record({ sendId: "unknown" }), status: "teleported" },
		good,
	];
	expect(parseSendLog(log(sends))?.sends).toEqual([good]);
});

test("parseSendLog keeps a string reason, never emits an undefined one and drops unknown fields", () => {
	const withReason = record({ sendId: "r", status: "not-passed-on", reason: "no live session" });
	const parsed = parseSendLog(
		log([withReason, { ...record({ sendId: "p" }), reason: undefined, surprise: "x" }]),
	);
	expect(parsed?.sends[0]?.reason).toBe("no live session");
	const plain = parsed?.sends[1];
	expect(plain).toBeDefined();
	expect(plain !== undefined && "reason" in plain).toBe(false);
	expect(plain !== undefined && "surprise" in plain).toBe(false);
});

test("parseSendLog keeps a valid kind of either value", () => {
	const handOff = record({ sendId: "h", kind: "hand-off" });
	const broadcast = record({ sendId: "b", kind: "broadcast" });
	expect(parseSendLog(log([handOff, broadcast]))?.sends).toEqual([handOff, broadcast]);
});

test("parseSendLog drops an unknown kind but keeps the record, and a missing kind stays missing", () => {
	const parsed = parseSendLog(
		log([
			{ ...record({ sendId: "odd" }), kind: "multicast" },
			{ ...record({ sendId: "num" }), kind: 7 },
			{ ...record({ sendId: "undef" }), kind: undefined },
			record({ sendId: "plain" }),
		]),
	);
	expect(parsed?.sends.map((s) => s.sendId)).toEqual(["odd", "num", "undef", "plain"]);
	for (const sent of parsed?.sends ?? []) expect("kind" in sent).toBe(false);
});

test("kind survives upsertSend, mergeRecords and a parse of the saved log", () => {
	const broadcast = record({ sendId: "b", kind: "broadcast", sentAt: NOW });
	const plain = record({ sendId: "p", sentAt: NOW - MINUTE });
	const saved = upsertSend(upsertSend(null, plain, NOW), broadcast, NOW);
	expect(saved.sends.map((s) => s.kind)).toEqual(["broadcast", undefined]);
	const reloaded = parseSendLog(JSON.parse(JSON.stringify(saved)));
	expect(reloaded?.sends).toEqual([broadcast, plain]);
	expect(mergeRecords([broadcast], [plain]).map((s) => s.kind)).toEqual(["broadcast", undefined]);
});

test("upsertSend adds a record to an empty log under the record's owner session", () => {
	const sent = record();
	const next = upsertSend(null, sent, NOW);
	expect(next).toEqual({ v: 1, sessionId: "owner-session", updatedAt: NOW, sends: [sent] });
});

test("upsertSend replaces a record by sendId and does not mutate the previous log", () => {
	const old = record({ sendId: "same", status: "passed-on" });
	const other = record({ sendId: "other", sentAt: NOW - 2 * MINUTE });
	const prev: SendLog = { v: 1, sessionId: "owner-session", updatedAt: 1, sends: [old, other] };
	const frozen = structuredClone(prev);
	const updated = record({ sendId: "same", status: "held", updatedAt: NOW });
	const next = upsertSend(prev, updated, NOW);
	expect(next.sends).toEqual([updated, other]);
	expect(next.updatedAt).toBe(NOW);
	expect(prev).toEqual(frozen);
	expect(next.sends).not.toBe(prev.sends);
});

test("upsertSend keeps the 50 newest by sentAt, newest first", () => {
	let current: SendLog | null = null;
	for (const sent of many(SENDS_PER_SESSION + 5)) current = upsertSend(current, sent, NOW);
	const ids = current?.sends.map((s) => s.sendId) ?? [];
	expect(ids).toHaveLength(SENDS_PER_SESSION);
	expect(ids[0]).toBe("send-54");
	expect(ids[SENDS_PER_SESSION - 1]).toBe("send-5");
	// An older record than all 50 kept is the one that falls out.
	const stale = record({ sendId: "ancient", sentAt: NOW - 10 * MINUTE });
	expect(upsertSend(current, stale, NOW).sends.map((s) => s.sendId)).not.toContain("ancient");
});

test("mergeRecords: the memory copy wins, newest first, at most 50", () => {
	const memory = [record({ sendId: "x", status: "received", sentAt: NOW })];
	const stored = [
		record({ sendId: "x", status: "passed-on", sentAt: NOW }),
		record({ sendId: "y", sentAt: NOW + MINUTE }),
		record({ sendId: "z", sentAt: NOW - MINUTE }),
	];
	const merged = mergeRecords(memory, stored);
	expect(merged.map((r) => r.sendId)).toEqual(["y", "x", "z"]);
	expect(merged.find((r) => r.sendId === "x")?.status).toBe("received");
	expect(
		mergeRecords(
			many(30),
			many(40).map((r) => ({ ...r, sendId: `s-${r.sendId}` })),
		),
	).toHaveLength(SENDS_PER_SESSION);
	expect(mergeRecords([], [])).toEqual([]);
});

test("sendLogKey namespaces the owner session and sendLogPruneItem feeds selectPrunable", () => {
	expect(SENDLOG_PREFIX).toBe("sends:");
	expect(sendLogKey("abc-123")).toBe("sends:abc-123");
	expect(SENDS_PER_SESSION).toBe(50);
	const stored: SendLog = {
		v: 1,
		sessionId: "owner-session",
		updatedAt: NOW - 20 * 86_400_000,
		sends: [],
	};
	const item = sendLogPruneItem(sendLogKey("owner-session"), stored, 321);
	expect(item).toEqual({
		key: "sends:owner-session",
		sessionId: "owner-session",
		updatedAt: stored.updatedAt,
		size: 321,
	});
	const doomed = selectPrunable([item], NOW, {
		maxAgeMs: 15 * 86_400_000,
		maxBytes: 1_000_000,
		keepSessionId: "someone-else",
	});
	expect(doomed).toEqual(["sends:owner-session"]);
});
