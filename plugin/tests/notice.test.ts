import { expect, test } from "claude-code/testing";
import {
	applyNotice,
	applySendResult,
	matchNotice,
	nextStatus,
	parseDeliveryNotice,
	type SendRecord,
	statusLine,
} from "../hooks/notice.js";

// Fixtures are copied verbatim from evidence.md § E1 (platform text; the recipients are probe names).
const HELD =
	"Cross-session message held by the receiving session (recipient: @probe-s01-hold). Claude in that session hasn't seen it. The usual cause is that the two sessions are in different permission modes: a terminal session then asks for approval there, but the desktop app and non-interactive sessions can't ask, so there the message expires undelivered unless the modes come to match. A session can also be set to hold every message.";
const REFUSED =
	"Cross-session message refused (recipient: @probe-s01-refuse). That session is not accepting cross-session messages (the feature is off there, or a setting or policy there refuses them); it was not delivered.";
const EXPIRED =
	"Cross-session message expired without approval (recipient: @probe-s01-hold). It was never approved, so it wasn't delivered and nothing is waiting in that session. Claude was told.";
const DROPPED =
	"Cross-session message was dropped at the recipient session's inbox (recipient: @probe-s01-accept) and not delivered — it repeated your previous message. Claude was told not to resend right away.";

const NOW = 1_792_274_900_000;
const MINUTE = 60_000;

const record = (over: Partial<SendRecord> = {}): SendRecord => ({
	bundleId: "ovr-abc-0001",
	sendId: "1a2b3c4",
	target: "probe-s01-hold",
	sentAt: NOW - MINUTE,
	status: "passed-on",
	...over,
});

test("parseDeliveryNotice recognises the four platform notices", () => {
	expect(parseDeliveryNotice(HELD)).toEqual({ kind: "held", recipient: "probe-s01-hold" });
	expect(parseDeliveryNotice(REFUSED)).toEqual({ kind: "refused", recipient: "probe-s01-refuse" });
	expect(parseDeliveryNotice(EXPIRED)).toEqual({ kind: "expired", recipient: "probe-s01-hold" });
	expect(parseDeliveryNotice(DROPPED)).toEqual({ kind: "dropped", recipient: "probe-s01-accept" });
});

test("parseDeliveryNotice keeps spaces and pipes in the recipient and stops at the closing parenthesis", () => {
	const text =
		"Cross-session message held by the receiving session (recipient: @repo-a | review | feature-y). Claude in that session hasn't seen it. (more)";
	expect(parseDeliveryNotice(text)).toEqual({
		kind: "held",
		recipient: "repo-a | review | feature-y",
	});
});

test("parseDeliveryNotice ignores everything else, including the mod's own log lines", () => {
	for (const text of [
		"",
		"turn_duration",
		"cc-over: passed on to probe-s01-hold (queued)",
		`cc-over: ${HELD}`,
		`Note: ${REFUSED}`,
		"Cross-session message was released (recipient: @probe-s01-hold).",
		"Cross-session message held (recipient: @probe-s01-hold).",
		"Cross-session message held by the receiving session",
	]) {
		expect(parseDeliveryNotice(text)).toBeNull();
	}
});

test("matchNotice finds the unresolved send to that recipient", () => {
	const sends = [record()];
	const match = matchNotice(sends, { kind: "held", recipient: "probe-s01-hold" }, NOW);
	expect(match?.isAmbiguous).toBe(false);
	expect(match?.record).toBe(sends[0]);
});

test("matchNotice ignores sends outside the 30 minute window and recipients the mod never sent to", () => {
	const old = [record({ sentAt: NOW - 31 * MINUTE })];
	expect(matchNotice(old, { kind: "held", recipient: "probe-s01-hold" }, NOW)).toBeNull();
	expect(matchNotice([record()], { kind: "held", recipient: "someone-else" }, NOW)).toBeNull();
	expect(matchNotice([], { kind: "held", recipient: "probe-s01-hold" }, NOW)).toBeNull();
});

test("matchNotice skips sends that are already settled", () => {
	const sends = [record({ status: "expired" }), record({ status: "not-passed-on" })];
	expect(matchNotice(sends, { kind: "held", recipient: "probe-s01-hold" }, NOW)).toBeNull();
});

test("matchNotice takes the newest of several candidates and flags the ambiguity", () => {
	const older = record({ sendId: "aaaaaaa", sentAt: NOW - 5 * MINUTE });
	const newer = record({ sendId: "bbbbbbb", sentAt: NOW - MINUTE, status: "held" });
	const match = matchNotice([older, newer], { kind: "expired", recipient: "probe-s01-hold" }, NOW);
	expect(match?.record).toBe(newer);
	expect(match?.isAmbiguous).toBe(true);
});

test("nextStatus moves from passed-on", () => {
	expect(nextStatus("passed-on", "held")).toBe("held");
	expect(nextStatus("passed-on", "refused")).toBe("not-passed-on");
	expect(nextStatus("passed-on", "dropped")).toBe("not-passed-on");
	expect(nextStatus("passed-on", "expired")).toBe("expired");
});

test("nextStatus moves from held: refusal and expiry settle it, a repeated held does not", () => {
	expect(nextStatus("held", "held")).toBe("held");
	expect(nextStatus("held", "refused")).toBe("not-passed-on");
	expect(nextStatus("held", "dropped")).toBe("not-passed-on");
	expect(nextStatus("held", "expired")).toBe("expired");
});

test("terminal statuses absorb every later notice, so a late held cannot reopen them", () => {
	for (const status of ["not-passed-on", "expired"] as const) {
		for (const kind of ["held", "refused", "expired", "dropped"] as const) {
			expect(nextStatus(status, kind)).toBe(status);
		}
	}
});

test("applySendResult maps the platform answer onto the record", () => {
	const sent = applySendResult(record({ status: "not-passed-on" }), { isDelivered: true });
	expect(sent.status).toBe("passed-on");
	expect(sent.reason).toBeUndefined();

	const failed = applySendResult(record(), {
		isDelivered: false,
		reason: "No agent named 'x' is reachable.\nUse ListAgents to see everyone you can message.",
	});
	expect(failed.status).toBe("not-passed-on");
	expect(failed.reason).toContain("No agent named 'x' is reachable.");
});

test("applyNotice settles the record and says why when the message was not passed on", () => {
	expect(applyNotice(record(), "held")).toMatchObject({ status: "held" });
	const refused = applyNotice(record(), "refused");
	expect(refused.status).toBe("not-passed-on");
	expect(refused.reason).toBeTruthy();
	expect(applyNotice(record({ status: "expired" }), "held")).toMatchObject({ status: "expired" });
});

test("statusLine reads as passed on, never received, and cannot re-trigger the notice hook", () => {
	const lines = [
		statusLine(record(), false),
		statusLine(record({ status: "held" }), false),
		statusLine(record({ status: "expired" }), false),
		statusLine(applyNotice(record(), "refused"), false),
		statusLine(
			applySendResult(record(), {
				isDelivered: false,
				reason:
					"this session has no SendMessage tool (messaging between sessions and agents is not on here)",
			}),
			false,
		),
	];
	for (const line of lines) {
		expect(line).toContain("probe-s01-hold");
		expect(line).not.toContain("\n");
		expect(line.startsWith("Cross-session message ")).toBe(false);
		expect(line.toLowerCase()).not.toContain("received");
		expect(parseDeliveryNotice(line)).toBeNull();
	}
	expect(lines[0]).toContain("passed on");
	expect(lines[1]).toContain("held");
	expect(lines[2]).toContain("expired");
	expect(lines[3]).toContain("not passed on");
	expect(lines[4]).toContain("SendMessage");
});

test("statusLine keeps only the first line of a multi-line platform reason", () => {
	const line = statusLine(
		applySendResult(record(), {
			isDelivered: false,
			reason:
				"2 agents are named 'x'. Re-send with the ref of the one you mean:\n  x [e417c4] — idle",
		}),
		false,
	);
	expect(line).toContain("2 agents are named 'x'");
	expect(line).not.toContain("e417c4");
	expect(line).not.toContain("\n");
});

test("statusLine warns when the notice could belong to another session of the same name", () => {
	expect(statusLine(record({ status: "held" }), true)).not.toBe(
		statusLine(record({ status: "held" }), false),
	);
});
