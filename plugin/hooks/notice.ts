// Delivery warnings the platform writes into the sender's conversation, matched to the
// mod's own sends, plus the status state machine. Pure: no `$` in this file.

import type { BundleKind } from "./bundle.js";

export type DeliveryKind = "held" | "released" | "denied" | "expired" | "refused" | "dropped";
export type NoticeRecipient = {
	name: string;
	/** The platform added `at uds:…`: two targets of the bundle share this name. */
	isAddressed: boolean;
};
export type DeliveryNotice = {
	kind: DeliveryKind;
	/** Messages the line speaks of: 1 for the singular wording, N for `messages (N)`. */
	count: number;
	recipients: NoticeRecipient[];
	/** The recipient list ends with `, …`: the platform left some names out. */
	isTruncated: boolean;
};
export type SendStatus =
	| "passed-on"
	| "held"
	| "released"
	| "refused"
	| "expired"
	| "not-passed-on"
	| "received";

export type SendRecord = {
	bundleId: string;
	/** Absent on records saved before broadcasts existed: those are hand-offs. */
	kind?: BundleKind;
	sendId: string;
	/** Recipient name without `[ref]`: the platform warning names the session only that way. */
	target: string;
	sentAt: number;
	status: SendStatus;
	reason?: string;
	/** The bundle's intent, cut to INTENT_MAX: the heading of the --status report. */
	intent: string;
	/** When the status last changed; equals `sentAt` until a notice or an ack arrives. */
	updatedAt: number;
	/** The session the send left from. It names the store key, which /clear does not move. */
	ownerSessionId: string;
};

export const INTENT_MAX = 60;

// Counted in code points, so a Polish letter is one character and is never cut in half.
export function truncateIntent(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	if (chars.length <= INTENT_MAX) return flat;
	return `${chars
		.slice(0, INTENT_MAX - 1)
		.join("")
		.trimEnd()}…`;
}

// `HH:MM` on this machine's clock: the --status heading and the "no news since" note.
export function clockTime(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MATCH_WINDOW_MS = 30 * 60_000;
/** A held send quiet for longer than this gets the "no news since" note in its status line. */
export const NO_NEWS_MS = 10 * 60_000;

// Wording: measured on Claude Code 2.1.302 (evidence E1), the rest read from the 2.1.310 binary
// (research.md § 3). The platform's `delivered` is our `released`. Anchored at the start of the
// text: the platform prefixes the mod's own log rows with the plugin name, so those never match,
// even if they quote a warning. Only the first sentence is read; the explanation after it
// differs between kinds and is the part most likely to change.
const VERBS: [DeliveryKind, string][] = [
	["held", "held by the receiving session"],
	["denied", "denied"],
	["expired", "expired without approval"],
	["released", "released after approval"],
	["refused", "refused"],
];
// Groups: 1 = the whole subject, 2 = N of `messages (N)`, 3 = the recipient list.
const COUNT = String.raw`(message|messages \((\d+)\))`;
// The list ends at the first ")": names keep spaces and pipes.
const LIST = String.raw` \((?:recipient|recipients): ([^)]*)\)`;
const NOTICES: [DeliveryKind, RegExp][] = [
	...VERBS.map(([kind, verb]): [DeliveryKind, RegExp] => [
		kind,
		new RegExp(String.raw`^Cross-session ${COUNT} ${verb}${LIST}\.`),
	]),
	[
		"dropped",
		new RegExp(
			String.raw`^Cross-session (message was|messages \((\d+)\) were) dropped at the recipient session's inbox${LIST} and not delivered`,
		),
	],
];

// `@name` and `@name at uds:…` name a recipient; a bare address names nobody we know.
function parseRecipient(item: string): NoticeRecipient | null {
	if (!item.startsWith("@")) return null;
	const body = item.slice(1);
	const addressed = /^(.+?) at (?:uds|bridge|did):/.exec(body);
	const name = (addressed ? addressed[1] : body)?.trim();
	return name ? { name, isAddressed: addressed !== null } : null;
}

export function parseDeliveryNotice(text: string): DeliveryNotice | null {
	const head = text.trimStart();
	for (const [kind, pattern] of NOTICES) {
		const found = pattern.exec(head);
		if (!found) continue;
		const items = (found[3] ?? "").split(", ");
		const recipients = items.flatMap((item) => {
			const recipient = parseRecipient(item);
			return recipient ? [recipient] : [];
		});
		if (recipients.length === 0) return null;
		return {
			kind,
			count: found[2] ? Number(found[2]) : 1,
			recipients,
			isTruncated: items[items.length - 1] === "…",
		};
	}
	return null;
}

// A record without its reason: a later status speaks for itself.
function withoutReason(record: SendRecord): SendRecord {
	const { reason: _dropped, ...rest } = record;
	return rest;
}

export function applySendResult(
	record: SendRecord,
	result: { isDelivered: boolean; reason?: string },
): SendRecord {
	const rest = withoutReason(record);
	return result.isDelivered
		? { ...rest, status: "passed-on" }
		: { ...rest, status: "not-passed-on", reason: result.reason ?? "" };
}

const isOpen = (status: SendStatus) => status === "passed-on" || status === "held";

// The warning names only the recipient session, so two open sends to one name cannot be
// told apart: the newest is chosen and the caller is told the pick is a guess. One call per
// recipient of the warning. Candidates: passed-on sends from the last 30 minutes, and held
// sends however old (a held send is still waiting for its outcome). A later outcome
// (released, denied, expired) can only concern a held send, so held ones take precedence.
// The pick is also a guess when the platform had to add the address to the name.
// `exclude` holds the send ids already matched by earlier recipients of the same warning, so two
// targets that share a name do not both land on one record.
export function matchNotice(
	records: SendRecord[],
	kind: DeliveryKind,
	recipient: NoticeRecipient,
	nowMs: number,
	exclude?: ReadonlySet<string>,
): { record: SendRecord; isAmbiguous: boolean } | null {
	const named = records.filter((r) => r.target === recipient.name && !exclude?.has(r.sendId));
	const held = named.filter((r) => r.status === "held");
	const open = named.filter(
		(r) => r.status === "held" || (r.status === "passed-on" && nowMs - r.sentAt <= MATCH_WINDOW_MS),
	);
	const isOutcome = kind === "released" || kind === "denied" || kind === "expired";
	const pool = (isOutcome && held.length > 0 ? held : open).sort((a, b) => b.sentAt - a.sentAt);
	const record = pool[0];
	return record ? { record, isAmbiguous: pool.length > 1 || recipient.isAddressed } : null;
}

// `released`, `expired`, `not-passed-on` (and the unused `refused`) absorb every later notice:
// notices carry no ordering guarantee, and a late `held` must not reopen a result.
// `received` is absorbing too: it is direct proof, no warning can undo it.
export function nextStatus(status: SendStatus, kind: DeliveryKind): SendStatus {
	if (!isOpen(status)) return status;
	switch (kind) {
		case "held":
			return "held";
		case "released":
			return "released";
		case "expired":
			return "expired";
		default:
			// denied, refused, dropped: the message did not reach the recipient.
			return "not-passed-on";
	}
}

const NOT_PASSED_ON_REASONS: Partial<Record<DeliveryKind, string>> = {
	denied: "the recipient's user declined it",
	refused: "the recipient refuses cross-session messages",
	dropped: "the recipient dropped the repeated text",
};

export function applyNotice(record: SendRecord, kind: DeliveryKind, now: number): SendRecord {
	const status = nextStatus(record.status, kind);
	if (status === record.status) return record;
	return status === "not-passed-on"
		? { ...record, status, updatedAt: now, reason: NOT_PASSED_ON_REASONS[kind] ?? "" }
		: { ...withoutReason(record), status, updatedAt: now };
}

// The recipient's own acknowledgement beats every earlier status, including `held` and
// `expired`: it proves the message arrived. A second ack returns the same object.
export function applyAck(record: SendRecord, now: number): SendRecord {
	if (record.status === "received") return record;
	return { ...withoutReason(record), status: "received", updatedAt: now };
}

function reasonText(reason: string | undefined): string {
	if (reason?.includes("no SendMessage tool")) {
		return "this session has no SendMessage tool (messaging between sessions is off here)";
	}
	return reason?.split(/\r?\n/)[0]?.trim() || "reason unknown";
}

/**
 * One line for the pane and the transcript. FR-009 wording: "passed on", and "received"
 * only for `received`, which comes from the recipient's acknowledgement and nothing else.
 * It must not start with the platform's warning phrase or the notice hook would see its
 * own output again.
 */
export function statusLine(record: SendRecord, isAmbiguous: boolean, now?: number): string {
	const to = record.target;
	let line: string;
	switch (record.status) {
		case "passed-on":
			line = `passed on to ${to} (queued)`;
			break;
		case "held":
			line = `held: ${to} has not seen it yet, waiting for the recipient's approval`;
			// Held sends can be settled long after the platform stops telling this session.
			if (now !== undefined && now - record.updatedAt > NO_NEWS_MS) {
				line += ` (no news since ${clockTime(record.updatedAt)}; a later outcome may not reach this session)`;
			}
			break;
		case "released":
			line = `passed on to ${to} (approved by the recipient, queued)`;
			break;
		case "expired":
			line = `expired: ${to} did not approve the message, nothing is waiting for them`;
			break;
		// Kept for type exhaustiveness: platform "refused" maps to "not-passed-on" in nextStatus.
		case "refused":
			line = `not passed on to ${to}: the recipient refuses cross-session messages`;
			break;
		case "received":
			line = `received by ${to} (acknowledged)`;
			break;
		default:
			line = `not passed on to ${to}: ${reasonText(record.reason)}`;
	}
	return isAmbiguous
		? `${line} (note: several sessions share this name, so it is unclear which one this is about)`
		: line;
}
