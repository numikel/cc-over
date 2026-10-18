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
		},
		{
			name: "repo-b | impl | feature-x",
			ref: "ff8294",
			status: "idle",
			type: "interactive",
			address: "repo-b | impl | feature-x",
			isSendable: true,
		},
		{
			name: "repo-a | review | feature-y",
			ref: "9f271c",
			status: "waiting",
			type: "interactive",
			address: "repo-a | review | feature-y",
			isSendable: true,
			note: "waiting for the user",
		},
	]);
});

test("a row without status (a session started seconds ago) is still sendable", () => {
	const { targets } = targetsFromListAgents(result([row("probe-s01-refuse", "67ef42")]));
	expect(targets).toHaveLength(1);
	expect(targets[0]?.status).toBeUndefined();
	expect(targets[0]?.isSendable).toBe(true);
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

test("selfName is filtered out from targets list if returned in rows", () => {
	const { targets } = targetsFromListAgents(
		result([row("probe-s01-sender", "a2f9f3"), row("other", "111111")]),
	);
	expect(targets.map((t) => t.name)).toEqual(["other"]);
});
