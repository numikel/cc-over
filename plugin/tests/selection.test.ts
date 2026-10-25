import { expect, test } from "claude-code/testing";
import type { Grouped, SessionRow } from "../hooks/groups.js";
import type { RegistryEntry } from "../hooks/registry.js";
import {
	keepListed,
	type Pick,
	pickHint,
	pickOf,
	preselect,
	resolvePicks,
	sendLabel,
	switchKind,
	togglePick,
} from "../hooks/selection.js";
import type { Target } from "../hooks/sessions.js";

const target = (name: string, ref?: string, extra: Partial<Target> = {}): Target => ({
	name,
	...(ref !== undefined ? { ref } : {}),
	type: "interactive",
	address: name,
	isSendable: true,
	...extra,
});

const entry = (sessionId: string): RegistryEntry => ({
	v: 1,
	sessionId,
	root: "/work/claude-over",
	lastActivityAt: 1000,
	updatedAt: 1000,
});

const row = (name: string, withEntry = true): SessionRow => ({
	...target(name, `${name}-ref`),
	...(withEntry ? { entry: entry(`id-${name}`) } : {}),
});

const pick = (name: string): Pick => ({ key: `${name}-ref`, name });
const picks = (...names: string[]): Pick[] => names.map(pick);
const keys = (list: Pick[]) => list.map((p) => p.key);

const grouped = (): Grouped => ({
	thisProject: { label: "claude-over", rows: [row("t2"), row("t1"), row("t3")] },
	other: {
		total: 3,
		repos: [{ label: "alpha", rows: [row("a1")] }],
		noDetails: [row("n1", false), row("n2", false)],
	},
});

const none = { preselected: [] as Pick[], isPreselected: false };

test("pickOf keys a target by its ref, and by its address when the list gave no ref", () => {
	expect(pickOf(target("one", "abc123"))).toEqual({ key: "abc123", name: "one" });
	expect(pickOf(target("two", undefined, { address: "two" }))).toEqual({
		key: "addr:two",
		name: "two",
	});
	expect(pickOf(target("dup", undefined, { address: "dup [x]" }))).toEqual({
		key: "addr:dup [x]",
		name: "dup",
	});
});

test("preselect takes the rows of this project in list order, none of the other group", () => {
	expect(preselect(grouped())).toEqual([
		{ key: "t2-ref", name: "t2" },
		{ key: "t1-ref", name: "t1" },
		{ key: "t3-ref", name: "t3" },
	]);
});

test("preselect of a list without own sessions is empty, however many sit elsewhere", () => {
	const g = grouped();
	g.thisProject.rows = [];
	expect(preselect(g)).toEqual([]);
});

test("togglePick in a hand-off replaces the pick, and a second click on it clears it", () => {
	expect(togglePick([], target("a", "a-ref"), "hand-off").picked).toEqual(picks("a"));
	expect(togglePick(picks("a"), target("b", "b-ref"), "hand-off").picked).toEqual(picks("b"));
	expect(togglePick(picks("a"), target("a", "a-ref"), "hand-off").picked).toEqual([]);
});

test("togglePick in a broadcast adds a session, and removes it when it is already picked", () => {
	const added = togglePick(picks("a"), target("b", "b-ref"), "broadcast").picked;
	expect(added).toEqual(picks("a", "b"));
	const removed = togglePick(added, target("a", "a-ref"), "broadcast").picked;
	expect(removed).toEqual(picks("b"));
	expect(togglePick([], target("c", "c-ref"), "broadcast").picked).toEqual(picks("c"));
});

test("togglePick matches by key, not by name", () => {
	const result = togglePick(picks("a"), target("a", "other-ref"), "broadcast").picked;
	expect(keys(result)).toEqual(["a-ref", "other-ref"]);
});

test("togglePick does not change the array it was given", () => {
	const before = picks("a", "b");
	togglePick(before, target("c", "c-ref"), "broadcast");
	togglePick(before, target("a", "a-ref"), "broadcast");
	expect(before).toEqual(picks("a", "b"));
});

test("togglePick always clears needsOnePick, in both kinds and for both directions of the click", () => {
	for (const kind of ["hand-off", "broadcast"] as const) {
		expect(togglePick([], target("a", "a-ref"), kind).needsOnePick).toBe(false);
		expect(togglePick(picks("a"), target("a", "a-ref"), kind).needsOnePick).toBe(false);
	}
});

test("switchKind to broadcast adds the project's sessions once: a union by key, picked first", () => {
	const preselected = picks("t1", "t2", "t3");
	const result = switchKind(picks("t2", "x"), "broadcast", { preselected, isPreselected: false });
	expect(keys(result.picked)).toEqual(["t2-ref", "x-ref", "t1-ref", "t3-ref"]);
	expect(result.isPreselected).toBe(true);
	expect(result.needsOnePick).toBe(false);
});

test("switchKind to broadcast leaves the picks as they are once the preselection was applied", () => {
	const result = switchKind(picks("x"), "broadcast", {
		preselected: picks("t1", "t2"),
		isPreselected: true,
	});
	expect(result).toEqual({ picked: picks("x"), isPreselected: true, needsOnePick: false });
});

test("switchKind to broadcast with nothing to preselect still marks the preselection as done", () => {
	const result = switchKind([], "broadcast", none);
	expect(result).toEqual({ picked: [], isPreselected: true, needsOnePick: false });
});

test("switchKind does not add a key twice, not even one repeated inside the preselection", () => {
	const result = switchKind([], "broadcast", {
		preselected: [pick("t1"), pick("t1"), pick("t2")],
		isPreselected: false,
	});
	expect(keys(result.picked)).toEqual(["t1-ref", "t2-ref"]);
});

test("switchKind to hand-off keeps zero or one pick and passes isPreselected through", () => {
	expect(switchKind([], "hand-off", { ...none, isPreselected: true })).toEqual({
		picked: [],
		isPreselected: true,
		needsOnePick: false,
	});
	expect(switchKind(picks("a"), "hand-off", none)).toEqual({
		picked: picks("a"),
		isPreselected: false,
		needsOnePick: false,
	});
});

test("switchKind to hand-off with several picks clears them and asks for exactly one", () => {
	const result = switchKind(picks("a", "b"), "hand-off", { ...none, isPreselected: true });
	expect(result).toEqual({ picked: [], isPreselected: true, needsOnePick: true });
	expect(pickHint(result.picked, "hand-off", result.needsOnePick)).toBe(
		"pick one session for a hand-off",
	);
});

test("the preselection comes back only the first time: hand-off then broadcast again keeps the pick", () => {
	const preselected = picks("t1", "t2");
	const up = switchKind([], "broadcast", { preselected, isPreselected: false });
	const down = switchKind(up.picked, "hand-off", {
		preselected,
		isPreselected: up.isPreselected,
	});
	const clicked = togglePick(down.picked, target("t2", "t2-ref"), "hand-off");
	const again = switchKind(clicked.picked, "broadcast", {
		preselected,
		isPreselected: down.isPreselected,
	});
	expect(again.picked).toEqual(picks("t2"));
});

test("keepListed drops the picks that left the list and keeps the order of the rest", () => {
	const listed = [target("a", "a-ref"), target("c", "c-ref")];
	expect(keepListed(picks("c", "gone", "a"), listed)).toEqual(picks("c", "a"));
});

test("keepListed never adds a session, however many the list holds", () => {
	const listed = [target("a", "a-ref"), target("b", "b-ref"), target("c", "c-ref")];
	expect(keepListed([], listed)).toEqual([]);
	expect(keepListed(picks("b"), listed)).toEqual(picks("b"));
});

test("keepListed finds a session without a ref by its address key", () => {
	const listed = [target("n", undefined, { address: "n" })];
	expect(keepListed([{ key: "addr:n", name: "n" }], listed)).toEqual([
		{ key: "addr:n", name: "n" },
	]);
	expect(keepListed([{ key: "addr:other", name: "n" }], listed)).toEqual([]);
});

test("resolvePicks returns the matched targets in the order of the picks, with no problems", () => {
	const a = target("a", "a-ref");
	const b = target("b", "b-ref");
	const c = target("c", "c-ref");
	const result = resolvePicks(picks("c", "a"), [a, b, c]);
	expect(result.targets).toEqual([c, a]);
	expect(result.problems).toEqual([]);
});

test("resolvePicks says a pick is a different session when its name now belongs to another ref", () => {
	const other = target("a", "new-ref");
	const result = resolvePicks([{ key: "old-ref", name: "a" }], [other]);
	expect(result.targets).toEqual([]);
	expect(result.problems).toEqual(["a is a different session now"]);
});

test("resolvePicks says a pick is gone when neither its key nor its name is listed", () => {
	const result = resolvePicks(picks("gone"), [target("a", "a-ref")]);
	expect(result.targets).toEqual([]);
	expect(result.problems).toEqual(["gone is no longer on the session list"]);
});

test("resolvePicks keeps the good picks next to the bad ones, one problem per bad pick", () => {
	const a = target("a", "a-ref");
	const result = resolvePicks(
		[pick("a"), pick("gone"), { key: "old-ref", name: "a" }],
		[a, target("z", "z-ref")],
	);
	expect(result.targets).toEqual([a]);
	expect(result.problems).toEqual([
		"gone is no longer on the session list",
		"a is a different session now",
	]);
});

test("resolvePicks of no picks resolves nothing and reports nothing", () => {
	expect(resolvePicks([], [target("a", "a-ref")])).toEqual({ targets: [], problems: [] });
});

test("sendLabel of a hand-off names the one session", () => {
	expect(sendLabel(picks("alpha"), "hand-off")).toBe("Send to alpha");
});

test("sendLabel of a broadcast to one session says 1 session", () => {
	expect(sendLabel(picks("alpha"), "broadcast")).toBe("Send to 1 session: alpha");
});

test("sendLabel of a broadcast lists up to three names without an ellipsis", () => {
	expect(sendLabel(picks("a", "b"), "broadcast")).toBe("Send to 2 sessions: a, b");
	expect(sendLabel(picks("a", "b", "c"), "broadcast")).toBe("Send to 3 sessions: a, b, c");
});

test("sendLabel of a broadcast to more than three shows three names and an ellipsis", () => {
	expect(sendLabel(picks("a", "b", "c", "d", "e"), "broadcast")).toBe(
		"Send to 5 sessions: a, b, c, …",
	);
	expect(sendLabel(picks("a", "b", "c", "d"), "broadcast")).toBe("Send to 4 sessions: a, b, c, …");
});

test("pickHint of a hand-off with nothing picked asks for one session only after a switch down", () => {
	expect(pickHint([], "hand-off", true)).toBe("pick one session for a hand-off");
	expect(pickHint([], "hand-off", false)).toBe("pick at least one session");
});

test("pickHint of a broadcast with nothing picked asks for at least one, whatever needsOnePick says", () => {
	expect(pickHint([], "broadcast", false)).toBe("pick at least one session");
	expect(pickHint([], "broadcast", true)).toBe("pick at least one session");
});

test("pickHint of a hand-off with several picks asks for one", () => {
	expect(pickHint(picks("a", "b"), "hand-off", false)).toBe("pick one session for a hand-off");
});

test("pickHint is silent when the picks are fine", () => {
	expect(pickHint(picks("a"), "hand-off", false)).toBeUndefined();
	expect(pickHint(picks("a"), "broadcast", false)).toBeUndefined();
	expect(pickHint(picks("a", "b", "c"), "broadcast", false)).toBeUndefined();
});
