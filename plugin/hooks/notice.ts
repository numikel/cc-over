// Delivery warnings the platform writes into the sender's conversation, matched to the
// mod's own sends, plus the status state machine. Pure: no `$` in this file.

export type DeliveryKind = "held" | "refused" | "expired" | "dropped";
export type DeliveryNotice = { kind: DeliveryKind; recipient: string };
export type SendStatus = "passed-on" | "held" | "refused" | "expired" | "not-passed-on";

export type SendRecord = {
	bundleId: string;
	sendId: string;
	/** Recipient name without `[ref]`: the platform warning names the session only that way. */
	target: string;
	sentAt: number;
	status: SendStatus;
	reason?: string;
};

const MATCH_WINDOW_MS = 30 * 60_000;

// Wording measured on Claude Code 2.1.302 (evidence E1). The name ends at the first ")".
// Anchored at the start of the text: the platform prefixes the mod's own log rows with
// the plugin name, so those never match, even if they quote a warning.
const NOTICES: [DeliveryKind, RegExp][] = [
	["held", /^Cross-session message held by the receiving session \(recipient: @([^)]+)\)/],
	["refused", /^Cross-session message refused \(recipient: @([^)]+)\)/],
	["expired", /^Cross-session message expired without approval \(recipient: @([^)]+)\)/],
	[
		"dropped",
		/^Cross-session message was dropped at the recipient session's inbox \(recipient: @([^)]+)\)/,
	],
];

export function parseDeliveryNotice(text: string): DeliveryNotice | null {
	const head = text.trimStart();
	for (const [kind, pattern] of NOTICES) {
		const recipient = pattern.exec(head)?.[1]?.trim();
		if (recipient) return { kind, recipient };
	}
	return null;
}

export function applySendResult(
	record: SendRecord,
	result: { isDelivered: boolean; reason?: string },
): SendRecord {
	const { bundleId, sendId, target, sentAt } = record;
	return result.isDelivered
		? { bundleId, sendId, target, sentAt, status: "passed-on" }
		: { bundleId, sendId, target, sentAt, status: "not-passed-on", reason: result.reason ?? "" };
}

const isOpen = (status: SendStatus) => status === "passed-on" || status === "held";

// The warning names only the recipient session, so two open sends to one name cannot be
// told apart: the newest is chosen and the caller is told the pick is a guess.
export function matchNotice(
	records: SendRecord[],
	notice: DeliveryNotice,
	nowMs: number,
): { record: SendRecord; isAmbiguous: boolean } | null {
	const candidates = records
		.filter(
			(r) =>
				isOpen(r.status) && r.target === notice.recipient && nowMs - r.sentAt <= MATCH_WINDOW_MS,
		)
		.sort((a, b) => b.sentAt - a.sentAt);
	const record = candidates[0];
	return record ? { record, isAmbiguous: candidates.length > 1 } : null;
}

// `not-passed-on`, `expired` (and the unused `refused`) absorb every later notice:
// notices carry no ordering guarantee, and a late `held` must not reopen a result.
export function nextStatus(status: SendStatus, kind: DeliveryKind): SendStatus {
	if (!isOpen(status)) return status;
	switch (kind) {
		case "held":
			return "held";
		case "expired":
			return "expired";
		default:
			return "not-passed-on";
	}
}

const NOT_PASSED_ON_REASONS: Partial<Record<DeliveryKind, string>> = {
	refused: "the recipient refuses cross-session messages",
	dropped: "the recipient dropped the repeated text",
};

export function applyNotice(record: SendRecord, kind: DeliveryKind): SendRecord {
	const status = nextStatus(record.status, kind);
	if (status === record.status) return record;
	return status === "not-passed-on"
		? { ...record, status, reason: NOT_PASSED_ON_REASONS[kind] ?? "" }
		: { ...record, status };
}

function reasonText(reason: string | undefined): string {
	if (reason?.includes("no SendMessage tool")) {
		return "this session has no SendMessage tool (messaging between sessions is off here)";
	}
	return reason?.split(/\r?\n/)[0]?.trim() || "reason unknown";
}

/**
 * One line for the pane and the transcript. FR-009 wording: "passed on", never "received".
 * It must not start with the platform's warning phrase or the notice hook would see its
 * own output again.
 */
export function statusLine(record: SendRecord, isAmbiguous: boolean): string {
	const to = record.target;
	let line: string;
	switch (record.status) {
		case "passed-on":
			line = `passed on to ${to} (queued)`;
			break;
		case "held":
			line = `held: ${to} has not seen it yet, waiting for the recipient's approval`;
			break;
		case "expired":
			line = `expired: ${to} did not approve the message, nothing is waiting for them`;
			break;
		case "refused":
			line = `not passed on to ${to}: the recipient refuses cross-session messages`;
			break;
		default:
			line = `not passed on to ${to}: ${reasonText(record.reason)}`;
	}
	return isAmbiguous
		? `${line} (note: several sessions share this name, so it is unclear which one this is about)`
		: line;
}
