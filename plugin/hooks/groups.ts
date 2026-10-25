// Session list model: join ListAgents targets with the registry, group them, number the visible
// rows and spell the labels. Pure: no `$` in this file.

import {
	projectKey,
	projectLabel,
	type RegistryEntry,
	slashed,
	worktreeLabel,
} from "./registry.js";
import type { Target } from "./sessions.js";

export type SessionRow = Target & { entry?: RegistryEntry };

export type Grouped = {
	thisProject: { label: string; rows: SessionRow[] };
	other: {
		total: number;
		repos: { label: string; rows: SessionRow[] }[];
		noDetails: SessionRow[];
	};
};

export type VisibleRow = { row: SessionRow; hotkey?: string; isLast: boolean; heading?: string };

// `ref` is the only key shared by a list row and a registry entry: it survives `/rename` and
// `/clear`, while the stored name and session id do not (evidence § 4).
export function joinRegistry(targets: Target[], entries: RegistryEntry[]): SessionRow[] {
	const byRef = new Map<string, RegistryEntry>();
	for (const entry of entries) {
		if (entry.ref === undefined) continue;
		const known = byRef.get(entry.ref);
		if (known === undefined || isNewer(entry, known)) byRef.set(entry.ref, entry);
	}
	return targets.map((target): SessionRow => {
		const entry = target.ref === undefined ? undefined : byRef.get(target.ref);
		return entry === undefined ? target : { ...target, entry };
	});
}

// Two entries share a ref after `/clear`. The later write wins; the tie-breaks only make the
// choice independent of the order the store returned them in.
function isNewer(a: RegistryEntry, b: RegistryEntry): boolean {
	if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
	if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt > b.lastActivityAt;
	return a.sessionId > b.sessionId;
}

// Newest first; Array.prototype.sort is stable, so a tie keeps the platform's order.
function byActivity(rows: SessionRow[]): SessionRow[] {
	const at = (row: SessionRow) => row.entry?.lastActivityAt ?? 0;
	return [...rows].sort((a, b) => at(b) - at(a));
}

// The path as the registry recorded it, only with forward slashes and no trailing one.
function fullPath(entry: RegistryEntry): string {
	return slashed(entry.repoRoot ?? entry.root);
}

export function groupSessions(rows: SessionRow[], self: { key: string; label: string }): Grouped {
	const mine: SessionRow[] = [];
	const noDetails: SessionRow[] = [];
	const repos = new Map<string, { entry: RegistryEntry; rows: SessionRow[] }>();
	for (const row of rows) {
		const entry = row.entry;
		if (entry === undefined) {
			noDetails.push(row);
			continue;
		}
		const key = projectKey(entry);
		if (key === self.key) {
			mine.push(row);
			continue;
		}
		const repo = repos.get(key);
		if (repo === undefined) repos.set(key, { entry, rows: [row] });
		else repo.rows.push(row);
	}

	// Two repos named alike would be indistinguishable, so both show where they live.
	const nameCounts = new Map<string, number>();
	for (const { entry } of repos.values()) {
		const name = projectLabel(entry).toLowerCase();
		nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	}
	const grouped = [...repos.entries()]
		.map(([key, { entry, rows: repoRows }]) => ({
			key,
			label:
				(nameCounts.get(projectLabel(entry).toLowerCase()) ?? 0) > 1
					? fullPath(entry)
					: projectLabel(entry),
			rows: byActivity(repoRows),
		}))
		.sort((a, b) => {
			const left = a.label.toLowerCase();
			const right = b.label.toLowerCase();
			if (left !== right) return left < right ? -1 : 1;
			return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
		})
		.map(({ label, rows: repoRows }) => ({ label, rows: repoRows }));

	return {
		thisProject: { label: self.label, rows: byActivity(mine) },
		other: {
			total: grouped.reduce((sum, repo) => sum + repo.rows.length, noDetails.length),
			repos: grouped,
			noDetails,
		},
	};
}

export const NO_DETAILS_HEADING = "no details (mod not running there)";

const MAX_HOTKEY = 9;

// The rows the panel draws, top to bottom. Only these are numbered, so a collapsed group
// neither shows rows nor takes keys, and the sub-heading of a block rides on its first row.
export function visibleRows(
	g: Grouped,
	collapsed: { this: boolean; other: boolean },
): VisibleRow[] {
	const blocks: { rows: SessionRow[]; heading?: string }[] = [];
	if (!collapsed.this) blocks.push({ rows: g.thisProject.rows });
	if (!collapsed.other) {
		for (const repo of g.other.repos) blocks.push({ rows: repo.rows, heading: repo.label });
		blocks.push({ rows: g.other.noDetails, heading: NO_DETAILS_HEADING });
	}

	const visible: VisibleRow[] = [];
	for (const block of blocks) {
		block.rows.forEach((row, index) => {
			const position = visible.length + 1;
			visible.push({
				row,
				...(position <= MAX_HOTKEY ? { hotkey: String(position) } : {}),
				isLast: index === block.rows.length - 1,
				...(index === 0 && block.heading !== undefined ? { heading: block.heading } : {}),
			});
		});
	}
	return visible;
}

/** Floored, in the largest whole unit: `5s`, `2m`, `1h`, `3d`. Negative or NaN counts as 0. */
export function relativeAge(ms: number): string {
	const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// The branch in the main checkout, `<worktree> (<branch>)` inside a worktree.
function placeOf(entry: RegistryEntry): string | undefined {
	const worktree = worktreeLabel(entry);
	const branch = entry.branch === "" ? undefined : entry.branch;
	if (worktree === undefined) return branch;
	return branch === undefined ? worktree : `${worktree} (${branch})`;
}

/** What a row says, in order: address, place, status, age, note; the parts that exist. */
export function rowParts(row: SessionRow, now: number): string[] {
	const entry = row.entry;
	const age =
		entry !== undefined
			? `${relativeAge(now - entry.lastActivityAt)} ago`
			: row.startedAgo !== undefined
				? `started ${row.startedAgo} ago`
				: undefined;
	return [
		row.address,
		entry === undefined ? undefined : placeOf(entry),
		row.status,
		age,
		row.note,
	].filter((part): part is string => part !== undefined && part !== "");
}

export function rowLabel(
	row: SessionRow,
	o: { isSelected: boolean; isLast: boolean; hotkey?: string; now: number },
): string {
	const parts = rowParts(row, o.now);
	const branch = o.isLast ? "└─" : "├─";
	const dot = o.isSelected ? "●" : "○";
	const key = o.hotkey === undefined ? "" : ` (${o.hotkey})`;
	return `${branch} ${dot} ${parts.join(" · ")}${key}`;
}

export function groupHeading(
	kind: "this" | "other",
	o: { label: string; count: number; isCollapsed: boolean; hotkey?: string },
): string {
	const arrow = o.isCollapsed ? "▶" : "▼";
	const title = kind === "this" ? `This project: ${o.label}` : `Other sessions: ${o.count}`;
	const key = o.hotkey === undefined ? "" : ` (${o.hotkey})`;
	return `${arrow} ${title}${key}`;
}
