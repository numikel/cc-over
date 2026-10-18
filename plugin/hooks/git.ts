// Pure git helpers: fixed argv for `$.process.run`, parsers for their output, and
// the merge of the three change sources into one list. No `$` in this file.

export type ChangeStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "untracked"
	| "other";
export type ChangeSource = "uncommitted" | "branch" | "session-commits";

export type RawChange = { path: string; status: ChangeStatus; from?: string };
export type FileChange = RawChange & { source: ChangeSource };
export type SessionCommit = { hash: string; subject: string; changes: RawChange[] };
export type GitRun = { exitCode: number; stdout: string };
export type GitMode = "branch-diff" | "session-commits" | "uncommitted-only";
export type GitSummary = {
	branch: string;
	base: string;
	mode: GitMode;
	changes: FileChange[];
	/** How many changes were cut off by MAX_CHANGES. */
	truncated: number;
	note?: string;
};

export const MAX_CHANGES = 200;
export const LOG_MARKER = "@@commit ";

export const GIT_STATUS = ["git", "status", "--porcelain=v1"];
export const GIT_BRANCH = ["git", "rev-parse", "--abbrev-ref", "HEAD"];
export const GIT_HEAD = ["git", "rev-parse", "HEAD"];
export const GIT_SHORT_HEAD = ["git", "rev-parse", "--short", "HEAD"];
export const GIT_ORIGIN_HEAD = ["git", "rev-parse", "--abbrev-ref", "origin/HEAD"];

export const gitMergeBaseArgv = (baseRef: string) => ["git", "merge-base", "--", "HEAD", baseRef];
export const gitBranchDiffArgv = (baseRef: string) => [
	"git",
	"diff",
	"--name-status",
	`${baseRef}...HEAD`,
];
export const gitSessionLogArgv = (sinceEpochSec: number) => [
	"git",
	"log",
	`--since=@${sinceEpochSec}`,
	"--name-status",
	`--format=${LOG_MARKER}%h %s`,
];

const ESCAPES: Record<string, number> = {
	a: 7,
	b: 8,
	t: 9,
	n: 10,
	v: 11,
	f: 12,
	r: 13,
	'"': 34,
	"\\": 92,
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Git quotes unusual paths C-style, with non-ASCII bytes as octal escapes
// ("\305\202.txt" is "ł.txt"), so the escapes are collected as bytes and decoded as UTF-8.
function unquoteInner(inner: string): string {
	const bytes: number[] = [];
	let i = 0;
	while (i < inner.length) {
		const ch = inner[i] ?? "";
		if (ch !== "\\") {
			const cp = inner.codePointAt(i) ?? 0;
			const width = cp > 0xffff ? 2 : 1;
			bytes.push(...encoder.encode(inner.slice(i, i + width)));
			i += width;
			continue;
		}
		const next = inner[i + 1] ?? "";
		if (next >= "0" && next <= "7") {
			bytes.push(Number.parseInt(inner.slice(i + 1, i + 4), 8));
			i += 4;
			continue;
		}
		const escaped = ESCAPES[next];
		if (escaped !== undefined) {
			bytes.push(escaped);
			i += 2;
			continue;
		}
		bytes.push(92);
		i += 1;
	}
	return decoder.decode(new Uint8Array(bytes));
}

function unquotePath(token: string): string {
	return token.length >= 2 && token.startsWith('"') && token.endsWith('"')
		? unquoteInner(token.slice(1, -1))
		: token;
}

// Index just past the closing quote of a quoted token that starts at `start`.
function quotedEnd(s: string, start: number): number {
	let i = start + 1;
	while (i < s.length) {
		if (s[i] === "\\") i += 2;
		else if (s[i] === '"') return i + 1;
		else i += 1;
	}
	return s.length;
}

// "old -> new" with either side optionally quoted; null when there is no arrow.
function splitRename(rest: string): { from: string; to: string } | null {
	const end = rest.startsWith('"') ? quotedEnd(rest, 0) : rest.indexOf(" -> ");
	if (end < 0 || !rest.startsWith(" -> ", end)) return null;
	return { from: unquotePath(rest.slice(0, end)), to: unquotePath(rest.slice(end + 4)) };
}

function statusOf(letter: string): ChangeStatus {
	switch (letter) {
		case "A":
			return "added";
		case "M":
		case "T":
			return "modified";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		default:
			return "other";
	}
}

const lines = (stdout: string) => stdout.split(/\r?\n/).filter((line) => line !== "");

export function parsePorcelain(stdout: string): RawChange[] {
	const out: RawChange[] = [];
	for (const line of lines(stdout)) {
		if (line.length < 4) continue;
		const xy = line.slice(0, 2);
		const rest = line.slice(3);
		if (xy === "!!") continue;
		if (xy === "??") {
			out.push({ path: unquotePath(rest), status: "untracked" });
			continue;
		}
		const status = statusOf(xy[0] !== " " ? (xy[0] ?? "") : (xy[1] ?? ""));
		const rename = status === "renamed" || status === "copied" ? splitRename(rest) : null;
		out.push(
			rename ? { path: rename.to, status, from: rename.from } : { path: unquotePath(rest), status },
		);
	}
	return out;
}

function parseNameStatusLine(line: string): RawChange | null {
	const parts = line.split("\t");
	const status = statusOf((parts[0] ?? "").charAt(0));
	if (parts.length < 2) return null;
	if ((status === "renamed" || status === "copied") && parts.length >= 3) {
		return { path: unquotePath(parts[2] ?? ""), status, from: unquotePath(parts[1] ?? "") };
	}
	return { path: unquotePath(parts[1] ?? ""), status };
}

export function parseNameStatus(stdout: string): RawChange[] {
	return lines(stdout).flatMap((line) => parseNameStatusLine(line) ?? []);
}

export function parseLogNameStatus(stdout: string): SessionCommit[] {
	const commits: SessionCommit[] = [];
	let current: SessionCommit | undefined;
	for (const line of lines(stdout)) {
		if (line.startsWith(LOG_MARKER)) {
			const header = line.slice(LOG_MARKER.length);
			const space = header.indexOf(" ");
			current = {
				hash: space < 0 ? header : header.slice(0, space),
				subject: space < 0 ? "" : header.slice(space + 1),
				changes: [],
			};
			commits.push(current);
			continue;
		}
		const change = current ? parseNameStatusLine(line) : null;
		if (current && change) current.changes.push(change);
	}
	return commits;
}

// Strongest source wins per path: what is on disk now, then what this session
// committed, then the rest of the branch. Output order follows that strength.
export function mergeChanges(sources: {
	uncommitted: RawChange[];
	branch?: RawChange[];
	sessionCommits?: SessionCommit[];
}): FileChange[] {
	const tagged: [ChangeSource, RawChange[]][] = [
		["uncommitted", sources.uncommitted],
		["session-commits", (sources.sessionCommits ?? []).flatMap((commit) => commit.changes)],
		["branch", sources.branch ?? []],
	];
	const seen = new Set<string>();
	const out: FileChange[] = [];
	for (const [source, changes] of tagged) {
		for (const change of changes) {
			if (seen.has(change.path)) continue;
			seen.add(change.path);
			out.push({ ...change, source });
		}
	}
	return out;
}

// A failed `rev-parse origin/HEAD` still prints "origin/HEAD" on stdout (E3), so
// the exit code is checked before the output is trusted.
export function resolveBaseRef(originHead: GitRun | undefined): string {
	const ref = originHead?.exitCode === 0 ? originHead.stdout.trim() : "";
	return ref === "" ? "main" : ref;
}

const stdoutIfOk = (run: GitRun | undefined) => (run?.exitCode === 0 ? run.stdout.trim() : "");

/**
 * Picks the change source for the repo state. The caller may run the branch diff
 * and the session log together and let this decide which one counts; a missing
 * `sessionLog` means the session start time is unknown.
 */
export function gitSummary(input: {
	status: GitRun;
	branch: GitRun;
	shortHead?: GitRun;
	head?: GitRun;
	baseRef: string;
	mergeBase?: GitRun;
	branchDiff?: GitRun;
	sessionLog?: GitRun;
}): GitSummary {
	const base = input.baseRef;
	if (input.status.exitCode !== 0) {
		return {
			branch: "none",
			base,
			mode: "uncommitted-only",
			changes: [],
			truncated: 0,
			note: "not a git repository",
		};
	}
	const uncommitted = parsePorcelain(input.status.stdout);
	const cap = (all: FileChange[], extra: Partial<GitSummary>) =>
		({
			base,
			changes: all.slice(0, MAX_CHANGES),
			truncated: Math.max(0, all.length - MAX_CHANGES),
			...extra,
		}) as GitSummary;

	if (input.branch.exitCode !== 0) {
		return cap(mergeChanges({ uncommitted }), {
			branch: "uncommitted",
			mode: "uncommitted-only",
			note: "the repository has no commits yet",
		});
	}
	const name = input.branch.stdout.trim();
	const branch = name === "HEAD" ? `detached at ${stdoutIfOk(input.shortHead) || "HEAD"}` : name;

	const head = stdoutIfOk(input.head);
	const mergeBase = stdoutIfOk(input.mergeBase);
	if (mergeBase !== "" && head !== "" && mergeBase !== head) {
		const diff = input.branchDiff;
		return cap(
			mergeChanges({
				uncommitted,
				branch: diff?.exitCode === 0 ? parseNameStatus(diff.stdout) : [],
			}),
			{
				branch,
				mode: "branch-diff",
				note: diff?.exitCode === 0 ? undefined : "could not read the diff against the base",
			},
		);
	}

	const notes = mergeBase === "" ? [`no common ancestor with ${base}`] : [];
	if (input.sessionLog?.exitCode === 0) {
		return cap(
			mergeChanges({ uncommitted, sessionCommits: parseLogNameStatus(input.sessionLog.stdout) }),
			{ branch, mode: "session-commits", note: notes.join("; ") || undefined },
		);
	}
	notes.push("session start time unknown, uncommitted changes only");
	return cap(mergeChanges({ uncommitted }), {
		branch,
		mode: "uncommitted-only",
		note: notes.join("; "),
	});
}
