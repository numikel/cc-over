// S-02 phase 3: the recipient's acknowledgement comes back as a peer message in the sender's
// `session.receive`. The mod matches it to its own send by bundle id + send id, turns the status
// into received and, when the ack is the bare line, takes it so the sender's model runs no turn.
// Every other message passes on untouched.

import { expect, test } from "claude-code/testing";
import { ackMessage } from "../hooks/ack.js";
import { heldText, noticeRow, over, type Seen, START, world } from "./support.js";

const PEER = { kind: "peer" } as const;

// The envelope the platform puts around a peer's message (measured on 2.1.302, research § 5).
const envelope = (body: string, name = "impl") =>
	String.raw`<cross-session-message from="uds:\\.\pipe\LOCAL\cc-msg-1" from-name="${name}" from-mode="prompting">` +
	`\n${body}\n</cross-session-message>`;

// The ids the recipient was asked to echo: read from what the mod actually sent.
function askedAck(seen: Seen, index = 0): string {
	const text = seen.sent[index]?.text ?? "";
	const bundleId = /^\[claude-over hand-off (\S+)\]$/m.exec(text)?.[1] ?? "";
	const sendId = /^Send: (\S+)$/m.exec(text)?.[1] ?? "";
	return ackMessage(bundleId, sendId);
}

test("the bare ack of our own send turns the status into received, says so once, and the model runs no turn", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	expect(seen.toasts).toEqual([]);

	const result = await $.session.receive({ origin: PEER, text: envelope(askedAck(seen)) });

	expect(result.consumed).toEqual(expect.stringContaining("acknowledgement"));
	expect(seen.received).toEqual([]);
	expect(seen.toasts).toEqual(["received by impl (acknowledged)"]);
	expect(seen.logs.at(-1)).toBe("received by impl (acknowledged)");
});

test("an ack with a note turns the status into received and still reaches the sender's model", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	const note = `${askedAck(seen)} not done here. Commits in this session need the local user's own instruction.`;

	const result = await $.session.receive({ origin: PEER, text: envelope(note) });

	expect(result.consumed).toBeUndefined();
	expect(result.text).toBe(envelope(note));
	expect(seen.received).toEqual([envelope(note)]);
	expect(seen.toasts).toEqual(["received by impl (acknowledged)"]);
});

test("an ack for a send this session no longer tracks is taken without a status line", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);

	const result = await $.session.receive({
		origin: PEER,
		text: envelope(ackMessage("ovr-mve4av3q-xngn", "146c6fb")),
	});

	expect(result.consumed).toEqual(expect.stringContaining("ovr-mve4av3q-xngn 146c6fb"));
	expect(seen.received).toEqual([]);
	expect(seen.toasts).toEqual([]);
	expect(seen.logs.join("\n")).toContain("no longer tracks");
});

test("a note on an ack for an untracked send reaches the model, as any other message does", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	const text = envelope(`${ackMessage("ovr-mve4av3q-xngn", "146c6fb")} done, committed`);

	const result = await $.session.receive({ origin: PEER, text });

	expect(result.text).toBe(text);
	expect(seen.received).toEqual([text]);
	expect(seen.toasts).toEqual([]);
});

test("messages that are not a clean ack of one of our sends pass on and leave the send open", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	const [bundleId, sendId] = askedAck(seen).split(" ").slice(1);
	const passing = [
		envelope("I finished the refactor, details below."),
		envelope(`over-ack ${bundleId} nothex7`),
		envelope(`over-ack not-a-bundle ${sendId}`),
		envelope(`please reply with over-ack ${bundleId} ${sendId}`),
		"plain text with no envelope",
	];

	for (const text of passing) {
		const result = await $.session.receive({ origin: PEER, text });
		expect(result.text).toBe(text);
	}

	expect(seen.received).toEqual(passing);
	expect(seen.toasts).toEqual([]);
	// The send is still open: a platform warning still moves it.
	await $.session.append(noticeRow(heldText("impl")));
	expect(seen.toasts).toHaveLength(1);
	expect(seen.toasts[0]).toContain("held: impl");
});

test("a valid ack that is not from a peer, or is for a subagent's loop, is left alone", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	const text = envelope(askedAck(seen));

	const fromCoordinator = await $.session.receive({ origin: { kind: "coordinator" }, text });
	const fromTask = await $.session.receive({ origin: { kind: "task-notification" }, text });
	const forAgent = await $.session.receive({ origin: PEER, text, agentId: "worker-1" });

	for (const result of [fromCoordinator, fromTask, forAgent]) expect(result.text).toBe(text);
	expect(seen.received).toEqual([text, text, text]);
	expect(seen.toasts).toEqual([]);
});

test("a second ack of the same send is taken but raises no second status line", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	const text = envelope(askedAck(seen));

	const first = await $.session.receive({ origin: PEER, text });
	const second = await $.session.receive({ origin: PEER, text });

	expect(first.consumed).toBeDefined();
	expect(second.consumed).toBeDefined();
	expect(seen.toasts).toEqual(["received by impl (acknowledged)"]);
	expect(seen.received).toEqual([]);
});

test("received is final: a platform warning arriving after the ack changes nothing", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await $.session.receive({ origin: PEER, text: envelope(askedAck(seen)) });

	await $.session.append(noticeRow(heldText("impl")));

	expect(seen.toasts).toEqual(["received by impl (acknowledged)"]);
});

test("an ack settles a send that was already reported held", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await $.session.append(noticeRow(heldText("impl")));

	await $.session.receive({ origin: PEER, text: envelope(askedAck(seen)) });

	expect(seen.toasts).toHaveLength(2);
	expect(seen.toasts[0]).toContain("held: impl");
	expect(seen.toasts[1]).toBe("received by impl (acknowledged)");
});

test("a delivery the hook cannot read loses no message: it goes on to the model", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	// A delivery without an origin makes the hook itself throw; the `.catch` must pass it on.
	const text = "a message the hook cannot classify";
	const broken = { text } as unknown as Parameters<typeof $.session.receive>[0];

	const result = await $.session.receive(broken);

	expect(result.consumed).toBeUndefined();
	expect(seen.received).toEqual([text]);
	// The cause is kept, like the notice hook does (`warning tracking failed`).
	expect(seen.logs).toContainEqual(expect.stringContaining("ack tracking failed ("));
});
