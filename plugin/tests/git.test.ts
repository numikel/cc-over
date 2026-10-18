import { expect, test } from "claude-code/testing";
import {
	GIT_BRANCH,
	GIT_HEAD,
	GIT_ORIGIN_HEAD,
	GIT_SHORT_HEAD,
	GIT_STATUS,
	gitBranchDiffArgv,
	gitMergeBaseArgv,
	gitSessionLogArgv,
	gitSummary,
	LOG_MARKER,
	MAX_CHANGES,
	mergeChanges,
	parseLogNameStatus,
	parseNameStatus,
	parsePorcelain,
	resolveBaseRef,
} from "../hooks/git.js";

const ok = (stdout: string) => ({ exitCode: 0, stdout });

test("argv builders produce read-only git invocations without a shell", () => {
	expect(GIT_STATUS).toEqual(["git", "status", "--porcelain=v1"]);
	expect(GIT_BRANCH).toEqual(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
	expect(GIT_HEAD).toEqual(["git", "rev-parse", "HEAD"]);
	expect(GIT_SHORT_HEAD).toEqual(["git", "rev-parse", "--short", "HEAD"]);
	expect(GIT_ORIGIN_HEAD).toEqual(["git", "rev-parse", "--abbrev-ref", "origin/HEAD"]);
	expect(gitMergeBaseArgv("origin/main")).toEqual([
		"git",
		"merge-base",
		"--",
		"HEAD",
		"origin/main",
	]);
	expect(gitBranchDiffArgv("origin/main")).toEqual([
		"git",
		"diff",
		"--name-status",
		"origin/main...HEAD",
	]);
	expect(gitSessionLogArgv(1792274895)).toEqual([
		"git",
		"log",
		"--since=@1792274895",
		"--name-status",
		`--format=${LOG_MARKER}%h %s`,
	]);
});

test("parsePorcelain reads the E3 sample: modified and untracked", () => {
	expect(parsePorcelain(" M a.txt\n?? b.txt\n")).toEqual([
		{ path: "a.txt", status: "modified" },
		{ path: "b.txt", status: "untracked" },
	]);
});

test("parsePorcelain handles renames, staged adds, deletes and quoted paths", () => {
	const out = [
		"R  old name.txt -> new name.txt",
		'R  "old \\"q\\".txt" -> "new\\tname.txt"',
		"A  added.ts",
		" D gone.ts",
		'?? "\\305\\202.txt"',
	].join("\n");
	expect(parsePorcelain(out)).toEqual([
		{ path: "new name.txt", status: "renamed", from: "old name.txt" },
		{ path: "new\tname.txt", status: "renamed", from: 'old "q".txt' },
		{ path: "added.ts", status: "added" },
		{ path: "gone.ts", status: "deleted" },
		{ path: "ł.txt", status: "untracked" },
	]);
});

test("parseNameStatus reads M/A/D, renames with scores and skips junk lines", () => {
	const out = ["M\tsrc/a.ts", "A\tb.ts", "D\tc.ts", "R100\told.ts\tnew.ts", "", "garbage"].join(
		"\n",
	);
	expect(parseNameStatus(out)).toEqual([
		{ path: "src/a.ts", status: "modified" },
		{ path: "b.ts", status: "added" },
		{ path: "c.ts", status: "deleted" },
		{ path: "new.ts", status: "renamed", from: "old.ts" },
	]);
});

test("parseLogNameStatus groups files under their commit and ignores text before the first one", () => {
	const out = [
		"stray line",
		`${LOG_MARKER}abc1234 Fix the thing`,
		"",
		"M\ta.ts",
		"A\tb.ts",
		`${LOG_MARKER}def5678 Merge branch`,
		"",
		`${LOG_MARKER}0123456 Remove c`,
		"",
		"D\tc.ts",
	].join("\n");
	expect(parseLogNameStatus(out)).toEqual([
		{
			hash: "abc1234",
			subject: "Fix the thing",
			changes: [
				{ path: "a.ts", status: "modified" },
				{ path: "b.ts", status: "added" },
			],
		},
		{ hash: "def5678", subject: "Merge branch", changes: [] },
		{ hash: "0123456", subject: "Remove c", changes: [{ path: "c.ts", status: "deleted" }] },
	]);
});

test("mergeChanges dedupes by path and keeps the strongest source", () => {
	const merged = mergeChanges({
		uncommitted: [
			{ path: "a.ts", status: "modified" },
			{ path: "new.ts", status: "untracked" },
		],
		branch: [
			{ path: "a.ts", status: "added" },
			{ path: "b.ts", status: "modified" },
		],
		sessionCommits: [
			{
				hash: "1111111",
				subject: "x",
				changes: [
					{ path: "b.ts", status: "deleted" },
					{ path: "c.ts", status: "added" },
				],
			},
		],
	});
	expect(merged).toEqual([
		{ path: "a.ts", status: "modified", source: "uncommitted" },
		{ path: "new.ts", status: "untracked", source: "uncommitted" },
		{ path: "b.ts", status: "deleted", source: "session-commits" },
		{ path: "c.ts", status: "added", source: "session-commits" },
	]);
});

test("resolveBaseRef ignores the stdout of a failed origin/HEAD lookup (E3)", () => {
	expect(resolveBaseRef({ exitCode: 128, stdout: "origin/HEAD\n" })).toBe("main");
	expect(resolveBaseRef(undefined)).toBe("main");
	expect(resolveBaseRef(ok("origin/develop\n"))).toBe("origin/develop");
});

const onBranch = {
	status: ok(" M a.ts\n"),
	branch: ok("feat/x\n"),
	head: ok("bbbbbbb\n"),
	baseRef: "origin/main",
};

test("gitSummary uses the branch diff when the branch left its base", () => {
	const s = gitSummary({
		...onBranch,
		mergeBase: ok("aaaaaaa\n"),
		branchDiff: ok("M\tb.ts\nA\tc.ts\n"),
	});
	expect(s).toMatchObject({
		branch: "feat/x",
		base: "origin/main",
		mode: "branch-diff",
		truncated: 0,
	});
	expect(s.changes).toEqual([
		{ path: "a.ts", status: "modified", source: "uncommitted" },
		{ path: "b.ts", status: "modified", source: "branch" },
		{ path: "c.ts", status: "added", source: "branch" },
	]);
});

test("gitSummary switches to session commits when merge-base equals HEAD", () => {
	const s = gitSummary({
		...onBranch,
		mergeBase: ok("bbbbbbb\n"),
		branchDiff: ok(""),
		sessionLog: ok(`${LOG_MARKER}bbbbbbb Fix\n\nM\td.ts\n`),
	});
	expect(s.mode).toBe("session-commits");
	expect(s.changes).toEqual([
		{ path: "a.ts", status: "modified", source: "uncommitted" },
		{ path: "d.ts", status: "modified", source: "session-commits" },
	]);
});

test("gitSummary falls back to uncommitted-only with a note when the session start is unknown", () => {
	const s = gitSummary({ ...onBranch, mergeBase: ok("bbbbbbb\n") });
	expect(s.mode).toBe("uncommitted-only");
	expect(s.note).toBeTruthy();
	expect(s.changes).toEqual([{ path: "a.ts", status: "modified", source: "uncommitted" }]);
});

test("gitSummary treats a failed merge-base like being on the base", () => {
	const s = gitSummary({
		...onBranch,
		mergeBase: { exitCode: 1, stdout: "" },
		sessionLog: ok(`${LOG_MARKER}bbbbbbb Fix\n\nA\te.ts\n`),
	});
	expect(s.mode).toBe("session-commits");
	expect(s.note).toBeTruthy();
});

test("gitSummary names a detached HEAD by its short hash", () => {
	const s = gitSummary({
		...onBranch,
		branch: ok("HEAD\n"),
		shortHead: ok("abc1234\n"),
		mergeBase: ok("aaaaaaa\n"),
		branchDiff: ok(""),
	});
	expect(s.branch).toBe("detached at abc1234");
});

test("gitSummary reports a repo without commits as uncommitted", () => {
	const s = gitSummary({
		status: ok("?? a.ts\n"),
		branch: { exitCode: 128, stdout: "HEAD\n" },
		baseRef: "main",
	});
	expect(s).toMatchObject({ branch: "uncommitted", mode: "uncommitted-only" });
	expect(s.changes).toEqual([{ path: "a.ts", status: "untracked", source: "uncommitted" }]);
});

test("gitSummary survives a directory outside any repository", () => {
	const s = gitSummary({
		status: { exitCode: 128, stdout: "" },
		branch: { exitCode: 128, stdout: "" },
		baseRef: "main",
	});
	expect(s).toMatchObject({ branch: "none", mode: "uncommitted-only", changes: [], truncated: 0 });
	expect(s.note).toBeTruthy();
});

test("gitSummary caps the list at MAX_CHANGES and counts the rest", () => {
	const lines = Array.from({ length: MAX_CHANGES + 5 }, (_, i) => `A\tf${i}.ts`).join("\n");
	const s = gitSummary({
		...onBranch,
		status: ok(""),
		mergeBase: ok("aaaaaaa\n"),
		branchDiff: ok(lines),
	});
	expect(s.changes.length).toBe(MAX_CHANGES);
	expect(s.truncated).toBe(5);
});
