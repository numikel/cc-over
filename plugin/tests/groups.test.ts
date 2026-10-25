import { expect, test } from "claude-code/testing";
import {
	type Grouped,
	groupHeading,
	groupSessions,
	joinRegistry,
	relativeAge,
	rowLabel,
	type SessionRow,
	visibleRows,
} from "../hooks/groups.js";
import type { RegistryEntry } from "../hooks/registry.js";
import type { Target } from "../hooks/sessions.js";

const target = (name: string, ref?: string, extra: Partial<Target> = {}): Target => ({
	name,
	...(ref !== undefined ? { ref } : {}),
	type: "interactive",
	address: name,
	isSendable: true,
	...extra,
});

const entry = (sessionId: string, extra: Partial<RegistryEntry> = {}): RegistryEntry => ({
	v: 1,
	sessionId,
	root: "D:/work/claude-over",
	lastActivityAt: 1000,
	updatedAt: 1000,
	...extra,
});

const winner = (entries: RegistryEntry[]) =>
	joinRegistry([target("t", "aaa111")], entries)[0]?.entry?.sessionId;

test("joinRegistry picks the entry with the larger updatedAt when /clear left two", () => {
	const older = entry("old", { ref: "aaa111", updatedAt: 1000, lastActivityAt: 9000 });
	const newer = entry("new", { ref: "aaa111", updatedAt: 2000, lastActivityAt: 1000 });
	expect(winner([older, newer])).toBe("new");
	expect(winner([newer, older])).toBe("new");
});

test("joinRegistry breaks an updatedAt tie by lastActivityAt, then by the larger sessionId", () => {
	const quiet = entry("a", { ref: "aaa111", updatedAt: 5, lastActivityAt: 10 });
	const busy = entry("b", { ref: "aaa111", updatedAt: 5, lastActivityAt: 20 });
	expect(winner([quiet, busy])).toBe("b");
	expect(winner([busy, quiet])).toBe("b");
	const low = entry("s-1", { ref: "aaa111", updatedAt: 5, lastActivityAt: 10 });
	const high = entry("s-2", { ref: "aaa111", updatedAt: 5, lastActivityAt: 10 });
	expect(winner([low, high])).toBe("s-2");
	expect(winner([high, low])).toBe("s-2");
});

test("joinRegistry gives no entry to a target without a ref or without a matching ref", () => {
	const noRefEntry = entry("orphan");
	const rows = joinRegistry(
		[target("no-ref"), target("stranger", "zzz999")],
		[noRefEntry, entry("s1", { ref: "aaa111" })],
	);
	expect(rows.map((r) => r.entry)).toEqual([undefined, undefined]);
});

test("joinRegistry keeps the order and the fields of the targets", () => {
	const rows = joinRegistry(
		[target("c", "ccc333", { status: "busy" }), target("a", "aaa111"), target("b", "bbb222")],
		[entry("s-a", { ref: "aaa111" })],
	);
	expect(rows.map((r) => r.name)).toEqual(["c", "a", "b"]);
	expect(rows[0]?.status).toBe("busy");
	expect(rows.map((r) => r.entry?.sessionId)).toEqual([undefined, "s-a", undefined]);
});

test("joinRegistry attaches the entry with the same ref, whatever its stored name", () => {
	const rows = joinRegistry(
		[target("renamed-now", "aaa111")],
		[entry("s1", { ref: "aaa111", name: "old-name" })],
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.entry?.sessionId).toBe("s1");
	expect(rows[0]?.name).toBe("renamed-now");
});

const SELF = { key: "d:/work/claude-over", label: "claude-over" };

const rowAt = (
	name: string,
	root: string | undefined,
	extra: Partial<RegistryEntry> = {},
): SessionRow => ({
	...target(name, `${name}-ref`),
	...(root !== undefined
		? { entry: entry(`id-${name}`, { root, lastActivityAt: 1000, ...extra }) }
		: {}),
});

const names = (rows: SessionRow[]) => rows.map((r) => r.name);

test("groupSessions puts rows of the own project first, other repos and unknown rows apart", () => {
	const g = groupSessions(
		[
			rowAt("mine", "D:/work/claude-over"),
			rowAt("theirs", "D:/work/zeta"),
			rowAt("blind", undefined),
			rowAt("wt", "D:/work/claude-over/.worktrees/feat", { repoRoot: "D:\\work\\claude-over" }),
		],
		SELF,
	);
	expect(g.thisProject.label).toBe("claude-over");
	expect(names(g.thisProject.rows).sort()).toEqual(["mine", "wt"]);
	expect(g.other.repos.map((r) => r.label)).toEqual(["zeta"]);
	expect(names(g.other.repos[0]?.rows ?? [])).toEqual(["theirs"]);
	expect(names(g.other.noDetails)).toEqual(["blind"]);
	expect(g.other.total).toBe(2);
});

test("groupSessions with nothing to group yields empty groups", () => {
	const g = groupSessions([], SELF);
	expect(g).toEqual({
		thisProject: { label: "claude-over", rows: [] },
		other: { total: 0, repos: [], noDetails: [] },
	});
});

test("groupSessions sorts rows by lastActivityAt descending and keeps input order on a tie", () => {
	const g = groupSessions(
		[
			rowAt("old", "D:/work/claude-over", { lastActivityAt: 100 }),
			rowAt("tie-1", "D:/work/claude-over", { lastActivityAt: 500 }),
			rowAt("new", "D:/work/claude-over", { lastActivityAt: 900 }),
			rowAt("tie-2", "D:/work/claude-over", { lastActivityAt: 500 }),
			rowAt("x-old", "D:/work/other", { lastActivityAt: 1 }),
			rowAt("x-new", "D:/work/other", { lastActivityAt: 2 }),
		],
		SELF,
	);
	expect(names(g.thisProject.rows)).toEqual(["new", "tie-1", "tie-2", "old"]);
	expect(names(g.other.repos[0]?.rows ?? [])).toEqual(["x-new", "x-old"]);
});

test("groupSessions orders repos alphabetically ignoring case and noDetails by platform order", () => {
	const g = groupSessions(
		[
			rowAt("n2", undefined),
			rowAt("r-b", "D:/work/Bravo"),
			rowAt("n1", undefined),
			rowAt("r-a", "D:/work/alpha"),
			rowAt("r-c", "D:/work/charlie"),
		],
		SELF,
	);
	expect(g.other.repos.map((r) => r.label)).toEqual(["alpha", "Bravo", "charlie"]);
	expect(names(g.other.noDetails)).toEqual(["n2", "n1"]);
	expect(g.other.total).toBe(5);
});

test("groupSessions merges rows of one repo seen under different spellings of its path", () => {
	const g = groupSessions(
		[
			rowAt("a", "D:\\Work\\Zeta"),
			rowAt("b", "d:/work/zeta/"),
			rowAt("c", "D:/work/zeta/sub", { repoRoot: "d:/work/zeta" }),
		],
		SELF,
	);
	expect(g.other.repos).toHaveLength(1);
	expect(names(g.other.repos[0]?.rows ?? []).sort()).toEqual(["a", "b", "c"]);
});

test("groupSessions labels two different repos with the same name by their full paths", () => {
	const g = groupSessions(
		[rowAt("a", "D:/work/App"), rowAt("b", "E:\\clients\\app\\"), rowAt("c", "D:/work/solo")],
		SELF,
	);
	expect(g.other.repos.map((r) => r.label)).toEqual(["D:/work/App", "E:/clients/app", "solo"]);
});

const plain = (name: string): SessionRow => target(name, `${name}-ref`);

const sample = (): Grouped => ({
	thisProject: { label: "claude-over", rows: [plain("t1"), plain("t2")] },
	other: {
		total: 4,
		repos: [
			{ label: "alpha", rows: [plain("a1")] },
			{ label: "beta", rows: [plain("b1")] },
		],
		noDetails: [plain("n1")],
	},
});

const expanded = { this: false, other: false };

test("visibleRows lists this project, then each repo, then the rows without details", () => {
	const rows = visibleRows(sample(), expanded);
	expect(rows.map((r) => r.row.name)).toEqual(["t1", "t2", "a1", "b1", "n1"]);
});

test("visibleRows numbers the visible rows from the top, 1 to 9, and stops at the tenth", () => {
	const many = (prefix: string, n: number) =>
		Array.from({ length: n }, (_, i) => plain(`${prefix}${i + 1}`));
	const g: Grouped = {
		thisProject: { label: "x", rows: many("t", 4) },
		other: { total: 7, repos: [{ label: "r", rows: many("r", 7) }], noDetails: [] },
	};
	const rows = visibleRows(g, expanded);
	expect(rows).toHaveLength(11);
	expect(rows.slice(0, 9).map((r) => r.hotkey)).toEqual([
		"1",
		"2",
		"3",
		"4",
		"5",
		"6",
		"7",
		"8",
		"9",
	]);
	expect(rows[9]?.hotkey).toBeUndefined();
	expect(rows[10]?.hotkey).toBeUndefined();
	expect("hotkey" in (rows[9] ?? {})).toBe(false);
});

test("visibleRows leaves out a collapsed group and does not number its rows", () => {
	const noThis = visibleRows(sample(), { this: true, other: false });
	expect(noThis.map((r) => [r.row.name, r.hotkey])).toEqual([
		["a1", "1"],
		["b1", "2"],
		["n1", "3"],
	]);
	const noOther = visibleRows(sample(), { this: false, other: true });
	expect(noOther.map((r) => [r.row.name, r.hotkey])).toEqual([
		["t1", "1"],
		["t2", "2"],
	]);
	expect(visibleRows(sample(), { this: true, other: true })).toEqual([]);
});

test("visibleRows marks the last row of each block: this group, every repo, no details", () => {
	const rows = visibleRows(sample(), expanded);
	expect(rows.map((r) => [r.row.name, r.isLast])).toEqual([
		["t1", false],
		["t2", true],
		["a1", true],
		["b1", true],
		["n1", true],
	]);
});

test("visibleRows puts a heading on the first row of each block of the other group only", () => {
	const g = sample();
	g.other.repos[0] = { label: "alpha", rows: [plain("a1"), plain("a2")] };
	const rows = visibleRows(g, expanded);
	expect(rows.map((r) => [r.row.name, r.heading])).toEqual([
		["t1", undefined],
		["t2", undefined],
		["a1", "alpha"],
		["a2", undefined],
		["b1", "beta"],
		["n1", "no details (mod not running there)"],
	]);
});

test("visibleRows skips a repo or a block without rows", () => {
	const g = sample();
	g.other.repos.unshift({ label: "empty", rows: [] });
	g.other.noDetails = [];
	expect(visibleRows(g, expanded).map((r) => r.row.name)).toEqual(["t1", "t2", "a1", "b1"]);
});

test("relativeAge floors to the largest whole unit: seconds, minutes, hours, days", () => {
	expect(relativeAge(0)).toBe("0s");
	expect(relativeAge(5_000)).toBe("5s");
	expect(relativeAge(59_999)).toBe("59s");
	expect(relativeAge(60_000)).toBe("1m");
	expect(relativeAge(119_999)).toBe("1m");
	expect(relativeAge(3_599_999)).toBe("59m");
	expect(relativeAge(3_600_000)).toBe("1h");
	expect(relativeAge(86_399_999)).toBe("23h");
	expect(relativeAge(86_400_000)).toBe("1d");
	expect(relativeAge(3 * 86_400_000 + 5)).toBe("3d");
});

test("relativeAge treats a negative or non-numeric age as zero", () => {
	expect(relativeAge(-5_000)).toBe("0s");
	expect(relativeAge(Number.NaN)).toBe("0s");
});

const NOW = 10_000_000;
const REPO = "D:/work/claude-over";

const labelled = (
	name: string,
	entryOver: Partial<RegistryEntry> | undefined,
	rowOver: Partial<SessionRow> = {},
): SessionRow => ({
	...target(name, `${name}-ref`, rowOver),
	...(entryOver !== undefined
		? { entry: entry(`id-${name}`, { root: REPO, repoRoot: REPO, ...entryOver }) }
		: {}),
});

const open = { isSelected: false, isLast: false, now: NOW };

test("rowLabel spells a row in the main checkout: name, branch, status, age, hotkey", () => {
	const row = labelled(
		"impl",
		{ branch: "main", lastActivityAt: NOW - 120_000 },
		{ status: "idle" },
	);
	expect(rowLabel(row, { ...open, hotkey: "1" })).toBe("├─ ○ impl · main · idle · 2m ago (1)");
});

test("rowLabel spells a row in a worktree as worktree (branch), on the last line of its block", () => {
	const row = labelled(
		"review",
		{ root: `${REPO}/.worktrees/wt-foo`, branch: "feat/foo", lastActivityAt: NOW - 5_000 },
		{ status: "busy" },
	);
	expect(rowLabel(row, { ...open, isLast: true, hotkey: "2" })).toBe(
		"└─ ○ review · wt-foo (feat/foo) · busy · 5s ago (2)",
	);
});

test("rowLabel marks the selected row with a filled dot and drops the hotkey suffix without one", () => {
	const row = labelled("impl", { branch: "main", lastActivityAt: NOW }, { status: "idle" });
	expect(rowLabel(row, { ...open, isSelected: true })).toBe("├─ ● impl · main · idle · 0s ago");
});

test("rowLabel shows a worktree without a branch by its directory, and no place outside a worktree", () => {
	const detached = labelled("d", { root: `${REPO}/.worktrees/wt-1`, lastActivityAt: NOW - 60_000 });
	expect(rowLabel(detached, open)).toBe("├─ ○ d · wt-1 · 1m ago");
	const bare = labelled("b", { lastActivityAt: NOW - 60_000 });
	expect(rowLabel(bare, open)).toBe("├─ ○ b · 1m ago");
});

test("rowLabel puts the note after the age", () => {
	const row = labelled(
		"w",
		{ branch: "main", lastActivityAt: NOW - 3_600_000 },
		{ status: "waiting", note: "waiting for the user" },
	);
	expect(rowLabel(row, open)).toBe("├─ ○ w · main · waiting · 1h ago · waiting for the user");
});

test("rowLabel uses the address, so a repeated name stays distinguishable", () => {
	const row = labelled("dup", undefined, {
		address: "dup [e417c4]",
		status: "busy",
		startedAgo: "1m",
	});
	expect(rowLabel(row, open)).toBe("├─ ○ dup [e417c4] · busy · started 1m ago");
});

test("rowLabel without a registry entry falls back to the listing's start time, or to no time", () => {
	const listed = labelled("alpha", undefined, { status: "idle", startedAgo: "12h" });
	expect(rowLabel(listed, open)).toBe("├─ ○ alpha · idle · started 12h ago");
	const bare = labelled("beta", undefined);
	expect(rowLabel(bare, open)).toBe("├─ ○ beta");
});

test("rowLabel prefers the registry's last activity over the listing's start time", () => {
	const row = labelled("both", { lastActivityAt: NOW - 30_000 }, { startedAgo: "12h" });
	expect(rowLabel(row, open)).toBe("├─ ○ both · 30s ago");
});

test("groupHeading shows the project label for this group and the count for the other", () => {
	expect(
		groupHeading("this", { label: "claude-over", count: 3, isCollapsed: false, hotkey: "t" }),
	).toBe("▼ This project: claude-over (t)");
	expect(
		groupHeading("other", { label: "ignored", count: 6, isCollapsed: true, hotkey: "o" }),
	).toBe("▶ Other sessions: 6 (o)");
});

test("groupHeading points right when collapsed, down when open, and omits a missing hotkey", () => {
	expect(groupHeading("this", { label: "claude-over", count: 3, isCollapsed: true })).toBe(
		"▶ This project: claude-over",
	);
	expect(groupHeading("other", { label: "x", count: 0, isCollapsed: false })).toBe(
		"▼ Other sessions: 0",
	);
});
