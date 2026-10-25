// S-01 phase 3: the `/over` pane. It opens before the bundle exists, lists the local sessions at
// once, and sends only what the user picked and confirmed. A mounted pane costs the kit about a
// second and a half, so each test mounts once and walks through several states.

import { type Engine, expect, test } from "claude-code/testing";
import {
	entry,
	gate,
	heldText,
	mountPane,
	NOW,
	noticeRow,
	over,
	ROOT,
	ROWS,
	type Seen,
	START,
	stored,
	world,
} from "./support.js";

// impl runs in the main checkout of the repo, repo-a | review in a worktree of the same repo.
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

async function markdown(pane: Pane, text: string | RegExp): Promise<boolean> {
	return (await pane.find({ type: "Markdown", text })) !== undefined;
}

test("the pane opens at once with the sessions, then shows the bundle, and `send` sends exactly once", async ($, on) => {
	const fork = gate();
	const seen = world(on, ["terminal"], { forkGate: fork.promise, entries: HERE });
	await $.session.start(START);

	expect(await over($, "hand over")).toEqual({});
	expect(seen.opened).toEqual([
		{ id: "over", title: "Hand-off", focus: true, closeOnEscape: true },
	]);
	expect(seen.logs).toEqual([]);

	const pane = await mountPane($);
	// Composing: the local sessions are already there, the bundle and the send button are not.
	expect(await shown(pane, /Composing the bundle/)).toBe(true);
	expect(await keys(pane)).toEqual([
		"type",
		"group:this",
		"target:c03940",
		"target:9f271c",
		"group:other",
		"refresh",
		"cancel",
	]);
	expect(
		await shown(pane, /Some sessions are not listed \(see README\)\. hidden: 1 \(not local\)/),
	).toBe(true);

	fork.release();
	await seen.clock.settle();
	await pane.redraw();
	expect(await markdown(pane, /Review done, two findings\./)).toBe(true);
	expect(await keys(pane)).toEqual([
		"type",
		"expand",
		"group:this",
		"target:c03940",
		"target:9f271c",
		"group:other",
		"refresh",
		"cancel",
	]);

	// A button with a hotkey names it on its label: `Label (key)`; the first nine rows get 1-9.
	// The worktree session shows `<worktree> (<branch>)`, the main checkout just its branch.
	const label = async (key: string) => (await pane.find({ key }))?.props.label;
	expect(await label("expand")).toBe("Show all (e)");
	expect(await label("group:this")).toBe("▼ This project: proj (t)");
	expect(await label("group:other")).toBe("▶ Other sessions: 0 (o)");
	expect(await label("target:c03940")).toBe("├─ ○ impl · main · idle · 5s ago (1)");
	expect(await label("target:9f271c")).toBe(
		"└─ ○ repo-a | review · wt-foo (feat/foo) · busy · 2m ago (2)",
	);
	expect(await label("refresh")).toBe("Refresh list (r)");
	expect(await label("cancel")).toBe("Cancel");

	// Nothing is sent until a session is picked.
	await pane.press({ key: "target:c03940" });
	expect(await label("target:c03940")).toBe("├─ ● impl · main · idle · 5s ago (1)");
	expect((await pane.find({ key: "send" }))?.props.label).toBe("Send to impl (s)");
	expect(seen.sent).toEqual([]);

	await pane.press({ key: "expand" });
	expect(await markdown(pane, /## Instructions/)).toBe(true);
	expect((await pane.find({ key: "expand" }))?.props.label).toBe("Collapse (e)");

	await Promise.all([pane.press({ key: "send" }), pane.press({ key: "send" })]);
	expect(seen.sent).toHaveLength(1);
	expect(seen.sent[0]?.to).toBe("impl");
	expect(seen.sent[0]?.text).toContain("Approved by the user");
	const sentText = seen.sent[0]?.text ?? "";
	const sendId = /^Send: (\S+)$/m.exec(sentText)?.[1];
	expect(sendId).toMatch(/^[0-9a-f]{7}$/);
	expect(sentText).toMatch(new RegExp(`\`message\` set to \`over-ack ovr-\\S+ ${sendId}\``));
	expect(await shown(pane, /passed on to impl \(queued\)/)).toBe(true);
	expect(seen.toasts).toEqual(["passed on to impl (queued)"]);
	// Sent: the sessions and the send button are gone, the preview stays, and the pane can close.
	expect(await keys(pane)).toEqual(["expand", "close"]);

	// The platform later says the message is held: the pane's status line follows.
	await $.session.append(noticeRow(heldText("impl")));
	expect(await shown(pane, /held: impl/)).toBe(true);
	expect(await shown(pane, /passed on to impl \(queued\)/)).toBe(false);

	// A second target of the same bundle through --send: the pane lists every send, one per row.
	await over($, "--send repo-a | review");
	expect(await shown(pane, /held: impl/)).toBe(true);
	expect(await shown(pane, /passed on to repo-a \| review \(queued\)/)).toBe(true);

	await pane.press({ key: "close" });
	expect(seen.closed).toEqual(["over"]);
	await pane.unmount();
});

test("a session that closed before `send` is not sent to, and the list shows it gone", async ($, on) => {
	// Lists: session.start, the pane's, then the one `send` takes.
	const seen = world(on, ["terminal"], {
		entries: HERE,
		rowsAfterFirst: ROWS.filter((row) => row.name !== "impl"),
		listsBeforeChange: 2,
	});
	await $.session.start(START);
	await over($, "hand over");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	await pane.press({ key: "target:c03940" });
	await pane.press({ key: "send" });

	expect(seen.sent).toEqual([]);
	expect(await shown(pane, /impl is no longer on the session list/)).toBe(true);
	expect(await keys(pane)).not.toContain("target:c03940");
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
	const seen = world(on, ["terminal"], { entries: HERE });
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
	await pane.press({ key: "target:c03940" });
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
	// Lists: session.start, the pane's, then the refresh.
	const seen = world(on, ["terminal"], {
		entries: HERE,
		rowsAfterFirst: ROWS.filter((row) => row.name !== "impl"),
		listsBeforeChange: 2,
	});
	await $.session.start(START);
	await over($, "hand over");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();
	await pane.press({ key: "target:c03940" });
	expect(await keys(pane)).toContain("send");

	await pane.press({ key: "refresh" });
	expect(await keys(pane)).not.toContain("target:c03940");
	expect(await keys(pane)).not.toContain("send");
	expect(seen.sent).toEqual([]);
	await pane.unmount();
});

// ---- the grouped list ----

// A third interactive session (no line in the listing), and an entry for it in another repo.
const OTHER_ROWS = [
	...ROWS,
	{ name: "lib-dev", ref: "d4d4d4", type: "interactive", status: "idle" },
];
const ELSEWHERE = stored(
	entry({
		sessionId: "impl-id",
		ref: "c03940",
		repoRoot: ROOT,
		branch: "main",
		lastActivityAt: NOW,
	}),
	entry({
		sessionId: "lib-id",
		ref: "d4d4d4",
		root: "/lib",
		repoRoot: "/lib",
		branch: "dev",
		lastActivityAt: NOW - 3_600_000,
	}),
);

test("'Other sessions' starts collapsed; `o` and `t` fold the groups, digits follow the rows drawn and a pick survives the fold", async ($, on) => {
	const seen = world(on, ["terminal"], { rows: OTHER_ROWS, entries: ELSEWHERE });
	await $.session.start(START);
	await over($, "hand over");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();
	const label = async (key: string) => (await pane.find({ key }))?.props.label;

	// Other is folded: only this project's row is drawn. The review session has no entry (no mod
	// there), lib-dev lives in another repo; both are behind `o`.
	expect(await keys(pane)).toEqual([
		"type",
		"expand",
		"group:this",
		"target:c03940",
		"group:other",
		"refresh",
		"cancel",
	]);
	expect(await label("group:other")).toBe("▶ Other sessions: 2 (o)");

	await pane.press({ key: "group:other" });
	expect(await keys(pane)).toEqual([
		"type",
		"expand",
		"group:this",
		"target:c03940",
		"group:other",
		"target:d4d4d4",
		"target:9f271c",
		"refresh",
		"cancel",
	]);
	expect(await label("group:other")).toBe("▼ Other sessions: 2 (o)");
	expect(await label("target:d4d4d4")).toBe("└─ ○ lib-dev · dev · idle · 1h ago (2)");
	expect(await label("target:9f271c")).toBe("└─ ○ repo-a | review · busy · started 2h ago (3)");
	expect(await shown(pane, "lib")).toBe(true);
	expect(await shown(pane, "no details (mod not running there)")).toBe(true);

	// Pick a session of Other, then fold both groups: the pick and its send button stay.
	await pane.press({ key: "target:9f271c" });
	await pane.press({ key: "group:other" });
	await pane.press({ key: "group:this" });
	expect(await keys(pane)).toEqual([
		"type",
		"expand",
		"group:this",
		"group:other",
		"refresh",
		"send",
		"cancel",
	]);
	expect(await label("group:this")).toBe("▶ This project: proj (t)");
	expect((await pane.find({ key: "send" }))?.props.label).toBe("Send to repo-a | review (s)");

	// Unfolded again, the digits are counted afresh from the top.
	await pane.press({ key: "group:other" });
	expect(await label("target:d4d4d4")).toBe("└─ ○ lib-dev · dev · idle · 1h ago (1)");
	expect(await label("target:9f271c")).toBe("└─ ● repo-a | review · busy · started 2h ago (2)");
	await pane.unmount();
});

test("an empty 'This project' says so, and the list refreshes every 10 s only while the pane is open", async ($, on) => {
	const seen = world(on, ["terminal"], { entries: {} });
	await $.session.start(START);
	await over($, "hand over");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();
	expect(await shown(pane, "no other session in this project")).toBe(true);

	const listedOpen = seen.listed;
	await seen.clock.advance(10_000);
	expect(seen.listed).toBe(listedOpen + 1);
	await seen.clock.advance(20_000);
	expect(seen.listed).toBe(listedOpen + 3);

	await pane.press({ key: "cancel" });
	const listedClosed = seen.listed;
	await seen.clock.advance(60_000);
	expect(seen.listed).toBe(listedClosed);
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

// ---- broadcast ----

// impl and the worktree session are of this repo (HERE), lib-dev lives in another one, `fresh` is
// of this repo too and only joins the list later.
const FRESH_ROW = { name: "fresh", ref: "f00001", type: "interactive", status: "idle" };
const MIXED_ROWS = [
	...ROWS,
	{ name: "lib-dev", ref: "d4d4d4", type: "interactive", status: "idle" },
];
const MIXED = {
	...HERE,
	...stored(
		entry({
			sessionId: "lib-id",
			ref: "d4d4d4",
			root: "/lib",
			repoRoot: "/lib",
			branch: "dev",
			lastActivityAt: NOW - 3_600_000,
		}),
		entry({
			sessionId: "fresh-id",
			ref: "f00001",
			repoRoot: ROOT,
			branch: "main",
			lastActivityAt: NOW - 1_000,
		}),
	),
};
const TWO_TICKED = "Send to 2 sessions: impl, repo-a | review (s)";

async function labelOf(pane: Pane, key: string): Promise<unknown> {
	return (await pane.find({ key }))?.props.label;
}

// The pane of `/over heads-up` once the list and the fork have come back.
async function readyPane($: Engine, seen: Seen): Promise<Pane> {
	await $.session.start(START);
	await over($, "heads-up: I am migrating the test database");
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();
	return pane;
}

test("`y` on a ready list switches to broadcast: exactly this project's sessions are ticked, the button names them, and nothing is sent", async ($, on) => {
	const seen = world(on, ["terminal"], { rows: MIXED_ROWS, entries: MIXED });
	const pane = await readyPane($, seen);
	expect(await labelOf(pane, "type")).toBe("Type: hand-off (y)");
	expect(await labelOf(pane, "target:c03940")).toContain("○");

	await pane.press({ key: "type" });
	expect(await labelOf(pane, "type")).toBe("Type: broadcast (y)");
	expect(await labelOf(pane, "target:c03940")).toBe("├─ ● impl · main · idle · 5s ago (1)");
	expect(await labelOf(pane, "target:9f271c")).toBe(
		"└─ ● repo-a | review · wt-foo (feat/foo) · busy · 2m ago (2)",
	);
	expect(await labelOf(pane, "send")).toBe(TWO_TICKED);
	// A session of another repo is not ticked: it is behind 'Other sessions', picked by hand only.
	await pane.press({ key: "group:other" });
	expect(await labelOf(pane, "target:d4d4d4")).toContain("○ lib-dev");

	// The pane says what it is: title, heading, and a preview that is only the message.
	expect(seen.opened.at(-1)).toEqual({ id: "over", title: "Broadcast", closeOnEscape: true });
	expect(await shown(pane, "Broadcast: heads-up: I am migrating the test database")).toBe(true);
	expect(
		await shown(pane, /^\[claude-over broadcast ovr-\S+\] · message only · proj · feat\/x$/),
	).toBe(true);
	// `y` only switched the type: it sent nothing and asked the model nothing more.
	expect(seen.sent.length).toBe(0);
	expect(seen.forks).toHaveLength(1);
	await pane.unmount();
});

test("/over --broadcast opens a Broadcast pane that is ready with no fork and has this project's sessions ticked", async ($, on) => {
	const seen = world(on, ["terminal"], { rows: MIXED_ROWS, entries: MIXED });
	await $.session.start(START);
	await over($, "--broadcast heads-up");
	expect(seen.opened).toEqual([
		{ id: "over", title: "Broadcast", focus: true, closeOnEscape: true },
	]);
	const pane = await mountPane($);
	await seen.clock.settle();
	await pane.redraw();

	expect(await labelOf(pane, "type")).toBe("Type: broadcast (y)");
	expect(await labelOf(pane, "send")).toBe(TWO_TICKED);
	expect(await shown(pane, "Broadcast: heads-up")).toBe(true);
	expect(seen.forks).toEqual([]);
	expect(seen.sent.length).toBe(0);
	await pane.unmount();
});

test("a broadcast to 2 sessions sends one message to each, with one bundle id and a send id of its own", async ($, on) => {
	const seen = world(on, ["terminal"], { entries: HERE });
	const pane = await readyPane($, seen);
	await pane.press({ key: "type" });
	await Promise.all([pane.press({ key: "send" }), pane.press({ key: "send" })]);

	expect(seen.sent.map((sent) => sent.to)).toEqual(["impl", "repo-a | review"]);
	const [first, second] = seen.sent.map((sent) => sent.text);
	for (const text of [first, second]) {
		expect(text).toContain("[claude-over broadcast ovr-");
		expect(text).toContain("## Message\nheads-up: I am migrating the test database");
		expect(text).not.toContain("## Summary");
	}
	const sendId = (text: string | undefined) => /^Send: (\S+)$/m.exec(text ?? "")?.[1];
	const bundleId = (text: string | undefined) =>
		/^\[claude-over broadcast (\S+)\]$/m.exec(text ?? "")?.[1];
	expect(sendId(first)).not.toBe(sendId(second));
	expect(bundleId(first)).toMatch(/^ovr-/);
	expect(bundleId(first)).toBe(bundleId(second));
	expect(seen.toasts).toEqual(["broadcast passed on to 2 of 2 sessions"]);
	expect(await shown(pane, "passed on to impl (queued)")).toBe(true);
	expect(await shown(pane, "passed on to repo-a | review (queued)")).toBe(true);
	expect(await keys(pane)).toEqual(["expand", "close"]);
	await pane.unmount();
});

test("a refresh that brings a new session of this repo does not tick it, and the send leaves it out", async ($, on) => {
	// Lists: session.start, the pane's, the refresh and the one the send takes.
	const seen = world(on, ["terminal"], {
		entries: MIXED,
		rowsAfterFirst: [...ROWS, FRESH_ROW],
		listsBeforeChange: 2,
	});
	const pane = await readyPane($, seen);
	await pane.press({ key: "type" });
	expect(await labelOf(pane, "send")).toBe(TWO_TICKED);

	await pane.press({ key: "refresh" });
	expect(await keys(pane)).toContain("target:f00001");
	expect(await labelOf(pane, "target:f00001")).toContain("○ fresh");
	expect(await labelOf(pane, "send")).toBe(TWO_TICKED);

	await pane.press({ key: "send" });
	expect(seen.sent.map((sent) => sent.to)).toEqual(["impl", "repo-a | review"]);
	await pane.unmount();
});

test("a name another session took over before the send is not sent to, and the rest waits for a second look", async ($, on) => {
	// Lists: session.start, the pane's, then the one the send takes: `impl` is another session now.
	const seen = world(on, ["terminal"], {
		entries: HERE,
		rowsAfterFirst: [
			{ name: "impl", ref: "e9e9e9", type: "interactive", status: "idle" },
			...ROWS.slice(1),
		],
		listsBeforeChange: 2,
	});
	const pane = await readyPane($, seen);
	await pane.press({ key: "type" });
	await pane.press({ key: "send" });

	expect(seen.sent.length).toBe(0);
	expect(
		await shown(
			pane,
			"not sent: impl is a different session now, check the selection and send again",
		),
	).toBe(true);
	// The session without a problem stays ticked; the one with it is dropped.
	expect(await labelOf(pane, "send")).toBe("Send to 1 session: repo-a | review (s)");
	await pane.unmount();
});

test("unticking every session removes Send and says to pick at least one", async ($, on) => {
	const seen = world(on, ["terminal"], { entries: HERE });
	const pane = await readyPane($, seen);
	await pane.press({ key: "type" });
	await pane.press({ key: "target:c03940" });
	expect(await labelOf(pane, "send")).toBe("Send to 1 session: repo-a | review (s)");
	await pane.press({ key: "target:9f271c" });

	expect(await keys(pane)).not.toContain("send");
	expect(await shown(pane, "pick at least one session")).toBe(true);
	await pane.press({ key: "target:c03940" });
	expect(await shown(pane, "pick at least one session")).toBe(false);
	expect(await labelOf(pane, "send")).toBe("Send to 1 session: impl (s)");
	expect(seen.sent.length).toBe(0);
	await pane.unmount();
});

test("back to hand-off from 2 ticked sessions empties the choice with a hint, a click clears it, and the saved hand-off needs no second fork", async ($, on) => {
	const seen = world(on, ["terminal"], { entries: HERE });
	const pane = await readyPane($, seen);
	await pane.press({ key: "type" });
	expect(await markdown(pane, /Review done, two findings\./)).toBe(false);

	await pane.press({ key: "type" });
	expect(await labelOf(pane, "type")).toBe("Type: hand-off (y)");
	expect(seen.opened.at(-1)?.title).toBe("Hand-off");
	expect(await labelOf(pane, "target:c03940")).toContain("○");
	expect(await labelOf(pane, "target:9f271c")).toContain("○");
	expect(await keys(pane)).not.toContain("send");
	expect(await shown(pane, "pick one session for a hand-off")).toBe(true);
	expect(await markdown(pane, /Review done, two findings\./)).toBe(true);
	expect(seen.forks).toHaveLength(1);

	await pane.press({ key: "target:c03940" });
	expect(await shown(pane, "pick one session for a hand-off")).toBe(false);
	expect(await labelOf(pane, "send")).toBe("Send to impl (s)");
	// A hand-off takes one session: a second click moves the pick.
	await pane.press({ key: "target:9f271c" });
	expect(await labelOf(pane, "send")).toBe("Send to repo-a | review (s)");
	expect(seen.sent.length).toBe(0);
	await pane.unmount();
});

test("switching to broadcast while the fork runs is ready at once; the late fork result does not replace it and serves the way back", async ($, on) => {
	const fork = gate();
	const seen = world(on, ["terminal"], { forkGate: fork.promise, entries: HERE });
	await $.session.start(START);
	await over($, "heads-up");
	const pane = await mountPane($);
	expect(await shown(pane, /Composing the bundle/)).toBe(true);

	await pane.press({ key: "type" });
	expect(await shown(pane, /Composing the bundle/)).toBe(false);
	expect(await labelOf(pane, "send")).toBe(TWO_TICKED);

	fork.release();
	await seen.clock.settle();
	await pane.redraw();
	expect(await markdown(pane, /Message: heads-up/)).toBe(true);
	expect(await markdown(pane, /Review done/)).toBe(false);
	// `--send` sends what the pane shows: the broadcast, not the hand-off that finished later.
	await over($, "--send impl");
	expect(seen.sent[0]?.text).toContain("[claude-over broadcast");

	await pane.press({ key: "type" });
	expect(await markdown(pane, /Review done, two findings\./)).toBe(true);
	expect(seen.forks).toHaveLength(1);
	await pane.unmount();
});

test("back to hand-off while the first fork still runs starts no second fork; the fork's end fills the pane", async ($, on) => {
	const fork = gate();
	const seen = world(on, ["terminal"], { forkGate: fork.promise, entries: HERE });
	await $.session.start(START);
	await over($, "heads-up");
	const pane = await mountPane($);

	await pane.press({ key: "type" });
	await pane.press({ key: "type" });
	expect(await shown(pane, /Composing the bundle… \(fork\)/)).toBe(true);
	expect(await keys(pane)).not.toContain("send");
	expect(seen.forks).toHaveLength(1);

	fork.release();
	await seen.clock.settle();
	await pane.redraw();
	expect(await markdown(pane, /Review done, two findings\./)).toBe(true);
	expect(await shown(pane, /Composing the bundle/)).toBe(false);
	expect(seen.forks).toHaveLength(1);
	// The two ticks of the broadcast were cleared on the way back.
	expect(await shown(pane, "pick one session for a hand-off")).toBe(true);
	await pane.unmount();
});
