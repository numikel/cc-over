import { expect, test } from "claude-code/testing";
import { ackMessage, matchAck, parseAck } from "../hooks/ack.js";
import type { SendRecord } from "../hooks/notice.js";

const BUNDLE = "ovr-mve4av3q-xngn";
const SEND = "146c6fb";

// Envelope copied verbatim from the live measurement (sender.jsonl of the LP2 batch,
// research.md Key Discoveries): the text the platform hands to `session.receive`.
const ENVELOPE = String.raw`<cross-session-message from="uds:\\.\pipe\LOCAL\cc-msg-2f9c1a7e" from-name="probe-s02-h1commit-a-i1" from-mode="prompting">
over-ack ovr-mve4av3q-xngn 146c6fb
</cross-session-message>`;

const record = (over: Partial<SendRecord> = {}): SendRecord => ({
	bundleId: BUNDLE,
	sendId: SEND,
	target: "impl",
	sentAt: 1_792_274_900_000,
	status: "passed-on",
	intent: "hand off the review",
	updatedAt: 1_792_274_900_000,
	ownerSessionId: "sender-session",
	...over,
});

test("ackMessage builds the line the recipient is told to send back", () => {
	expect(ackMessage(BUNDLE, SEND)).toBe(`over-ack ${BUNDLE} ${SEND}`);
});

test("parseAck reads an exact acknowledgement out of the platform envelope", () => {
	expect(parseAck(ENVELOPE)).toEqual({
		bundleId: BUNDLE,
		sendId: SEND,
		fromName: "probe-s02-h1commit-a-i1",
		extra: "",
	});
});

test("parseAck keeps what the recipient added after the identifiers", () => {
	const text = `<cross-session-message from="uds:x" from-name="impl">\nover-ack ${BUNDLE} ${SEND} not done here. Commits in this session need the local user's own instruction.\n</cross-session-message>`;
	expect(parseAck(text)).toEqual({
		bundleId: BUNDLE,
		sendId: SEND,
		fromName: "impl",
		extra: "not done here. Commits in this session need the local user's own instruction.",
	});
});

test("parseAck accepts a bare line and envelope attributes in any order", () => {
	expect(parseAck(`  over-ack ${BUNDLE} ${SEND}\n`)).toEqual({
		bundleId: BUNDLE,
		sendId: SEND,
		extra: "",
	});
	const reordered = `<cross-session-message from-mode="prompting" from-name="impl" from="uds:x">\nover-ack ${BUNDLE} ${SEND}\n</cross-session-message>`;
	expect(parseAck(reordered)?.fromName).toBe("impl");
});

test("parseAck lower-cases identifiers a model typed in capitals", () => {
	expect(parseAck("over-ack OVR-MVE4AV3Q-XNGN 146C6FB")).toEqual({
		bundleId: BUNDLE,
		sendId: SEND,
		extra: "",
	});
});

test("parseAck ignores everything that is not an acknowledgement of a bundle", () => {
	for (const text of [
		"",
		"Done. I edited README.md.",
		"over-ack",
		"over-ack foo bar",
		`over-ack ${BUNDLE}`,
		`over-ack ${BUNDLE} 146c6f`,
		`over-ack ${BUNDLE} 146c6fbx`,
		`over-ack ovr-mve4av3q ${SEND}`,
		`I will reply over-ack ${BUNDLE} ${SEND} when I am done`,
		`<cross-session-message from="uds:x">\nthanks, over-ack ${BUNDLE} ${SEND}\n</cross-session-message>`,
	]) {
		expect(parseAck(text)).toBeNull();
	}
});

test("matchAck needs both identifiers: the send id alone differs per send", () => {
	const mine = record();
	const resend = record({ sendId: "abcdef0" });
	const other = record({ bundleId: "ovr-zzzzzz-0001" });
	const ack = parseAck(ENVELOPE);
	if (!ack) throw new Error("fixture must parse");
	expect(matchAck([other, resend, mine], ack)).toBe(mine);
	expect(matchAck([other, resend], ack)).toBeUndefined();
	expect(matchAck([], ack)).toBeUndefined();
});
