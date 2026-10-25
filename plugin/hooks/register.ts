// All `$` use of the mod lives in this file (static analysis: `$` is passed only to
// top-level functions here). The pure logic is in args.ts, git.ts, sessions.ts, bundle.ts,
// notice.ts, sendlog.ts, history.ts and report.ts, each with its own unit tests.

import type { Args, EngineInterface, Register, Timer } from "claude-code";
import { matchAck, parseAck } from "./ack.js";
import { intentFromField, parseOverArgs } from "./args.js";
import {
	type Bundle,
	type BundleKind,
	broadcastBundle,
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
	type Grouped,
	groupHeading,
	groupSessions,
	joinRegistry,
	NO_DETAILS_HEADING,
	rowLabel,
	rowParts,
	type SessionRow,
	type VisibleRow,
	visibleRows,
} from "./groups.js";
import {
	applyStatus,
	entryFromBundle,
	HISTORY_PREFIX,
	type HistoryLog,
	type HistoryView,
	historyDetail,
	historyKey,
	historyPruneItem,
	historyRow,
	parseHistoryLog,
	projectHistory,
	recordSend,
	trimLog,
} from "./history.js";
import { historySection } from "./history-pane.js";
import {
	applyAck,
	applyNotice,
	applySendResult,
	matchNotice,
	parseDeliveryNotice,
	type SendRecord,
	statusLine,
	truncateIntent,
} from "./notice.js";
import {
	nextEntry,
	PRUNE_MAX_AGE_MS,
	PRUNE_MAX_BYTES,
	PRUNE_SCAN_LIMIT,
	type PruneItem,
	parseEntry,
	projectKey,
	projectLabel,
	REGISTRY_PREFIX,
	type RegistryEntry,
	type RegistryPatch,
	registryKey,
	selectPrunable,
} from "./registry.js";
import { bundleLines, statusReport } from "./report.js";
import {
	keepListed,
	type Pick,
	pickHint,
	pickOf,
	preselect,
	resolvePicks,
	sendLabel,
	switchKind,
	togglePick,
} from "./selection.js";
import {
	mergeRecords,
	parseSendLog,
	SENDLOG_PREFIX,
	SENDS_PER_SESSION,
	sendLogKey,
	sendLogPruneItem,
	upsertSend,
} from "./sendlog.js";
import {
	type ListAgentsResult,
	type Target,
	type TargetList,
	targetsFromListAgents,
} from "./sessions.js";

type Mode = "fork" | "none";

const COMMAND = "over";
const COMPOSE_KEY = "cc-over.compose";
const HISTORY_CONFIG_KEY = "cc-over.history";
const GIT_TIMEOUT_MS = 10_000;
const PANE_ID = "over";
const NOTHING_TO_SEND = "nothing to send: compose a bundle first with /over <intent>";

// Module state, reset in `register` (a hot reload starts clean).
let currentSessionId: string | undefined;
let sessionStartedAt: number | undefined;
let lastComposed: Bundle | undefined;
/** Newest first; the saved copy of each lives under `sends:<ownerSessionId>` in the store. */
let sends: SendRecord[] = [];
/** Settles when the saved sends of the starting session are back in `sends`. */
let sendsLoaded: Promise<void> = Promise.resolve();

// `intent`: the bare `/over` pane, the list is live and the intent is still to be typed.
type Phase = "intent" | "composing" | "ready" | "sending" | "sent" | "failed";

// The phases in which a session can be picked and the list refreshed.
const canChoose = (phase: Phase): boolean =>
	phase === "intent" || phase === "composing" || phase === "ready";

// What the pane shows. Kept apart from `lastComposed`: that is only the last bundle the user
// can still send with `--send`, this is the state of one open preview.
type Draft = {
	phase: Phase;
	intent: string;
	/** What the intent field holds: a redraw hands it back as `value`, so it is not wiped. */
	typed: string;
	mode: Mode;
	bundle?: Bundle;
	targets: Target[];
	hiddenCount: number;
	/** The same sessions as `targets`, joined with the registry and sorted into the two groups. */
	grouped: Grouped;
	/** Which groups are folded; 'Other sessions' and the history start folded on every new pane. */
	collapsed: { this: boolean; other: boolean; history: boolean };
	/** The project's sent bundles, read when the bare pane opens and on Refresh; unset until then. */
	history?: HistoryView;
	/** The `bundleId` whose history entry is open. */
	historyOpen?: string;
	/** When the list was read: the ages on the rows are counted from it (the render is synchronous). */
	now: number;
	/** The sessions the user picked: one at most while the type is hand-off. */
	picked: Pick[];
	/** The type of the bundle this pane previews and sends. */
	kind: BundleKind;
	/** One id for the draft, whatever the type: a switch back to hand-off keeps it. */
	bundleId: string;
	/** This session's name from the last listing: the `From:` line of a broadcast. */
	selfName?: string;
	/** A `runCompose` of this draft is running: a second one must not start beside it. */
	isInFlight: boolean;
	/** The same-repo sessions were already ticked once for this draft. */
	isPreselected: boolean;
	/** The session list was read at least once: an empty list is then a real answer. */
	hasListing: boolean;
	/** Going down to hand-off cleared several picks, so the pane asks for exactly one. */
	needsOnePick: boolean;
	/** The hand-off bundle, kept while the type is broadcast so a switch back needs no new fork. */
	handoff?: Bundle;
	isExpanded: boolean;
	error?: string;
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

// The entries other sessions (and this one) keep in the shared store. A store that cannot be read
// costs the rows their details, not the list: they fall back to 'no details'.
async function readRegistry($: EngineInterface): Promise<RegistryEntry[]> {
	try {
		const keys = (await $.store.keys())
			.filter((key) => key.startsWith(REGISTRY_PREFIX))
			.slice(0, PRUNE_SCAN_LIMIT);
		const entries: RegistryEntry[] = [];
		for (const key of keys) {
			const parsed = parseEntry(await $.store.get(key));
			if (parsed !== null && registryKey(parsed.sessionId) === key) entries.push(parsed);
		}
		return entries;
	} catch (error) {
		reportRegistryError($, "read", error);
		return [];
	}
}

type Listing = { list: TargetList; grouped: Grouped; now: number };

// The platform's list stays the only source of who is alive; the registry only adds details to
// its rows, so an entry of a closed session never reaches the pane. `known` is a list the caller
// already fetched.
async function listGrouped($: EngineInterface, known?: TargetList): Promise<Listing> {
	const list = known ?? (await listTargets($));
	const entries = await readRegistry($);
	const place = await selfPlace($);
	const rows = joinRegistry(list.targets, entries);
	return {
		list,
		grouped: groupSessions(rows, { key: projectKey(place), label: projectLabel(place) }),
		now: await $.clock.now(),
	};
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

// ---- the registry of sessions running this mod ----

// Each session keeps one `session:<id>` entry about itself in the shared `$.store`; the pane joins
// them to the platform's list. `$.store` get+set is not atomic and every session of every project
// writes the same file, so each read-modify-write of ours goes through one chain (pattern of
// compaction-keeper's `updateRecord`): a stale save could otherwise undo a newer one.
const REGISTRY_WAIT_MS = 2_000;
let registryWrites: Promise<void> = Promise.resolve();
let registryUnitsInFlight = 0;
/** The store subjects ("session registry", "send status") whose first failure was already shown. */
const reportedStoreErrors = new Set<string>();

// Per subject, the first failure of the module's life is visible, the later ones go to the debug log.
function reportStoreError($: EngineInterface, subject: string, what: string, error: unknown): void {
	const text = `${subject}: ${what} failed (${reasonOf(error)})`;
	if (reportedStoreErrors.has(subject)) $.ui.log(text, { to: "debug" });
	else $.ui.log(text);
	reportedStoreErrors.add(subject);
}

function reportRegistryError($: EngineInterface, what: string, error: unknown): void {
	reportStoreError($, "session registry", what, error);
}

// Resolves when `predecessor` settles, or after REGISTRY_WAIT_MS: a store write that never settles
// must not hold up every later unit.
async function waitForRegistryWrites(
	$: EngineInterface,
	predecessor: Promise<unknown>,
): Promise<void> {
	const held: { timer?: Timer } = {};
	const timedOut = new Promise<void>((resolve) => {
		held.timer = $.clock.after(REGISTRY_WAIT_MS, () => resolve());
	});
	await Promise.race([predecessor, timedOut]);
	held.timer?.cancel();
}

// A unit is exactly one load-change-save; no ask, toast or other unit goes inside (that would
// deadlock the chain). A failed unit rejects to its caller and does not break the chain.
async function chained<T>($: EngineInterface, unit: () => Promise<T>): Promise<T> {
	const queued = registryUnitsInFlight > 0;
	const predecessor = registryWrites;
	registryUnitsInFlight += 1;
	const run = async (): Promise<T> => {
		try {
			if (queued) await waitForRegistryWrites($, predecessor);
			return await unit();
		} finally {
			registryUnitsInFlight -= 1;
		}
	};
	const result = run();
	registryWrites = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

// `touch` stamps the entry's last activity with the time of the write.
async function updateRegistry(
	$: EngineInterface,
	sessionId: string,
	patch: Omit<RegistryPatch, "sessionId">,
	o: { touch: boolean },
): Promise<void> {
	await chained($, async () => {
		const key = registryKey(sessionId);
		const previous = parseEntry(await $.store.get(key));
		const now = await $.clock.now();
		const next = nextEntry(
			previous,
			{ ...patch, sessionId, ...(o.touch ? { lastActivityAt: now } : {}) },
			now,
		);
		if (next !== null) await $.store.set(key, next);
	});
}

// A branch name, or undefined on a detached HEAD or where git cannot say.
async function currentBranch($: EngineInterface, cwd: string): Promise<string | undefined> {
	const run = await runGit($, GIT_BRANCH, cwd);
	const name = run?.exitCode === 0 ? run.stdout.trim() : "";
	return name === "" || name === "HEAD" ? undefined : name;
}

async function selfSessionId($: EngineInterface): Promise<string> {
	return currentSessionId ?? (await $.session.id());
}

async function selfPlace(
	$: EngineInterface,
): Promise<{ root: string; repoRoot: string | undefined }> {
	const root = await $.session.root();
	const repo = await $.session.repo();
	return { root, repoRoot: repo?.root };
}

// The full entry: where the session is and who the platform's list says it is. The name and `ref`
// come from the list header; where ListAgents cannot be called (a `-p` run at `classic.SessionStart`)
// the entry is written without them and the next full write fills them in.
async function writeSelfEntry(
	$: EngineInterface,
	sessionId: string,
	known?: TargetList,
): Promise<void> {
	const place = await selfPlace($);
	const branch = await currentBranch($, place.root);
	let identity: { name?: string; ref?: string } = {};
	try {
		const list = known ?? (await listTargets($));
		identity = {
			...(list.selfName ? { name: list.selfName } : {}),
			...(list.selfRef ? { ref: list.selfRef } : {}),
		};
	} catch (error) {
		$.ui.log(`session registry: no list identity (${reasonOf(error)})`, { to: "debug" });
	}
	await updateRegistry($, sessionId, { ...place, branch, ...identity }, { touch: true });
}

// Opening the pane refreshes this session's entry with the list it has just fetched.
async function refreshSelfEntry($: EngineInterface, list: TargetList): Promise<void> {
	try {
		await writeSelfEntry($, await selfSessionId($), list);
	} catch (error) {
		reportRegistryError($, "write", error);
	}
}

// Up to PRUNE_SCAN_LIMIT keys with this prefix, as prune items; a value `toItem` cannot read
// (junk, another version, a log filed under another session's key) gives none.
async function scanPrefix(
	$: EngineInterface,
	keys: readonly string[],
	prefix: string,
	toItem: (key: string, value: unknown, size: number) => PruneItem | null,
): Promise<PruneItem[]> {
	const items: PruneItem[] = [];
	for (const key of keys
		.filter((candidate) => candidate.startsWith(prefix))
		.slice(0, PRUNE_SCAN_LIMIT)) {
		const value = await $.store.get(key);
		if (value === undefined) continue;
		const item = toItem(key, value, JSON.stringify(value).length);
		if (item !== null) items.push(item);
	}
	return items;
}

const registryPruneItem = (key: string, value: unknown, size: number): PruneItem | null => {
	const parsed = parseEntry(value);
	if (parsed === null || registryKey(parsed.sessionId) !== key) return null;
	return { key, sessionId: parsed.sessionId, updatedAt: parsed.updatedAt, size };
};

const storedSendLogPruneItem = (key: string, value: unknown, size: number): PruneItem | null => {
	const log = parseSendLog(value);
	return log === null || sendLogKey(log.sessionId) !== key
		? null
		: sendLogPruneItem(key, log, size);
};

const storedHistoryPruneItem = (key: string, value: unknown, size: number): PruneItem | null => {
	const log = parseHistoryLog(value);
	return log === null || historyKey(log.sessionId) !== key
		? null
		: historyPruneItem(key, log, size);
};

// One pass over the registry, the send logs and the history, so the size limit counts all of this
// mod's data. Drops what was untouched for long and, past the size limit, the oldest; never the
// current session and never a key whose value this mod cannot read (other data is not ours to delete).
async function pruneStore($: EngineInterface, keepSessionId: string): Promise<void> {
	await chained($, async () => {
		const keys = await $.store.keys();
		const items = [
			...(await scanPrefix($, keys, REGISTRY_PREFIX, registryPruneItem)),
			...(await scanPrefix($, keys, SENDLOG_PREFIX, storedSendLogPruneItem)),
			...(await scanPrefix($, keys, HISTORY_PREFIX, storedHistoryPruneItem)),
		];
		const doomed = selectPrunable(items, await $.clock.now(), {
			maxAgeMs: PRUNE_MAX_AGE_MS,
			maxBytes: PRUNE_MAX_BYTES,
			keepSessionId,
		});
		for (const key of doomed) await $.store.delete(key);
	});
}

// Never throws: a registry that cannot be written costs the pane its details, not the session.
async function registerSession(
	$: EngineInterface,
	sessionId: string,
	o: { prune: boolean },
): Promise<void> {
	currentSessionId = sessionId;
	try {
		await writeSelfEntry($, sessionId);
		if (o.prune) await pruneStore($, sessionId);
	} catch (error) {
		reportRegistryError($, "write", error);
	}
}

// ---- the saved sends ----

// One status change saved to the log of the session the send left from (after /clear that is not
// the current one). Detached by its callers: a send's result and its toast never wait on the store.
// Never throws.
async function persistSend($: EngineInterface, record: SendRecord): Promise<void> {
	try {
		await chained($, async () => {
			const key = sendLogKey(record.ownerSessionId);
			const previous = parseSendLog(await $.store.get(key));
			await $.store.set(key, upsertSend(previous, record, await $.clock.now()));
		});
	} catch (error) {
		reportStoreError($, "send status", "save", error);
	}
}

// Brings back what an earlier process, or this mod before a reload, saved for the session. The
// copy in memory wins: it can hold a change whose save is still on the chain. Never throws.
async function loadSends($: EngineInterface, sessionId: string): Promise<void> {
	try {
		const log = parseSendLog(await $.store.get(sendLogKey(sessionId)));
		if (log !== null && log.sessionId === sessionId) sends = mergeRecords(sends, log.sends);
	} catch (error) {
		reportStoreError($, "send status", "load", error);
	}
}

// ---- the history of sent bundles ----

// Off only when the `/config` row says so. A config that cannot be read keeps the default (on).
async function historyEnabled($: EngineInterface): Promise<boolean> {
	try {
		const rows = await $.config.list();
		const value = rows.find((row) => row.key === HISTORY_CONFIG_KEY)?.value;
		return value !== false && value !== "false" && value !== "off";
	} catch {
		return true;
	}
}

// Each of the three writers enters `chained` before its first await, so in one process a status
// update always queues behind the save that creates its entry. Detached by the callers, never throws.
async function persistHistory(
	$: EngineInterface,
	bundle: Bundle,
	record: SendRecord,
): Promise<void> {
	try {
		await chained($, async () => {
			if (!(await historyEnabled($))) return;
			const project = projectKey(await selfPlace($));
			const key = historyKey(record.ownerSessionId);
			const previous = parseHistoryLog(await $.store.get(key));
			const now = await $.clock.now();
			const entry = entryFromBundle(bundle, project, record);
			await $.store.set(key, trimLog(recordSend(previous, entry, record, now), now));
		});
	} catch (error) {
		reportStoreError($, "history", "save", error);
	}
}

// A status change for a bundle that has no entry (sent with the history off, or already trimmed)
// writes nothing. The same 14-day cut as a send: a late warning must not leave an old entry in
// the key, and it must not keep that key looking freshly touched with the old row still inside.
async function persistHistoryStatus($: EngineInterface, record: SendRecord): Promise<void> {
	try {
		await chained($, async () => {
			if (!(await historyEnabled($))) return;
			const key = historyKey(record.ownerSessionId);
			const previous = parseHistoryLog(await $.store.get(key));
			const now = await $.clock.now();
			const next = applyStatus(previous, record, now);
			if (next !== null && next !== previous) await $.store.set(key, trimLog(next, now));
		});
	} catch (error) {
		reportStoreError($, "history", "save", error);
	}
}

// The rows of this project from every session's key, behind the pending writes, so a history read
// right after a send sees it. Never throws: the pane and the command show the reason instead.
async function readHistory($: EngineInterface): Promise<HistoryView> {
	try {
		return await chained($, async (): Promise<HistoryView> => {
			if (!(await historyEnabled($))) return { state: "off" };
			const place = await selfPlace($);
			const keys = (await $.store.keys())
				.filter((key) => key.startsWith(HISTORY_PREFIX))
				.slice(0, PRUNE_SCAN_LIMIT);
			const logs: HistoryLog[] = [];
			for (const key of keys) {
				const log = parseHistoryLog(await $.store.get(key));
				if (log !== null && historyKey(log.sessionId) === key) logs.push(log);
			}
			const now = await $.clock.now();
			return {
				state: "ready",
				entries: projectHistory(logs, projectKey(place), now),
				project: projectLabel(place),
				now,
			};
		});
	} catch (error) {
		return { state: "error", reason: reasonOf(error) };
	}
}

// A turn only moves the last-activity stamp: no git, no ListAgents on the turn's path.
async function touchSession($: EngineInterface): Promise<void> {
	try {
		await updateRegistry($, await selfSessionId($), {}, { touch: true });
	} catch (error) {
		reportRegistryError($, "update", error);
	}
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

const repoNameOf = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? root;

const freshBundleId = async ($: EngineInterface): Promise<string> =>
	newBundleId(await $.clock.now(), Math.random());

// `bundleId` keeps the id of a draft that returns to hand-off; without it the bundle gets a new one.
async function composeBundle(
	$: EngineInterface,
	intent: string,
	mode: Mode,
	selfName: string | undefined,
	bundleId?: string,
): Promise<Bundle> {
	const root = await $.session.root();
	const git = await gatherGit($, root);
	const content = await composeContent($, intent, mode, git !== undefined);
	const sessionId = await selfSessionId($);
	return {
		bundleId: bundleId ?? (await freshBundleId($)),
		kind: "hand-off",
		intent,
		...content,
		...(git ? { git } : {}),
		source: {
			...(selfName ? { name: selfName } : {}),
			repo: repoNameOf(root),
			branch: git?.branch ?? "unknown",
			sessionId,
		},
	};
}

// A broadcast is the intent and its source: no model, no files, so only the branch is read, with
// one git call (a failure says `unknown`). It is ready as fast as the list.
async function composeBroadcast($: EngineInterface, d: Draft): Promise<Bundle> {
	const root = await $.session.root();
	const run = await runGit($, GIT_BRANCH, root);
	const name = run?.exitCode === 0 ? run.stdout.trim() : "";
	return broadcastBundle({
		bundleId: d.bundleId,
		intent: d.intent,
		source: {
			...(d.selfName ? { name: d.selfName } : {}),
			repo: repoNameOf(root),
			branch: name === "" ? "unknown" : name === "HEAD" ? "detached HEAD" : name,
			sessionId: await selfSessionId($),
		},
	});
}

function logPreview($: EngineInterface, bundle: Bundle): void {
	const preview = previewModel(bundle);
	logLines($, preview.meta);
	logLines($, preview.full);
}

// Reads the session list into the draft and redraws, so the pane has the sessions early.
async function loadListing($: EngineInterface, d: Draft): Promise<TargetList> {
	const list = await listTargets($);
	applyListing(d, await listGrouped($, list));
	$.ui.invalidate("ui.render");
	await refreshSelfEntry($, list);
	return list;
}

// Lists the sessions first (about 100 ms, so the pane has them early), then composes the bundle of
// the draft's type: a broadcast at once, a hand-off through the fork. The type can change while
// this runs (the pane's `y`), so each step reads `d.kind` again after its await, and a result is
// written to the pane only while the draft is still `composing`: a broadcast the user switched to
// is already `ready` (and may be sent), and a late fork then lands in `d.handoff` only.
// Never throws: a failure of a draft that is `composing` ends in the `failed` phase. A draft that
// was cancelled meanwhile no longer owns `lastComposed`, so a bundle the user dismissed cannot be
// sent with `--send`.
async function runCompose($: EngineInterface, d: Draft): Promise<void> {
	d.isInFlight = true;
	try {
		const list = await loadListing($, d);
		for (;;) {
			if (d.kind === "broadcast") {
				const broadcast = await composeBroadcast($, d);
				// Switched to hand-off meanwhile: the loop goes on to the fork.
				if (d.kind !== "broadcast") continue;
				if (d.phase === "composing") {
					d.bundle = broadcast;
					d.phase = "ready";
				}
			} else {
				const handoff =
					d.handoff ?? (await composeBundle($, d.intent, d.mode, list.selfName, d.bundleId));
				d.handoff = handoff;
				if (d.kind === "hand-off" && d.phase === "composing") {
					d.bundle = handoff;
					d.phase = "ready";
				}
			}
			break;
		}
		if (draft === d) lastComposed = d.bundle;
	} catch (error) {
		if (d.phase === "composing") {
			d.phase = "failed";
			d.error = `could not compose the bundle: ${reasonOf(error)}`;
			if (draft === d) stopRefresh();
		} else {
			$.ui.log(`could not compose the bundle: ${reasonOf(error)}`, { to: "debug" });
		}
	} finally {
		d.isInFlight = false;
	}
	if (draft === d) $.ui.invalidate("ui.render");
}

// Takes a fresh listing into the draft. A pick that is no longer on the list is dropped, so
// `send` cannot target a session that is gone. The same-repo sessions are ticked once, with the
// first list a broadcast draft sees; every later list only removes.
function applyListing(d: Draft, listing: Listing): void {
	d.targets = listing.list.targets;
	d.hiddenCount = listing.list.hiddenCount;
	d.grouped = listing.grouped;
	d.now = listing.now;
	d.selfName = listing.list.selfName;
	d.hasListing = true;
	d.picked = keepListed(d.picked, d.targets);
	if (d.kind === "broadcast" && !d.isPreselected) {
		const next = switchKind(d.picked, "broadcast", {
			preselected: preselect(d.grouped),
			isPreselected: d.isPreselected,
		});
		d.picked = next.picked;
		d.isPreselected = next.isPreselected;
		d.needsOnePick = next.needsOnePick;
	}
}

// ---- the refresh timer ----

const REFRESH_MS = 10_000;
let refreshTimer: Timer | undefined;
let isRefreshing = false;

function stopRefresh(): void {
	refreshTimer?.cancel();
	refreshTimer = undefined;
}

// Runs only while the preview this timer was started for is the open one and can still choose a
// session; any other state ends the timer, so a closed pane costs no ListAgents call.
async function refreshTick($: EngineInterface, d: Draft): Promise<void> {
	if (draft !== d || d.phase === "sent" || d.phase === "failed") {
		stopRefresh();
		return;
	}
	try {
		await refreshTargets($, d);
		if (draft === d) $.ui.invalidate("ui.render");
	} catch (error) {
		$.ui.log(`list refresh failed (${reasonOf(error)})`, { to: "debug" });
	}
}

function startRefresh($: EngineInterface, d: Draft): void {
	stopRefresh();
	refreshTimer = $.clock.every(REFRESH_MS, () => void refreshTick($, d));
}

const kindName = (kind: BundleKind): string => (kind === "broadcast" ? "Broadcast" : "Hand-off");

// A pane opens only where a surface draws one; the reason it did not is reported, never lost.
async function openPane(
	$: EngineInterface,
	kind: BundleKind,
): Promise<{ isPlaced: boolean; reason?: string }> {
	const surfaces = await $.session.surfaces();
	if (!surfaces.some((surface) => surface === "terminal" || surface === "desktop")) {
		return { isPlaced: false };
	}
	try {
		const opened = await $.ui.open({
			id: PANE_ID,
			title: kindName(kind),
			focus: true,
			closeOnEscape: true,
		});
		return opened.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: opened.reason };
	} catch (error) {
		return { isPlaced: false, reason: reasonOf(error) };
	}
}

// Opening an open id retitles it. Every open sets `closeOnEscape` anew, so it is passed again;
// `focus` is left out, the keys stay where they are.
async function retitlePane($: EngineInterface, kind: BundleKind): Promise<void> {
	try {
		await $.ui.open({ id: PANE_ID, title: kindName(kind), closeOnEscape: true });
	} catch (error) {
		$.ui.log(`the pane title did not change (${reasonOf(error)})`, { to: "debug" });
	}
}

function newDraft(
	phase: Phase,
	intent: string,
	mode: Mode,
	bundleId: string,
	kind: BundleKind,
): Draft {
	return {
		phase,
		intent,
		typed: "",
		mode,
		targets: [],
		hiddenCount: 0,
		grouped: groupSessions([], { key: "", label: "" }),
		collapsed: { this: false, other: true, history: true },
		now: 0,
		picked: [],
		kind,
		bundleId,
		isInFlight: false,
		isPreselected: false,
		hasListing: false,
		needsOnePick: false,
		isExpanded: false,
	};
}

// The list for a pane that has no intent yet. A failure is shown in the pane and the phase stays,
// so the user can still type, or press Refresh.
async function readSessions($: EngineInterface, d: Draft): Promise<void> {
	try {
		await loadListing($, d);
		if (draft === d && d.phase === "intent") delete d.error;
	} catch (error) {
		if (draft === d && d.phase === "intent") {
			d.error = `could not read the session list: ${reasonOf(error)}`;
		}
	}
	if (draft === d) $.ui.invalidate("ui.render");
}

// Reads the project's history into the draft and redraws. Only the bare pane shows it, and only a
// press of Refresh or the opening reads it: no store reads on the refresh timer's ticks.
async function readHistoryInto($: EngineInterface, d: Draft): Promise<void> {
	const history = await readHistory($);
	if (draft !== d) return;
	d.history = history;
	$.ui.invalidate("ui.render");
}

// Bare `/over`: the pane opens with the field and the list, and nothing is composed before Enter
// (`submit` in `paneAction`). Without a pane there is nothing to type into, so it says how to give
// the intent instead; the list is not read then.
async function panelCommand($: EngineInterface): Promise<void> {
	const d = newDraft("intent", "", await configuredMode($), await freshBundleId($), "hand-off");
	draft = d;
	const pane = await openPane($, d.kind);
	if (pane.isPlaced) {
		startRefresh($, d);
		void readSessions($, d);
		void readHistoryInto($, d);
		return;
	}
	if (draft === d) draft = undefined;
	if (pane.reason !== undefined) $.ui.log(`the pane did not open (${pane.reason})`);
	usage($, "no pane here: give the intent as an argument");
}

// With a pane the command returns at once and the composing runs detached (measured in
// phase 1, E4: `$` keeps working after `command.run` returned). Without one (`-p`, SDK) the
// compose is awaited, because the process ends with the command, and the preview is logged.
async function composeCommand(
	$: EngineInterface,
	intent: string,
	noFork: boolean,
	kind: BundleKind,
): Promise<void> {
	const mode: Mode = noFork ? "none" : await configuredMode($);
	const d = newDraft("composing", intent, mode, await freshBundleId($), kind);
	draft = d;
	const pane = await openPane($, kind);
	if (pane.isPlaced) {
		startRefresh($, d);
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
		{
			bundleId: bundle.bundleId,
			kind: bundle.kind,
			sendId,
			target: target.name,
			sentAt,
			status: "passed-on",
			intent: truncateIntent(bundle.intent),
			updatedAt: sentAt,
			ownerSessionId: await selfSessionId($),
		},
		result,
	);
	sends = [record, ...sends].slice(0, SENDS_PER_SESSION);
	void persistSend($, record);
	void persistHistory($, bundle, record);
	$.ui.log(statusLine(record, false), { to: "transcript" });
	// A second target sent with --send while the pane is open joins the pane's block of sends.
	$.ui.invalidate("ui.render");
	return record;
}

async function listCommand($: EngineInterface): Promise<void> {
	const { list, grouped, now } = await listGrouped($);
	const line = (row: SessionRow) => $.ui.log(`● ${rowParts(row, now).join(" · ")}`);
	if (list.targets.length === 0) $.ui.log("no live local sessions");
	else {
		$.ui.log(`This project: ${grouped.thisProject.label}`);
		if (grouped.thisProject.rows.length === 0) $.ui.log("● (no other session in this project)");
		for (const row of grouped.thisProject.rows) line(row);
		for (const repo of grouped.other.repos) {
			$.ui.log(`Other sessions: ${repo.label}`);
			for (const row of repo.rows) line(row);
		}
		if (grouped.other.noDetails.length > 0) {
			$.ui.log(`Other sessions: ${NO_DETAILS_HEADING}`);
			for (const row of grouped.other.noDetails) line(row);
		}
	}
	if (list.hiddenCount > 0) {
		$.ui.log(`hidden: ${list.hiddenCount} (not a local interactive session)`);
	}
}

// The target must be on a fresh list: never a session the user did not name, never a dead one.
async function sendCommand($: EngineInterface, wanted: string): Promise<void> {
	if (lastComposed === undefined) {
		$.ui.log(NOTHING_TO_SEND);
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

// `-p` has no pane to tick the project's sessions in: this sends the composed broadcast to all of
// them. A target that already has a record of this bundle is skipped, so a repeat (or a `--send`
// before it) does not message anyone twice. The record holds the bare name, so another session
// with the same name is skipped too.
async function sendRepoCommand($: EngineInterface): Promise<void> {
	const bundle = lastComposed;
	if (bundle === undefined) {
		$.ui.log(NOTHING_TO_SEND);
		return;
	}
	if (bundle.kind !== "broadcast") {
		$.ui.log("--send-repo sends a broadcast; compose one with /over --broadcast <intent>");
		return;
	}
	const { list, grouped } = await listGrouped($);
	const { targets: sameRepo } = resolvePicks(preselect(grouped), list.targets);
	if (sameRepo.length === 0) {
		$.ui.log("no other sessions of this repo on the list");
		return;
	}
	const sentTo = new Set(
		sends.filter((record) => record.bundleId === bundle.bundleId).map((record) => record.target),
	);
	const targets: Target[] = [];
	for (const target of sameRepo) {
		if (sentTo.has(target.name)) $.ui.log(`already sent to ${target.name}`);
		else targets.push(target);
	}
	if (targets.length === 0) return;
	try {
		const records = await deliverAll($, bundle, targets);
		$.ui.log(broadcastSummary(records));
	} catch (error) {
		$.ui.log(`send failed: ${reasonOf(error)}`);
	}
}

// One after the other, in the order given: not measured whether the engine serializes parallel
// sends, and the status lines then come out in the order of the picks. A throw leaves the records
// of the targets already sent in `sends`.
async function deliverAll(
	$: EngineInterface,
	bundle: Bundle,
	targets: readonly Target[],
): Promise<SendRecord[]> {
	const records: SendRecord[] = [];
	for (const target of targets) records.push(await deliver($, bundle, target));
	return records;
}

const broadcastSummary = (records: readonly SendRecord[]): string =>
	`broadcast passed on to ${records.filter((record) => record.status === "passed-on").length} of ${records.length} sessions`;

// The pane's status for -p, where nothing is drawn: every send this session knows, the saved ones
// included, grouped by bundle. It waits for the load, which a fresh `-p` process may still be doing.
async function statusCommand($: EngineInterface): Promise<void> {
	await sendsLoaded;
	logLines($, statusReport(sends, await $.clock.now()).join("\n"));
}

// The pane's history section for -p: the same rows with numbers, or one whole entry by its number.
async function historyCommand($: EngineInterface, index?: number): Promise<void> {
	const view = await readHistory($);
	if (view.state === "off") {
		$.ui.log("history is off: turn it on in /config (cc-over.history)");
		return;
	}
	if (view.state === "error") {
		$.ui.log(`could not read the history (${view.reason})`);
		return;
	}
	const { entries, project, now } = view;
	if (index !== undefined) {
		const entry = entries[index - 1];
		if (entry === undefined) $.ui.log(`no history entry ${index} (there are ${entries.length})`);
		else logLines($, historyDetail(entry, now));
		return;
	}
	if (entries.length === 0) {
		$.ui.log("no bundles sent from this project in the last 14 days");
		return;
	}
	$.ui.log(`History: ${project} (${entries.length})`);
	for (const [i, entry] of entries.entries()) $.ui.log(`${i + 1}. ${historyRow(entry, now)}`);
}

function usage($: EngineInterface, reason?: string): void {
	const text =
		"Usage: /over <intent> · /over --no-fork <intent> · /over --broadcast <intent> · /over --list · /over --send <session> · /over --send-repo · /over --status · /over --history [n]";
	$.ui.log(reason ? `${text} (${reason})` : text);
}

// ---- the pane ----

type PaneAction =
	| { kind: "select"; key: string }
	| { kind: "toggle"; group: "this" | "other" | "history" }
	| { kind: "openHistory"; bundleId: string }
	| { kind: "submit"; text: string }
	| { kind: "expand" | "refresh" | "send" | "close" | "type" };

async function refreshTargets($: EngineInterface, d: Draft): Promise<void> {
	if (isRefreshing || !canChoose(d.phase)) return;
	isRefreshing = true;
	try {
		const listing = await listGrouped($);
		if (draft === d && canChoose(d.phase)) {
			applyListing(d, listing);
			if (d.phase === "intent" && d.error?.startsWith("could not read the session list")) {
				delete d.error;
			}
		}
	} finally {
		isRefreshing = false;
	}
}

// The state goes to `sending` before the first await, so a second press of the same button
// (a Button has no `disabled`) finds a draft that is no longer `ready` and does nothing.
async function sendDraft($: EngineInterface, d: Draft): Promise<void> {
	const { bundle } = d;
	if (
		d.phase !== "ready" ||
		bundle === undefined ||
		pickHint(d.picked, d.kind, d.needsOnePick) !== undefined
	) {
		return;
	}
	// What the user picked, before the fresh list takes away the sessions that are gone.
	const picks = d.picked;
	d.phase = "sending";
	delete d.error;
	$.ui.invalidate("ui.render");
	try {
		const listing = await listGrouped($);
		applyListing(d, listing);
		const { targets, problems } = resolvePicks(picks, listing.list.targets);
		// Any problem stops the whole send: a hand-off to fewer sessions than picked, or a broadcast
		// that skipped one silently, is not what the user confirmed. `applyListing` already left in
		// `picked` the sessions without a problem.
		if (problems.length > 0) {
			d.phase = "ready";
			d.error = `not sent: ${problems.join("; ")}, check the selection and send again`;
			return;
		}
		const records = await deliverAll($, bundle, targets);
		// Closing the pane, or a newer /over, takes `draft` away while the confirmed
		// sends finish. Leave that newer pane's refresh timer alone, and do not toast
		// into a pane that is gone.
		if (draft !== d) return;
		d.phase = "sent";
		stopRefresh();
		const [only] = records;
		$.ui.toast(
			d.kind === "broadcast" || only === undefined
				? broadcastSummary(records)
				: statusLine(only, false),
		);
	} catch (error) {
		if (draft !== d) return;
		d.phase = "failed";
		d.error = `send failed: ${reasonOf(error)}`;
		stopRefresh();
	} finally {
		$.ui.invalidate("ui.render");
	}
}

// The type button. The bundle the other type needs is made first and the switch is applied in one
// step after it, so the pane never shows a type whose bundle is the other one, and a second press
// that comes in meanwhile (or a send, which still sees the old type) finds a draft that is whole.
// The rules (state sequencing in the plan):
// - to broadcast: the bundle is the intent as it is, ready at once, also while the fork runs; a
//   hand-off bundle already made is kept in `d.handoff`, the fork's late result goes there too;
//   the project's sessions are ticked only if the list was already read (else the first list does
//   it, in `applyListing`, and a compose still waiting for it makes the broadcast then);
// - to hand-off: `d.handoff` when there is one, else the fork in flight writes the bundle (its
//   end reads the type again), else a new compose starts.
async function switchType($: EngineInterface, d: Draft): Promise<void> {
	const from = d.kind;
	const to: BundleKind = from === "hand-off" ? "broadcast" : "hand-off";
	const hasIntent = d.phase !== "intent";
	const broadcast =
		to === "broadcast" && hasIntent && d.hasListing ? await composeBroadcast($, d) : undefined;
	if (draft !== d || d.kind !== from || !canChoose(d.phase)) return;
	d.kind = to;
	if (to === "broadcast") {
		const next = d.hasListing
			? switchKind(d.picked, "broadcast", {
					preselected: preselect(d.grouped),
					isPreselected: d.isPreselected,
				})
			: { picked: d.picked, isPreselected: d.isPreselected, needsOnePick: false };
		d.picked = next.picked;
		d.isPreselected = next.isPreselected;
		d.needsOnePick = next.needsOnePick;
		if (d.bundle?.kind === "hand-off") d.handoff = d.bundle;
		if (broadcast !== undefined) {
			d.bundle = broadcast;
			d.phase = "ready";
		}
	} else {
		const next = switchKind(d.picked, "hand-off", {
			preselected: [],
			isPreselected: d.isPreselected,
		});
		d.picked = next.picked;
		d.needsOnePick = next.needsOnePick;
		if (hasIntent) {
			if (d.handoff !== undefined) {
				d.bundle = d.handoff;
				d.phase = "ready";
			} else {
				delete d.bundle;
				d.phase = "composing";
				if (!d.isInFlight) void runCompose($, d);
			}
		}
	}
	// `lastComposed` is what the pane shows, so `--send` sends what the person sees.
	if (hasIntent) lastComposed = d.bundle;
	await retitlePane($, d.kind);
}

// Dismissing a preview that was not sent also withdraws its bundle from `--send`: a bundle the
// user cancelled must not go out later. A send already in `sending` was confirmed, so closing
// keeps that bundle for `--send` while the loop finishes. After a send, closing keeps it too.
function dropDraft(): void {
	if (
		draft &&
		draft.phase !== "sent" &&
		draft.phase !== "sending" &&
		lastComposed === draft.bundle
	) {
		lastComposed = undefined;
	}
	draft = undefined;
	stopRefresh();
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
		case "select": {
			const target = d.targets.find((candidate) => pickOf(candidate).key === action.key);
			if (canChoose(d.phase) && target !== undefined) {
				// A hand-off holds one pick, a broadcast toggles; any click clears the hint.
				const next = togglePick(d.picked, target, d.kind);
				d.picked = next.picked;
				d.needsOnePick = next.needsOnePick;
			}
			break;
		}
		case "submit": {
			// A repeated Enter finds a phase other than `intent` and does nothing.
			if (d.phase !== "intent") break;
			d.typed = action.text;
			const intent = intentFromField(action.text);
			if (intent === undefined) {
				d.error = "Type the intent first, then press Enter.";
				break;
			}
			// The phase moves before the compose is detached, so a second submit is a no-op.
			d.intent = intent;
			delete d.error;
			d.phase = "composing";
			void runCompose($, d);
			break;
		}
		case "toggle":
			d.collapsed[action.group] = !d.collapsed[action.group];
			break;
		case "openHistory":
			// One open entry at a time: the same row again closes it.
			if (d.historyOpen === action.bundleId) delete d.historyOpen;
			else d.historyOpen = action.bundleId;
			break;
		case "expand":
			d.isExpanded = !d.isExpanded;
			break;
		case "refresh":
			await refreshTargets($, d);
			if (d.phase === "intent") await readHistoryInto($, d);
			break;
		// Explicit, and it must end in `break`: `default` below is the send.
		case "type":
			await switchType($, d);
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

const sourceLine = (hiddenCount: number): string =>
	`From the platform's session list; details only from sessions running cc-over. Some sessions are not listed (see README).${hiddenCount > 0 ? ` hidden: ${hiddenCount} (not local)` : ""}`;

// A render that fails draws one line saying so: a throw would make the engine draw its own
// component and the user would not know why.
function renderPane($: EngineInterface, e: Args<"ui.render">) {
	const table = $.ui.resolve(e);
	const { Box, Text, Button, Markdown } = table;
	// The mobile table has no field; the pane never opens there (see `openPane`).
	const Input = "Input" in table ? table.Input : undefined;
	try {
		const d = draft;
		const close = (label: string) =>
			Button({ key: "close", label, onPress: () => panePress($, { kind: "close" }) });
		if (d === undefined) {
			return Box({
				flexDirection: "column",
				children: [
					Text({
						dimColor: true,
						children: "No hand-off in progress. Type /over or /over <intent>.",
					}),
					close("Close"),
				],
			});
		}

		const preview = d.bundle ? previewModel(d.bundle) : undefined;
		const bundleBlock = [];
		if (d.phase === "composing") {
			bundleBlock.push(
				Text({
					children: `Composing the bundle… (${d.mode === "fork" && d.kind === "hand-off" ? "fork" : "no model"})`,
				}),
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

		const isChoosing = canChoose(d.phase);
		const g = d.grouped;
		const visible = visibleRows(g, d.collapsed);
		// The first rows drawn belong to 'This project' (when it is unfolded), the rest to 'Other'.
		const thisCount = d.collapsed.this ? 0 : g.thisProject.rows.length;
		const rowButton = (v: VisibleRow) =>
			Button({
				key: `target:${pickOf(v.row).key}`,
				label: rowLabel(v.row, {
					isSelected: d.picked.some((pick) => pick.key === pickOf(v.row).key),
					isLast: v.isLast,
					...(v.hotkey ? { hotkey: v.hotkey } : {}),
					now: d.now,
				}),
				...(v.hotkey ? { hotkey: v.hotkey } : {}),
				onPress: () => panePress($, { kind: "select", key: pickOf(v.row).key }),
			});
		const groupButton = (group: "this" | "other") => {
			const hotkey = group === "this" ? "t" : "o";
			return Button({
				key: `group:${group}`,
				label: groupHeading(group, {
					label: g.thisProject.label,
					count: g.other.total,
					isCollapsed: d.collapsed[group],
					hotkey,
				}),
				hotkey,
				onPress: () => panePress($, { kind: "toggle", group }),
			});
		};
		const targetBlock = [
			Text({ dimColor: true, children: sourceLine(d.hiddenCount) }),
			groupButton("this"),
			...(d.collapsed.this
				? []
				: g.thisProject.rows.length === 0
					? [Text({ dimColor: true, children: "no other session in this project" })]
					: visible.slice(0, thisCount).map(rowButton)),
			groupButton("other"),
			...(d.collapsed.other
				? []
				: visible
						.slice(thisCount)
						.flatMap((v) => [
							...(v.heading !== undefined ? [Text({ dimColor: true, children: v.heading })] : []),
							rowButton(v),
						])),
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

		// Only the bare pane: a pane with an intent is about that one bundle.
		const historyBlock =
			d.phase === "intent"
				? historySection(table, {
						history: d.history,
						isCollapsed: d.collapsed.history,
						...(d.historyOpen !== undefined ? { openBundleId: d.historyOpen } : {}),
						onToggle: () => panePress($, { kind: "toggle", group: "history" }),
						onOpen: (bundleId) => panePress($, { kind: "openHistory", bundleId }),
					})
				: [];

		// Every send of this bundle, one row per target, read from `sends` on each draw.
		const statusBlock = d.bundle
			? bundleLines(sends, d.bundle.bundleId, d.now).map((line) => Text({ children: line }))
			: [];
		const actions = [];
		if (d.phase === "ready" || d.phase === "sending") {
			// Without a valid pick there is no Send button, only the reason in its place.
			const hint = pickHint(d.picked, d.kind, d.needsOnePick);
			actions.push(
				hint !== undefined
					? Text({ dimColor: true, children: hint })
					: Button({
							key: "send",
							label: d.phase === "sending" ? "Sending…" : withKey(sendLabel(d.picked, d.kind), "s"),
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
				Text({
					bold: true,
					children: d.phase === "intent" ? kindName(d.kind) : `${kindName(d.kind)}: ${d.intent}`,
				}),
				...(d.phase !== "intent"
					? []
					: Input === undefined
						? [
								Text({
									dimColor: true,
									children: "No intent field here: give the intent as /over <intent>.",
								}),
							]
						: [
								Input({
									key: "intent",
									label: "Intent:",
									placeholder: "What should the other session do?",
									value: d.typed,
									submitLabel: d.mode === "fork" ? "compose" : "compose (no model)",
									autoFocus: true,
									// Only the draft is written: no `$` call per keystroke.
									onInput: (value) => {
										if (draft === d) d.typed = value;
									},
									onSubmit: (value) => panePress($, { kind: "submit", text: value }),
								}),
							]),
				...(isChoosing
					? [
							Button({
								key: "type",
								label: withKey(`Type: ${d.kind}`, "y"),
								hotkey: "y",
								onPress: () => panePress($, { kind: "type" }),
							}),
						]
					: []),
				...bundleBlock,
				...(d.phase === "sent" || d.phase === "failed" ? [] : targetBlock),
				...historyBlock,
				...statusBlock,
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
	// A warning for a send saved before a reload must find it: wait for the load first.
	await sendsLoaded;
	// Read `sends` after the await: an ack landing meanwhile must not be overwritten by a stale copy.
	const now = await $.clock.now();
	// One warning can name several recipients (path A parses the plural lines); each is matched
	// on its own against the sends as they stand after the previous one.
	// A send already matched by an earlier recipient of this warning is not a candidate again, even
	// when its status did not change: two targets that share a name get a record each.
	const matched = new Set<string>();
	for (const recipient of notice.recipients) {
		const match = matchNotice(sends, notice.kind, recipient, now, matched);
		if (match === null) continue;
		matched.add(match.record.sendId);
		const updated = applyNotice(match.record, notice.kind, now);
		if (updated === match.record) continue;
		sends = sends.map((record) => (record.sendId === updated.sendId ? updated : record));
		void persistSend($, updated);
		void persistHistoryStatus($, updated);
		const line = statusLine(updated, match.isAmbiguous);
		$.ui.toast(line);
		$.ui.log(line, { to: "transcript" });
		$.ui.invalidate("ui.render");
	}
}

// ---- acknowledgements ----

// The recipient's `over-ack <bundle-id> <send-id>` comes back as a peer message. A tracked send
// becomes `received` whatever the ack carries; only the bare line is taken, so the sender's model
// runs no turn for it, while a note after the ids (the recipient explaining what it left undone)
// still reaches the model. Returns the reason to take the delivery, or null to pass it on.
async function observeAck($: EngineInterface, text: string): Promise<string | null> {
	const ack = parseAck(text);
	if (ack === null) return null;
	const isBare = ack.extra === "";
	// An ack for a send saved before a reload must find it: wait for the load first.
	await sendsLoaded;
	const now = await $.clock.now();
	// Matched after the await, so a second ack sees the record the first one already settled.
	const record = matchAck(sends, ack);
	if (record !== undefined) {
		markReceived($, record, now);
	} else if (isBare) {
		$.ui.log(
			`acknowledgement for a send this session no longer tracks: ${ack.bundleId} ${ack.sendId} from ${ack.fromName ?? "unknown"}`,
			{ to: "debug" },
		);
	}
	return isBare ? `acknowledgement ${ack.bundleId} ${ack.sendId}` : null;
}

// A repeated ack finds the record already `received`, so it raises no second status line.
function markReceived($: EngineInterface, record: SendRecord, now: number): void {
	const updated = applyAck(record, now);
	if (updated === record) return;
	sends = sends.map((candidate) => (candidate.sendId === updated.sendId ? updated : candidate));
	void persistSend($, updated);
	void persistHistoryStatus($, updated);
	// The id pair is unique, so unlike a platform warning this is never a guess.
	const line = statusLine(updated, false);
	$.ui.toast(line);
	$.ui.log(line, { to: "transcript" });
	$.ui.invalidate("ui.render");
}

async function overCommand($: EngineInterface, args: string): Promise<Record<string, never>> {
	const parsed = parseOverArgs(args);
	switch (parsed.kind) {
		case "compose":
			await composeCommand($, parsed.intent, parsed.noFork, parsed.bundleKind);
			break;
		case "list":
			await listCommand($);
			break;
		case "send":
			await sendCommand($, parsed.target);
			break;
		case "send-repo":
			await sendRepoCommand($);
			break;
		case "panel":
			await panelCommand($);
			break;
		case "status":
			await statusCommand($);
			break;
		case "history":
			await historyCommand($, parsed.index);
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
				"Hand the work over to another local session, or send a short notice to several: bare /over opens the pane to type the intent; /over <intent> previews a bundle; --broadcast <intent>, --list, --send <session>, --send-repo, --status, --history [n], --no-fork",
			argumentHint:
				"[intent] | --list | --send <session> | --send-repo | --status | --history [n] | --no-fork <intent> | --broadcast <intent>",
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const text = `/${COMMAND} is unavailable: the command could not be registered (${reason})`;
		$.ui.toast(text);
		$.ui.log(text);
	}
}

export const register: Register = (on) => {
	currentSessionId = undefined;
	sessionStartedAt = undefined;
	lastComposed = undefined;
	sends = [];
	sendsLoaded = Promise.resolve();
	draft = undefined;
	stopRefresh();
	isRefreshing = false;
	registryWrites = Promise.resolve();
	registryUnitsInFlight = 0;
	reportedStoreErrors.clear();

	// Fires on startup and after a hot reload. The load starts before the command exists, so a
	// `/over --status` that comes at once (a fresh `-p`) finds `sendsLoaded` already set.
	on("session.start", async ($, e, next) => {
		sessionStartedAt ??= await $.clock.now();
		const sessionId = await $.session.id();
		sendsLoaded = loadSends($, sessionId);
		await registerCommand($);
		await registerSession($, sessionId, { prune: true });
		await sendsLoaded;
		return next(e);
	});

	// After `/clear` `$.session.id()` can still name the old session: the entry goes under the
	// event's id, and that session's saved sends (a `/resume`d one has some) come back.
	on("classic.SessionStart", async ($, e, next) => {
		sessionStartedAt = await $.clock.now();
		// `/clear` and `/resume` bring a new id: the old session's sends stop being reported here.
		// A compaction keeps the id, so its sends (some maybe not saved yet) and the bundle stay.
		sends = sends.filter((r) => r.ownerSessionId === e.session_id);
		sendsLoaded = loadSends($, e.session_id);
		await registerSession($, e.session_id, { prune: false });
		await sendsLoaded;
		return next(e);
	}).catch((_$, e, next) => next(e));

	// Both observe only (the result passes on unchanged) and detach the write from the turn. The
	// filter keeps a subagent's turns out: its activity is not this session's.
	on("turn.start", async ($, e, next) => {
		const started = await next(e);
		if (e.agentId === undefined) void touchSession($);
		return started;
	});

	on("turn.complete", async ($, e, next) => {
		const completed = await next(e);
		if (e.agentId === undefined) void touchSession($);
		return completed;
	});

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

	// A lost peer message is worse than an ack that reaches the model, so every path that is not a
	// clean ack passes on, the `.catch` included. A message for a subagent's loop (`agentId`) is not
	// about this conversation's sends. The filter sits in the body rather than in an
	// `{ origin: "peer" }` matcher: the kind and `agentId` checks stay in one place, and the
	// matcher's string form is only an example in the types (M:4456), untested here.
	// `next` stays outside the `try`, so a failure below it is never delivered twice.
	on("session.receive", async ($, e, next) => {
		let consumed: string | null = null;
		try {
			const isPeerOfMainLoop = e.origin.kind === "peer" && e.agentId === undefined;
			consumed = isPeerOfMainLoop ? await observeAck($, e.text) : null;
		} catch (error) {
			$.ui.log(`ack tracking failed (${reasonOf(error)})`, { to: "debug" });
		}
		return consumed === null ? next(e) : { consumed };
	}).catch((_$, e, next) => next(e));

	// The person closing the pane (Escape) drops the draft, so a reopened pane starts clean.
	// Always `next`: this mod never keeps the pane open.
	on("ui.close", (_$, e, next) => {
		if (e.id === PANE_ID) dropDraft();
		return next(e);
	}).catch((_$, e, next) => next(e));
};
