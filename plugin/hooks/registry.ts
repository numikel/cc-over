// What each session running cc-over records about itself in the shared `$.store`, so the
// panel can show repo, worktree, branch and last activity that ListAgents does not give.
// Pure: no `$` in this file.

export type RegistryEntry = {
	v: 1;
	sessionId: string;
	/** From the ListAgents header; `/rename` has no event, so it can be stale. */
	name?: string;
	/** Stable across `/rename` and `/clear`; the key that joins an entry to a list row. */
	ref?: string;
	/** `$.session.root()` */
	root: string;
	/** `$.session.repo()?.root`: the main working tree's root, also inside a worktree. */
	repoRoot?: string;
	branch?: string;
	lastActivityAt: number;
	updatedAt: number;
};

export const REGISTRY_PREFIX = "session:";

export function registryKey(sessionId: string): string {
	return `${REGISTRY_PREFIX}${sessionId}`;
}

const DRIVE_LETTER = /^[A-Za-z]:/;
const BARE_DRIVE = /^[A-Za-z]:$/;

// Forward slashes, no trailing slash; a bare root ("/" or a drive root) keeps its slash.
export function slashed(path: string): string {
	const forward = path.replace(/\\/g, "/");
	const trimmed = forward.replace(/\/+$/, "");
	if (trimmed === "") return forward.startsWith("/") ? "/" : "";
	return BARE_DRIVE.test(trimmed) ? `${trimmed}/` : trimmed;
}

function basename(path: string): string {
	const normal = slashed(path);
	const last = normal.slice(normal.lastIndexOf("/") + 1);
	return last === "" ? normal : last;
}

// Windows ignores case, Linux does not: only paths with a drive letter are lowercased.
export function normalizePath(path: string): string {
	const normal = slashed(path);
	return DRIVE_LETTER.test(normal) ? normal.toLowerCase() : normal;
}

type Place = Pick<RegistryEntry, "root" | "repoRoot">;

export function projectKey(entry: Place): string {
	return normalizePath(entry.repoRoot ?? entry.root);
}

export function projectLabel(entry: Place): string {
	return basename(entry.repoRoot ?? entry.root);
}

/** The worktree directory name, or undefined in the main checkout and outside git. */
export function worktreeLabel(entry: Place): string | undefined {
	if (entry.repoRoot === undefined) return undefined;
	return normalizePath(entry.root) === normalizePath(entry.repoRoot)
		? undefined
		: basename(entry.root);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function isTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

const OPTIONAL_TEXT = ["name", "ref", "repoRoot", "branch"] as const;

/**
 * Validates a value read from the shared store, which can hold junk or another version. Returns a
 * new entry with the known fields only, or null when the record is corrupt; never throws.
 */
export function parseEntry(value: unknown): RegistryEntry | null {
	if (!isRecord(value) || value.v !== 1) return null;
	const { sessionId, root, lastActivityAt, updatedAt } = value;
	if (!isNonEmptyString(sessionId) || !isNonEmptyString(root)) return null;
	if (!isTime(lastActivityAt) || !isTime(updatedAt)) return null;
	const entry: RegistryEntry = { v: 1, sessionId, root, lastActivityAt, updatedAt };
	for (const field of OPTIONAL_TEXT) {
		const text = value[field];
		if (text === undefined) continue;
		if (typeof text !== "string") return null;
		entry[field] = text;
	}
	return entry;
}

export type RegistryPatch = Partial<RegistryEntry> & { sessionId: string };

// A key present in the patch wins, even as undefined (which removes an optional field); a key left
// out keeps the previous value.
function pick(
	prev: RegistryEntry | null,
	patch: RegistryPatch,
	key: (typeof OPTIONAL_TEXT)[number],
): string | undefined {
	return key in patch ? patch[key] : prev?.[key];
}

/**
 * Merges a patch into the previous entry. Last activity only moves forward. Returns null when no
 * root is known: a light activity update must not invent an entry.
 */
export function nextEntry(
	prev: RegistryEntry | null,
	patch: RegistryPatch,
	now: number,
): RegistryEntry | null {
	const root = patch.root ?? prev?.root;
	if (root === undefined) return null;
	const seen = [prev?.lastActivityAt, patch.lastActivityAt].filter((t) => t !== undefined);
	const entry: RegistryEntry = {
		v: 1,
		sessionId: patch.sessionId,
		root,
		lastActivityAt: seen.length === 0 ? now : Math.max(...seen),
		updatedAt: now,
	};
	for (const field of OPTIONAL_TEXT) {
		const text = pick(prev, patch, field);
		if (text !== undefined) entry[field] = text;
	}
	return entry;
}

export const PRUNE_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;
export const PRUNE_MAX_BYTES = 3 * 1024 * 1024;
/** How many registry entries one prune pass looks at. */
export const PRUNE_SCAN_LIMIT = 500;

export type PruneItem = { key: string; sessionId: string; updatedAt: number; size: number };

export type PruneLimits = {
	maxAgeMs: number;
	maxBytes: number;
	/** The current session is never selected, though it counts toward the byte total. */
	keepSessionId: string;
};

/**
 * The store keys to delete: first every entry untouched for more than `maxAgeMs`, oldest first;
 * then, while the rest still weighs more than `maxBytes`, the oldest remaining ones.
 */
export function selectPrunable(
	items: readonly PruneItem[],
	now: number,
	limits: PruneLimits,
): string[] {
	const oldestFirst = [...items].sort((a, b) => a.updatedAt - b.updatedAt);
	const doomed: string[] = [];
	const kept: PruneItem[] = [];
	for (const item of oldestFirst) {
		if (item.sessionId !== limits.keepSessionId && now - item.updatedAt > limits.maxAgeMs) {
			doomed.push(item.key);
		} else {
			kept.push(item);
		}
	}
	let total = kept.reduce((sum, item) => sum + item.size, 0);
	for (const item of kept) {
		if (total <= limits.maxBytes) break;
		if (item.sessionId === limits.keepSessionId) continue;
		doomed.push(item.key);
		total -= item.size;
	}
	return doomed;
}
