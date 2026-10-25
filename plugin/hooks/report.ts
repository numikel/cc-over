// The `/over --status` report and the pane block, built from the recorded sends.
// Pure: no `$` in this file.

import { clockTime, type SendRecord, statusLine } from "./notice.js";

const bySendingOrder = (a: SendRecord, b: SendRecord) => a.sentAt - b.sentAt;

// All records of one bundle share the kind; a record without one is a hand-off.
function heading(group: readonly SendRecord[]): string {
	const first = group[0];
	const label = first?.kind === "broadcast" ? "broadcast: " : "";
	return `${clockTime(first?.sentAt ?? 0)} ${label}${first?.intent ?? ""}`;
}

/**
 * Sends grouped by bundle, the group with the newest send first. Each group is a header
 * (`HH:MM intent` of its earliest send; `HH:MM broadcast: intent` for a broadcast) and one indented status line per target, in sending order.
 */
export function statusReport(records: SendRecord[], now: number): string[] {
	if (records.length === 0) return ["no sends recorded for this session"];
	const groups = new Map<string, SendRecord[]>();
	for (const record of records) {
		const group = groups.get(record.bundleId);
		if (group) group.push(record);
		else groups.set(record.bundleId, [record]);
	}
	const ordered = [...groups.values()]
		.map((group) => group.sort(bySendingOrder))
		.sort((a, b) => (b.at(-1)?.sentAt ?? 0) - (a.at(-1)?.sentAt ?? 0));
	return ordered.flatMap((group) => [
		heading(group),
		...group.map((record) => `  ${statusLine(record, false, now)}`),
	]);
}

/** The lines of one bundle for the pane block: no header, no indent; an unknown bundle gives []. */
export function bundleLines(records: SendRecord[], bundleId: string, now: number): string[] {
	return records
		.filter((record) => record.bundleId === bundleId)
		.sort(bySendingOrder)
		.map((record) => statusLine(record, false, now));
}
