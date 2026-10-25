// S-07 phase 4: the "History (h)" section of the bare `/over` pane. It is folded at first, lists the
// project's sent bundles when opened, opens one entry at a time, and exists only in the `intent`
// phase. A mounted pane costs the kit about a second and a half, so each test mounts once.

import { expect, test } from "claude-code/testing";
import { type HistoryEntry, type HistoryLog, historyKey } from "../hooks/history.js";
import { mountPane, NOW, over, SESSION_ID, START, world } from "./support.js";

const MINUTE = 60_000;

type Pane = Awaited<ReturnType<typeof mountPane>>;

async function keys(pane: Pane): Promise<string[]> {
	return (await pane.findAll({ type: "Button" })).map((button) => String(button.key));
}

async function shown(pane: Pane, text: string | RegExp): Promise<boolean> {
	return (await pane.find({ type: "Text", text })) !== undefined;
}

function entryOf(id: string, intent: string, ageMinutes: number): HistoryEntry {
	const at = NOW - ageMinutes * MINUTE;
	return {
		bundleId: id,
		project: "/proj",
		repo: "proj",
		branch: "main",
		composedAt: at,
		lastSentAt: at,
		intent,
		summary: `Summary of ${intent}.`,
		instructions: `Do ${intent}.`,
		files: ["src/a.ts"],
		filesTotal: 1,
		targets: [
			{ sendId: `send-${id}`, target: "impl", sentAt: at, status: "passed-on", updatedAt: at },
		],
		targetsTotal: 1,
	};
}

const seeded = (...entries: HistoryEntry[]): Record<string, unknown> => ({
	[historyKey("before-clear")]: {
		v: 1,
		sessionId: "before-clear",
		updatedAt: NOW,
		entries,
	} satisfies HistoryLog,
});

test("the bare pane has a folded History section; (h) opens it, a row opens one entry at a time", async ($, on) => {
	const seen = world(on, ["terminal"], {
		entries: seeded(
			entryOf("ovr-a-0001", "review the parser", 3),
			entryOf("ovr-b-0001", "fix the tests", 9),
		),
	});
	await $.session.start(START);
	await over($, "");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();
	const label = async (key: string) => (await pane.find({ key }))?.props.label;

	// Folded: the header only, no rows, and no detail.
	expect(await label("group:history")).toBe("▶ History (2) (h)");
	expect(await keys(pane)).not.toContain("history:ovr-a-0001");
	expect((await pane.find({ key: "group:history" }))?.props.hotkey).toBe("h");

	// The indents drawn: folded there are none, the rows sit one indent under the header.
	const indents = async () =>
		(await pane.findAll({ type: "Box" }))
			.map((box) => Number(box.props.paddingLeft ?? 0))
			.filter(Boolean);
	expect(await indents()).toEqual([]);

	await pane.press({ key: "group:history" });
	expect(await label("group:history")).toBe("▼ History (2) (h)");
	// Each row says it can be opened, like the session groups do: ▶ closed, ▼ open.
	expect(await label("history:ovr-a-0001")).toBe(
		"▶ 3m ago · review the parser · passed on to impl (queued)",
	);
	expect(await label("history:ovr-b-0001")).toBe(
		"▶ 9m ago · fix the tests · passed on to impl (queued)",
	);
	expect((await pane.find({ key: "history:ovr-a-0001" }))?.props.hotkey).toBeUndefined();
	expect(await indents()).toEqual([2]);
	expect(await shown(pane, /^Instructions: Do review the parser\.$/)).toBe(false);

	// A row opens its entry (▼); another row closes the first; the same row again closes it.
	await pane.press({ key: "history:ovr-a-0001" });
	expect(await label("history:ovr-a-0001")).toBe(
		"▼ 3m ago · review the parser · passed on to impl (queued)",
	);
	expect(await shown(pane, /^Instructions: Do review the parser\.$/)).toBe(true);
	expect(await shown(pane, /^Summary: Summary of review the parser\.$/)).toBe(true);
	// The lists are indented under their heading, not drawn flush left (and not as one Markdown).
	expect(await shown(pane, /^Files \(1\):$/)).toBe(true);
	expect(await shown(pane, /^- src\/a\.ts$/)).toBe(true);
	expect(await pane.find({ type: "Markdown" })).toBeUndefined();
	expect((await indents()).length).toBeGreaterThanOrEqual(3);

	await pane.press({ key: "history:ovr-b-0001" });
	expect(await label("history:ovr-a-0001")).toMatch(/^▶ /);
	expect(await label("history:ovr-b-0001")).toMatch(/^▼ /);
	expect(await shown(pane, /^Instructions: Do fix the tests\.$/)).toBe(true);
	expect(await shown(pane, /^Instructions: Do review the parser\.$/)).toBe(false);

	await pane.press({ key: "history:ovr-b-0001" });
	expect(await label("history:ovr-b-0001")).toMatch(/^▶ /);
	expect(await shown(pane, /^Instructions: Do fix the tests\.$/)).toBe(false);
	expect(await indents()).toEqual([2]);

	// Folded again, the rows go and the count stays.
	await pane.press({ key: "group:history" });
	expect(await label("group:history")).toBe("▶ History (2) (h)");
	expect(await keys(pane)).not.toContain("history:ovr-a-0001");
	expect(await indents()).toEqual([]);
	await pane.unmount();
});

test("with no bundle sent the opened section says so", async ($, on) => {
	const seen = world(on, ["terminal"]);
	await $.session.start(START);
	await over($, "");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	expect((await pane.find({ key: "group:history" }))?.props.label).toBe("▶ History (0) (h)");
	await pane.press({ key: "group:history" });
	expect(await shown(pane, "No bundles sent from this project in the last 14 days")).toBe(true);
	await pane.unmount();
});

test("with the switch off the opened section says the history is off", async ($, on) => {
	const seen = world(on, ["terminal"], {
		history: false,
		entries: seeded(entryOf("ovr-a-0001", "review the parser", 3)),
	});
	await $.session.start(START);
	await over($, "");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	await pane.press({ key: "group:history" });
	expect(await shown(pane, "History is off (see /config: cc-over.history)")).toBe(true);
	expect(await keys(pane)).not.toContain("history:ovr-a-0001");
	await pane.unmount();
});

test("an unreadable history is said in red inside the opened section", async ($, on) => {
	const seen = world(on, ["terminal"], {
		historyReadFails: true,
		entries: seeded(entryOf("ovr-a-0001", "review the parser", 3)),
	});
	await $.session.start(START);
	await over($, "");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	await pane.press({ key: "group:history" });
	expect(await shown(pane, /^could not read the history \(.+\)$/)).toBe(true);
	await pane.unmount();
});

test("a pane opened with an intent has no History section", async ($, on) => {
	const seen = world(on, ["terminal"], {
		entries: seeded(entryOf("ovr-a-0001", "review the parser", 3)),
	});
	await $.session.start(START);
	await over($, "hand over");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	expect(await keys(pane)).not.toContain("group:history");
	await pane.unmount();
});

test("Refresh list reads the history again: a bundle sent meanwhile appears", async ($, on) => {
	const seen = world(on, ["terminal"]);
	await $.session.start(START);
	// A composed bundle for `--send` to use; the bare pane that follows replaces this draft.
	await over($, "hand over");
	await seen.clock.settle();
	await over($, "");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();
	expect((await pane.find({ key: "group:history" }))?.props.label).toBe("▶ History (0) (h)");

	await over($, "--send impl");
	await seen.clock.settle();
	expect(seen.store[historyKey(SESSION_ID)]).toBeDefined();
	// Not read on its own: the count moves only when the list is refreshed.
	expect((await pane.find({ key: "group:history" }))?.props.label).toBe("▶ History (0) (h)");

	await pane.press({ key: "refresh" });
	expect((await pane.find({ key: "group:history" }))?.props.label).toBe("▶ History (1) (h)");
	await pane.unmount();
});
