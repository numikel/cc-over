// Hand-off bundle: the fork prompt, its parsed reply, and the fixed template that is
// sent to the recipient. Pure: no `$` in this file.
import type { GitSummary } from "./git.js";

export type Bundle = {
	bundleId: string;
	intent: string;
	summary: string;
	instructions: string;
	details: string;
	/** Files named by the model; only set when git was unavailable (unverified). */
	files?: string;
	/** Why there is no conversation summary, when there is none. */
	note?: string;
	git?: GitSummary;
	source: { name?: string; repo: string; branch: string; sessionId: string };
};

export type ForkReply = {
	summary: string;
	instructions: string;
	details: string;
	files?: string;
	isStructured: boolean;
};

export type Preview = {
	/** Single-line items for the pane summary and `-p` logs (a newline draws as a glyph). */
	lines: string[];
	meta: string;
	/** The text as the recipient will see it, with a placeholder where the send id goes. */
	full: string;
};

// The platform limit is ~1M characters (research § 10).
const SIZE_LIMIT = 900_000;
const SUMMARY_FALLBACK_CHARS = 300;
const LINE_MAX = 200;
const TRUNCATED_NOTE = "[truncated: bundle exceeded size limit]";

export function forkPrompt(intent: string, opts: { filesFromModel: boolean }): string {
	const sections = [
		"### SUMMARY\nAt most 3 sentences: what was done in this conversation and where it stands.",
		"### INSTRUCTIONS\nWhat the recipient should do, concretely, to carry out the intent.",
		"### DETAILS\nContext the recipient needs: decisions and why, current state, open questions, relevant paths.",
	];
	if (opts.filesFromModel) {
		sections.push(
			"### FILES\nOne path per line: the files changed in this conversation. Say so if you are unsure.",
		);
	}
	return [
		`You are preparing a hand-off of this conversation for another Claude Code session. The user's intent: ${intent}`,
		"Reply with exactly the sections below, in this order, under these exact headings. No preface and no tool calls. Write in the language of the intent.",
		sections.join("\n\n"),
	].join("\n\n");
}

export function parseForkReply(text: string): ForkReply {
	const headers = [...text.matchAll(/^###[ \t]+(SUMMARY|INSTRUCTIONS|DETAILS|FILES)[ \t]*$/gim)];
	const sections = new Map<string, string>();
	headers.forEach((match, i) => {
		const name = (match[1] ?? "").toLowerCase();
		const end = headers[i + 1]?.index ?? text.length;
		const body = text.slice((match.index ?? 0) + match[0].length, end).trim();
		if (!sections.has(name)) sections.set(name, body);
	});

	const files = sections.get("files");
	const filesPart = files ? { files } : {};
	const summary = sections.get("summary") ?? "";
	const instructions = sections.get("instructions") ?? "";
	if (summary !== "" && instructions !== "") {
		return {
			summary,
			instructions,
			details: sections.get("details") ?? "",
			...filesPart,
			isStructured: true,
		};
	}
	const flat = text.trim();
	return {
		summary:
			flat.length > SUMMARY_FALLBACK_CHARS
				? `${flat.slice(0, SUMMARY_FALLBACK_CHARS).trimEnd()}…`
				: flat,
		instructions: "",
		details: text,
		...filesPart,
		isStructured: false,
	};
}

export function noModelContent(
	intent: string,
	reason: string,
): { summary: string; instructions: string; details: string; note: string } {
	return {
		summary: intent,
		instructions: intent,
		details: "",
		note: `no conversation summary: ${reason}`,
	};
}

// `entropy` is a number in [0, 1) like Math.random(); injected to keep this module deterministic.
function entropyDigits(entropy: number, radix: number, width: number): string {
	const size = radix ** width;
	const n = Number.isFinite(entropy) ? Math.floor(entropy * size) : 0;
	return Math.min(Math.max(n, 0), size - 1)
		.toString(radix)
		.padStart(width, "0");
}

export const newBundleId = (nowMs: number, entropy: number): string =>
	`ovr-${Math.floor(nowMs).toString(36)}-${entropyDigits(entropy, 36, 4)}`;

// A new id on every send: the platform silently drops a second identical message to
// the same recipient (evidence E2), so a re-send of one bundle must differ in text.
export const newSendId = (entropy: number): string => entropyDigits(entropy, 16, 7);

export const bundleSizeOk = (text: string): boolean => text.length < SIZE_LIMIT;

function modeLabel(git: GitSummary): string {
	switch (git.mode) {
		case "branch-diff":
			return `branch diff against ${git.base}`;
		case "session-commits":
			return "commits made during this session";
		default:
			return "uncommitted changes only";
	}
}

// Git paths can hold a newline once unquoted; shown raw, one would open a line of its own in
// the bundle and could pass for a header or an instruction. Control characters stay visible.
const VISIBLE_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const visible = (text: string): string =>
	text.replace(
		/[\p{Cc}\p{Zl}\p{Zp}]/gu,
		(ch) => VISIBLE_ESCAPES[ch] ?? `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
	);

function changedFiles(b: Bundle, isTrimmed: boolean): string {
	if (isTrimmed) return `## Changed files\n${TRUNCATED_NOTE}`;
	const { git } = b;
	if (git) {
		const rows = git.changes.map(
			(c) =>
				`- ${c.status} ${visible(c.path)}${c.from ? ` <- ${visible(c.from)}` : ""} (${c.source})`,
		);
		if (rows.length === 0) rows.push("(no changes detected)");
		if (git.truncated > 0) rows.push(`...and ${git.truncated} more not listed`);
		if (git.note) rows.push(`Note: ${git.note}`);
		return [`## Changed files (git, ${modeLabel(git)})`, ...rows].join("\n");
	}
	const files = b.files?.trim();
	if (files) {
		return `## Changed files (unverified: listed by the model, not read from git)\n${files}`;
	}
	return "## Changed files\n(unknown: git was not available)";
}

function render(b: Bundle, sendId: string, isTrimmed: boolean): string {
	const { source } = b;
	const from = source.name ?? `${source.repo}/${source.sessionId.slice(0, 8)}`;
	const header = [
		`[claude-over hand-off ${b.bundleId}]`,
		`Send: ${sendId}`,
		`From: ${from} · repo ${source.repo} · branch ${source.branch} · session ${source.sessionId}`,
		"Approved by the user: they reviewed this hand-off in a preview and chose to send it to you. It is not a prompt typed by the user in this session.",
		"Handling: finish your current task first, then pick up the work below. If you are busy, add it to your task list and say so.",
	].join("\n");

	const detailParts = isTrimmed
		? [TRUNCATED_NOTE]
		: [b.details.trim(), b.note ? `Note: ${b.note}` : ""].filter((part) => part !== "");
	const blocks = [
		header,
		`## Summary\n${b.summary.trim() || b.intent}`,
		`## Instructions\n${b.instructions.trim() || b.intent}`,
		changedFiles(b, isTrimmed),
	];
	if (detailParts.length > 0) blocks.push(`## Details\n${detailParts.join("\n\n")}`);
	return blocks.join("\n\n");
}

export function renderBundle(b: Bundle, sendId: string): string {
	const full = render(b, sendId, false);
	if (bundleSizeOk(full)) return full;
	const trimmed = render(b, sendId, true);
	return bundleSizeOk(trimmed)
		? trimmed
		: `${trimmed.slice(0, SIZE_LIMIT - TRUNCATED_NOTE.length - 10)}\n\n${TRUNCATED_NOTE}`;
}

const oneLine = (label: string, text: string): string => {
	const chunk = text.slice(0, LINE_MAX * 2);
	const flat = `${label}${chunk}`.replace(/\s+/g, " ").trim();
	return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX).trimEnd()}…` : flat;
};

export function previewModel(b: Bundle): Preview {
	const { git } = b;
	const files = git
		? `files: ${git.changes.length + git.truncated} (${
				git.mode === "branch-diff" ? `branch-diff vs ${git.base}` : git.mode
			})`
		: b.files
			? "files: unverified (from the model)"
			: "files: no data (git unavailable)";
	return {
		lines: [
			oneLine("", `[claude-over hand-off ${b.bundleId}]`),
			oneLine("Summary: ", b.summary.trim() || b.intent),
			oneLine("Instructions: ", b.instructions.trim() || b.intent),
		],
		meta: [`branch ${b.source.branch}`, files, b.note].filter(Boolean).join(" · "),
		full: renderBundle(b, "<send-id>"),
	};
}
