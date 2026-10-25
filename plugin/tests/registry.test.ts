import { expect, test } from "claude-code/testing";
import {
	nextEntry,
	normalizePath,
	PRUNE_MAX_AGE_MS,
	PRUNE_MAX_BYTES,
	PRUNE_SCAN_LIMIT,
	parseEntry,
	projectKey,
	projectLabel,
	REGISTRY_PREFIX,
	type RegistryEntry,
	registryKey,
	selectPrunable,
	worktreeLabel,
} from "../hooks/registry.js";

test("registryKey namespaces the session id under the registry prefix", () => {
	expect(REGISTRY_PREFIX).toBe("session:");
	expect(registryKey("abc-123")).toBe("session:abc-123");
});

test("normalizePath makes Windows spellings of one directory equal", () => {
	expect(normalizePath("D:\\work\\claude-over\\")).toBe("d:/work/claude-over");
	expect(normalizePath("d:/work/claude-over")).toBe("d:/work/claude-over");
});

test("normalizePath keeps the case of paths without a drive letter", () => {
	expect(normalizePath("/home/Micha/Repo/")).toBe("/home/Micha/Repo");
	expect(normalizePath("/home/micha/repo")).not.toBe(normalizePath("/home/Micha/repo"));
});

test("normalizePath does not strip a root down to nothing", () => {
	expect(normalizePath("/")).toBe("/");
	expect(normalizePath("C:\\")).toBe("c:/");
});

test("projectKey groups a worktree with the main checkout of its repo", () => {
	const main = { root: "D:/work/claude-over", repoRoot: "D:/work/claude-over" };
	const worktree = {
		root: "D:/work/claude-over/.worktrees/foo",
		repoRoot: "D:\\work\\claude-over\\",
	};
	expect(projectKey(worktree)).toBe(projectKey(main));
});

test("projectKey falls back to root outside git", () => {
	expect(projectKey({ root: "D:\\Temp\\scratch" })).toBe("d:/temp/scratch");
});

test("projectLabel is the repo directory name, keeping its case", () => {
	expect(
		projectLabel({
			root: "D:/work/claude-over/.worktrees/foo",
			repoRoot: "D:\\work\\Claude-Over\\",
		}),
	).toBe("Claude-Over");
	expect(projectLabel({ root: "D:/Temp/Scratch" })).toBe("Scratch");
});

test("worktreeLabel names the worktree directory only when root differs from the repo root", () => {
	expect(
		worktreeLabel({
			root: "D:/work/claude-over/.worktrees/wt-foo",
			repoRoot: "D:/work/claude-over",
		}),
	).toBe("wt-foo");
	expect(
		worktreeLabel({
			root: "D:\\work\\claude-over\\",
			repoRoot: "d:/work/claude-over",
		}),
	).toBeUndefined();
	expect(worktreeLabel({ root: "D:/Temp/scratch" })).toBeUndefined();
});

const valid: RegistryEntry = {
	v: 1,
	sessionId: "s-1",
	root: "D:/repo",
	lastActivityAt: 100,
	updatedAt: 200,
};

test("parseEntry accepts a complete entry and returns it unchanged", () => {
	const full = {
		...valid,
		name: "probe",
		ref: "r-1",
		repoRoot: "D:/repo",
		branch: "main",
	};
	expect(parseEntry(full)).toEqual(full);
});

test("parseEntry accepts an entry without the optional fields", () => {
	expect(parseEntry(valid)).toEqual(valid);
});

test("parseEntry rejects values that are not objects", () => {
	for (const junk of [null, undefined, [], [valid], "session", 42, true]) {
		expect(parseEntry(junk)).toBeNull();
	}
});

test("parseEntry rejects another schema version", () => {
	expect(parseEntry({ ...valid, v: 2 })).toBeNull();
	expect(parseEntry({ ...valid, v: undefined })).toBeNull();
});

test("parseEntry rejects an entry missing or corrupting a required field", () => {
	expect(parseEntry({ ...valid, sessionId: "" })).toBeNull();
	expect(parseEntry({ ...valid, sessionId: 7 })).toBeNull();
	expect(parseEntry({ ...valid, root: "" })).toBeNull();
	expect(parseEntry({ ...valid, root: undefined })).toBeNull();
	expect(parseEntry({ ...valid, lastActivityAt: "100" })).toBeNull();
	expect(parseEntry({ ...valid, lastActivityAt: Number.NaN })).toBeNull();
	expect(parseEntry({ ...valid, updatedAt: Number.POSITIVE_INFINITY })).toBeNull();
	expect(parseEntry({ ...valid, updatedAt: undefined })).toBeNull();
});

test("parseEntry rejects an entry whose optional field has the wrong type", () => {
	expect(parseEntry({ ...valid, name: 5 })).toBeNull();
	expect(parseEntry({ ...valid, ref: {} })).toBeNull();
	expect(parseEntry({ ...valid, repoRoot: false })).toBeNull();
	expect(parseEntry({ ...valid, branch: ["main"] })).toBeNull();
});

test("parseEntry drops unknown fields instead of carrying them along", () => {
	const parsed = parseEntry({ ...valid, secret: "x", extra: 1 });
	expect(parsed).toEqual(valid);
	expect(parsed).not.toBe(valid);
	expect(Object.keys(parsed ?? {})).not.toContain("secret");
});

test("nextEntry creates a first entry stamped with the time it was made", () => {
	const entry = nextEntry(
		null,
		{ sessionId: "s-1", root: "D:/repo", repoRoot: "D:/repo", branch: "main", name: "probe" },
		1000,
	);
	expect(entry).toEqual({
		v: 1,
		sessionId: "s-1",
		root: "D:/repo",
		repoRoot: "D:/repo",
		branch: "main",
		name: "probe",
		lastActivityAt: 1000,
		updatedAt: 1000,
	});
});

test("nextEntry does not invent an entry when there is no root to record", () => {
	expect(nextEntry(null, { sessionId: "s-1", lastActivityAt: 500 }, 1000)).toBeNull();
});

test("nextEntry keeps the fields the patch does not mention", () => {
	const prev = { ...valid, repoRoot: "D:/repo", branch: "main", name: "probe", ref: "r-1" };
	const next = nextEntry(prev, { sessionId: "s-1", lastActivityAt: 300 }, 1000);
	expect(next).toEqual({ ...prev, lastActivityAt: 300, updatedAt: 1000 });
});

test("nextEntry refreshes updatedAt even for a patch that changes nothing else", () => {
	expect(nextEntry(valid, { sessionId: "s-1" }, 5000)?.updatedAt).toBe(5000);
});

test("nextEntry lets a patch with an undefined field remove it", () => {
	const prev = { ...valid, repoRoot: "D:/repo", branch: "main" };
	const next = nextEntry(prev, { sessionId: "s-1", branch: undefined }, 1000);
	expect(next).not.toBeNull();
	expect(next?.branch).toBeUndefined();
	expect(next !== null && "branch" in next).toBe(false);
	expect(next?.repoRoot).toBe("D:/repo");
});

test("nextEntry overwrites a field the patch sets", () => {
	const prev = { ...valid, branch: "main" };
	expect(
		nextEntry(prev, { sessionId: "s-1", branch: "feat/x", root: "D:/wt" }, 1000),
	).toMatchObject({
		branch: "feat/x",
		root: "D:/wt",
	});
});

test("nextEntry only moves last activity forward", () => {
	const prev = { ...valid, lastActivityAt: 900 };
	expect(nextEntry(prev, { sessionId: "s-1", lastActivityAt: 400 }, 1000)?.lastActivityAt).toBe(
		900,
	);
	expect(nextEntry(prev, { sessionId: "s-1", lastActivityAt: 950 }, 1000)?.lastActivityAt).toBe(
		950,
	);
});

test("nextEntry falls back to now when neither side knows the last activity", () => {
	expect(nextEntry(null, { sessionId: "s-1", root: "D:/repo" }, 1234)?.lastActivityAt).toBe(1234);
});

test("nextEntry produces an entry that parseEntry accepts", () => {
	const next = nextEntry(null, { sessionId: "s-1", root: "D:/repo", branch: "main" }, 1000);
	expect(parseEntry(next)).toEqual(next);
});

const NOW = 100 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const item = (sessionId: string, ageMs: number, size = 10) => ({
	key: registryKey(sessionId),
	sessionId,
	updatedAt: NOW - ageMs,
	size,
});
const limits = { maxAgeMs: PRUNE_MAX_AGE_MS, maxBytes: 1000, keepSessionId: "me" };

test("the prune limits are 15 days, 3 MiB and a scan of 500 entries", () => {
	expect(PRUNE_MAX_AGE_MS).toBe(15 * DAY);
	expect(PRUNE_MAX_BYTES).toBe(3 * 1024 * 1024);
	expect(PRUNE_SCAN_LIMIT).toBe(500);
});

test("selectPrunable selects nothing from an empty store", () => {
	expect(selectPrunable([], NOW, limits)).toEqual([]);
});

test("selectPrunable selects entries untouched for more than the maximum age", () => {
	const items = [item("old", 16 * DAY), item("fresh", 1 * DAY)];
	expect(selectPrunable(items, NOW, limits)).toEqual([registryKey("old")]);
});

test("selectPrunable keeps an entry that is exactly at the maximum age", () => {
	const items = [item("edge", 15 * DAY), item("just-over", 15 * DAY + 1)];
	expect(selectPrunable(items, NOW, limits)).toEqual([registryKey("just-over")]);
});

test("selectPrunable over the byte limit drops the oldest first and stops once under", () => {
	const items = [
		item("newest", 1 * DAY, 400),
		item("oldest", 3 * DAY, 400),
		item("middle", 2 * DAY, 400),
	];
	expect(selectPrunable(items, NOW, limits)).toEqual([registryKey("oldest")]);
});

test("selectPrunable keeps everything when the total is exactly at the byte limit", () => {
	const items = [item("a", 1 * DAY, 500), item("b", 2 * DAY, 500)];
	expect(selectPrunable(items, NOW, limits)).toEqual([]);
});

test("selectPrunable never selects the current session, even when it is expired or over budget", () => {
	const items = [item("me", 20 * DAY, 5000), item("other", 1 * DAY, 100)];
	expect(selectPrunable(items, NOW, limits)).toEqual([registryKey("other")]);
});

test("selectPrunable counts the current session toward the byte total", () => {
	const items = [item("me", 5 * DAY, 800), item("other", 1 * DAY, 400)];
	expect(selectPrunable(items, NOW, limits)).toEqual([registryKey("other")]);
});

test("selectPrunable lists expired entries by age first, then the byte excess oldest first", () => {
	const items = [
		item("fresh-b", 2 * DAY, 600),
		item("expired-new", 16 * DAY),
		item("fresh-a", 3 * DAY, 600),
		item("expired-old", 30 * DAY),
	];
	expect(selectPrunable(items, NOW, limits)).toEqual([
		registryKey("expired-old"),
		registryKey("expired-new"),
		registryKey("fresh-a"),
	]);
});

test("selectPrunable does not count expired entries toward the byte total it then trims", () => {
	const items = [item("expired", 20 * DAY, 5000), item("a", 1 * DAY, 400), item("b", 2 * DAY, 400)];
	expect(selectPrunable(items, NOW, limits)).toEqual([registryKey("expired")]);
});

test("selectPrunable leaves its input untouched", () => {
	const items = [item("b", 2 * DAY, 600), item("a", 3 * DAY, 600)];
	const snapshot = structuredClone(items);
	selectPrunable(items, NOW, limits);
	expect(items).toEqual(snapshot);
});
