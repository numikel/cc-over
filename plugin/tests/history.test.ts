import { expect, test } from "claude-code/testing";
import { type Bundle, newBundleId } from "../hooks/bundle.js";
import type { GitSummary } from "../hooks/git.js";
import {
	applyStatus,
	composedAtFrom,
	entryFromBundle,
	HISTORY_ENTRY_MAX_CHARS,
	HISTORY_MAX_AGE_MS,
	HISTORY_PER_SESSION,
	HISTORY_SHOWN,
	type HistoryEntry,
	type HistoryLog,
	historyDetail,
	historyKey,
	historyPruneItem,
	historyRow,
	parseHistoryLog,
	projectHistory,
	recordSend,
	trimLog,
} from "../hooks/history.js";
import type { SendRecord } from "../hooks/notice.js";
import { selectPrunable } from "../hooks/registry.js";

const NOW = 1_792_274_900_000;
const MINUTE = 60_000;
const PROJECT = "/work/repo";

const bundle = (over: Partial<Bundle> = {}): Bundle => ({
	bundleId: newBundleId(NOW - 5 * MINUTE, 0),
	kind: "hand-off",
	intent: "hand off the review",
	summary: "Reviewed the parser.",
	instructions: "Finish the tests.",
	details: "SECRET DETAILS that never reach the store",
	source: { repo: "repo", branch: "feat/x", sessionId: "source-session-id" },
	...over,
});

const record = (over: Partial<SendRecord> = {}): SendRecord => ({
	bundleId: bundle().bundleId,
	sendId: "send-1",
	target: "probe-one",
	sentAt: NOW - MINUTE,
	status: "passed-on",
	intent: "hand off the review",
	updatedAt: NOW - MINUTE,
	ownerSessionId: "owner-session",
	...over,
});

const git = (paths: string[]): GitSummary => ({
	branch: "feat/x",
	base: "main",
	mode: "branch-diff",
	changes: paths.map((path) => ({ path, status: "modified", source: "uncommitted" })),
	truncated: 0,
});

// A one-entry log for `record()`, as `recordSend` writes it.
const logOf = (over: Partial<SendRecord> = {}, from: Partial<Bundle> = {}): HistoryLog => {
	const sent = record(over);
	return recordSend(
		null,
		entryFromBundle(bundle({ bundleId: sent.bundleId, ...from }), PROJECT, sent),
		sent,
		NOW,
	);
};

const entryAt = (log: HistoryLog | null, index = 0): HistoryEntry => {
	const entry = log?.entries[index];
	if (entry === undefined) throw new Error(`no entry at ${index}`);
	return entry;
};

test("historyKey names the store key after the owner session", () => {
	expect(historyKey("owner-session")).toBe("history:owner-session");
});

test("composedAtFrom reads the compose time from a bundle id and is null for a foreign id", () => {
	expect(composedAtFrom(newBundleId(NOW, 0.5))).toBe(NOW);
	for (const id of ["", "abc", "ovr-", "ovr--0001", "ovr-!!-0001", "ovr-1a2b", "xyz-1a2b-0001"]) {
		expect(composedAtFrom(id)).toBeNull();
	}
});

test("entryFromBundle keeps the preview and leaves out details and the source session id", () => {
	const sent = record();
	const entry = entryFromBundle(bundle(), PROJECT, sent);
	expect(entry).toEqual({
		bundleId: sent.bundleId,
		project: PROJECT,
		repo: "repo",
		branch: "feat/x",
		composedAt: NOW - 5 * MINUTE,
		lastSentAt: sent.sentAt,
		intent: "hand off the review",
		summary: "Reviewed the parser.",
		instructions: "Finish the tests.",
		files: [],
		filesTotal: 0,
		targets: [
			{
				sendId: "send-1",
				target: "probe-one",
				sentAt: sent.sentAt,
				status: "passed-on",
				updatedAt: sent.updatedAt,
			},
		],
		targetsTotal: 1,
	});
	const json = JSON.stringify(entry);
	expect(json).not.toContain("SECRET DETAILS");
	expect(json).not.toContain("source-session-id");
});

test("entryFromBundle takes the files from git, else from the model's lines, capped at 30", () => {
	const fromGit = entryFromBundle(
		bundle({ git: git(["src/a.ts", "src/b.ts"]) }),
		PROJECT,
		record(),
	);
	expect(fromGit.files).toEqual(["src/a.ts", "src/b.ts"]);
	expect(fromGit.filesTotal).toBe(2);

	const fromModel = entryFromBundle(bundle({ files: "a.ts\n\n  b.ts  \n" }), PROJECT, record());
	expect(fromModel.files).toEqual(["a.ts", "b.ts"]);

	const many = Array.from({ length: 45 }, (_, i) => `f${i}.ts`);
	const capped = entryFromBundle(bundle({ git: git(many) }), PROJECT, record());
	expect(capped.files).toEqual(many.slice(0, 30));
	expect(capped.filesTotal).toBe(45);
});

test("a long file path loses its beginning, so the file name stays", () => {
	const long = `${"d".repeat(200)}/deep/name.ts`;
	const [path] = entryFromBundle(bundle({ git: git([long]) }), PROJECT, record()).files;
	expect(Array.from(path ?? "")).toHaveLength(120);
	expect(path?.startsWith("…")).toBe(true);
	expect(path?.endsWith("/deep/name.ts")).toBe(true);
	const polish = `${"ż".repeat(150)}.ts`;
	const [cut] = entryFromBundle(bundle({ git: git([polish]) }), PROJECT, record()).files;
	expect(Array.from(cut ?? "")).toHaveLength(120);
	expect(cut?.endsWith("ż.ts")).toBe(true);
});

test("entryFromBundle cuts intent to 500, summary and instructions to 1000 characters", () => {
	const entry = entryFromBundle(
		bundle({ intent: "ż".repeat(900), summary: "ł".repeat(5000), instructions: "ą".repeat(5000) }),
		PROJECT,
		record(),
	);
	expect(Array.from(entry.intent)).toHaveLength(500);
	expect(Array.from(entry.summary)).toHaveLength(1000);
	expect(Array.from(entry.instructions)).toHaveLength(1000);
	expect(entry.intent.endsWith("…")).toBe(true);
	expect(entry.summary.endsWith("ł…")).toBe(true);
});

test("recordSend adds an entry under the owner session, newest first", () => {
	const older = logOf({ bundleId: "ovr-a-0001", sendId: "a", sentAt: NOW - 2 * MINUTE });
	const sent = record({ bundleId: "ovr-b-0001", sendId: "b", sentAt: NOW - MINUTE });
	const log = recordSend(
		older,
		entryFromBundle(bundle({ bundleId: sent.bundleId }), PROJECT, sent),
		sent,
		NOW,
	);
	expect(log.v).toBe(1);
	expect(log.sessionId).toBe("owner-session");
	expect(log.updatedAt).toBe(NOW);
	expect(log.entries.map((e) => e.bundleId)).toEqual(["ovr-b-0001", "ovr-a-0001"]);
});

test("a second send of the same bundle adds a target and lifts the entry to the top", () => {
	let log = logOf({ bundleId: "ovr-a-0001", sendId: "a1", sentAt: NOW - 3 * MINUTE });
	const other = record({ bundleId: "ovr-b-0001", sendId: "b1", sentAt: NOW - 2 * MINUTE });
	log = recordSend(
		log,
		entryFromBundle(bundle({ bundleId: other.bundleId }), PROJECT, other),
		other,
		NOW,
	);
	expect(log.entries.map((e) => e.bundleId)).toEqual(["ovr-b-0001", "ovr-a-0001"]);

	const again = record({
		bundleId: "ovr-a-0001",
		sendId: "a2",
		target: "probe-two",
		sentAt: NOW - MINUTE,
	});
	log = recordSend(
		log,
		entryFromBundle(bundle({ bundleId: again.bundleId }), PROJECT, again),
		again,
		NOW,
	);
	expect(log.entries.map((e) => e.bundleId)).toEqual(["ovr-a-0001", "ovr-b-0001"]);
	const lifted = entryAt(log);
	expect(lifted.lastSentAt).toBe(NOW - MINUTE);
	expect(lifted.targets.map((t) => t.sendId)).toEqual(["a1", "a2"]);
	expect(lifted.targetsTotal).toBe(2);
});

test("recordSend replaces a target with the same sendId and ignores another owner's log", () => {
	const first = logOf({ sendId: "s1", status: "passed-on" });
	const sent = record({ sendId: "s1", status: "held", updatedAt: NOW });
	const replaced = recordSend(first, entryFromBundle(bundle(), PROJECT, sent), sent, NOW);
	expect(entryAt(replaced).targets).toHaveLength(1);
	expect(entryAt(replaced).targets[0]?.status).toBe("held");

	const foreign = recordSend(
		{ ...first, sessionId: "someone-else" },
		entryFromBundle(bundle(), PROJECT, sent),
		sent,
		NOW,
	);
	expect(foreign.sessionId).toBe("owner-session");
	expect(foreign.entries).toHaveLength(1);
});

test("applyStatus updates a target's status without moving the entry in time", () => {
	const log = logOf({ sendId: "s1" });
	const held = record({ sendId: "s1", status: "held", reason: "waiting", updatedAt: NOW });
	const next = applyStatus(log, held, NOW + MINUTE);
	const entry = entryAt(next);
	expect(entry.targets[0]).toMatchObject({ status: "held", reason: "waiting", updatedAt: NOW });
	expect(entry.lastSentAt).toBe(entryAt(log).lastSentAt);
	expect(next?.updatedAt).toBe(NOW + MINUTE);
});

test("applyStatus returns the same log when the bundle or the send is unknown", () => {
	const log = logOf({ sendId: "s1" });
	expect(applyStatus(null, record(), NOW)).toBeNull();
	expect(applyStatus(log, record({ bundleId: "ovr-none-0000" }), NOW)).toBe(log);
	expect(applyStatus(log, record({ sendId: "unknown" }), NOW)).toBe(log);
	expect(applyStatus(log, record({ sendId: "s1" }), NOW)).toBe(log);
});

test("applyStatus cuts the reason to 120 and the target name to 80 characters", () => {
	const log = logOf({ sendId: "s1" });
	const loud = record({
		sendId: "s1",
		status: "not-passed-on",
		reason: "r".repeat(500),
		target: "t".repeat(300),
		updatedAt: NOW,
	});
	const target = entryAt(applyStatus(log, loud, NOW)).targets[0];
	expect(Array.from(target?.reason ?? "")).toHaveLength(120);
	expect(Array.from(target?.target ?? "")).toHaveLength(80);
});

// An entry as `recordSend` would store it, for tests that need many of them.
const plain = (id: string, lastSentAt: number, updatedAt = lastSentAt): HistoryEntry => ({
	bundleId: id,
	project: PROJECT,
	repo: "repo",
	branch: "main",
	composedAt: lastSentAt,
	lastSentAt,
	intent: `intent ${id}`,
	summary: "",
	instructions: "",
	files: [],
	filesTotal: 0,
	targets: [
		{ sendId: `send-${id}`, target: "t", sentAt: lastSentAt, status: "passed-on", updatedAt },
	],
	targetsTotal: 1,
});

const logWith = (entries: HistoryEntry[]): HistoryLog => ({
	v: 1,
	sessionId: "owner-session",
	updatedAt: NOW,
	entries,
});

const DAY = 24 * 60 * MINUTE;

test("trimLog keeps an entry of exactly 14 days and drops one a millisecond older", () => {
	const kept = plain("ovr-keep-0001", NOW - 14 * DAY);
	const gone = plain("ovr-gone-0001", NOW - 14 * DAY - 1);
	const trimmed = trimLog(logWith([kept, gone]), NOW);
	expect(trimmed.entries.map((e) => e.bundleId)).toEqual(["ovr-keep-0001"]);
	expect(HISTORY_MAX_AGE_MS).toBe(14 * DAY);
});

test("trimLog keeps the 50 newest entries and drops the 51st", () => {
	const entries = Array.from({ length: 51 }, (_, i) =>
		plain(`ovr-${String(i).padStart(3, "0")}-0001`, NOW - i * MINUTE),
	);
	const trimmed = trimLog(logWith(entries), NOW);
	expect(HISTORY_PER_SESSION).toBe(50);
	expect(trimmed.entries).toHaveLength(50);
	expect(trimmed.entries.at(-1)?.bundleId).toBe("ovr-049-0001");
	expect(trimLog(logWith(entries.slice(0, 50)), NOW).entries).toHaveLength(50);
});

test("trimLog puts the newer updatedAt first on a tie, then the larger bundleId", () => {
	const quiet = plain("ovr-zzz-0001", NOW - MINUTE, NOW - MINUTE);
	const busy = plain("ovr-aaa-0001", NOW - MINUTE, NOW);
	const small = plain("ovr-bbb-0001", NOW - MINUTE, NOW - 2 * MINUTE);
	const large = plain("ovr-ccc-0001", NOW - MINUTE, NOW - 2 * MINUTE);
	const order = trimLog(logWith([quiet, small, large, busy]), NOW).entries.map((e) => e.bundleId);
	expect(order).toEqual(["ovr-aaa-0001", "ovr-zzz-0001", "ovr-ccc-0001", "ovr-bbb-0001"]);
});

test("a tie at the cap keeps the same entries trimLog would rank first", () => {
	const entries = Array.from({ length: 51 }, (_, i) =>
		plain(`ovr-${String(i).padStart(3, "0")}-0001`, NOW - MINUTE),
	);
	const kept = trimLog(logWith(entries), NOW).entries.map((e) => e.bundleId);
	expect(kept).toHaveLength(50);
	expect(kept).not.toContain("ovr-000-0001");
	expect(kept[0]).toBe("ovr-050-0001");
});

test("targets beyond the 20th are counted but not stored", () => {
	let log: HistoryLog | null = null;
	const first = record({ sendId: "s0" });
	const entry = entryFromBundle(bundle(), PROJECT, first);
	for (let i = 0; i < 22; i++) {
		log = recordSend(log, entry, record({ sendId: `s${i}`, sentAt: NOW - MINUTE + i }), NOW);
	}
	const targets = entryAt(log).targets;
	expect(targets).toHaveLength(20);
	expect(entryAt(log).targetsTotal).toBe(22);
	expect(targets[0]?.sendId).toBe("s2");
	expect(targets.at(-1)?.sendId).toBe("s21");
	const newest = record({ sendId: "s21", status: "held", updatedAt: NOW + 1 });
	expect(entryAt(applyStatus(log, newest, NOW + 1)).targets.at(-1)?.status).toBe("held");
	expect(applyStatus(log, record({ sendId: "s0" }), NOW + 1)).toBe(log);
});

const jsonSize = (value: unknown): number => JSON.stringify(value).length;

test("a hostile bundle never makes an entry larger than 8000 characters", () => {
	const huge = "x".repeat(900_000);
	const hostile = bundle({
		intent: huge,
		summary: huge,
		instructions: huge,
		details: huge,
		git: git(Array.from({ length: 200 }, (_, i) => `${huge}/f${i}.ts`)),
		source: { repo: "repo", branch: "feat/x", sessionId: huge },
	});
	const first = record({ sendId: "s0", target: huge, reason: huge, status: "not-passed-on" });
	const entry = entryFromBundle(hostile, PROJECT, first);
	expect(HISTORY_ENTRY_MAX_CHARS).toBe(8000);
	expect(jsonSize(entry)).toBeLessThanOrEqual(HISTORY_ENTRY_MAX_CHARS);

	let log: HistoryLog | null = null;
	for (let i = 0; i < 25; i++) {
		const sent = record({ sendId: `s${i}`, target: huge, reason: huge, status: "not-passed-on" });
		log = recordSend(log, entry, sent, NOW);
		expect(jsonSize(entryAt(log))).toBeLessThanOrEqual(HISTORY_ENTRY_MAX_CHARS);
	}
	const loud = record({ sendId: "s3", target: huge, reason: huge, status: "expired" });
	expect(jsonSize(entryAt(applyStatus(log, loud, NOW)))).toBeLessThanOrEqual(
		HISTORY_ENTRY_MAX_CHARS,
	);
});

test("quotes that the JSON doubles do not break the 8000 limit either", () => {
	const quotes = '"'.repeat(900_000);
	const hostile = bundle({ intent: quotes, summary: quotes, instructions: quotes });
	let log: HistoryLog | null = null;
	const entry = entryFromBundle(hostile, PROJECT, record({ sendId: "s0" }));
	for (let i = 0; i < 20; i++) {
		const sent = record({ sendId: `s${i}`, target: quotes, reason: quotes, status: "refused" });
		log = recordSend(log, entry, sent, NOW);
	}
	expect(jsonSize(entryAt(log))).toBeLessThanOrEqual(HISTORY_ENTRY_MAX_CHARS);
});

test("a huge project path loses its beginning once the preview text is already cut", () => {
	const huge = `/${"p".repeat(900_000)}/tail`;
	const entry = entryFromBundle(bundle(), huge, record());
	expect(jsonSize(entry)).toBeLessThanOrEqual(HISTORY_ENTRY_MAX_CHARS);
	expect(entry.project.startsWith("…")).toBe(true);
	expect(entry.project.endsWith("/tail")).toBe(true);
	expect(entry.repo).toBe("repo");
	expect(entry.branch).toBe("feat/x");
	// The text goes first (files, instructions, summary), the path only when that was not enough.
	expect(entry.summary).toBe("");
	expect(entry.instructions).toBe("");
});

// What the store hands back: the log after a JSON round trip.
const stored = (log: HistoryLog): unknown => JSON.parse(JSON.stringify(log));

test("parseHistoryLog returns null for garbage, another version or a wrong overall shape", () => {
	const good = logWith([plain("ovr-a-0001", NOW)]);
	const garbage: unknown[] = [
		null,
		undefined,
		"text",
		42,
		[],
		{},
		{ ...good, v: 2 },
		{ ...good, v: "1" },
	];
	for (const value of garbage) expect(parseHistoryLog(value)).toBeNull();
	expect(parseHistoryLog({ ...good, sessionId: 7 })).toBeNull();
	expect(parseHistoryLog({ ...good, updatedAt: "now" })).toBeNull();
	expect(parseHistoryLog({ ...good, entries: "not an array" })).toBeNull();
});

test("parseHistoryLog round-trips a valid log and keeps only the fields it knows", () => {
	const log = logWith([plain("ovr-a-0001", NOW), plain("ovr-b-0001", NOW - MINUTE)]);
	expect(parseHistoryLog(stored(log))).toEqual(log);

	const dirty = stored(log) as {
		secret?: string;
		entries: { secret?: string; targets: { secret?: string }[] }[];
	};
	dirty.secret = "log";
	for (const entry of dirty.entries) {
		entry.secret = "entry";
		for (const target of entry.targets) target.secret = "target";
	}
	const parsed = parseHistoryLog(dirty);
	expect(parsed).toEqual(log);
	expect(JSON.stringify(parsed)).not.toContain("secret");
});

test("parseHistoryLog skips a damaged entry or target and keeps the rest", () => {
	const log = stored(
		logWith([
			plain("ovr-a-0001", NOW),
			plain("ovr-b-0001", NOW - MINUTE),
			plain("ovr-c-0001", NOW - 2 * MINUTE),
		]),
	) as { entries: Record<string, unknown>[] };
	log.entries[0] = { ...log.entries[0], lastSentAt: "yesterday" };
	log.entries[1] = { ...log.entries[1], files: [1, 2] };
	const third = log.entries[2] as { targets: Record<string, unknown>[] };
	third.targets = [
		{ ...third.targets[0], status: "exploded" },
		{ ...third.targets[0], sendId: "ok" },
	];
	const parsed = parseHistoryLog(log);
	expect(parsed?.entries.map((e) => e.bundleId)).toEqual(["ovr-c-0001"]);
	expect(parsed?.entries[0]?.targets.map((t) => t.sendId)).toEqual(["ok"]);
	expect(parseHistoryLog({ ...log, entries: [null, 3, "x", []] })?.entries).toEqual([]);
});

const logFor = (sessionId: string, entries: HistoryEntry[]): HistoryLog => ({
	...logWith(entries),
	sessionId,
});

test("projectHistory shows only the project's entries, newest first, ignoring drive-letter case", () => {
	const mine = { ...plain("ovr-a-0001", NOW - 2 * MINUTE), project: "C:/Work/Repo" };
	const newer = { ...plain("ovr-b-0001", NOW - MINUTE), project: "c:/work/repo" };
	const other = { ...plain("ovr-c-0001", NOW), project: "c:/work/other" };
	const linux = { ...plain("ovr-d-0001", NOW), project: "/work/Repo" };
	const view = projectHistory(
		[logFor("s1", [mine, other]), logFor("s2", [newer, linux])],
		"c:/work/repo",
		NOW,
	);
	expect(view.map((e) => e.bundleId)).toEqual(["ovr-b-0001", "ovr-a-0001"]);
	expect(projectHistory([logFor("s1", [linux])], "/work/repo", NOW)).toEqual([]);
});

test("projectHistory hides an entry older than 14 days by the same rule as trimLog", () => {
	const kept = plain("ovr-keep-0001", NOW - 14 * DAY);
	const gone = plain("ovr-gone-0001", NOW - 14 * DAY - 1);
	expect(projectHistory([logWith([kept, gone])], PROJECT, NOW).map((e) => e.bundleId)).toEqual([
		"ovr-keep-0001",
	]);
});

test("projectHistory joins the same bundle from two keys into one row with all its targets", () => {
	const before = plain("ovr-a-0001", NOW - 2 * MINUTE);
	const after = plain("ovr-a-0001", NOW - MINUTE);
	before.targets = [
		{
			sendId: "x",
			target: "one",
			sentAt: NOW - 2 * MINUTE,
			status: "held",
			updatedAt: NOW - 2 * MINUTE,
		},
		{
			sendId: "y",
			target: "two",
			sentAt: NOW - 2 * MINUTE,
			status: "passed-on",
			updatedAt: NOW - 2 * MINUTE,
		},
	];
	after.targets = [
		{ sendId: "x", target: "one", sentAt: NOW - 2 * MINUTE, status: "received", updatedAt: NOW },
		{
			sendId: "z",
			target: "three",
			sentAt: NOW - MINUTE,
			status: "passed-on",
			updatedAt: NOW - MINUTE,
		},
	];
	const view = projectHistory([logFor("old", [before]), logFor("new", [after])], PROJECT, NOW);
	expect(view).toHaveLength(1);
	expect(view[0]?.lastSentAt).toBe(NOW - MINUTE);
	expect(view[0]?.targets.map((t) => `${t.sendId}:${t.status}`)).toEqual([
		"x:received",
		"y:passed-on",
		"z:passed-on",
	]);
	expect(view[0]?.targetsTotal).toBe(3);
});

test("a joined row keeps the newest 20 targets and counts every one", () => {
	const target = (sendId: string, sentAt: number): HistoryEntry["targets"][number] => ({
		sendId,
		target: sendId,
		sentAt,
		status: "passed-on",
		updatedAt: sentAt,
	});
	const older = plain("ovr-a-0001", NOW - MINUTE);
	const newer = plain("ovr-a-0001", NOW);
	older.targets = Array.from({ length: 15 }, (_, i) => target(`a${i}`, NOW - 2 * MINUTE + i));
	older.targetsTotal = 15;
	newer.targets = Array.from({ length: 15 }, (_, i) => target(`b${i}`, NOW - MINUTE + i));
	newer.targetsTotal = 15;
	const row = projectHistory([logFor("old", [older]), logFor("new", [newer])], PROJECT, NOW)[0];
	expect(row?.targets).toHaveLength(20);
	expect(row?.targetsTotal).toBe(30);
	expect(row?.targets[0]?.sendId).toBe("a10");
	expect(row?.targets.at(-1)?.sendId).toBe("b14");
});

test("on equal updatedAt the joined row keeps the target of the entry that ranks first", () => {
	const winner = plain("ovr-a-0001", NOW);
	const loser = plain("ovr-a-0001", NOW - MINUTE);
	const at = NOW - 30_000;
	winner.targets = [
		{ sendId: "x", target: "from-winner", sentAt: NOW, status: "held", updatedAt: at },
	];
	loser.targets = [
		{ sendId: "x", target: "from-loser", sentAt: NOW, status: "expired", updatedAt: at },
	];
	for (const logs of [
		[logFor("a", [winner]), logFor("b", [loser])],
		[logFor("b", [loser]), logFor("a", [winner])],
	]) {
		expect(projectHistory(logs, PROJECT, NOW)[0]?.targets[0]?.target).toBe("from-winner");
	}
});

test("projectHistory shows at most 50 rows after the keys are joined", () => {
	const first = Array.from({ length: 30 }, (_, i) =>
		plain(`ovr-a${String(i).padStart(2, "0")}-0001`, NOW - i * MINUTE),
	);
	const second = Array.from({ length: 30 }, (_, i) =>
		plain(`ovr-b${String(i).padStart(2, "0")}-0001`, NOW - (i + 30) * MINUTE),
	);
	const view = projectHistory([logFor("a", first), logFor("b", second)], PROJECT, NOW);
	expect(HISTORY_SHOWN).toBe(50);
	expect(view).toHaveLength(50);
	expect(view.at(-1)?.bundleId).toBe("ovr-b19-0001");
});

test("historyPruneItem lets a history key go through selectPrunable like the other keys", () => {
	const log = logFor("old-session", [plain("ovr-a-0001", NOW - 20 * DAY)]);
	const item = historyPruneItem("history:old-session", log, 1234);
	expect(item).toEqual({
		key: "history:old-session",
		sessionId: "old-session",
		updatedAt: log.updatedAt,
		size: 1234,
	});
	const limits = { maxAgeMs: 15 * DAY, maxBytes: 1 << 30 };
	const old = { ...item, updatedAt: NOW - 16 * DAY };
	expect(selectPrunable([old], NOW, { ...limits, keepSessionId: "me" })).toEqual([
		"history:old-session",
	]);
	expect(selectPrunable([old], NOW, { ...limits, keepSessionId: "old-session" })).toEqual([]);
});

test("historyRow reads: age, intent, the first target's status, and how many more", () => {
	const entry = plain("ovr-a-0001", NOW - 5 * MINUTE);
	entry.intent = "hand off the review";
	entry.targets = [
		{
			sendId: "x",
			target: "probe-one",
			sentAt: NOW - 5 * MINUTE,
			status: "passed-on",
			updatedAt: NOW - 5 * MINUTE,
		},
		{
			sendId: "y",
			target: "probe-two",
			sentAt: NOW - 5 * MINUTE,
			status: "held",
			updatedAt: NOW - 5 * MINUTE,
		},
	];
	entry.targetsTotal = 2;
	expect(historyRow(entry, NOW)).toBe(
		"5m ago · hand off the review · passed on to probe-one (queued) +1 more",
	);
	entry.targets = entry.targets.slice(0, 1);
	entry.targetsTotal = 1;
	entry.intent = "ł".repeat(80);
	expect(historyRow(entry, NOW)).toBe(
		`5m ago · ${"ł".repeat(59)}… · passed on to probe-one (queued)`,
	);
	expect(historyRow({ ...entry, targets: [], targetsTotal: 0 }, NOW)).toBe(
		`5m ago · ${"ł".repeat(59)}…`,
	);
});

test("historyDetail lists place, send time, targets, summary, instructions and files", () => {
	const entry = entryFromBundle(
		bundle({ git: git(Array.from({ length: 45 }, (_, i) => `src/f${i}.ts`)) }),
		PROJECT,
		record({ sentAt: NOW - 3 * MINUTE, updatedAt: NOW - 3 * MINUTE }),
	);
	const lines = historyDetail(entry, NOW).split("\n");
	expect(lines).toContain("From: repo (feat/x)");
	expect(lines.some((l) => l.startsWith("Sent: 3m ago"))).toBe(true);
	expect(lines).toContain("- passed on to probe-one (queued)");
	expect(lines).toContain("Summary: Reviewed the parser.");
	expect(lines).toContain("Instructions: Finish the tests.");
	expect(lines).toContain("Files (45):");
	expect(lines).toContain("- src/f0.ts");
	expect(lines).toContain("- +15 more");
	expect(lines).not.toContain("- src/f30.ts");
});

test("a newline in a git path stays inside the one file line", () => {
	const entry = entryFromBundle(
		bundle({ git: git(["src/a.ts\nSummary: planted"]) }),
		PROJECT,
		record(),
	);
	expect(entry.files).toEqual(["src/a.ts\\nSummary: planted"]);
	const lines = historyDetail(entry, NOW).split("\n");
	expect(lines.filter((line) => line.includes("planted"))).toEqual([
		"- src/a.ts\\nSummary: planted",
	]);
	expect(lines.filter((line) => line.startsWith("Summary:"))).toEqual([
		"Summary: Reviewed the parser.",
	]);
});

test("historyDetail leaves out what an entry does not have", () => {
	const entry = { ...plain("ovr-a-0001", NOW - MINUTE), summary: "", instructions: "" };
	const text = historyDetail(entry, NOW);
	expect(text).not.toContain("Summary");
	expect(text).not.toContain("Instructions");
	expect(text).not.toContain("Files");
});

test("a huge repo and branch lose their beginning too, project first", () => {
	const huge = `${"p".repeat(900_000)}/tail`;
	const hostile = bundle({ source: { repo: huge, branch: huge, sessionId: "s" } });
	const entry = entryFromBundle(hostile, `/${huge}`, record());
	expect(jsonSize(entry)).toBeLessThanOrEqual(HISTORY_ENTRY_MAX_CHARS);
	expect(entry.project.startsWith("…")).toBe(true);
	expect(entry.branch.endsWith("/tail")).toBe(true);
});
