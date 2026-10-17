#!/usr/bin/env node
// Drift check for the committed mod types (F-01 pin, F-02 manifest). Run from the repo root:
//   node scripts/check-types-drift.mjs [--types <dir>] [--pin <file>] [--hashes <file>]
//   node scripts/check-types-drift.mjs --write-hashes
// Prints one `<LEVEL> <id> <message>` line per check. Exit 0 when nothing FAILed, 1 otherwise.
//   1 pin is X.Y.Z                      5 installed `claude --version` (see below)
//   2 types header on line 1            6 pin vs the expected version (CI only)
//   3 header equals the pin             7 file set under the types dir equals the manifest
//   4 no MCP tool names in the types    8 sha256 of every file equals the manifest
// Check 5 is advisory locally (WARN). With CI=true (or 1) it is a gate: the installed version must
// equal CLAUDE_CODE_EXPECTED_VERSION, or the pin when that is unset. Check 6 then WARNs when the
// pin differs from the expected version. With GITHUB_ACTIONS=true every FAIL/WARN is also printed
// as an ::error/::warning annotation.
// --write-hashes refreshes the manifest, but only from a state that passes checks 1-4 and has all
// four required files. It does not run `claude --version`.
import { execFileSync } from "node:child_process";
import { annotation, checkTypesDrift, writeHashes } from "./types-drift.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(name);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const paths = {
	typesDir: option("--types", "plugin/.claude-plugin/types"),
	pinFile: option("--pin", "plugin/.claude-code-version"),
	hashFile: option("--hashes", "plugin/.claude-code-types.sha256"),
};

function print(results) {
	for (const result of results) {
		console.log(`${result.level} ${result.id} ${result.message}`);
		if (process.env.GITHUB_ACTIONS === "true") {
			const line = annotation(result);
			if (line) console.log(line);
		}
	}
}

function installedVersion() {
	try {
		const spawnOptions = {
			encoding: "utf8",
			timeout: 15000,
			stdio: ["ignore", "pipe", "ignore"],
		};
		let output;
		try {
			output = execFileSync("claude", ["--version"], spawnOptions);
		} catch (err) {
			// npm i -g leaves only claude.cmd on Windows: execFile does not resolve it (ENOENT) or
			// refuses it without a shell (EINVAL), so retry through the shell.
			if (process.platform === "win32" && (err.code === "ENOENT" || err.code === "EINVAL")) {
				output = execFileSync("claude", ["--version"], { ...spawnOptions, shell: true });
			} else {
				throw err;
			}
		}
		return output.match(/^(\d+\.\d+\.\d+)/)?.[1] ?? null;
	} catch {
		// Not on PATH, non-zero exit or timeout: check 5 decides what that means.
		return null;
	}
}

if (args.includes("--write-hashes")) {
	const { written, results, entries } = writeHashes(paths);
	print(results);
	if (written) {
		for (const entry of entries) console.log(`WROTE ${entry}`);
		console.log(`WROTE ${paths.hashFile} (${entries.length} entries)`);
	} else {
		console.log(`REFUSED to write ${paths.hashFile}: fix the FAIL lines above first`);
	}
	process.exitCode = written ? 0 : 1;
} else {
	const { results, failed } = checkTypesDrift({
		...paths,
		env: process.env,
		installed: installedVersion(),
	});
	print(results);
	process.exitCode = failed ? 1 : 0;
}
