// Tests for the types drift check (scripts/types-drift.mjs). Each case copies the committed
// types and pin into a fresh temp directory, builds a manifest with writeHashes, mutates one
// element and checks the verdict. Run: npm run test:scripts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { annotation, checkTypesDrift, writeHashes } from "./types-drift.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = [];

after(() => {
	for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

// A copy of the committed types and pin in a temp dir, laid out like plugin/.
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "types-drift-"));
	fixtures.push(root);
	const plugin = join(root, "plugin");
	cpSync(join(repoRoot, "plugin/.claude-plugin/types"), join(plugin, ".claude-plugin/types"), {
		recursive: true,
	});
	cpSync(join(repoRoot, "plugin/.claude-code-version"), join(plugin, ".claude-code-version"));
	const paths = {
		typesDir: join(plugin, ".claude-plugin/types"),
		pinFile: join(plugin, ".claude-code-version"),
		hashFile: join(plugin, ".claude-code-types.sha256"),
	};
	return { ...paths, file: (name) => join(paths.typesDir, name) };
}

// A fixture with a manifest generated from the unmodified types.
function baseline() {
	const paths = fixture();
	const written = writeHashes(paths);
	assert.equal(written.written, true, JSON.stringify(written.results));
	return paths;
}

const edit = (path, change) => writeFileSync(path, change(readFileSync(path, "utf8")));
const pinOf = (paths) => readFileSync(paths.pinFile, "utf8").trim();

function run(paths, options = {}) {
	return checkTypesDrift({
		typesDir: paths.typesDir,
		pinFile: paths.pinFile,
		hashFile: paths.hashFile,
		env: options.env ?? {},
		installed: options.installed === undefined ? pinOf(paths) : options.installed,
	});
}

const find = (outcome, level, id) =>
	outcome.results.find((entry) => entry.level === level && entry.id === id);
const describeResults = (outcome) =>
	outcome.results.map((entry) => `${entry.level} ${entry.id} ${entry.message}`).join("\n");

function assertHas(outcome, level, id) {
	assert.ok(find(outcome, level, id), `expected ${level} ${id} in:\n${describeResults(outcome)}`);
}

describe("baseline", () => {
	it("passes every check on the committed types", () => {
		const outcome = run(baseline());
		assert.equal(outcome.failed, false, describeResults(outcome));
		for (const id of ["1", "2", "3", "4", "7", "8"]) assertHas(outcome, "PASS", id);
	});

	it("writes a sorted sha256sum manifest and rewrites it byte for byte", () => {
		const paths = baseline();
		const first = readFileSync(paths.hashFile, "utf8");
		const rows = first.trimEnd().split("\n");
		assert.equal(rows.length, 4);
		assert.ok(first.endsWith("\n"));
		for (const row of rows) assert.match(row, /^[0-9a-f]{64} {2}\.claude-plugin\/types\/\S+$/);
		const names = rows.map((row) => row.slice(66));
		assert.deepEqual(names, [...names].sort());

		assert.equal(writeHashes(paths).written, true);
		assert.equal(readFileSync(paths.hashFile, "utf8"), first);
	});
});

describe("check 3: pin and header", () => {
	it("names the way out and nothing outside the exported files", () => {
		const paths = baseline();
		writeFileSync(paths.pinFile, "2.1.999\n");
		const message = find(run(paths), "FAIL", "3")?.message ?? "";
		assert.match(message, /--strict-mcp-config/);
		assert.doesNotMatch(message, /CLAUDE\.md/);
	});
});

describe("check 8: content hashes", () => {
	const typesFile = "claude-code/index.d.ts";
	const cases = [
		["B: text appended to the types", (p) => edit(p.file(typesFile), (t) => `${t}\n// edited\n`)],
		[
			"E: tools file emptied to export {}",
			(p) => writeFileSync(p.file("claude-code-tools/index.d.ts"), "export {}\n"),
		],
		[
			"G: strict switched off in tsconfig.json",
			(p) => edit(p.file("tsconfig.json"), (t) => t.replace('"strict": true', '"strict": false')),
		],
		[
			"I: Register widened to any",
			(p) => edit(p.file(typesFile), (t) => `${t}\nexport type Register = any;\n`),
		],
		[
			"L: private name in the MCP file without the mcp__ prefix",
			(p) => edit(p.file("claude-code-mcp/index.d.ts"), (t) => `${t}// private-server\n`),
		],
		[
			"CRLF line endings in the types",
			(p) => edit(p.file(typesFile), (t) => t.replaceAll("\n", "\r\n")),
		],
	];
	for (const [name, mutate] of cases) {
		it(`fails on ${name}`, () => {
			const paths = baseline();
			mutate(paths);
			assertHas(run(paths), "FAIL", "8");
		});
	}

	it("J: header and pin bumped together still fail on the hash", () => {
		const paths = baseline();
		edit(paths.file("claude-code/index.d.ts"), (t) =>
			t.replace("Claude Code 2.1.302.", "Claude Code 2.1.303."),
		);
		writeFileSync(paths.pinFile, "2.1.303\n");
		const outcome = run(paths, { installed: "2.1.303" });
		assertHas(outcome, "PASS", "3");
		assertHas(outcome, "FAIL", "8");
	});

	it("names the file and the way out", () => {
		const paths = baseline();
		edit(paths.file("claude-code/index.d.ts"), (t) => `${t}\n// edited\n`);
		const message = find(run(paths), "FAIL", "8").message;
		assert.match(message, /claude-code\/index\.d\.ts/);
		assert.match(message, /--write-hashes/);
	});
});

describe("check 7: the file set", () => {
	it("fails on a package the manifest does not know", () => {
		const paths = baseline();
		mkdirSync(paths.file("claude-code-foo"));
		writeFileSync(paths.file("claude-code-foo/index.d.ts"), "export {}\n");
		const outcome = run(paths);
		assertHas(outcome, "FAIL", "7");
		assert.match(find(outcome, "FAIL", "7").message, /claude-code-foo\/index\.d\.ts/);
	});

	it("fails when the manifest is missing", () => {
		const paths = baseline();
		unlinkSync(paths.hashFile);
		const outcome = run(paths);
		assertHas(outcome, "FAIL", "7");
		assert.match(find(outcome, "FAIL", "7").message, /--write-hashes/);
	});

	it("N: a removed MCP file fails checks 4 and 7", () => {
		const paths = baseline();
		unlinkSync(paths.file("claude-code-mcp/index.d.ts"));
		const outcome = run(paths);
		assertHas(outcome, "FAIL", "4");
		assertHas(outcome, "FAIL", "7");
	});

	it("K: a BOM before the header fails check 2", () => {
		const paths = baseline();
		edit(paths.file("claude-code/index.d.ts"), (t) => `﻿${t}`);
		assertHas(run(paths), "FAIL", "2");
	});

	it("fails on a manifest row outside the types directory", () => {
		const paths = baseline();
		writeFileSync(paths.hashFile, `${"0".repeat(64)}  ../elsewhere.d.ts\n`, { flag: "a" });
		assertHas(run(paths), "FAIL", "7");
	});

	it("accepts a manifest saved with CRLF line endings", () => {
		const paths = baseline();
		edit(paths.hashFile, (t) => t.replaceAll("\n", "\r\n"));
		const outcome = run(paths);
		assert.equal(outcome.failed, false, describeResults(outcome));
		assertHas(outcome, "PASS", "7");
		assertHas(outcome, "PASS", "8");
	});
});

describe("checks 5 and 6: installed CLI", () => {
	const ci = { CI: "true" };

	it("outside CI a differing or unknown version only warns, and check 6 is absent", () => {
		const paths = baseline();
		for (const installed of ["2.1.999", null]) {
			const outcome = run(paths, { installed });
			assertHas(outcome, "WARN", "5");
			assert.equal(outcome.failed, false, describeResults(outcome));
			assert.equal(find(outcome, "PASS", "6") ?? find(outcome, "WARN", "6"), undefined);
		}
		assertHas(run(paths), "PASS", "5");
	});

	it("in CI an unknown installed version fails", () => {
		assertHas(run(baseline(), { env: ci, installed: null }), "FAIL", "5");
	});

	it("in CI an installed version other than the pin fails when nothing else is expected", () => {
		assertHas(run(baseline(), { env: ci, installed: "2.1.999" }), "FAIL", "5");
	});

	it("in CI a malformed expected version fails", () => {
		const env = { ...ci, CLAUDE_CODE_EXPECTED_VERSION: "latest" };
		assertHas(run(baseline(), { env, installed: "2.1.302" }), "FAIL", "5");
	});

	it("treats CI=1 and CI=TRUE as CI", () => {
		const paths = baseline();
		for (const value of ["1", "TRUE"]) {
			assertHas(run(paths, { env: { CI: value }, installed: null }), "FAIL", "5");
		}
	});

	it("in CI without an expected version, the pin is expected and check 6 passes", () => {
		const outcome = run(baseline(), { env: ci, installed: "2.1.302" });
		assertHas(outcome, "PASS", "5");
		assertHas(outcome, "PASS", "6");
	});

	it("in CI an expected version ahead of the pin passes 5 and warns on 6", () => {
		const env = { ...ci, CLAUDE_CODE_EXPECTED_VERSION: "2.1.400" };
		const outcome = run(baseline(), { env, installed: "2.1.400" });
		assertHas(outcome, "PASS", "5");
		assertHas(outcome, "WARN", "6");
		assert.equal(outcome.failed, false, describeResults(outcome));
	});
});

describe("annotation", () => {
	it("maps FAIL and WARN to GitHub commands and leaves PASS alone", () => {
		assert.equal(
			annotation({ level: "FAIL", id: "8", message: "bad" }),
			"::error title=Types drift 8::bad",
		);
		assert.equal(
			annotation({ level: "WARN", id: "6", message: "behind" }),
			"::warning title=Types drift 6::behind",
		);
		assert.equal(annotation({ level: "PASS", id: "1", message: "ok" }), null);
	});

	it("encodes %, CR and LF so the message is not cut short", () => {
		assert.equal(
			annotation({ level: "FAIL", id: "8", message: "100%\r\nnext" }),
			"::error title=Types drift 8::100%25%0D%0Anext",
		);
	});
});

describe("CLI", () => {
	const script = join(repoRoot, "scripts/check-types-drift.mjs");
	// Without CI, GITHUB_ACTIONS and the expected version, so check 5 does not depend on where the
	// suite runs (the CI job exports all three).
	const cleanEnv = (extra = {}) => ({
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !["CI", "GITHUB_ACTIONS", "CLAUDE_CODE_EXPECTED_VERSION"].includes(key),
			),
		),
		...extra,
	});
	const cli = (paths, flags = [], env = cleanEnv()) =>
		spawnSync(
			process.execPath,
			[
				script,
				"--types",
				paths.typesDir,
				"--pin",
				paths.pinFile,
				"--hashes",
				paths.hashFile,
				...flags,
			],
			{ cwd: repoRoot, env, encoding: "utf8", timeout: 60000 },
		);

	it("exits 0 on the baseline and prints one line per check", () => {
		const result = cli(baseline());
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /^PASS 7 /m);
		assert.match(result.stdout, /^PASS 8 /m);
	});

	it("exits 1 on a mutated type file and annotates only under GITHUB_ACTIONS", () => {
		const paths = baseline();
		edit(paths.file("claude-code/index.d.ts"), (t) => `${t}\n// edited\n`);

		const plain = cli(paths);
		assert.equal(plain.status, 1);
		assert.match(plain.stdout, /^FAIL 8 /m);
		assert.doesNotMatch(plain.stdout, /::error/);

		const actions = cli(paths, [], cleanEnv({ GITHUB_ACTIONS: "true" }));
		assert.equal(actions.status, 1);
		assert.match(actions.stdout, /^::error title=Types drift 8::/m);
	});

	// `npm i -g` leaves only claude.cmd on Windows. execFile finds no claude.exe there (ENOENT, not
	// EINVAL), so check 5 failed on the windows-latest runner while a native claude.exe passed.
	it("reads the version from a claude.cmd shim on PATH", {
		skip: process.platform !== "win32",
	}, () => {
		const paths = baseline();
		const shimDir = mkdtempSync(join(tmpdir(), "claude-shim-"));
		fixtures.push(shimDir);
		writeFileSync(
			join(shimDir, "claude.cmd"),
			`@echo off\r\necho ${pinOf(paths)} (Claude Code)\r\n`,
		);
		const env = Object.fromEntries(
			Object.entries(cleanEnv({ CI: "true", CLAUDE_CODE_EXPECTED_VERSION: pinOf(paths) })).filter(
				([key]) => key.toLowerCase() !== "path",
			),
		);
		env.PATH = `${shimDir};${process.env.SystemRoot}\\System32`;
		const result = cli(paths, [], env);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /^PASS 5 /m);
	});

	it("--write-hashes rewrites a consistent manifest and refuses an inconsistent state", () => {
		const paths = baseline();
		const before = readFileSync(paths.hashFile, "utf8");
		assert.equal(cli(paths, ["--write-hashes"]).status, 0);
		assert.equal(readFileSync(paths.hashFile, "utf8"), before);

		writeFileSync(paths.pinFile, "2.1.999\n");
		const refused = cli(paths, ["--write-hashes"]);
		assert.equal(refused.status, 1);
		assert.equal(readFileSync(paths.hashFile, "utf8"), before);
	});
});

describe("writeHashes", () => {
	const refuses = (name, mutate) =>
		it(`refuses to write when ${name}`, () => {
			const paths = baseline();
			const before = readFileSync(paths.hashFile, "utf8");
			mutate(paths);
			const outcome = writeHashes(paths);
			assert.equal(outcome.written, false);
			assert.equal(readFileSync(paths.hashFile, "utf8"), before);
		});

	refuses("the header does not match the pin", (p) => writeFileSync(p.pinFile, "2.1.999\n"));
	refuses("the MCP file lists a server tool", (p) =>
		edit(p.file("claude-code-mcp/index.d.ts"), (t) => `${t}// mcp__private__tool\n`),
	);
	refuses("a required types file is missing", (p) =>
		unlinkSync(p.file("claude-code-tools/index.d.ts")),
	);
});
