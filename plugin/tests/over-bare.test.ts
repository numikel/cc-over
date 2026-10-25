// S-05 phase 2: a bare `/over` opens the pane with an intent field and the live session list.
// The fork does not start before Enter; from Enter on the pane is the one `/over <intent>` draws.
// A mounted pane costs the kit about a second and a half, so each test mounts once.

import { expect, test } from "claude-code/testing";
import { entry, gate, mountPane, NOW, over, ROOT, ROWS, START, stored, world } from "./support.js";

const HERE = stored(
	entry({
		sessionId: "impl-id",
		ref: "c03940",
		repoRoot: ROOT,
		branch: "main",
		lastActivityAt: NOW - 5_000,
	}),
	entry({
		sessionId: "review-id",
		ref: "9f271c",
		root: `${ROOT}/.worktrees/wt-foo`,
		repoRoot: ROOT,
		branch: "feat/foo",
		lastActivityAt: NOW - 120_000,
	}),
);

type Pane = Awaited<ReturnType<typeof mountPane>>;

async function keys(pane: Pane): Promise<string[]> {
	return (await pane.findAll({ type: "Button" })).map((button) => String(button.key));
}

async function shown(pane: Pane, text: string | RegExp): Promise<boolean> {
	return (await pane.find({ type: "Text", text })) !== undefined;
}

test("a bare /over opens the pane with the intent field and the sessions, and starts no fork", async ($, on) => {
	const seen = world(on, ["terminal"], { entries: HERE });
	await $.session.start(START);

	expect(await over($, "")).toEqual({});
	expect(seen.opened).toEqual([
		{ id: "over", title: "Hand-off", focus: true, closeOnEscape: true },
	]);
	expect(seen.logs).toEqual([]);

	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	const field = await pane.find({ key: "intent" });
	expect(field?.props.label).toBe("Intent:");
	expect(field?.props.placeholder).toBe("What should the other session do?");
	expect(field?.props.submitLabel).toBe("compose");
	expect(field?.props.autoFocus).toBe(true);
	expect(await shown(pane, /^Hand-off$/)).toBe(true);
	// Sessions can be picked already; there is no preview and nothing to send.
	expect(await keys(pane)).toEqual([
		"type",
		"group:this",
		"target:c03940",
		"target:9f271c",
		"group:other",
		"refresh",
		"group:history",
		"cancel",
	]);
	expect(seen.listed).toBeGreaterThan(0);
	expect(seen.forks).toEqual([]);
	expect(seen.sent).toEqual([]);
});

test("Enter on an empty or blank field says so and composes nothing; typed text survives a redraw", async ($, on) => {
	const seen = world(on, ["terminal"], { entries: HERE });
	await $.session.start(START);
	await over($, "   ");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	await pane.input({ key: "intent", text: "draft", kind: "change" });
	await pane.redraw();
	expect((await pane.find({ key: "intent" }))?.props.value).toBe("draft");

	await pane.input({ key: "intent", text: "  \t " });
	await pane.redraw();
	expect(await shown(pane, "Type the intent first, then press Enter.")).toBe(true);
	expect((await pane.find({ key: "intent" }))?.props.value).toBe("  \t ");
	expect(seen.forks).toEqual([]);
});

test("Enter with an intent composes through the S-01 path, keeps the picked session, and sends once", async ($, on) => {
	const fork = gate();
	const seen = world(on, ["terminal"], { entries: HERE, forkGate: fork.promise });
	await $.session.start(START);
	await over($, "");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	await pane.press({ key: "target:c03940" });
	await Promise.all([
		pane.input({ key: "intent", text: "  hand over  " }),
		pane.input({ key: "intent", text: "  hand over  " }),
	]);
	await pane.redraw();

	expect(await shown(pane, "Hand-off: hand over")).toBe(true);
	expect(await shown(pane, /Composing the bundle… \(fork\)/)).toBe(true);
	expect(await pane.find({ key: "intent" })).toBeUndefined();
	expect(seen.forks).toHaveLength(1);
	expect(seen.forks[0]).toContain("hand over");

	fork.release();
	await seen.clock.settle();
	await pane.redraw();
	expect(await keys(pane)).toContain("expand");
	expect((await pane.find({ key: "send" }))?.props.label).toBe("Send to impl (s)");

	await Promise.all([pane.press({ key: "send" }), pane.press({ key: "send" })]);
	expect(seen.sent).toHaveLength(1);
	expect(seen.sent[0]?.to).toBe("impl");
});

test("the 'none' compose mode labels the field and Enter composes without the model", async ($, on) => {
	const seen = world(on, ["terminal"], { entries: HERE, compose: "none" });
	await $.session.start(START);
	await over($, "");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	expect((await pane.find({ key: "intent" }))?.props.submitLabel).toBe("compose (no model)");
	await pane.input({ key: "intent", text: "smoke" });
	await seen.clock.settle();
	await pane.redraw();
	expect(seen.forks).toEqual([]);
	await pane.press({ key: "expand" });
	expect(
		await pane.find({ type: "Markdown", text: /no conversation summary: none mode/ }),
	).toBeDefined();
});

test("Refresh list reads the sessions again before the intent exists, and a failed list keeps the field", async ($, on) => {
	const seen = world(on, ["terminal"], { entries: HERE });
	await $.session.start(START);
	await over($, "");
	const pane = await mountPane($);
	await seen.clock.settle();
	const before = seen.listed;

	await pane.press({ key: "refresh" });
	expect(seen.listed).toBe(before + 1);
	expect(await pane.find({ key: "intent" })).toBeDefined();
});

const SESSIONS = {
	...HERE,
	...stored(
		entry({
			sessionId: "fresh-id",
			ref: "f00001",
			repoRoot: ROOT,
			branch: "main",
			lastActivityAt: NOW - 1_000,
		}),
	),
};

test("the type button is there before the intent; confirming the intent as a broadcast composes it with no fork, ticks the project's sessions and sends to each", async ($, on) => {
	const seen = world(on, ["terminal"], { entries: HERE });
	await $.session.start(START);
	await over($, "");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	expect((await pane.find({ key: "type" }))?.props.label).toBe("Type: hand-off (y)");
	await pane.press({ key: "type" });
	expect((await pane.find({ key: "type" }))?.props.label).toBe("Type: broadcast (y)");
	expect(await shown(pane, /^Broadcast$/)).toBe(true);
	expect(seen.opened.at(-1)?.title).toBe("Broadcast");

	await pane.input({ key: "intent", text: "heads-up: I am migrating the test database" });
	await seen.clock.settle();
	await pane.redraw();
	expect(seen.forks).toEqual([]);
	expect(await shown(pane, "Broadcast: heads-up: I am migrating the test database")).toBe(true);
	expect((await pane.find({ key: "send" }))?.props.label).toBe(
		"Send to 2 sessions: impl, repo-a | review (s)",
	);

	await pane.press({ key: "send" });
	expect(seen.sent.map((sent) => sent.to)).toEqual(["impl", "repo-a | review"]);
	expect(seen.sent[0]?.text).toContain("[claude-over broadcast ovr-");
	expect(seen.toasts).toEqual(["broadcast passed on to 2 of 2 sessions"]);
	await pane.unmount();
});

test("`y` before the list came back only sets the type; the rows that arrive are ticked once, and a later refresh does not add a new one", async ($, on) => {
	const list = gate();
	// Lists: session.start, the pane's (held back), then the refresh, which brings `fresh`.
	const seen = world(on, ["terminal"], {
		entries: SESSIONS,
		listGate: { after: 1, promise: list.promise },
		rowsAfterFirst: [
			...ROWS,
			{ name: "fresh", ref: "f00001", type: "interactive", status: "idle" },
		],
		listsBeforeChange: 2,
	});
	await $.session.start(START);
	await over($, "");
	const pane = await mountPane($);
	expect(await keys(pane)).toEqual([
		"type",
		"group:this",
		"group:other",
		"refresh",
		"group:history",
		"cancel",
	]);

	await pane.press({ key: "type" });
	expect((await pane.find({ key: "type" }))?.props.label).toBe("Type: broadcast (y)");

	list.release();
	await seen.clock.settle();
	await pane.redraw();
	const label = async (key: string) => (await pane.find({ key }))?.props.label;
	expect(await label("target:c03940")).toContain("● impl");
	expect(await label("target:9f271c")).toContain("● repo-a | review");

	await pane.press({ key: "refresh" });
	expect(await label("target:f00001")).toContain("○ fresh");
	expect(await label("target:c03940")).toContain("● impl");
	await pane.unmount();
});

test("the command hint and description name both entries", async ($, on) => {
	const seen = world(on, ["terminal"]);
	await $.session.start(START);
	expect(seen.registered[0]?.argumentHint).toBe(
		"[intent] | --list | --send <session> | --send-repo | --status | --history [n] | --no-fork <intent> | --broadcast <intent>",
	);
	expect(seen.registered[0]?.description).toBe(
		"Hand the work over to another local session, or send a short notice to several: bare /over opens the pane to type the intent; /over <intent> previews a bundle; --broadcast <intent>, --list, --send <session>, --send-repo, --status, --history [n], --no-fork",
	);
});

test("an unreadable session list is said in the pane and the field stays", async ($, on) => {
	const seen = world(on, ["terminal"], { listFails: true });
	await $.session.start(START);
	await over($, "");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	expect(await shown(pane, /could not read the session list: /)).toBe(true);
	expect(await pane.find({ key: "intent" })).toBeDefined();
});
