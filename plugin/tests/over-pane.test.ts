// S-01 phase 3: the `/over` pane. It opens before the bundle exists, lists the local sessions at
// once, and sends only what the user picked and confirmed. A mounted pane costs the kit about a
// second and a half, so each test mounts once and walks through several states.

import { expect, test } from "claude-code/testing";
import { gate, heldText, mountPane, noticeRow, over, ROWS, START, world } from "./support.js";

type Pane = Awaited<ReturnType<typeof mountPane>>;

async function keys(pane: Pane): Promise<string[]> {
	return (await pane.findAll({ type: "Button" })).map((button) => String(button.key));
}

async function shown(pane: Pane, text: string | RegExp): Promise<boolean> {
	return (await pane.find({ type: "Text", text })) !== undefined;
}

async function markdown(pane: Pane, text: string | RegExp): Promise<boolean> {
	return (await pane.find({ type: "Markdown", text })) !== undefined;
}

test("the pane opens at once with the sessions, then shows the bundle, and `send` sends exactly once", async ($, on) => {
	const fork = gate();
	const seen = world(on, ["terminal"], { forkGate: fork.promise });
	await $.session.start(START);

	expect(await over($, "hand over")).toEqual({});
	expect(seen.opened).toEqual([
		{ id: "over", title: "Hand-off", focus: true, closeOnEscape: true },
	]);
	expect(seen.logs).toEqual([]);

	const pane = await mountPane($);
	// Composing: the local sessions are already there, the bundle and the send button are not.
	expect(await shown(pane, /Composing the bundle/)).toBe(true);
	expect(await keys(pane)).toEqual(["target:impl", "target:repo-a | review", "refresh", "cancel"]);
	expect(await shown(pane, /hidden: 1/)).toBe(true);

	fork.release();
	await seen.clock.settle();
	await pane.redraw();
	expect(await markdown(pane, /Review done, two findings\./)).toBe(true);
	expect(await keys(pane)).toEqual([
		"expand",
		"target:impl",
		"target:repo-a | review",
		"refresh",
		"cancel",
	]);

	// A button with a hotkey names it on its label: `Label (key)`; the first nine sessions get 1-9.
	const label = async (key: string) => (await pane.find({ key }))?.props.label;
	expect(await label("expand")).toBe("Show all (e)");
	expect(await label("target:impl")).toBe("○ impl · idle (1)");
	expect(await label("target:repo-a | review")).toBe("○ repo-a | review · busy (2)");
	expect(await label("refresh")).toBe("Refresh list (r)");
	expect(await label("cancel")).toBe("Cancel");

	// Nothing is sent until a session is picked.
	await pane.press({ key: "target:impl" });
	expect(await label("target:impl")).toBe("● impl · idle (1)");
	expect((await pane.find({ key: "send" }))?.props.label).toBe("Send to impl (s)");
	expect(seen.sent).toEqual([]);

	await pane.press({ key: "expand" });
	expect(await markdown(pane, /## Instructions/)).toBe(true);
	expect((await pane.find({ key: "expand" }))?.props.label).toBe("Collapse (e)");

	await Promise.all([pane.press({ key: "send" }), pane.press({ key: "send" })]);
	expect(seen.sent).toHaveLength(1);
	expect(seen.sent[0]?.to).toBe("impl");
	expect(seen.sent[0]?.text).toContain("Approved by the user");
	expect(await shown(pane, /passed on to impl \(queued\)/)).toBe(true);
	expect(seen.toasts).toEqual(["passed on to impl (queued)"]);
	// Sent: the sessions and the send button are gone, the preview stays, and the pane can close.
	expect(await keys(pane)).toEqual(["expand", "close"]);

	// The platform later says the message is held: the pane's status line follows.
	await $.session.append(noticeRow(heldText("impl")));
	expect(await shown(pane, /held: impl/)).toBe(true);
	expect(await shown(pane, /passed on to impl \(queued\)/)).toBe(false);

	await pane.press({ key: "close" });
	expect(seen.closed).toEqual(["over"]);
	await pane.unmount();
});

test("a session that closed before `send` is not sent to, and the list shows it gone", async ($, on) => {
	const seen = world(on, ["terminal"], {
		rowsAfterFirst: ROWS.filter((row) => row.name !== "impl"),
	});
	await $.session.start(START);
	await over($, "hand over");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	await pane.press({ key: "target:impl" });
	await pane.press({ key: "send" });

	expect(seen.sent).toEqual([]);
	expect(await shown(pane, /impl is no longer on the session list/)).toBe(true);
	expect(await keys(pane)).not.toContain("target:impl");
	expect(await keys(pane)).not.toContain("send");
	await pane.unmount();
});

test("cancel while the bundle composes closes the pane, sends nothing and leaves nothing to --send", async ($, on) => {
	const fork = gate();
	const seen = world(on, ["terminal"], { forkGate: fork.promise });
	await $.session.start(START);
	await over($, "hand over");
	const pane = await mountPane($);

	await pane.press({ key: "cancel" });
	expect(seen.closed).toEqual(["over"]);

	// The fork answers after the cancel: the cancelled bundle must not become sendable.
	fork.release();
	await seen.clock.settle();
	await over($, "--send impl");
	expect(seen.sent).toEqual([]);
	expect(seen.logs.join("\n")).toContain("compose a bundle first");
	await pane.unmount();
});

// The kit cannot raise a `ui.close` of the person's (and a plugin's own close skips its own
// hook), so Escape is covered by the manual steps; the button path shares the same cleanup.
test("cancel on a bundle that is ready leaves nothing to --send; closing after a send keeps it", async ($, on) => {
	const seen = world(on, ["terminal"]);
	await $.session.start(START);
	await over($, "hand over");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();
	expect(await keys(pane)).toContain("expand");

	await pane.press({ key: "cancel" });
	expect(seen.closed).toEqual(["over"]);
	await over($, "--send impl");
	expect(seen.sent).toEqual([]);
	expect(seen.logs.join("\n")).toContain("compose a bundle first");

	// Sent from the pane, then closed: the bundle stays available for a second target.
	await over($, "hand over again");
	await seen.clock.settle();
	await pane.redraw();
	await pane.press({ key: "target:impl" });
	await pane.press({ key: "send" });
	await pane.press({ key: "close" });
	await over($, "--send repo-a | review");
	expect(seen.sent.map((sent) => sent.to)).toEqual(["impl", "repo-a | review"]);
	await pane.unmount();
});

test("where the pane cannot be placed the command falls back to the log and says why", async ($, on) => {
	const seen = world(on, ["terminal"], { open: { isPlaced: false, reason: "too narrow" } });
	await $.session.start(START);
	await over($, "hand over");
	const log = seen.logs.join("\n");
	expect(log).toContain("too narrow");
	expect(log).toContain("## Summary");
	expect(seen.sent).toEqual([]);
});

test("refresh drops a pick that is no longer on the list, so `send` cannot target it", async ($, on) => {
	const seen = world(on, ["terminal"], {
		rowsAfterFirst: ROWS.filter((row) => row.name !== "impl"),
	});
	await $.session.start(START);
	await over($, "hand over");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();
	await pane.press({ key: "target:impl" });
	expect(await keys(pane)).toContain("send");

	await pane.press({ key: "refresh" });
	expect(await keys(pane)).not.toContain("target:impl");
	expect(await keys(pane)).not.toContain("send");
	expect(seen.sent).toEqual([]);
	await pane.unmount();
});

test("a bundle that failed to compose shows the reason and can only be closed", async ($, on) => {
	const seen = world(on, ["terminal"], { listFails: true });
	await $.session.start(START);
	await over($, "hand over");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();
	expect(await shown(pane, /could not compose the bundle: ListAgents is not available/)).toBe(true);
	expect(await keys(pane)).toEqual(["close"]);
	await pane.unmount();
});
