// Pure checks of the hand-off acceptance run: what a delivered bundle, a preview and a delivery
// warning look like in the streams. No process, no I/O; `--selftest` covers all of it.

// Every string value found anywhere inside `value`, in document order. The shape of the event that
// carries a cross-session message is not documented, so the streams are searched by text, not by
// field name.
export function allStrings(value) {
	const found = [];
	const walk = (node) => {
		if (typeof node === "string") found.push(node);
		else if (Array.isArray(node)) node.forEach(walk);
		else if (typeof node === "object" && node !== null) Object.values(node).forEach(walk);
	};
	walk(value);
	return found;
}

// The first lines of a bundle (plugin/hooks/bundle.ts, `render`). The preview carries a
// `Send: <send-id>` placeholder, so only a delivered bundle has a `sendId` (7 hex characters).
const HEADER_RE =
	/\[claude-over hand-off (ovr-[0-9a-z]+-[0-9a-z]{4})\](?:[ \t]*\r?\n[ \t]*Send: ([0-9a-f]{7})(?![0-9a-z]))?/g;

export function findHeaders(text) {
	return [...text.matchAll(HEADER_RE)].map((match) => {
		const [, bundleId, sendId] = match;
		return sendId === undefined ? { bundleId } : { bundleId, sendId };
	});
}

// Guardrail of the run: a message goes only to a session this script started itself.
export const TARGET_PREFIX = "probe-handoff-";
const TARGET_RE = /^probe-handoff-[a-z0-9][a-z0-9-]*$/;

export const isProbeTarget = (name) => typeof name === "string" && TARGET_RE.test(name);

const SECTIONS = ["## Summary", "## Instructions", "## Changed files"];

// The compose preview that `-p` logs, one ui_log line per line. A fork that fell back to the
// intent alone is reported in `fallbackNote` and does not fail the check: the delivery is what
// this run proves, not the quality of a model's summary.
export function composeVerdict(lines, { fileName }) {
	const problems = [];
	const [first] = findHeaders(lines.join("\n"));
	if (first === undefined)
		problems.push("no bundle header ([claude-over hand-off <id>]) in the log");
	for (const section of SECTIONS) {
		if (!lines.some((line) => line.includes(section)))
			problems.push(`missing section "${section}"`);
	}
	if (!lines.some((line) => line.includes(fileName))) {
		problems.push(`the changed file ${fileName} is not listed`);
	}
	const fallbackNote = lines.find((line) => line.includes("no conversation summary:"));
	return {
		ok: problems.length === 0,
		bundleId: first?.bundleId,
		problems,
		...(fallbackNote === undefined ? {} : { fallbackNote }),
	};
}

// The wrapper the platform puts around a message from another session.
const FROM_NAME_RE = /<cross-session-message[^>]*\bfrom-name="([^"]*)"/;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The status line the mod logs after a send (plugin/hooks/notice.ts, `statusLine`).
export function sendVerdict(lines, target) {
	const queued = new RegExp(`passed on to ${escapeRe(target)} \\(queued\\)`);
	if (lines.some((line) => queued.test(line))) return { ok: true, problems: [] };
	const seen = lines.filter((line) => line.includes("passed on"));
	return {
		ok: false,
		problems: [
			seen.length === 0
				? `no "passed on to ${target} (queued)" line in the log`
				: `not queued for ${target}: ${seen.join(" | ")}`,
		],
	};
}

// What a receiver that accepts messages saw. The same delivery can show up in several events (the
// injected message, a quote by the model, the final result), so deliveries are counted by their
// distinct send ids, and one text with the approval block is enough.
export function deliveryVerdict(texts, bundleId, { expected = 2 } = {}) {
	const problems = [];
	const sendIds = [];
	let hasApproval = false;
	let fromName;
	for (const text of texts) {
		const own = findHeaders(text).filter((h) => h.bundleId === bundleId && h.sendId !== undefined);
		for (const { sendId } of own) if (!sendIds.includes(sendId)) sendIds.push(sendId);
		if (own.length === 0) continue;
		if (/^Approved by the user:/m.test(text)) hasApproval = true;
		fromName ??= FROM_NAME_RE.exec(text)?.[1];
	}
	if (sendIds.length < expected) {
		problems.push(`expected ${expected} distinct send ids for ${bundleId}, saw ${sendIds.length}`);
	}
	if (sendIds.length > 0 && !hasApproval) {
		problems.push('the delivered text has no "Approved by the user:" block');
	}
	return {
		ok: problems.length === 0,
		problems,
		sendIds,
		...(fromName === undefined ? {} : { fromName }),
	};
}

// A `-p` receiver's stream carries no text of an injected message (only `command_lifecycle`
// events), but its transcript does: every string of every JSON line of that file.
export function transcriptStrings(jsonl) {
	return jsonl.split("\n").flatMap((line) => {
		try {
			return allStrings(JSON.parse(line));
		} catch {
			return [];
		}
	});
}

// A receiver that holds every message must never have seen a bundle.
export function holdVerdict(texts) {
	const seen = texts.flatMap(findHeaders);
	return {
		ok: seen.length === 0,
		problems: seen.map((h) => `the holding receiver saw ${h.bundleId}`),
	};
}

// The platform's delivery warnings reach the sender as system lines of the stream; the sender's
// model may quote them later, so only system events count.
export function noticeVerdict(events) {
	const system = events.filter((event) => event.kind === "system");
	return {
		isHeld: system.some((event) =>
			/^Cross-session message held by the receiving session/m.test(event.text),
		),
		isDropped: system.some((event) => /repeated your previous message/.test(event.text)),
	};
}
