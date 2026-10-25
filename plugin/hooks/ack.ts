// The acknowledgement a recipient sends back, in one place: the bundle tells the recipient
// what to send (`ackMessage`) and the sender's hook reads it (`parseAck`, `matchAck`).
// Pure: no `$` in this file.

import type { SendRecord } from "./notice.js";

export type Ack = { bundleId: string; sendId: string; fromName?: string; extra: string };

export const ackMessage = (bundleId: string, sendId: string): string =>
	`over-ack ${bundleId} ${sendId}`;

// The platform wraps a peer's message in an envelope (measured, research § 5), so the
// text the hook sees is the envelope, not the bare line the recipient wrote.
const ENVELOPE = /^<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>$/;
const FROM_NAME = /\bfrom-name="([^"]*)"/;

// Identifier shapes are those of `newBundleId` and `newSendId` in bundle.ts. A model may
// type them in capitals, so matching ignores case and the result is lower-cased.
const ACK = /^over-ack[ \t]+(ovr-[0-9a-z]+-[0-9a-z]{4})[ \t]+([0-9a-f]{7})(?=\s|$)([\s\S]*)$/i;

export function parseAck(text: string): Ack | null {
	const trimmed = text.trim();
	const envelope = ENVELOPE.exec(trimmed);
	const body = envelope ? (envelope[2] ?? "").trim() : trimmed;
	const match = ACK.exec(body);
	if (!match) return null;
	const [, bundleId = "", sendId = "", extra = ""] = match;
	const fromName = envelope ? FROM_NAME.exec(envelope[1] ?? "")?.[1] : undefined;
	return {
		bundleId: bundleId.toLowerCase(),
		sendId: sendId.toLowerCase(),
		...(fromName ? { fromName } : {}),
		extra: extra.trim(),
	};
}

// The send id differs on every send, so the pair identifies exactly one record.
export const matchAck = (records: SendRecord[], ack: Ack): SendRecord | undefined =>
	records.find((r) => r.bundleId === ack.bundleId && r.sendId === ack.sendId);
