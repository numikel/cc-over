import { expect, test } from "claude-code/testing";
import {
	applyAck,
	applyNotice,
	applySendResult,
	clockTime,
	INTENT_MAX,
	matchNotice,
	NO_NEWS_MS,
	nextStatus,
	parseDeliveryNotice,
	type SendRecord,
	statusLine,
	truncateIntent,
} from "../hooks/notice.js";
import { deniedText, droppedText, heldText, pluralText, releasedText } from "./support.js";

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
	intent: "hand off the review",
	updatedAt: NOW - MINUTE,
	ownerSessionId: "sender-session",
	...over,
});

// One named recipient, singular wording: the shape of the notices measured on 2.1.302.
const one = (kind: string, name: string) => ({
	kind,
	count: 1,
	recipients: [{ name, isAddressed: false }],
	isTruncated: false,
});

const to = (name: string) => ({ name, isAddressed: false });

test("parseDeliveryNotice recognises the four platform notices", () => {
	expect(parseDeliveryNotice(HELD)).toEqual(one("held", "probe-s01-hold"));
	expect(parseDeliveryNotice(REFUSED)).toEqual(one("refused", "probe-s01-refuse"));
	expect(parseDeliveryNotice(EXPIRED)).toEqual(one("expired", "probe-s01-hold"));
	expect(parseDeliveryNotice(DROPPED)).toEqual(one("dropped", "probe-s01-accept"));
});

test("parseDeliveryNotice recognises released and denied, which the platform sends once a held message is decided", () => {
	expect(parseDeliveryNotice(releasedText("probe-s01-hold"))).toEqual(
		one("released", "probe-s01-hold"),
	);
	expect(parseDeliveryNotice(deniedText("probe-s01-hold"))).toEqual(
		one("denied", "probe-s01-hold"),
	);
	// The dropped line in the platform's own wording, built by the shared helper.
	expect(parseDeliveryNotice(droppedText("probe-s01-accept"))).toEqual(
		one("dropped", "probe-s01-accept"),
	);
});

test("parseDeliveryNotice reads the batched wording of every kind: count from messages (N), names from recipients", () => {
	for (const kind of ["held", "released", "denied", "expired", "refused", "dropped"] as const) {
		expect(parseDeliveryNotice(pluralText(kind, ["alpha", "beta"], 3))).toEqual({
			kind,
			count: 3,
			recipients: [to("alpha"), to("beta")],
			isTruncated: false,
		});
	}
	// One name behind a plural count: the platform writes `recipient:` but the count stays N.
	expect(parseDeliveryNotice(pluralText("held", ["alpha"], 2))).toEqual({
		kind: "held",
		count: 2,
		recipients: [to("alpha")],
		isTruncated: false,
	});
});

test("parseDeliveryNotice marks a recipient the platform wrote as `@name at uds:…`", () => {
	const text =
		"Cross-session messages (2) held by the receiving session (recipients: @impl at uds:\\\\.\\pipe\\claude-a, @impl at uds:\\\\.\\pipe\\claude-b). Claude in that session hasn't seen it.";
	expect(parseDeliveryNotice(text)).toEqual({
		kind: "held",
		count: 2,
		recipients: [
			{ name: "impl", isAddressed: true },
			{ name: "impl", isAddressed: true },
		],
		isTruncated: false,
	});
	// Only the shared handle is marked; the other recipient of the batch stays plain.
	const mixed =
		"Cross-session messages (3) denied (recipients: @impl at uds:/tmp/a.sock, @review, @impl at uds:/tmp/b.sock). The recipient's user declined it.";
	expect(parseDeliveryNotice(mixed)?.recipients).toEqual([
		{ name: "impl", isAddressed: true },
		to("review"),
		{ name: "impl", isAddressed: true },
	]);
});

test("parseDeliveryNotice skips a bare address and flags a list the platform cut after three names", () => {
	const bare =
		"Cross-session messages (2) expired without approval (recipients: uds:/tmp/a.sock, @review). It was never approved.";
	expect(parseDeliveryNotice(bare)?.recipients).toEqual([to("review")]);

	const cut = parseDeliveryNotice(pluralText("held", ["a", "b", "c", "d", "e"]));
	expect(cut).toMatchObject({
		count: 5,
		recipients: [to("a"), to("b"), to("c")],
		isTruncated: true,
	});

	// Nothing to attach a status to: a bare address alone, an empty list, or no parenthesis at all.
	for (const text of [
		"Cross-session message refused (recipient: uds:/tmp/a.sock). That session is not accepting cross-session messages.",
		"Cross-session message refused (recipients: …). That session is not accepting cross-session messages.",
		"Cross-session message refused. That session is not accepting cross-session messages.",
		"Cross-session messages (2) were dropped at the recipient session's inbox and not delivered. Claude was told not to resend right away.",
	]) {
		expect(parseDeliveryNotice(text)).toBeNull();
	}
});

test("parseDeliveryNotice ignores the explanation after the first sentence and unknown verbs", () => {
	// A future wording of the explanation, even one that quotes another notice, changes nothing.
	const quoted = `Cross-session message denied (recipient: @alpha). Later: ${heldText("beta")}`;
	expect(parseDeliveryNotice(quoted)).toEqual(one("denied", "alpha"));
	for (const text of [
		"Cross-session message postponed (recipient: @alpha). Soon.",
		"Cross-session messages (x) held by the receiving session (recipients: @alpha, @beta).",
		"Cross-session messages held by the receiving session (recipients: @alpha, @beta).",
		"Cross-session message were dropped at the recipient session's inbox (recipient: @alpha) and not delivered.",
	]) {
		expect(parseDeliveryNotice(text)).toBeNull();
	}
});

test("parseDeliveryNotice keeps spaces and pipes in the recipient and stops at the closing parenthesis", () => {
	const text =
		"Cross-session message held by the receiving session (recipient: @repo-a | review | feature-y). Claude in that session hasn't seen it. (more)";
	expect(parseDeliveryNotice(text)).toEqual(one("held", "repo-a | review | feature-y"));
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
	const match = matchNotice(sends, "held", to("probe-s01-hold"), NOW);
	expect(match?.isAmbiguous).toBe(false);
	expect(match?.record).toBe(sends[0]);
});

test("matchNotice ignores sends outside the 30 minute window and recipients the mod never sent to", () => {
	const old = [record({ sentAt: NOW - 31 * MINUTE })];
	expect(matchNotice(old, "held", to("probe-s01-hold"), NOW)).toBeNull();
	expect(matchNotice([record()], "held", to("someone-else"), NOW)).toBeNull();
	expect(matchNotice([], "held", to("probe-s01-hold"), NOW)).toBeNull();
});

test("matchNotice skips sends that are already settled", () => {
	const sends = [record({ status: "expired" }), record({ status: "not-passed-on" })];
	expect(matchNotice(sends, "held", to("probe-s01-hold"), NOW)).toBeNull();
});

test("matchNotice keeps a held send as a candidate however long it has waited, but not an old passed-on one", () => {
	const waiting = record({ status: "held", sentAt: NOW - 3 * 60 * MINUTE });
	expect(matchNotice([waiting], "released", to("probe-s01-hold"), NOW)?.record).toBe(waiting);
	expect(matchNotice([waiting], "held", to("probe-s01-hold"), NOW)?.record).toBe(waiting);
	const stale = record({ sentAt: NOW - 3 * 60 * MINUTE });
	expect(matchNotice([stale], "released", to("probe-s01-hold"), NOW)).toBeNull();
	// The window counts from the send time and includes its end.
	const edge = record({ sentAt: NOW - 30 * MINUTE });
	expect(matchNotice([edge], "held", to("probe-s01-hold"), NOW)?.record).toBe(edge);
});

test("matchNotice prefers held sends for a later outcome, even when a passed-on one is newer", () => {
	const held = record({ sendId: "hhhhhhh", status: "held", sentAt: NOW - 20 * MINUTE });
	const fresh = record({ sendId: "fffffff", sentAt: NOW - MINUTE });
	for (const kind of ["released", "denied", "expired"] as const) {
		const match = matchNotice([fresh, held], kind, to("probe-s01-hold"), NOW);
		expect(match?.record).toBe(held);
		// One held candidate: the pick is certain, the newer passed-on send does not muddy it.
		expect(match?.isAmbiguous).toBe(false);
	}
	// A notice that is not a later outcome sees both and takes the newest.
	const any = matchNotice([fresh, held], "held", to("probe-s01-hold"), NOW);
	expect(any?.record).toBe(fresh);
	expect(any?.isAmbiguous).toBe(true);
	// Without a held send the outcome falls back to the passed-on ones.
	expect(matchNotice([fresh], "released", to("probe-s01-hold"), NOW)?.record).toBe(fresh);
});

test("matchNotice is ambiguous among several held sends and when the platform addressed the recipient", () => {
	const older = record({ sendId: "aaaaaaa", status: "held", sentAt: NOW - 50 * MINUTE });
	const newer = record({ sendId: "bbbbbbb", status: "held", sentAt: NOW - 40 * MINUTE });
	const match = matchNotice([older, newer], "denied", to("probe-s01-hold"), NOW);
	expect(match).toEqual({ record: newer, isAmbiguous: true });

	const single = record();
	const addressed = { name: "probe-s01-hold", isAddressed: true };
	expect(matchNotice([single], "held", addressed, NOW)).toEqual({
		record: single,
		isAmbiguous: true,
	});
});

test("matchNotice takes the newest of several candidates and flags the ambiguity", () => {
	const older = record({ sendId: "aaaaaaa", sentAt: NOW - 5 * MINUTE });
	const newer = record({ sendId: "bbbbbbb", sentAt: NOW - MINUTE, status: "held" });
	const match = matchNotice([older, newer], "held", to("probe-s01-hold"), NOW);
	expect(match?.record).toBe(newer);
	expect(match?.isAmbiguous).toBe(true);
});

test("matchNotice with exclude gives two targets of one warning that share a name two different records", () => {
	const older = record({ sendId: "aaaaaaa", sentAt: NOW - 5 * MINUTE });
	const newer = record({ sendId: "bbbbbbb", sentAt: NOW - MINUTE });
	const sends = [older, newer];
	const addressed = { name: "probe-s01-hold", isAddressed: true };
	const taken = new Set<string>();

	const first = matchNotice(sends, "held", addressed, NOW, taken);
	expect(first?.record).toBe(newer);
	taken.add(first?.record.sendId ?? "");

	const second = matchNotice(sends, "held", addressed, NOW, taken);
	expect(second).toEqual({ record: older, isAmbiguous: true });
	taken.add(second?.record.sendId ?? "");

	// Both sends are taken: a third recipient of the same name has nothing left to match.
	expect(matchNotice(sends, "held", addressed, NOW, taken)).toBeNull();
});

test("matchNotice excludes by sendId before it looks for held sends, and an empty set changes nothing", () => {
	const held = record({ sendId: "hhhhhhh", status: "held", sentAt: NOW - 20 * MINUTE });
	const fresh = record({ sendId: "fffffff", sentAt: NOW - MINUTE });
	// The held send is excluded, so the outcome falls back to the passed-on one.
	const skipped = matchNotice(
		[held, fresh],
		"released",
		to("probe-s01-hold"),
		NOW,
		new Set(["hhhhhhh"]),
	);
	expect(skipped).toEqual({ record: fresh, isAmbiguous: false });
	// An id of another recipient's record excludes nothing here.
	const unrelated = matchNotice(
		[held, fresh],
		"released",
		to("probe-s01-hold"),
		NOW,
		new Set(["zzzzzzz"]),
	);
	expect(unrelated?.record).toBe(held);
	// An empty set and no set behave alike.
	expect(matchNotice([held, fresh], "held", to("probe-s01-hold"), NOW, new Set())).toEqual(
		matchNotice([held, fresh], "held", to("probe-s01-hold"), NOW),
	);
});

const ALL_KINDS = ["held", "released", "denied", "expired", "refused", "dropped"] as const;

test("nextStatus moves an open send by the notice kind, from passed-on and from held alike", () => {
	const expected = {
		held: "held",
		released: "released",
		denied: "not-passed-on",
		expired: "expired",
		refused: "not-passed-on",
		dropped: "not-passed-on",
	} as const;
	for (const status of ["passed-on", "held"] as const) {
		for (const kind of ALL_KINDS) {
			expect(nextStatus(status, kind)).toBe(expected[kind]);
		}
	}
});

test("settled statuses absorb every later notice, so a late held cannot reopen them", () => {
	for (const status of ["released", "expired", "not-passed-on", "refused", "received"] as const) {
		for (const kind of ALL_KINDS) {
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

test("applyNotice gives every not-passed-on kind its own reason", () => {
	const reasons = new Set<string | undefined>();
	for (const kind of ["denied", "refused", "dropped"] as const) {
		const settled = applyNotice(record({ status: "held" }), kind, NOW);
		expect(settled).toMatchObject({ status: "not-passed-on", updatedAt: NOW });
		reasons.add(settled.reason);
	}
	expect(applyNotice(record({ status: "held" }), "denied", NOW).reason).toBe(
		"the recipient's user declined it",
	);
	expect(reasons.size).toBe(3);
	expect(reasons.has("")).toBe(false);
});

test("applyNotice releases a held send, and a settled send ignores the release", () => {
	const released = applyNotice(record({ status: "held" }), "released", NOW);
	expect(released).toEqual({ ...record({ status: "held" }), status: "released", updatedAt: NOW });
	const expired = record({ status: "expired" });
	expect(applyNotice(expired, "released", NOW)).toBe(expired);
});

test("applyNotice settles the record and says why when the message was not passed on", () => {
	expect(applyNotice(record(), "held", NOW)).toMatchObject({ status: "held" });
	const refused = applyNotice(record(), "refused", NOW);
	expect(refused.status).toBe("not-passed-on");
	expect(refused.reason).toBeTruthy();
	expect(applyNotice(record({ status: "expired" }), "held", NOW)).toMatchObject({
		status: "expired",
	});
});

test("statusLine reads as passed on, never received, and cannot re-trigger the notice hook", () => {
	const lines = [
		statusLine(record(), false),
		statusLine(record({ status: "held" }), false),
		statusLine(record({ status: "expired" }), false),
		statusLine(applyNotice(record(), "refused", NOW), false),
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

const OTHER_STATUSES = ["passed-on", "held", "refused", "expired", "not-passed-on"] as const;

test("applyAck marks the send received from any status and drops an earlier reason", () => {
	for (const status of OTHER_STATUSES) {
		const before = record({ status, reason: status === "not-passed-on" ? "no luck" : undefined });
		const after = applyAck(before, NOW);
		expect(after.status).toBe("received");
		expect(after.reason).toBeUndefined();
		expect(after).toMatchObject({ bundleId: before.bundleId, sendId: before.sendId });
	}
});

test("applyAck leaves an already received send untouched, so a second ack changes nothing", () => {
	const received = applyAck(record(), NOW);
	expect(applyAck(received, NOW)).toBe(received);
});

// The store key and the --status report depend on these fields, so no step may drop them.
test("every status change keeps the intent and the owner session and stamps the time of the change", () => {
	const before = record({ updatedAt: NOW - 9 * MINUTE });
	const kept = { intent: before.intent, ownerSessionId: before.ownerSessionId };

	expect(applyNotice(before, "held", NOW)).toEqual({ ...before, status: "held", updatedAt: NOW });
	expect(applyNotice(before, "refused", NOW)).toMatchObject({ ...kept, updatedAt: NOW });
	expect(applyAck(before, NOW)).toEqual({ ...before, status: "received", updatedAt: NOW });
	expect(applySendResult(before, { isDelivered: true })).toEqual(before);
	expect(applySendResult(before, { isDelivered: false, reason: "gone" })).toMatchObject({
		...kept,
		updatedAt: before.updatedAt,
		reason: "gone",
	});
});

test("a notice that changes nothing keeps the old time of the change", () => {
	const settled = record({ status: "expired", updatedAt: NOW - 9 * MINUTE });
	expect(applyNotice(settled, "held", NOW)).toBe(settled);
});

test("truncateIntent keeps a short intent and cuts a long one to INTENT_MAX with an ellipsis", () => {
	expect(INTENT_MAX).toBe(60);
	expect(truncateIntent("  przekaż review  ")).toBe("przekaż review");
	const exact = "ż".repeat(INTENT_MAX);
	expect(truncateIntent(exact)).toBe(exact);
	const long = "ł".repeat(INTENT_MAX + 5);
	expect(truncateIntent(long)).toBe(`${"ł".repeat(INTENT_MAX - 1)}…`);
	// A cut that lands on a space leaves no trailing space before the ellipsis.
	expect(truncateIntent(`${"a".repeat(58)} ${"b".repeat(10)}`)).toBe(`${"a".repeat(58)}…`);
	expect(truncateIntent("line one\nline two")).toBe("line one line two");
});

// Local wall-clock time, so the assertion is built from local getters and holds in any zone.
test("clockTime shows the local hour and minute, both zero-padded", () => {
	const at = new Date(2026, 9, 25, 7, 5, 59).getTime();
	expect(clockTime(at)).toBe("07:05");
	expect(clockTime(new Date(2026, 9, 25, 23, 0).getTime())).toBe("23:00");
});

test("received is final: later platform notices neither move it nor match it", () => {
	for (const kind of ["held", "refused", "expired", "dropped"] as const) {
		expect(nextStatus("received", kind)).toBe("received");
		expect(applyNotice(record({ status: "received" }), kind, NOW).status).toBe("received");
	}
	const sends = [record({ status: "received" })];
	expect(matchNotice(sends, "held", to("probe-s01-hold"), NOW)).toBeNull();
});

test("statusLine says received only for an acknowledged send", () => {
	const line = statusLine(applyAck(record({ target: "impl" }), NOW), false);
	expect(line).toBe("received by impl (acknowledged)");
	expect(line.startsWith("Cross-session message ")).toBe(false);
	expect(parseDeliveryNotice(line)).toBeNull();
	expect(statusLine(applyAck(record(), NOW), true)).toContain("several sessions share this name");
	for (const status of OTHER_STATUSES) {
		expect(statusLine(record({ status }), false).toLowerCase()).not.toContain("received");
	}
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

test("statusLine says a released send was approved by the recipient and is queued, not received", () => {
	const line = statusLine(record({ status: "released" }), false);
	expect(line).toBe("passed on to probe-s01-hold (approved by the recipient, queued)");
	expect(line.toLowerCase()).not.toContain("received");
});

test("statusLine adds the no-news note to a held send only after NO_NEWS_MS, built from the local clock", () => {
	expect(NO_NEWS_MS).toBe(10 * MINUTE);
	const held = record({ status: "held", updatedAt: NOW - 40 * MINUTE });
	const base = statusLine(held, false);
	const note = ` (no news since ${clockTime(held.updatedAt)}; a later outcome may not reach this session)`;
	// Without a clock, inside the limit, and exactly at it: the plain line.
	expect(statusLine(held, false, undefined)).toBe(base);
	expect(statusLine(held, false, held.updatedAt + NO_NEWS_MS)).toBe(base);
	expect(statusLine(held, false, held.updatedAt + NO_NEWS_MS + 1)).toBe(`${base}${note}`);
	// Other statuses never get the note, however old.
	for (const status of ["passed-on", "released", "expired", "refused", "received"] as const) {
		expect(statusLine(record({ status, updatedAt: 0 }), false, NOW)).not.toContain("no news");
	}
});

test("statusLine puts the no-news note before the ambiguity note", () => {
	const held = record({ status: "held", updatedAt: NOW - 40 * MINUTE });
	const line = statusLine(held, true, NOW);
	expect(line.indexOf("no news since")).toBeGreaterThan(line.indexOf("held:"));
	expect(line.indexOf("several sessions share this name")).toBeGreaterThan(
		line.indexOf("no news since"),
	);
});

// 2.2: the mod writes its status lines into the conversation, so neither the notice hook nor a
// reader may take a status line for a platform warning.
test("no statusLine variant starts with Cross-session or parses as a platform notice", () => {
	const statuses = [
		"passed-on",
		"held",
		"released",
		"refused",
		"expired",
		"not-passed-on",
		"received",
	] as const;
	const lines: string[] = [];
	for (const status of statuses) {
		const base = record({ status, reason: status === "not-passed-on" ? "gone" : undefined });
		for (const isAmbiguous of [false, true]) {
			for (const now of [undefined, NOW, NOW + 24 * 60 * MINUTE]) {
				lines.push(statusLine(base, isAmbiguous, now));
			}
		}
	}
	for (const kind of ["denied", "refused", "dropped"] as const) {
		lines.push(statusLine(applyNotice(record({ status: "held" }), kind, NOW), false, NOW));
	}
	expect(lines.some((line) => line.includes("no news since"))).toBe(true);
	for (const line of lines) {
		expect(line.startsWith("Cross-session")).toBe(false);
		expect(parseDeliveryNotice(line)).toBeNull();
		expect(line).not.toContain("\n");
		if (!line.startsWith("received by")) expect(line.toLowerCase()).not.toContain("received");
	}
});

test("statusLine warns when the notice could belong to another session of the same name", () => {
	expect(statusLine(record({ status: "held" }), true)).not.toBe(
		statusLine(record({ status: "held" }), false),
	);
});
