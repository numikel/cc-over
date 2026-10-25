// A preview of each bundle a session sent, kept in the shared `$.store` under
// `history:<ownerSessionId>` so bare `/over` and `/over --history` can list it later. Pure: no `$`
// here. Only the preview is stored (no Details, no diffs, no full text), within fixed limits.

import type { Bundle } from "./bundle.js";
import { relativeAge } from "./groups.js";
import { type SendRecord, type SendStatus, statusLine, truncateIntent } from "./notice.js";
import { normalizePath, type PruneItem } from "./registry.js";

export const HISTORY_PREFIX = "history:";
/** How many entries one session's key keeps; the oldest fall out first. */
export const HISTORY_PER_SESSION = 50;
/** How many entries the project view shows, after the keys are joined. */
export const HISTORY_SHOWN = 50;
export const HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** `JSON.stringify(entry).length` never goes above this. */
export const HISTORY_ENTRY_MAX_CHARS = 8000;

const FIELD_MAX = { intent: 500, summary: 1000, instructions: 1000, reason: 120, target: 80 };
const PATH_MAX = 120;
const FILES_MAX = 30;
const TARGETS_MAX = 20;

export type HistoryTarget = {
	sendId: string;
	target: string;
	sentAt: number;
	status: SendStatus;
	reason?: string;
	updatedAt: number;
};

export type HistoryEntry = {
	bundleId: string;
	/** `projectKey` of the sender's place: what the project view filters on. */
	project: string;
	repo: string;
	branch: string;
	/** From the bundle id; the first send's time when the id has another format. */
	composedAt: number;
	/** The newest `sentAt` of the bundle: the entry's age and its place in the list. */
	lastSentAt: number;
	intent: string;
	summary: string;
	instructions: string;
	files: string[];
	filesTotal: number;
	targets: HistoryTarget[];
	targetsTotal: number;
};

export type HistoryLog = {
	v: 1;
	/** The owner session: the one the sends left from (`SendRecord.ownerSessionId`). */
	sessionId: string;
	updatedAt: number;
	/** Newest first by `lastSentAt`. */
	entries: HistoryEntry[];
};

/** What reading the history gave: the switch is off, the store failed, or the project's rows. */
export type HistoryView =
	| { state: "off" }
	| { state: "error"; reason: string }
	| { state: "ready"; entries: HistoryEntry[]; project: string; now: number };

export function historyKey(sessionId: string): string {
	return `${HISTORY_PREFIX}${sessionId}`;
}

const BUNDLE_ID = /^ovr-([0-9a-z]+)-[0-9a-z]{4}$/;

/** When the bundle was composed, read from `ovr-<ms base36>-<4>`; null for any other id. */
export function composedAtFrom(bundleId: string): number | null {
	const digits = BUNDLE_ID.exec(bundleId)?.[1];
	if (digits === undefined) return null;
	const ms = Number.parseInt(digits, 36);
	return Number.isFinite(ms) ? ms : null;
}

// Both clips count code points, so a Polish letter is never cut in half. A code point is at most
// two UTF-16 units, so a text longer than `2 * max` units is surely too long and only its first
// (or last) `2 * max` units are worth splitting: the cost does not grow with a 900 000-char field.
function clipEnd(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = text.length > max * 2 ? text.slice(0, max * 2) : text;
	const chars = Array.from(head);
	if (head === text && chars.length <= max) return text;
	return `${chars
		.slice(0, max - 1)
		.join("")
		.trimEnd()}…`;
}

// The beginning goes, so the end of a path (the file name) stays.
function clipStart(text: string, max: number): string {
	if (text.length <= max) return text;
	const tail = text.length > max * 2 ? text.slice(-max * 2) : text;
	const chars = Array.from(tail);
	if (tail === text && chars.length <= max) return text;
	return `…${chars.slice(chars.length - (max - 1)).join("")}`;
}

function targetOf(record: SendRecord): HistoryTarget {
	const target: HistoryTarget = {
		sendId: record.sendId,
		target: clipEnd(record.target, FIELD_MAX.target),
		sentAt: record.sentAt,
		status: record.status,
		updatedAt: record.updatedAt,
	};
	if (record.reason !== undefined) target.reason = clipEnd(record.reason, FIELD_MAX.reason);
	return target;
}

// Git paths can hold a newline once unquoted. Shown raw, one would open a line of its own in the
// history preview and could pass for a Summary or an instruction. Same escapes as the bundle text
// (`bundle.ts`); that file stays untouched.
const VISIBLE_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
function visiblePath(text: string): string {
	return text.replace(
		/[\p{Cc}\p{Zl}\p{Zp}]/gu,
		(ch) => VISIBLE_ESCAPES[ch] ?? `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
	);
}

function filePaths(bundle: Bundle): string[] {
	if (bundle.git !== undefined) {
		return bundle.git.changes.map((change) => visiblePath(change.path));
	}
	return (bundle.files ?? "")
		.split(/\r?\n/)
		.map((line) => visiblePath(line.trim()))
		.filter((line) => line !== "");
}

const jsonSize = (value: unknown): number => JSON.stringify(value).length;

type TextField = "instructions" | "summary" | "intent";
type PlaceField = "project" | "repo" | "branch";

// Cuts `field` by `excess` characters or empties it; JSON only ever shrinks by at least that much.
function shrinkText(entry: HistoryEntry, field: TextField, excess: number): HistoryEntry {
	const keep = Array.from(entry[field]).length - excess;
	return { ...entry, [field]: keep <= 0 ? "" : clipEnd(entry[field], keep) };
}

// A short path is left alone: cutting it would not help and would erase where the bundle came from.
function shrinkPlace(entry: HistoryEntry, field: PlaceField, excess: number): HistoryEntry {
	const keep = Math.max(PATH_MAX, Array.from(entry[field]).length - excess);
	return { ...entry, [field]: clipStart(entry[field], keep) };
}

function dropFromEnd(entry: HistoryEntry, field: "files" | "targets"): HistoryEntry {
	const kept = [...entry[field]];
	while (kept.length > 0 && jsonSize({ ...entry, [field]: kept }) > HISTORY_ENTRY_MAX_CHARS) {
		kept.pop();
	}
	return { ...entry, [field]: kept };
}

// The order is the plan's (files, instructions, summary, then where it came from), with the intent
// and the last targets as a final guard: escaped quotes can make even capped fields too big.
const SHRINK_STEPS: ((entry: HistoryEntry, excess: number) => HistoryEntry)[] = [
	(entry) => dropFromEnd(entry, "files"),
	(entry, excess) => shrinkText(entry, "instructions", excess),
	(entry, excess) => shrinkText(entry, "summary", excess),
	(entry, excess) => shrinkPlace(entry, "project", excess),
	(entry, excess) => shrinkPlace(entry, "repo", excess),
	(entry, excess) => shrinkPlace(entry, "branch", excess),
	(entry, excess) => shrinkText(entry, "intent", excess),
	(entry) => dropFromEnd(entry, "targets"),
];

// The guard: whatever the bundle held, the stored entry stays within HISTORY_ENTRY_MAX_CHARS.
function fit(entry: HistoryEntry): HistoryEntry {
	let fitted = entry;
	for (const step of SHRINK_STEPS) {
		const excess = jsonSize(fitted) - HISTORY_ENTRY_MAX_CHARS;
		if (excess <= 0) break;
		fitted = step(fitted, excess);
	}
	return fitted;
}

/** The preview of `bundle` with `record` as its first target; details and source session are left out. */
export function entryFromBundle(bundle: Bundle, project: string, record: SendRecord): HistoryEntry {
	const paths = filePaths(bundle);
	return fit({
		bundleId: bundle.bundleId,
		project,
		repo: bundle.source.repo,
		branch: bundle.source.branch,
		composedAt: composedAtFrom(bundle.bundleId) ?? record.sentAt,
		lastSentAt: record.sentAt,
		intent: clipEnd(bundle.intent, FIELD_MAX.intent),
		summary: clipEnd(bundle.summary, FIELD_MAX.summary),
		instructions: clipEnd(bundle.instructions, FIELD_MAX.instructions),
		files: paths.slice(0, FILES_MAX).map((path) => clipStart(path, PATH_MAX)),
		filesTotal: paths.length,
		targets: [targetOf(record)],
		targetsTotal: 1,
	});
}

// When the entry last changed: the newest of its send time and its targets' status times.
function entryUpdatedAt(entry: HistoryEntry): number {
	return Math.max(entry.lastSentAt, ...entry.targets.map((t) => t.updatedAt));
}

// The one order for the cap and the list: newest send, then newest status change, then the larger
// bundleId, so equal entries rank the same way everywhere.
function newestFirst(a: HistoryEntry, b: HistoryEntry): number {
	if (a.lastSentAt !== b.lastSentAt) return b.lastSentAt - a.lastSentAt;
	const updated = entryUpdatedAt(b) - entryUpdatedAt(a);
	if (updated !== 0) return updated;
	return compareText(b.bundleId, a.bundleId);
}

// Code-unit order, not locale order: the same on every machine.
function compareText(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

// Oldest first among the ones kept, so a row still leads with the earliest stored recipient.
// Past the cap the oldest fall off: the send just made stays, and a later warning can find it.
function capTargets(targets: HistoryTarget[]): HistoryTarget[] {
	return [...targets]
		.sort((x, y) => x.sentAt - y.sentAt || compareText(x.sendId, y.sendId))
		.slice(-TARGETS_MAX);
}

/**
 * Adds `entry` to the owner's log, or, when the bundle is already there, adds `record` as one more
 * target (the same `sendId` replaces) and moves `lastSentAt` forward. `prev` is left untouched.
 */
export function recordSend(
	prev: HistoryLog | null,
	entry: HistoryEntry,
	record: SendRecord,
	now: number,
): HistoryLog {
	const base = prev !== null && prev.sessionId === record.ownerSessionId ? prev.entries : [];
	const existing = base.find((e) => e.bundleId === entry.bundleId);
	const others = base.filter((e) => e.bundleId !== entry.bundleId);
	let merged = entry;
	if (existing !== undefined) {
		const isKnown = existing.targets.some((t) => t.sendId === record.sendId);
		const targets = [
			...existing.targets.filter((t) => t.sendId !== record.sendId),
			targetOf(record),
		];
		merged = fit({
			...existing,
			lastSentAt: Math.max(existing.lastSentAt, record.sentAt),
			targets: capTargets(targets),
			targetsTotal: existing.targetsTotal + (isKnown ? 0 : 1),
		});
	}
	return {
		v: 1,
		sessionId: record.ownerSessionId,
		updatedAt: now,
		entries: [merged, ...others].sort(newestFirst),
	};
}

/**
 * Copies a send's current status into its target. Returns `prev` itself when there is no entry
 * for the bundle, no target for the send, or nothing changed, so callers can skip the write.
 */
export function applyStatus(
	prev: HistoryLog | null,
	record: SendRecord,
	now: number,
): HistoryLog | null {
	if (prev === null) return prev;
	const entry = prev.entries.find((e) => e.bundleId === record.bundleId);
	const old = entry?.targets.find((t) => t.sendId === record.sendId);
	if (entry === undefined || old === undefined) return prev;
	// Not `sentAt`: a status change never moves the entry in time.
	const next: HistoryTarget = { ...targetOf(record), sentAt: old.sentAt };
	if (JSON.stringify(next) === JSON.stringify(old)) return prev;
	return {
		...prev,
		updatedAt: now,
		entries: prev.entries.map((e) =>
			e === entry ? fit({ ...e, targets: e.targets.map((t) => (t === old ? next : t)) }) : e,
		),
	};
}

/** Drops what is older than 14 days, then keeps the newest HISTORY_PER_SESSION. */
export function trimLog(log: HistoryLog, now: number): HistoryLog {
	const fresh = log.entries.filter((e) => now - e.lastSentAt <= HISTORY_MAX_AGE_MS);
	return { ...log, entries: fresh.sort(newestFirst).slice(0, HISTORY_PER_SESSION) };
}

// A Record, not a list: tsc fails here when `SendStatus` gains a member this file does not know.
const KNOWN_STATUSES: Record<SendStatus, true> = {
	"passed-on": true,
	held: true,
	released: true,
	refused: true,
	expired: true,
	"not-passed-on": true,
	received: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isStatus(value: unknown): value is SendStatus {
	return typeof value === "string" && Object.hasOwn(KNOWN_STATUSES, value);
}

// A new target with the known fields only; null when a required field is missing or mistyped.
function parseTarget(value: unknown): HistoryTarget | null {
	if (!isRecord(value)) return null;
	const { sendId, target, sentAt, status, reason, updatedAt } = value;
	if (typeof sendId !== "string" || typeof target !== "string") return null;
	if (!isTime(sentAt) || !isTime(updatedAt) || !isStatus(status)) return null;
	if (reason !== undefined && typeof reason !== "string") return null;
	const parsed: HistoryTarget = { sendId, target, sentAt, status, updatedAt };
	if (reason !== undefined) parsed.reason = reason;
	return parsed;
}

function parseEntry(value: unknown): HistoryEntry | null {
	if (!isRecord(value)) return null;
	const { bundleId, project, repo, branch, intent, summary, instructions } = value;
	const { composedAt, lastSentAt, files, filesTotal, targets, targetsTotal } = value;
	if (
		typeof bundleId !== "string" ||
		typeof project !== "string" ||
		typeof repo !== "string" ||
		typeof branch !== "string" ||
		typeof intent !== "string" ||
		typeof summary !== "string" ||
		typeof instructions !== "string"
	) {
		return null;
	}
	if (!isTime(composedAt) || !isTime(lastSentAt) || !isTime(filesTotal) || !isTime(targetsTotal)) {
		return null;
	}
	if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) return null;
	if (!Array.isArray(targets)) return null;
	const kept: HistoryTarget[] = [];
	for (const item of targets) {
		const parsed = parseTarget(item);
		if (parsed) kept.push(parsed);
	}
	return {
		bundleId,
		project,
		repo,
		branch,
		composedAt,
		lastSentAt,
		intent,
		summary,
		instructions,
		files: files as string[],
		filesTotal,
		targets: kept,
		targetsTotal,
	};
}

/**
 * Validates a value read from the shared store, which can hold junk or another version. A wrong
 * overall shape gives null; a single damaged entry is skipped and the rest survive. Unknown
 * fields are dropped. Never throws.
 */
export function parseHistoryLog(value: unknown): HistoryLog | null {
	if (!isRecord(value) || value.v !== 1) return null;
	const { sessionId, updatedAt, entries } = value;
	if (typeof sessionId !== "string" || !isTime(updatedAt) || !Array.isArray(entries)) return null;
	const kept: HistoryEntry[] = [];
	for (const item of entries) {
		const parsed = parseEntry(item);
		if (parsed) kept.push(parsed);
	}
	return { v: 1, sessionId, updatedAt, entries: kept.slice(0, HISTORY_PER_SESSION) };
}

// One bundle sent from two keys (it was sent again after /clear): the entry that ranks first
// supplies the text, the targets are the union by `sendId`. The newer status change wins a
// target; on equal times the winner's copy stays.
function joinEntries(a: HistoryEntry, b: HistoryEntry): HistoryEntry {
	const [first, second] = newestFirst(a, b) <= 0 ? [a, b] : [b, a];
	const bySend = new Map<string, HistoryTarget>();
	for (const target of [...second.targets, ...first.targets]) {
		const seen = bySend.get(target.sendId);
		if (seen === undefined || target.updatedAt >= seen.updatedAt) bySend.set(target.sendId, target);
	}
	const union = [...bySend.values()];
	const targets = capTargets(union);
	return {
		...first,
		lastSentAt: Math.max(first.lastSentAt, second.lastSentAt),
		targets,
		targetsTotal: Math.max(first.targetsTotal, second.targetsTotal, union.length),
	};
}

/**
 * What the project view lists: the entries of `project` from every session's log, not older than
 * 14 days, the same bundle joined into one row, newest first, at most HISTORY_SHOWN.
 */
export function projectHistory(
	logs: readonly HistoryLog[],
	project: string,
	now: number,
): HistoryEntry[] {
	const wanted = normalizePath(project);
	const byBundle = new Map<string, HistoryEntry>();
	for (const log of logs) {
		for (const entry of log.entries) {
			if (normalizePath(entry.project) !== wanted) continue;
			const seen = byBundle.get(entry.bundleId);
			byBundle.set(entry.bundleId, seen === undefined ? entry : joinEntries(seen, entry));
		}
	}
	return [...byBundle.values()]
		.filter((e) => now - e.lastSentAt <= HISTORY_MAX_AGE_MS)
		.sort(newestFirst)
		.slice(0, HISTORY_SHOWN);
}

/** Lets a history log go through `selectPrunable` next to the registry entries and send logs. */
export function historyPruneItem(key: string, log: HistoryLog, size: number): PruneItem {
	return { key, sessionId: log.sessionId, updatedAt: log.updatedAt, size };
}

// `statusLine` wants a whole SendRecord but reads only the target, status, reason and updatedAt.
function statusOf(entry: HistoryEntry, target: HistoryTarget, now: number): string {
	return statusLine(
		{ ...target, bundleId: entry.bundleId, intent: "", ownerSessionId: "" },
		false,
		now,
	);
}

/** One list row: age, intent, the first target's status and how many more there are. */
export function historyRow(entry: HistoryEntry, now: number): string {
	const parts = [`${relativeAge(now - entry.lastSentAt)} ago`, truncateIntent(entry.intent)];
	const first = entry.targets[0];
	if (first !== undefined) {
		const more = entry.targetsTotal - 1;
		parts.push(`${statusOf(entry, first, now)}${more > 0 ? ` +${more} more` : ""}`);
	}
	return parts.join(" · ");
}

// UTC, so the same entry reads the same on every machine (and in every test).
function utcStamp(ms: number): string {
	const date = new Date(ms);
	return Number.isNaN(date.getTime())
		? "unknown time"
		: `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The whole preview of one entry, one fact per line. */
export function historyDetail(entry: HistoryEntry, now: number): string {
	const lines = [
		`Intent: ${entry.intent}`,
		`From: ${entry.repo} (${entry.branch})`,
		`Sent: ${relativeAge(now - entry.lastSentAt)} ago (${utcStamp(entry.lastSentAt)})`,
	];
	if (entry.targets.length > 0) {
		lines.push("To:", ...entry.targets.map((t) => `- ${statusOf(entry, t, now)}`));
		if (entry.targetsTotal > entry.targets.length) {
			lines.push(`- +${entry.targetsTotal - entry.targets.length} more`);
		}
	}
	if (entry.summary !== "") lines.push(`Summary: ${entry.summary}`);
	if (entry.instructions !== "") lines.push(`Instructions: ${entry.instructions}`);
	if (entry.filesTotal > 0) {
		lines.push(`Files (${entry.filesTotal}):`, ...entry.files.map((f) => `- ${f}`));
		if (entry.filesTotal > entry.files.length) {
			lines.push(`- +${entry.filesTotal - entry.files.length} more`);
		}
	}
	return lines.join("\n");
}
