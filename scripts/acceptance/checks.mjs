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

// The first lines of a bundle (plugin/hooks/bundle.ts, `render`; one grammar for a hand-off and a
// broadcast). The preview carries a `Send: <send-id>` placeholder, so only a delivered bundle has
// a `sendId` (7 hex characters).
const HEADER_RE =
	/\[claude-over (?:hand-off|broadcast) (ovr-[0-9a-z]+-[0-9a-z]{4})\](?:[ \t]*\r?\n[ \t]*Send: ([0-9a-f]{7})(?![0-9a-z]))?/g;

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

// `/over --status` after the run (phase-3 `statusReport`): a header `HH:MM <intent>` (cut to 60
// characters with an ellipsis when long) and one line per target. `lines` are the status process's
// ui_log texts: each is split on newlines and matched with a plugin prefix and the indentation
// tolerated. The `-p` sender never sees the platform's held warning, so its record for the hold
// receiver stays 'passed on'. `ackSeen` is whether the run saw the acknowledgement: then the accept
// receiver must read 'received by'; otherwise 'passed on to' is as good.
export function statusVerdict(lines, { intent, accept, hold, ackSeen }) {
	const rows = lines.flatMap((text) => text.split(/\r?\n/));
	const problems = [];
	const hasHeader = rows.some((row) => {
		const body = /\b\d{2}:\d{2} (.+)$/.exec(row)?.[1].trimEnd().replace(/…$/, "").trimEnd();
		return body !== undefined && body !== "" && intent.startsWith(body);
	});
	if (!hasHeader) problems.push(`no header "HH:MM ${intent}" in the status report`);
	const received = new RegExp(`received by ${escapeRe(accept)}(?![A-Za-z0-9-])`);
	const passedOn = (name) => new RegExp(`(?<!not )passed on to ${escapeRe(name)}(?![A-Za-z0-9-])`);
	const acceptOk = rows.some(
		(row) => received.test(row) || (!ackSeen && passedOn(accept).test(row)),
	);
	if (!acceptOk) {
		problems.push(
			ackSeen
				? `no "received by ${accept}" line in the status report`
				: `no "received by ${accept}" or "passed on to ${accept}" line in the status report`,
		);
	}
	if (!rows.some((row) => passedOn(hold).test(row))) {
		problems.push(`no "passed on to ${hold}" line in the status report`);
	}
	for (const row of rows.filter((r) => r.includes("not passed on"))) {
		problems.push(`the status report has a refused send: ${row.trim()}`);
	}
	return { ok: problems.length === 0, problems };
}

// The status process resumed the sender's session: its `system/init` must carry the same id.
// A new id would mean `--resume` in `-p` forked the session, and the report below would be empty
// for a reason other than the mod's.
export function resumeVerdict(senderId, statusId) {
	if (senderId === undefined) {
		return { ok: false, problems: ["the sender never reported a session id"] };
	}
	if (statusId === undefined) {
		return { ok: false, problems: ["the status process never reported a session id"] };
	}
	if (statusId !== senderId) {
		return {
			ok: false,
			problems: [
				`--resume in -p assigned a new id: sender ${senderId}, status process ${statusId}`,
			],
		};
	}
	return { ok: true, problems: [] };
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

// What the receivers of a broadcast saw. `seen` maps a receiver's name to the strings it carried
// (stream plus transcript). A broadcast has the hand-off's six header lines (plugin/hooks/bundle.ts,
// `render`), then ONE section, `## Message`, with the intent word for word, and none of the
// hand-off sections. The same delivery shows up in several strings of a transcript, so only the part
// of a string from the broadcast's header up to the next `[claude-over ` marker is judged: a
// hand-off the same receiver got earlier has a `## Summary` that is not this broadcast's.
export function broadcastVerdict(seen, { accept, note, bundleId, intent }) {
	if (bundleId === undefined) {
		return {
			ok: false,
			problems: ["no bundle id to look for: the broadcast preview had no header"],
		};
	}
	const header = new RegExp(
		`\\[claude-over broadcast ${escapeRe(bundleId)}\\][ \\t]*\\r?\\n[ \\t]*Send: [0-9a-f]{7}(?![0-9a-z])`,
	);
	const problems = [];
	for (const name of [accept, note]) {
		const bodies = (seen[name] ?? []).flatMap((text) => {
			const start = header.exec(text)?.index;
			if (start === undefined) return [];
			const body = text.slice(start);
			const next = body.indexOf("[claude-over ", 1);
			return [next === -1 ? body : body.slice(0, next)];
		});
		if (bodies.length === 0) {
			problems.push(`${name} never saw "[claude-over broadcast ${bundleId}]" with a Send: id`);
			continue;
		}
		const hasMessage = bodies.some((body) => {
			const at = body.indexOf("## Message");
			return at !== -1 && body.indexOf(intent, at) !== -1;
		});
		if (!hasMessage) {
			problems.push(`${name}: no "## Message" section that holds the intent`);
		}
		for (const section of SECTIONS) {
			if (bodies.some((body) => body.includes(section))) {
				problems.push(`${name}: a broadcast must not carry "${section}"`);
			}
		}
	}
	return { ok: problems.length === 0, problems };
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

// The acknowledgement the mod's `session.receive` hook intercepts (plugin/hooks/register.ts,
// `observeAck`; the line is `statusLine` of the `received` status). Two proofs in one verdict:
// the mod logged `received by <target> (acknowledged)` (only the mod writes `ui_log` events, so a
// quote by the sender's model cannot fake it), and the sender's model ran no turn of its own
// since `before` results (`{consumed}` takes the message before the model). `before` is the
// result count read right after the explicit send steps, which are turns themselves.
export function ackVerdict(events, target, { before }) {
	const line = new RegExp(`received by ${escapeRe(target)} \\(acknowledged\\)`);
	const received = events.filter((e) => e.kind === "ui_log" && line.test(e.text)).length;
	const extraTurns = Math.max(0, events.filter((e) => e.kind === "result").length - before);
	const problems = [];
	if (received === 0) {
		problems.push(`no "received by ${target} (acknowledged)" line in the sender's log`);
	}
	if (extraTurns > 0) {
		problems.push(
			`the sender's model ran ${extraTurns} turn(s) after the sends: the acknowledgement was not consumed`,
		);
	}
	return { ok: problems.length === 0, problems, received, extraTurns };
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
