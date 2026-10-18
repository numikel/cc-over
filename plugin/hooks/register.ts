// All `$` use of the mod lives in this file (static analysis: `$` is passed only to
// top-level functions here). The pure logic is in args.ts, git.ts, sessions.ts, bundle.ts
// and notice.ts, each with its own unit tests.

import type { Args, EngineInterface, Register } from "claude-code";
import { parseOverArgs } from "./args.js";
import {
	type Bundle,
	forkPrompt,
	newBundleId,
	newSendId,
	noModelContent,
	parseForkReply,
	previewModel,
	renderBundle,
} from "./bundle.js";
import {
	GIT_BRANCH,
	GIT_HEAD,
	GIT_ORIGIN_HEAD,
	GIT_SHORT_HEAD,
	GIT_STATUS,
	type GitRun,
	type GitSummary,
	gitBranchDiffArgv,
	gitMergeBaseArgv,
	gitSessionLogArgv,
	gitSummary,
	resolveBaseRef,
} from "./git.js";
import {
	applyNotice,
	applySendResult,
	matchNotice,
	parseDeliveryNotice,
	type SendRecord,
	statusLine,
} from "./notice.js";
import {
	type ListAgentsResult,
	type Target,
	type TargetList,
	targetsFromListAgents,
} from "./sessions.js";

type Mode = "fork" | "none";

const COMMAND = "over";
const COMPOSE_KEY = "cc-over.compose";
const GIT_TIMEOUT_MS = 10_000;
const SENDS_KEPT = 10;
const PANE_ID = "over";

// Module state, reset in `register` (a hot reload starts clean).
let sessionStartedAt: number | undefined;
let lastComposed: Bundle | undefined;
let sends: SendRecord[] = [];

type Phase = "composing" | "ready" | "sending" | "sent" | "failed";

// What the pane shows. Kept apart from `lastComposed`: that is only the last bundle the user
// can still send with `--send`, this is the state of one open preview.
type Draft = {
	phase: Phase;
	intent: string;
	mode: Mode;
	bundle?: Bundle;
	targets: Target[];
	hiddenCount: number;
	/** `Target.address` of the session the user picked. */
	selected?: string;
	isExpanded: boolean;
	error?: string;
	/** The send the pane reports on; its status is read from `sends` on every draw. */
	sendId?: string;
};

let draft: Draft | undefined;

const reasonOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

// One line per `$.ui.log` call: a newline inside one draws as a glyph.
function logLines($: EngineInterface, text: string): void {
	for (const line of text.split("\n")) {
		if (line.trim() !== "") $.ui.log(line);
	}
}

async function configuredMode($: EngineInterface): Promise<Mode> {
	try {
		const rows = await $.config.list();
		return rows.find((row) => row.key === COMPOSE_KEY)?.value === "none" ? "none" : "fork";
	} catch {
		return "fork";
	}
}

async function listTargets($: EngineInterface): Promise<TargetList> {
	const called = await $.tool.call({ tool: "ListAgents" });
	// A refused or failed call still resolves: read as an empty list it would pose as "no sessions".
	if (called.deny !== undefined) throw new Error(called.deny);
	if (called.isError) throw new Error(called.text ?? "ListAgents failed");
	return targetsFromListAgents((called.result ?? {}) as ListAgentsResult);
}

// A rejection means git could not start (or timed out): the caller treats it as "no git".
async function runGit(
	$: EngineInterface,
	argv: readonly string[],
	cwd: string,
): Promise<GitRun | undefined> {
	try {
		const run = await $.process.run(argv, { cwd, timeoutMs: GIT_TIMEOUT_MS });
		return { exitCode: run.exitCode, stdout: run.stdout };
	} catch {
		return undefined;
	}
}

async function gatherGit($: EngineInterface, cwd: string): Promise<GitSummary | undefined> {
	const [status, branch, shortHead, head, originHead] = await Promise.all([
		runGit($, GIT_STATUS, cwd),
		runGit($, GIT_BRANCH, cwd),
		runGit($, GIT_SHORT_HEAD, cwd),
		runGit($, GIT_HEAD, cwd),
		runGit($, GIT_ORIGIN_HEAD, cwd),
	]);
	if (status === undefined || branch === undefined) return undefined;
	const baseRef = resolveBaseRef(originHead);
	const [mergeBase, branchDiff, sessionLog] = await Promise.all([
		runGit($, gitMergeBaseArgv(baseRef), cwd),
		runGit($, gitBranchDiffArgv(baseRef), cwd),
		sessionStartedAt === undefined
			? Promise.resolve(undefined)
			: runGit($, gitSessionLogArgv(Math.floor(sessionStartedAt / 1000)), cwd),
	]);
	return gitSummary({
		status,
		branch,
		baseRef,
		...(shortHead ? { shortHead } : {}),
		...(head ? { head } : {}),
		...(mergeBase ? { mergeBase } : {}),
		...(branchDiff ? { branchDiff } : {}),
		...(sessionLog ? { sessionLog } : {}),
	});
}

type Content = {
	summary: string;
	instructions: string;
	details: string;
	files?: string;
	note?: string;
};

// The conversation part of the bundle: the fork's reply, or the intent alone with the reason.
async function composeContent(
	$: EngineInterface,
	intent: string,
	mode: Mode,
	hasGit: boolean,
): Promise<Content> {
	if (mode === "none") return noModelContent(intent, "none mode");
	const forked = await $.model.fork({ prompt: forkPrompt(intent, { filesFromModel: !hasGit }) });
	if (!forked.isAnswered) {
		const reason =
			forked.reason === "api-error" ? `api-error ${forked.status ?? "?"}` : forked.reason;
		return noModelContent(intent, reason);
	}
	const reply = parseForkReply(forked.text);
	return {
		summary: reply.summary,
		instructions: reply.instructions,
		details: reply.details,
		...(reply.files ? { files: reply.files } : {}),
	};
}

async function composeBundle(
	$: EngineInterface,
	intent: string,
	mode: Mode,
	selfName: string | undefined,
): Promise<Bundle> {
	const root = await $.session.root();
	const git = await gatherGit($, root);
	const content = await composeContent($, intent, mode, git !== undefined);
	const sessionId = await $.session.id();
	return {
		bundleId: newBundleId(await $.clock.now(), Math.random()),
		intent,
		...content,
		...(git ? { git } : {}),
		source: {
			...(selfName ? { name: selfName } : {}),
			repo: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
			branch: git?.branch ?? "unknown",
			sessionId,
		},
	};
}

function logPreview($: EngineInterface, bundle: Bundle): void {
	const preview = previewModel(bundle);
	logLines($, preview.meta);
	logLines($, preview.full);
}

// Lists the sessions first (about 100 ms, so the pane has them early), then composes the bundle.
// Never throws: a failure ends in the `failed` phase. A draft that was cancelled meanwhile no
// longer owns `lastComposed`, so a bundle the user dismissed cannot be sent with `--send`.
async function runCompose($: EngineInterface, d: Draft): Promise<void> {
	try {
		const list = await listTargets($);
		d.targets = list.targets;
		d.hiddenCount = list.hiddenCount;
		$.ui.invalidate("ui.render");
		d.bundle = await composeBundle($, d.intent, d.mode, list.selfName);
		d.phase = "ready";
		if (draft === d) lastComposed = d.bundle;
	} catch (error) {
		d.phase = "failed";
		d.error = `could not compose the bundle: ${reasonOf(error)}`;
	}
	$.ui.invalidate("ui.render");
}

// A pane opens only where a surface draws one; the reason it did not is reported, never lost.
async function openPane($: EngineInterface): Promise<{ isPlaced: boolean; reason?: string }> {
	const surfaces = await $.session.surfaces();
	if (!surfaces.some((surface) => surface === "terminal" || surface === "desktop")) {
		return { isPlaced: false };
	}
	try {
		const opened = await $.ui.open({
			id: PANE_ID,
			title: "Hand-off",
			focus: true,
			closeOnEscape: true,
		});
		return opened.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: opened.reason };
	} catch (error) {
		return { isPlaced: false, reason: reasonOf(error) };
	}
}

// With a pane the command returns at once and the composing runs detached (measured in
// phase 1, E4: `$` keeps working after `command.run` returned). Without one (`-p`, SDK) the
// compose is awaited, because the process ends with the command, and the preview is logged.
async function composeCommand($: EngineInterface, intent: string, noFork: boolean): Promise<void> {
	const mode: Mode = noFork ? "none" : await configuredMode($);
	const d: Draft = {
		phase: "composing",
		intent,
		mode,
		targets: [],
		hiddenCount: 0,
		isExpanded: false,
	};
	draft = d;
	const pane = await openPane($);
	if (pane.isPlaced) {
		void runCompose($, d);
		return;
	}
	if (pane.reason !== undefined) {
		$.ui.log(`the pane did not open (${pane.reason}): preview in the log`);
	}
	await runCompose($, d);
	if (d.bundle) logPreview($, d.bundle);
	else $.ui.log(d.error ?? "could not compose the bundle");
	if (draft === d) draft = undefined;
}

// A fresh send id on every call: the platform silently drops a second identical message to
// the same recipient (evidence E2), and the bundle id stays the same across re-sends.
async function deliver($: EngineInterface, bundle: Bundle, target: Target): Promise<SendRecord> {
	const sentAt = await $.clock.now();
	const sendId = newSendId(Math.random());
	const result = await $.session.send({
		to: target.address,
		text: renderBundle(bundle, sendId),
	});
	const record = applySendResult(
		{ bundleId: bundle.bundleId, sendId, target: target.name, sentAt, status: "passed-on" },
		result,
	);
	sends = [record, ...sends].slice(0, SENDS_KEPT);
	$.ui.log(statusLine(record, false), { to: "transcript" });
	return record;
}

async function listCommand($: EngineInterface): Promise<void> {
	const { targets, hiddenCount } = await listTargets($);
	if (targets.length === 0) $.ui.log("no live local sessions");
	for (const target of targets) {
		const parts = [`● ${target.address}`, target.status, target.note];
		$.ui.log(parts.filter(Boolean).join(" · "));
	}
	if (hiddenCount > 0) {
		$.ui.log(`hidden: ${hiddenCount} (not a local interactive session)`);
	}
}

// The target must be on a fresh list: never a session the user did not name, never a dead one.
async function sendCommand($: EngineInterface, wanted: string): Promise<void> {
	if (lastComposed === undefined) {
		$.ui.log("nothing to send: compose a bundle first with /over <intent>");
		return;
	}
	const { targets } = await listTargets($);
	const matches = targets.filter(
		(target) =>
			target.address === wanted ||
			target.name === wanted ||
			(target.ref !== undefined && `${target.name} [${target.ref}]` === wanted),
	);
	const [target] = matches;
	if (target === undefined) {
		$.ui.log(
			`not passed on: no session named ${wanted} on the list of local sessions (see /over --list)`,
		);
		return;
	}
	if (matches.length > 1) {
		const options = matches.map((match) => `${match.name} [${match.ref}]`).join(" or ");
		$.ui.log(`several sessions are named ${wanted}: use ${options}`);
		return;
	}
	await deliver($, lastComposed, target);
}

function usage($: EngineInterface, reason?: string): void {
	const text =
		"Usage: /over <intent> · /over --no-fork <intent> · /over --list · /over --send <session>";
	$.ui.log(reason ? `${text} (${reason})` : text);
}

// ---- the pane ----

type PaneAction =
	| { kind: "select"; address: string }
	| { kind: "expand" | "refresh" | "send" | "close" };

async function refreshTargets($: EngineInterface, d: Draft): Promise<void> {
	const list = await listTargets($);
	d.targets = list.targets;
	d.hiddenCount = list.hiddenCount;
	if (d.selected !== undefined && !list.targets.some((target) => target.address === d.selected)) {
		delete d.selected;
	}
}

// The state goes to `sending` before the first await, so a second press of the same button
// (a Button has no `disabled`) finds a draft that is no longer `ready` and does nothing.
async function sendDraft($: EngineInterface, d: Draft): Promise<void> {
	const { bundle, selected } = d;
	if (d.phase !== "ready" || bundle === undefined || selected === undefined) return;
	d.phase = "sending";
	delete d.error;
	$.ui.invalidate("ui.render");
	try {
		const list = await listTargets($);
		d.targets = list.targets;
		d.hiddenCount = list.hiddenCount;
		const target = list.targets.find((candidate) => candidate.address === selected);
		if (target === undefined) {
			delete d.selected;
			d.phase = "ready";
			d.error = `not sent: ${selected} is no longer on the session list, pick another`;
			return;
		}
		const record = await deliver($, bundle, target);
		d.sendId = record.sendId;
		d.phase = "sent";
		$.ui.toast(statusLine(record, false));
	} catch (error) {
		d.phase = "failed";
		d.error = `send failed: ${reasonOf(error)}`;
	} finally {
		$.ui.invalidate("ui.render");
	}
}

// Dismissing a preview that was not sent also withdraws its bundle from `--send`: a bundle the
// user cancelled must not go out later. After a send, closing keeps it for a second target.
function dropDraft(): void {
	if (draft && draft.phase !== "sent" && lastComposed === draft.bundle) lastComposed = undefined;
	draft = undefined;
}

async function paneAction($: EngineInterface, action: PaneAction): Promise<void> {
	const d = draft;
	if (action.kind === "close") {
		// The plugin's own close does not reach its own ui.close hook, so the draft goes here.
		dropDraft();
		await $.ui.close({ id: PANE_ID });
		return;
	}
	if (d === undefined) {
		$.ui.invalidate("ui.render");
		return;
	}
	switch (action.kind) {
		case "select":
			if (d.phase === "composing" || d.phase === "ready") d.selected = action.address;
			break;
		case "expand":
			d.isExpanded = !d.isExpanded;
			break;
		case "refresh":
			await refreshTargets($, d);
			break;
		default:
			await sendDraft($, d);
			return;
	}
	$.ui.invalidate("ui.render");
}

// A press that fails is said, as a hook's failure is, and leaves the pane as it was.
async function panePress($: EngineInterface, action: PaneAction): Promise<void> {
	try {
		await paneAction($, action);
	} catch (error) {
		const text = `pane action failed (${reasonOf(error)})`;
		$.ui.toast(text);
		$.ui.log(text);
	}
}

// A button with a hotkey names it on its label, `Label (key)`, so the shortcut is discoverable.
const withKey = (label: string, hotkey: string | undefined): string =>
	hotkey === undefined ? label : `${label} (${hotkey})`;

const targetLabel = (target: Target, isSelected: boolean, hotkey: string | undefined): string =>
	withKey(
		[`${isSelected ? "●" : "○"} ${target.address}`, target.status, target.note]
			.filter(Boolean)
			.join(" · "),
		hotkey,
	);

// A render that fails draws one line saying so: a throw would make the engine draw its own
// component and the user would not know why.
function renderPane($: EngineInterface, e: Args<"ui.render">) {
	const { Box, Text, Button, Markdown } = $.ui.resolve(e);
	try {
		const d = draft;
		const close = (label: string) =>
			Button({ key: "close", label, onPress: () => panePress($, { kind: "close" }) });
		if (d === undefined) {
			return Box({
				flexDirection: "column",
				children: [
					Text({ dimColor: true, children: "No hand-off in progress. Type /over <intent>." }),
					close("Close"),
				],
			});
		}

		const preview = d.bundle ? previewModel(d.bundle) : undefined;
		const bundleBlock = [];
		if (d.phase === "composing") {
			bundleBlock.push(
				Text({ children: `Composing the bundle… (${d.mode === "fork" ? "fork" : "no model"})` }),
			);
		}
		if (preview) {
			bundleBlock.push(
				Text({ dimColor: true, children: `${preview.lines[0] ?? ""} · ${preview.meta}` }),
				Markdown({ text: d.isExpanded ? preview.full : preview.lines.slice(1).join("\n\n") }),
				Button({
					key: "expand",
					label: withKey(d.isExpanded ? "Collapse" : "Show all", "e"),
					hotkey: "e",
					onPress: () => panePress($, { kind: "expand" }),
				}),
			);
		}

		const isChoosing = d.phase === "composing" || d.phase === "ready";
		const targetBlock = [
			Text({
				dimColor: true,
				children: `Live local sessions (hidden: ${d.hiddenCount}); --bare and WSL sessions are not visible.`,
			}),
			...d.targets.map((target, i) => {
				const hotkey = i < 9 ? String(i + 1) : undefined;
				return Button({
					key: `target:${target.address}`,
					label: targetLabel(target, target.address === d.selected, hotkey),
					...(hotkey ? { hotkey } : {}),
					onPress: () => panePress($, { kind: "select", address: target.address }),
				});
			}),
			...(isChoosing
				? [
						Button({
							key: "refresh",
							label: withKey("Refresh list", "r"),
							hotkey: "r",
							onPress: () => panePress($, { kind: "refresh" }),
						}),
					]
				: []),
		];

		const record = sends.find((candidate) => candidate.sendId === d.sendId);
		const actions = [];
		if ((d.phase === "ready" || d.phase === "sending") && d.selected !== undefined) {
			actions.push(
				Button({
					key: "send",
					label: d.phase === "sending" ? "Sending…" : withKey(`Send to ${d.selected}`, "s"),
					variant: "primary",
					hotkey: "s",
					onPress: () => panePress($, { kind: "send" }),
				}),
			);
		}
		if (isChoosing) {
			actions.push(
				Button({
					key: "cancel",
					label: "Cancel",
					role: "dismiss",
					onPress: () => panePress($, { kind: "close" }),
				}),
			);
		}
		if (d.phase === "sent" || d.phase === "failed") actions.push(close("Close"));

		return Box({
			flexDirection: "column",
			gap: 1,
			children: [
				Text({ bold: true, children: `Hand-off: ${d.intent}` }),
				...bundleBlock,
				...(d.phase === "sent" || d.phase === "failed" ? [] : targetBlock),
				...(record ? [Text({ children: statusLine(record, false) })] : []),
				...(d.error ? [Text({ color: "red", children: d.error })] : []),
				Box({ flexDirection: "row", gap: 2, children: actions }),
			],
		});
	} catch (error) {
		return Text({ color: "red", children: `could not draw the pane (${reasonOf(error)})` });
	}
}

// ---- delivery warnings ----

// The platform writes held/refused/expired into the sender's conversation as a `notice` row. The
// match is by recipient name and time only (the text carries no message id), and an unknown
// wording changes nothing: the status then stays "passed on (queued)".
async function observeNotice($: EngineInterface, text: string): Promise<void> {
	const notice = parseDeliveryNotice(text);
	if (notice === null) return;
	const match = matchNotice(sends, notice, await $.clock.now());
	if (match === null) return;
	const updated = applyNotice(match.record, notice.kind);
	if (updated === match.record) return;
	sends = sends.map((record) => (record.sendId === updated.sendId ? updated : record));
	const line = statusLine(updated, match.isAmbiguous);
	$.ui.toast(line);
	$.ui.log(line, { to: "transcript" });
	$.ui.invalidate("ui.render");
}

async function overCommand($: EngineInterface, args: string): Promise<Record<string, never>> {
	const parsed = parseOverArgs(args);
	switch (parsed.kind) {
		case "compose":
			await composeCommand($, parsed.intent, parsed.noFork);
			break;
		case "list":
			await listCommand($);
			break;
		case "send":
			await sendCommand($, parsed.target);
			break;
		default:
			usage($, parsed.reason);
	}
	return {};
}

async function registerCommand($: EngineInterface): Promise<void> {
	try {
		await $.command.register({
			name: COMMAND,
			description:
				"Hand the work over to another local session: /over <intent> previews and sends a bundle; --list, --send <session>, --no-fork",
			argumentHint: "<intent> | --list | --send <session> | --no-fork <intent>",
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const text = `/${COMMAND} is unavailable: the command could not be registered (${reason})`;
		$.ui.toast(text);
		$.ui.log(text);
	}
}

export const register: Register = (on) => {
	sessionStartedAt = undefined;
	lastComposed = undefined;
	sends = [];
	draft = undefined;

	on("session.start", async ($, e, next) => {
		sessionStartedAt ??= await $.clock.now();
		await registerCommand($);
		return next(e);
	});

	on("classic.SessionStart", async ($, e, next) => {
		sessionStartedAt = await $.clock.now();
		return next(e);
	}).catch((_$, e, next) => next(e));

	on("command.run", { command: COMMAND }, ($, e) => overCommand($, e.args ?? "")).catch(() => ({}));

	on("ui.render", { component: "Pane", requestId: PANE_ID }, ($, e) => renderPane($, e));

	// Observes only: the row is stored first and always passes on unchanged. Our own log lines
	// come back here as rows led by the plugin's name, which the parser's anchor ignores.
	on("session.append", { door: "notice" }, async ($, e, next) => {
		const stored = await next(e);
		try {
			const text = e.message.content.flatMap((block) =>
				block.type === "text" ? [block.text] : [],
			);
			await observeNotice($, text.join("\n"));
		} catch (error) {
			$.ui.log(`warning tracking failed (${reasonOf(error)})`, { to: "debug" });
		}
		return stored;
	}).catch((_$, e, next) => next(e));

	// The person closing the pane (Escape) drops the draft, so a reopened pane starts clean.
	// Always `next`: this mod never keeps the pane open.
	on("ui.close", (_$, e, next) => {
		if (e.id === PANE_ID) dropDraft();
		return next(e);
	}).catch((_$, e, next) => next(e));
};
