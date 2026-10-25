// What each session remembers about the messages it sent, kept in the shared `$.store` under
// `sends:<ownerSessionId>` so `/over --status` still works after a reload. Pure: no `$` here.

import type { SendRecord, SendStatus } from "./notice.js";
import type { PruneItem } from "./registry.js";

export const SENDLOG_PREFIX = "sends:";
/**
 * How many sends one session keeps; the oldest fall out first. A broadcast writes one record per
 * target, so the limit has to hold a few of them next to the hand-offs.
 */
export const SENDS_PER_SESSION = 50;

export type SendLog = {
	v: 1;
	/** The owner session: the one the sends left from (`SendRecord.ownerSessionId`). */
	sessionId: string;
	updatedAt: number;
	/** Newest first by `sentAt`. */
	sends: SendRecord[];
};

export function sendLogKey(sessionId: string): string {
	return `${SENDLOG_PREFIX}${sessionId}`;
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

// A new record with the known fields only; null when any required field is missing or mistyped.
function parseRecord(value: unknown): SendRecord | null {
	if (!isRecord(value)) return null;
	const {
		bundleId,
		kind,
		sendId,
		target,
		intent,
		ownerSessionId,
		sentAt,
		updatedAt,
		status,
		reason,
	} = value;
	if (
		typeof bundleId !== "string" ||
		typeof sendId !== "string" ||
		typeof target !== "string" ||
		typeof intent !== "string" ||
		typeof ownerSessionId !== "string"
	) {
		return null;
	}
	if (!isTime(sentAt) || !isTime(updatedAt) || !isStatus(status)) return null;
	if (reason !== undefined && typeof reason !== "string") return null;
	const parsed: SendRecord = {
		bundleId,
		sendId,
		target,
		sentAt,
		status,
		intent,
		updatedAt,
		ownerSessionId,
	};
	if (reason !== undefined) parsed.reason = reason;
	// An unknown kind is dropped, not fatal: the record stays valid and reads as a hand-off.
	if (kind === "hand-off" || kind === "broadcast") parsed.kind = kind;
	return parsed;
}

/**
 * Validates a value read from the shared store, which can hold junk or another version. A wrong
 * overall shape gives null; a single damaged record (or one with an unknown status) is skipped
 * and the rest survive. Never throws.
 */
export function parseSendLog(value: unknown): SendLog | null {
	if (!isRecord(value) || value.v !== 1) return null;
	const { sessionId, updatedAt, sends } = value;
	if (typeof sessionId !== "string" || !isTime(updatedAt) || !Array.isArray(sends)) return null;
	const kept: SendRecord[] = [];
	for (const item of sends) {
		const parsed = parseRecord(item);
		if (parsed) kept.push(parsed);
	}
	return { v: 1, sessionId, updatedAt, sends: kept.slice(0, SENDS_PER_SESSION) };
}

// Distinct by `sendId` (the first occurrence wins), newest first, at most SENDS_PER_SESSION.
function newest(records: readonly SendRecord[]): SendRecord[] {
	const seen = new Set<string>();
	const unique = records.filter((r) => {
		if (seen.has(r.sendId)) return false;
		seen.add(r.sendId);
		return true;
	});
	return unique.sort((a, b) => b.sentAt - a.sentAt).slice(0, SENDS_PER_SESSION);
}

/** Replaces the record with the same `sendId` (or adds it); `prev` is left untouched. */
export function upsertSend(prev: SendLog | null, record: SendRecord, now: number): SendLog {
	const base = prev !== null && prev.sessionId === record.ownerSessionId ? prev.sends : [];
	const others = base.filter((r) => r.sendId !== record.sendId);
	return {
		v: 1,
		sessionId: record.ownerSessionId,
		updatedAt: now,
		sends: newest([record, ...others]),
	};
}

/** Union of the in-memory and stored records by `sendId`; the memory copy is the newer truth. */
export function mergeRecords(memory: SendRecord[], stored: SendRecord[]): SendRecord[] {
	return newest([...memory, ...stored]);
}

/** Lets a send log go through `selectPrunable` next to the registry entries. */
export function sendLogPruneItem(key: string, log: SendLog, size: number): PruneItem {
	return { key, sessionId: log.sessionId, updatedAt: log.updatedAt, size };
}
