// ListAgents result -> sessions the user may pick. Pure: no `$` in this file.

export type Target = {
	name: string;
	ref?: string;
	/** The platform's word as listed (`idle`, `busy`, `waiting`, `shell`, ...). */
	status?: string;
	type?: string;
	/** What `$.session.send` gets as `to`: the name, or `name [ref]` when the name repeats. */
	address: string;
	isSendable: boolean;
	note?: string;
	/** The `<x>` of "started <x> ago" from the listing text (`12h`, `1m`, `23s`). */
	startedAgo?: string;
};

// Structural subset of the ListAgents result (claude-code-tools/index.d.ts:4837-4855).
export type ListAgentsRow = { name?: string; ref?: string; type?: string; status?: string };
export type ListAgentsResult = {
	listing?: string;
	sections?: { kind?: string; total?: number; rows: ListAgentsRow[] }[];
};

export type TargetList = {
	targets: Target[];
	hiddenCount: number;
	selfName?: string;
	/** This session's own `ref` from the header: the key of its registry entry. */
	selfRef?: string;
};

// Only `interactive` was ever observed; the list can also hold cloud and Remote Control
// sessions, which a local hand-off must not offer (PRD: no delivery beyond one machine).
const LOCAL_TYPE = "interactive";

// "This session is <name> [<ref>] — ..." (evidence E2). The header may follow an extra
// paragraph about a missing SendMessage tool, so it is matched on any line.
const SELF_HEADER = /^This session is (.+?) \[([^\]]+)\] — /m;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "  <name> [<ref>]  ·  <type>  ·  [<status>  ·  ]started <x> ago" (evidence § 3): the row is
// found by its exact "[<ref>]", because names repeat and may hold spaces and pipes. A
// listing in another format yields undefined rather than a guess.
function startedAgoOf(listing: string, ref: string | undefined): string | undefined {
	if (ref === undefined || ref === "") return undefined;
	const line = new RegExp(
		`^[ \\t]+[^\\n]*? \\[${escapeRegExp(ref)}\\]  ·  (?:[^\\n]*  ·  )?started (\\S+) ago[ \\t]*$`,
		"m",
	);
	return line.exec(listing)?.[1];
}

export function targetsFromListAgents(result: ListAgentsResult): TargetList {
	const rows = (result.sections ?? []).flatMap((section) => section.rows);
	const named = rows.filter((row) => row.name !== undefined && row.name !== "");

	// The platform counts every reachable agent when it rejects an ambiguous name, so
	// hidden sessions take part in the duplicate check too.
	const nameCounts = new Map<string, number>();
	for (const row of named)
		nameCounts.set(row.name ?? "", (nameCounts.get(row.name ?? "") ?? 0) + 1);

	const header = SELF_HEADER.exec(result.listing ?? "");
	const selfName = header?.[1];
	const selfRef = header?.[2];

	const targets: Target[] = [];
	let hiddenCount = 0;
	for (const row of named) {
		if (row.type !== LOCAL_TYPE) {
			hiddenCount += 1;
			continue;
		}
		const name = row.name ?? "";
		const isSelf =
			selfRef !== undefined && row.ref !== undefined
				? row.ref === selfRef
				: selfName !== undefined && name === selfName;
		if (isSelf) {
			continue;
		}
		const isDuplicate =
			((nameCounts.get(name) ?? 0) > 1 || (selfName !== undefined && name === selfName)) &&
			row.ref !== undefined;
		const status = row.status !== undefined && row.status !== "" ? row.status : undefined;
		const startedAgo = startedAgoOf(result.listing ?? "", row.ref);
		targets.push({
			name,
			...(row.ref !== undefined ? { ref: row.ref } : {}),
			...(status ? { status } : {}),
			type: row.type,
			address: isDuplicate ? `${name} [${row.ref}]` : name,
			isSendable: true,
			...(status === "waiting" ? { note: "waiting for the user" } : {}),
			...(startedAgo !== undefined ? { startedAgo } : {}),
		});
	}

	return {
		targets,
		hiddenCount,
		...(selfName ? { selfName } : {}),
		...(selfRef ? { selfRef } : {}),
	};
}
