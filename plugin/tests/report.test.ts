import { expect, test } from "claude-code/testing";
import { clockTime, type SendRecord, statusLine } from "../hooks/notice.js";
import { bundleLines, statusReport } from "../hooks/report.js";

const NOW = 1_792_274_900_000;
const MINUTE = 60_000;

const record = (over: Partial<SendRecord> = {}): SendRecord => ({
	bundleId: "bundle-a",
	sendId: "send-1",
	target: "probe-one",
	sentAt: NOW - 30 * MINUTE,
	status: "passed-on",
	intent: "hand off the review",
	updatedAt: NOW - 30 * MINUTE,
	ownerSessionId: "owner-session",
	...over,
});

// Two bundles: A (two targets, sent in reverse order in the input) and the newer B (one target).
const a2 = record({ sendId: "a2", target: "beta", sentAt: NOW - 20 * MINUTE, status: "received" });
const a1 = record({ sendId: "a1", target: "alpha", sentAt: NOW - 30 * MINUTE });
const b1 = record({
	bundleId: "bundle-b",
	sendId: "b1",
	target: "gamma",
	sentAt: NOW - 10 * MINUTE,
	status: "not-passed-on",
	reason: "No agent named 'gamma' is reachable.",
	intent: "second topic",
});

test("statusReport groups by bundle: newest group first, a header from the earliest send, targets in sending order", () => {
	const lines = statusReport([a2, b1, a1], NOW);
	expect(lines).toEqual([
		`${clockTime(b1.sentAt)} second topic`,
		`  ${statusLine(b1, false, NOW)}`,
		`${clockTime(a1.sentAt)} hand off the review`,
		`  ${statusLine(a1, false, NOW)}`,
		`  ${statusLine(a2, false, NOW)}`,
	]);
});

test("statusReport heads a broadcast group with `broadcast:` and leaves hand-off and kind-less groups as they were", () => {
	const c1 = record({
		bundleId: "bundle-c",
		sendId: "c1",
		kind: "broadcast",
		target: "delta",
		sentAt: NOW - 5 * MINUTE,
		intent: "freeze the build",
	});
	const c2 = record({ ...c1, sendId: "c2", target: "epsilon", sentAt: NOW - 4 * MINUTE });
	const d1 = record({
		bundleId: "bundle-d",
		sendId: "d1",
		kind: "hand-off",
		sentAt: NOW - 3 * MINUTE,
		intent: "explicit hand-off",
	});
	expect(statusReport([a1, c2, d1, c1], NOW)).toEqual([
		`${clockTime(d1.sentAt)} explicit hand-off`,
		`  ${statusLine(d1, false, NOW)}`,
		`${clockTime(c1.sentAt)} broadcast: freeze the build`,
		`  ${statusLine(c1, false, NOW)}`,
		`  ${statusLine(c2, false, NOW)}`,
		`${clockTime(a1.sentAt)} hand off the review`,
		`  ${statusLine(a1, false, NOW)}`,
	]);
});

test("statusReport orders groups by their newest send", () => {
	// Bundle A's first send is the oldest, but its second send is newer than all of bundle B.
	const lateA = record({ sendId: "a3", target: "delta", sentAt: NOW - MINUTE });
	const lines = statusReport([a1, b1, lateA], NOW);
	expect(lines[0]).toBe(`${clockTime(a1.sentAt)} hand off the review`);
	expect(lines.indexOf(`${clockTime(b1.sentAt)} second topic`)).toBeGreaterThan(0);
	expect(lines.slice(0, 3)).toEqual([
		`${clockTime(a1.sentAt)} hand off the review`,
		`  ${statusLine(a1, false, NOW)}`,
		`  ${statusLine(lateA, false, NOW)}`,
	]);
});

test("statusReport says so for an empty list and never starts a line with the platform phrase", () => {
	expect(statusReport([], NOW)).toEqual(["no sends recorded for this session"]);
	const statuses: SendRecord["status"][] = [
		"passed-on",
		"held",
		"released",
		"refused",
		"expired",
		"not-passed-on",
		"received",
	];
	const all = statuses.map((status, i) => record({ sendId: `s${i}`, status, bundleId: `b${i}` }));
	for (const line of statusReport(all, NOW)) expect(line.startsWith("Cross-session")).toBe(false);
});

test("bundleLines gives one status line per send of that bundle, in sending order, without header or indent", () => {
	expect(bundleLines([a2, b1, a1], "bundle-a", NOW)).toEqual([
		statusLine(a1, false, NOW),
		statusLine(a2, false, NOW),
	]);
	expect(bundleLines([a2, b1, a1], "bundle-b", NOW)).toEqual([statusLine(b1, false, NOW)]);
	expect(bundleLines([a2, b1, a1], "no-such-bundle", NOW)).toEqual([]);
	expect(bundleLines([], "bundle-a", NOW)).toEqual([]);
});
