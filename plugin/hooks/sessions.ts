// ListAgents result -> sessions the user may pick. Pure: no `$` in this file.

export type TargetStatus = "idle" | "busy" | "waiting";

export type Target = {
	name: string;
	ref?: string;
	status?: TargetStatus;
	type?: string;
	/** What `$.session.send` gets as `to`: the name, or `name [ref]` when the name repeats. */
	address: string;
	isSendable: boolean;
	note?: string;
};

// Structural subset of the ListAgents result (claude-code-tools/index.d.ts:4837-4855).
export type ListAgentsRow = { name?: string; ref?: string; type?: string; status?: string };
export type ListAgentsResult = {
	listing?: string;
	sections?: { kind?: string; total?: number; rows: ListAgentsRow[] }[];
};

export type TargetList = { targets: Target[]; hiddenCount: number; selfName?: string };

// Only `interactive` was ever observed; the list can also hold cloud and Remote Control
// sessions, which a local hand-off must not offer (PRD: no delivery beyond one machine).
const LOCAL_TYPE = "interactive";

const STATUSES: readonly string[] = ["idle", "busy", "waiting"];

// "This session is <name> [<ref>] — ..." (evidence E2). The header may follow an extra
// paragraph about a missing SendMessage tool, so it is matched on any line.
const SELF_HEADER = /^This session is (.+?) \[[^\]]+\] — /m;

export function targetsFromListAgents(result: ListAgentsResult): TargetList {
	const rows = (result.sections ?? []).flatMap((section) => section.rows);
	const named = rows.filter((row) => row.name !== undefined && row.name !== "");

	// The platform counts every reachable agent when it rejects an ambiguous name, so
	// hidden sessions take part in the duplicate check too.
	const nameCounts = new Map<string, number>();
	for (const row of named)
		nameCounts.set(row.name ?? "", (nameCounts.get(row.name ?? "") ?? 0) + 1);

	const selfName = SELF_HEADER.exec(result.listing ?? "")?.[1];

	const targets: Target[] = [];
	let hiddenCount = 0;
	for (const row of named) {
		if (row.type !== LOCAL_TYPE) {
			hiddenCount += 1;
			continue;
		}
		const name = row.name ?? "";
		if (selfName !== undefined && name === selfName) {
			continue;
		}
		const isDuplicate = (nameCounts.get(name) ?? 0) > 1 && row.ref !== undefined;
		const status =
			row.status !== undefined && STATUSES.includes(row.status)
				? (row.status as TargetStatus)
				: undefined;
		targets.push({
			name,
			...(row.ref !== undefined ? { ref: row.ref } : {}),
			...(status ? { status } : {}),
			type: row.type,
			address: isDuplicate ? `${name} [${row.ref}]` : name,
			isSendable: true,
			...(status === "waiting" ? { note: "waiting for the user" } : {}),
		});
	}

	return { targets, hiddenCount, ...(selfName ? { selfName } : {}) };
}
