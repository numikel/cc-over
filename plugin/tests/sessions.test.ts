import { expect, test } from "claude-code/testing";
import { type ListAgentsRow, targetsFromListAgents } from "../hooks/sessions.js";

// Fixtures are copied verbatim from evidence.md § E2 (anonymised there).
const LISTING = `This session is probe-s01-sender [a2f9f3] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).

Peer sessions (5):
  probe-s01-dup [e417c4]  ·  interactive  ·  busy  ·  started 1m ago
  alpha-1 [c03940]  ·  interactive  ·  idle  ·  started 12h ago
  probe-s01-refuse [67ef42]  ·  interactive  ·  started 2s ago
  repo-b | impl | feature-x [ff8294]  ·  interactive  ·  idle  ·  started 12h ago
  repo-a | review | feature-y [9f271c]  ·  interactive  ·  waiting  ·  started 2h ago`;

const NO_SEND_PARAGRAPH =
	"None of the agents below can be messaged with SendMessage from here: it is not among the tools available to you.";

const row = (name: string, ref: string, status?: string, type = "interactive") => ({
	name,
	ref,
	type,
	...(status ? { status } : {}),
});

const result = (rows: ListAgentsRow[], listing = LISTING) => ({
	listing,
	sections: [{ kind: "sessions", total: rows.length, rows }],
	notes: [],
});

test("maps rows to targets by name, with status and a note for waiting", () => {
	const { targets, hiddenCount, selfName } = targetsFromListAgents(
		result([
			row("alpha-1", "c03940", "idle"),
			row("repo-b | impl | feature-x", "ff8294", "idle"),
			row("repo-a | review | feature-y", "9f271c", "waiting"),
		]),
	);
	expect(hiddenCount).toBe(0);
	expect(selfName).toBe("probe-s01-sender");
	expect(targets).toEqual([
		{
			name: "alpha-1",
			ref: "c03940",
			status: "idle",
			type: "interactive",
			address: "alpha-1",
			isSendable: true,
			startedAgo: "12h",
		},
		{
			name: "repo-b | impl | feature-x",
			ref: "ff8294",
			status: "idle",
			type: "interactive",
			address: "repo-b | impl | feature-x",
			isSendable: true,
			startedAgo: "12h",
		},
		{
			name: "repo-a | review | feature-y",
			ref: "9f271c",
			status: "waiting",
			type: "interactive",
			address: "repo-a | review | feature-y",
			isSendable: true,
			note: "waiting for the user",
			startedAgo: "2h",
		},
	]);
});

test("a row without status (a session started seconds ago) is still sendable", () => {
	const { targets } = targetsFromListAgents(result([row("probe-s01-refuse", "67ef42")]));
	expect(targets).toHaveLength(1);
	expect(targets[0]?.status).toBeUndefined();
	expect(targets[0]?.isSendable).toBe(true);
});

test("a status outside idle/busy/waiting is kept verbatim", () => {
	const { targets } = targetsFromListAgents(result([row("sh", "1671e0", "shell")]));
	expect(targets[0]?.status).toBe("shell");
	expect(targets[0]?.note).toBeUndefined();
});

const agoOf = (rows: ListAgentsRow[], listing: string) =>
	Object.fromEntries(
		targetsFromListAgents(result(rows, listing)).targets.map((t) => [t.ref, t.startedAgo]),
	);

test("startedAgo is read from the listing line of each target, with or without a status column", () => {
	expect(
		agoOf(
			[
				row("probe-s01-dup", "e417c4", "busy"),
				row("alpha-1", "c03940", "idle"),
				row("probe-s01-refuse", "67ef42"),
				row("repo-b | impl | feature-x", "ff8294", "idle"),
				row("repo-a | review | feature-y", "9f271c", "waiting"),
			],
			LISTING,
		),
	).toEqual({
		e417c4: "1m",
		c03940: "12h",
		"67ef42": "2s",
		ff8294: "12h",
		"9f271c": "2h",
	});
});

test("startedAgo follows the ref, not the name, when two sessions share a name", () => {
	const listing = `${LISTING}\n  alpha-1 [c03941]  ·  interactive  ·  busy  ·  started 7m ago`;
	expect(
		agoOf([row("alpha-1", "c03940", "idle"), row("alpha-1", "c03941", "busy")], listing),
	).toEqual({ c03940: "12h", c03941: "7m" });
});

test("startedAgo needs the whole [ref]: a longer ref with the same prefix is another row", () => {
	const listing = [
		"  alpha-1 [c039401]  ·  interactive  ·  idle  ·  started 9d ago",
		"  alpha-2 [c03940]  ·  interactive  ·  idle  ·  started 3h ago",
	].join("\n");
	expect(agoOf([row("alpha-2", "c03940", "idle")], listing)).toEqual({ c03940: "3h" });
});

test("startedAgo is absent when the listing has no line for the ref or the format changed", () => {
	const [noLine] = targetsFromListAgents(result([row("ghost", "abcdef", "idle")])).targets;
	expect(noLine?.startedAgo).toBeUndefined();
	const reformatted = "  alpha-1 [c03940]  ·  interactive  ·  idle  ·  since 12h";
	const [changed] = targetsFromListAgents(
		result([row("alpha-1", "c03940", "idle")], reformatted),
	).targets;
	expect(changed?.startedAgo).toBeUndefined();
	const [noRef] = targetsFromListAgents(
		result([{ name: "alpha-1", type: "interactive", status: "idle" }]),
	).targets;
	expect(noRef?.startedAgo).toBeUndefined();
});

test("duplicate names are both sendable, addressed as name [ref]", () => {
	const { targets } = targetsFromListAgents(
		result([
			row("probe-s01-dup", "e417c4", "busy"),
			row("probe-s01-dup", "fb7a6a", "idle"),
			row("alpha-1", "c03940", "idle"),
		]),
	);
	expect(targets.map((t) => t.address)).toEqual([
		"probe-s01-dup [e417c4]",
		"probe-s01-dup [fb7a6a]",
		"alpha-1",
	]);
	expect(targets.every((t) => t.isSendable)).toBe(true);
});

test("only type interactive is listed; every other type is counted as hidden", () => {
	const { targets, hiddenCount } = targetsFromListAgents(
		result([
			row("alpha-1", "c03940", "idle"),
			row("cloud-1", "aa11bb", "idle", "remote"),
			row("bg-1", "cc22dd", "busy", "background"),
			{ name: "typeless", ref: "ee33ff" },
		]),
	);
	expect(targets.map((t) => t.name)).toEqual(["alpha-1"]);
	expect(hiddenCount).toBe(3);
});

test("a hidden session still makes a local name ambiguous for the platform", () => {
	const { targets } = targetsFromListAgents(
		result([row("shared", "111111", "idle"), row("shared", "222222", "idle", "remote")]),
	);
	expect(targets.map((t) => t.address)).toEqual(["shared [111111]"]);
});

test("rows without a name are skipped and do not count as hidden", () => {
	const { targets, hiddenCount } = targetsFromListAgents({
		listing: LISTING,
		sections: [
			{ kind: "sessions", total: 2, rows: [{ ref: "000000", type: "interactive" }, row("a", "1")] },
		],
	});
	expect(targets.map((t) => t.name)).toEqual(["a"]);
	expect(hiddenCount).toBe(0);
});

test("selfName survives the extra SendMessage paragraph before the header", () => {
	const { selfName } = targetsFromListAgents(result([], `${NO_SEND_PARAGRAPH}\n\n${LISTING}`));
	expect(selfName).toBe("probe-s01-sender");
});

test("selfRef is read from the header, also next to a name with pipes", () => {
	expect(targetsFromListAgents(result([])).selfRef).toBe("a2f9f3");
	expect(
		targetsFromListAgents(
			result(
				[],
				"This session is repo-a | review | feature-y [9f271c] — the name other sessions use.",
			),
		).selfRef,
	).toBe("9f271c");
	expect(targetsFromListAgents(result([], "")).selfRef).toBeUndefined();
});

test("selfName keeps pipes and spaces from the name", () => {
	const { selfName } = targetsFromListAgents(
		result(
			[],
			"This session is repo-a | review | feature-y [9f271c] — the name other sessions use.",
		),
	);
	expect(selfName).toBe("repo-a | review | feature-y");
});

test("missing header, sections or listing yield an empty result", () => {
	expect(targetsFromListAgents({ listing: "No other sessions." })).toEqual({
		targets: [],
		hiddenCount: 0,
	});
	expect(targetsFromListAgents(result([], "")).selfName).toBeUndefined();
});

test("self session is filtered by selfRef, while a peer sharing selfName stays listed as name [ref]", () => {
	const { targets } = targetsFromListAgents(
		result([
			row("probe-s01-sender", "a2f9f3"),
			row("probe-s01-sender", "222222"),
			row("other", "111111"),
		]),
	);
	expect(targets.map((t) => t.address)).toEqual(["probe-s01-sender [222222]", "other"]);
});
