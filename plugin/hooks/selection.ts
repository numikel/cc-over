// Which sessions the user picked for a send. Pure: no `$` in this file.

import type { BundleKind } from "./bundle.js";
import type { Grouped } from "./groups.js";
import type { Target } from "./sessions.js";

/** One picked session. `key` is `Target.ref`, or `"addr:" + address` where the list gave no ref. */
export type Pick = { key: string; name: string };

const HAND_OFF_HINT = "pick one session for a hand-off";
const MAX_LISTED_NAMES = 3;

// The key of a pick: `ref` outlives a `/rename`, an address does not.
export const pickOf = (target: Target): Pick => ({
	key: target.ref ?? `addr:${target.address}`,
	name: target.name,
});

/** The sessions of this project, in list order. Rows of other repos or without details never. */
export function preselect(grouped: Grouped): Pick[] {
	return grouped.thisProject.rows.map(pickOf);
}

/** A click on a row: a hand-off holds one pick, a broadcast toggles. Any click clears the hint. */
export function togglePick(
	picked: Pick[],
	target: Target,
	kind: BundleKind,
): { picked: Pick[]; needsOnePick: false } {
	const pick = pickOf(target);
	const isPicked = picked.some((p) => p.key === pick.key);
	if (kind === "hand-off") {
		return { picked: isPicked ? [] : [pick], needsOnePick: false };
	}
	return {
		picked: isPicked ? picked.filter((p) => p.key !== pick.key) : [...picked, pick],
		needsOnePick: false,
	};
}

/**
 * The type switch. Up to broadcast the project's sessions join the picks once (a union by key,
 * so a session picked earlier does not enter twice); down to hand-off more than one pick cannot
 * stay, and none is chosen for the user.
 */
export function switchKind(
	picked: Pick[],
	to: BundleKind,
	opts: { preselected: Pick[]; isPreselected: boolean },
): { picked: Pick[]; isPreselected: boolean; needsOnePick: boolean } {
	if (to === "broadcast") {
		if (opts.isPreselected) return { picked, isPreselected: true, needsOnePick: false };
		const known = new Set(picked.map((p) => p.key));
		const added: Pick[] = [];
		for (const pick of opts.preselected) {
			if (known.has(pick.key)) continue;
			known.add(pick.key);
			added.push(pick);
		}
		return { picked: [...picked, ...added], isPreselected: true, needsOnePick: false };
	}
	if (picked.length <= 1) {
		return { picked, isPreselected: opts.isPreselected, needsOnePick: false };
	}
	return { picked: [], isPreselected: opts.isPreselected, needsOnePick: true };
}

/** Drops the picks that left the list; never adds one. */
export function keepListed(picked: Pick[], targets: Target[]): Pick[] {
	const listed = new Set(targets.map((target) => pickOf(target).key));
	return picked.filter((pick) => listed.has(pick.key));
}

/**
 * The targets behind the picks, in the order of the picks. A pick that is gone is a problem,
 * not a guess: a name that now sits under another key is another session.
 */
export function resolvePicks(
	picked: Pick[],
	targets: Target[],
): { targets: Target[]; problems: string[] } {
	const byKey = new Map(targets.map((target) => [pickOf(target).key, target]));
	const names = new Set(targets.map((target) => target.name));
	const resolved: Target[] = [];
	const problems: string[] = [];
	for (const pick of picked) {
		const target = byKey.get(pick.key);
		if (target !== undefined) resolved.push(target);
		else if (names.has(pick.name)) problems.push(`${pick.name} is a different session now`);
		else problems.push(`${pick.name} is no longer on the session list`);
	}
	return { targets: resolved, problems };
}

/** The send button's words, without the hotkey suffix. */
export function sendLabel(picked: Pick[], kind: BundleKind): string {
	if (kind === "hand-off") {
		const [first] = picked;
		return first === undefined ? "Send" : `Send to ${first.name}`;
	}
	const [first] = picked;
	if (first === undefined) return "Send";
	if (picked.length === 1) return `Send to 1 session: ${first.name}`;
	const shown = picked.slice(0, MAX_LISTED_NAMES).map((pick) => pick.name);
	const more = picked.length > MAX_LISTED_NAMES ? ", …" : "";
	return `Send to ${picked.length} sessions: ${shown.join(", ")}${more}`;
}

/** Why Send is not offered yet, or undefined when the picks are fine. */
export function pickHint(
	picked: Pick[],
	kind: BundleKind,
	needsOnePick: boolean,
): string | undefined {
	if (picked.length === 0) {
		return kind === "hand-off" && needsOnePick ? HAND_OFF_HINT : "pick at least one session";
	}
	if (kind === "hand-off" && picked.length > 1) return HAND_OFF_HINT;
	return undefined;
}
