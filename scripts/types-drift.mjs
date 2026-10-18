// Types drift checks for the committed mod types (F-01 pin, F-02 manifest). Pure functions: they
// read files under the given paths and nothing else, so tests can inject every input.
// The CLI wrapper is scripts/check-types-drift.mjs.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const REGENERATE =
	"Regenerate from the repo root: `claude --plugin-dir plugin --strict-mcp-config`, then /exit.";
const REFRESH_HASHES = "`npm run drift -- --write-hashes`";
// Files the manifest must cover. The sha256 manifest is the only guard on their content.
const REQUIRED_FILES = [
	"claude-code/index.d.ts",
	"claude-code-tools/index.d.ts",
	"claude-code-mcp/index.d.ts",
	"tsconfig.json",
];

const readText = (path) => {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
};
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const toPosix = (path) => path.split(sep).join("/");
// A GitHub Actions workflow command for a FAIL/WARN result, or null for PASS. The message must
// encode %, CR and LF or the annotation is cut short in the run summary.
export function annotation({ level, id, message }) {
	const command = level === "FAIL" ? "error" : level === "WARN" ? "warning" : null;
	if (!command) return null;
	const data = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
	return `::${command} title=Types drift ${id}::${data}`;
}

const outcome = (results) => ({ results, failed: results.some((r) => r.level === "FAIL") });

function listFiles(dir) {
	if (!existsSync(dir)) return [];
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...listFiles(full));
		else if (entry.isFile()) found.push(full);
	}
	return found;
}

// Checks 1-4: pin format, "Written by" header on line 1, header = pin, no MCP tool names.
function checkPinAndHeader({ typesDir, pinFile }) {
	const results = [];
	const add = (level, id, message) => results.push({ level, id, message });

	const pinText = readText(pinFile)?.trim();
	const pin = pinText && /^\d+\.\d+\.\d+$/.test(pinText) ? pinText : null;
	if (pin) add("PASS", "1", `pin is ${pin} (${pinFile})`);
	else add("FAIL", "1", `${pinFile} is missing or does not match X.Y.Z`);

	const typesFile = join(typesDir, "claude-code", "index.d.ts");
	const types = readText(typesFile);
	const header = types?.split("\n", 1)[0].replace(/\r$/, "");
	const written = header?.match(/^\/\/ Written by Claude Code (\d+\.\d+\.\d+)\.$/)?.[1];
	if (written) add("PASS", "2", `types header says Claude Code ${written}`);
	else if (types === null) add("FAIL", "2", `${typesFile} is missing. ${REGENERATE}`);
	else add("FAIL", "2", `line 1 of ${typesFile} is not the "Written by" header. ${REGENERATE}`);

	if (!pin || !written) {
		add("FAIL", "3", `cannot compare, ${pin ? "types header unreadable" : "pin invalid"}`);
	} else if (pin === written) {
		add("PASS", "3", "types header matches the pin");
	} else {
		add(
			"FAIL",
			"3",
			`types are for ${written} but the pin is ${pin}. Bump the pin only after refreshing the types with an interactive \`claude --plugin-dir plugin --strict-mcp-config\` start and re-reading index.d.ts.`,
		);
	}

	// The header comment "mcp__<server>__<tool>" does not match: "<" is outside the class.
	const mcpFile = join(typesDir, "claude-code-mcp", "index.d.ts");
	const mcp = readText(mcpFile);
	const tools = [...new Set(mcp?.match(/mcp__[A-Za-z0-9][\w-]*/g) ?? [])];
	if (mcp === null) add("FAIL", "4", `${mcpFile} is missing. ${REGENERATE}`);
	else if (tools.length) {
		add("FAIL", "4", `${mcpFile} lists MCP tools (${tools.slice(0, 3).join(", ")}). ${REGENERATE}`);
	} else add("PASS", "4", "claude-code-mcp has no MCP tool names");

	return results;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const isCi = (env) => /^(true|1)$/i.test(env.CI ?? "");

// Check 5: the installed CLI. Advisory locally, a hard gate in CI where the expected version is
// CLAUDE_CODE_EXPECTED_VERSION (the channel the job installed) or else the pin.
// Check 6 (CI only): the pin lags the expected version, the signal the "latest" leg exists for.
function checkInstalled({ pinFile, env, installed }) {
	const results = [];
	const add = (level, id, message) => results.push({ level, id, message });
	const pinText = readText(pinFile)?.trim();
	const pin = pinText && VERSION.test(pinText) ? pinText : null;

	if (!isCi(env)) {
		if (!installed || !pin) add("WARN", "5", "installed-version check skipped");
		else if (installed === pin) add("PASS", "5", `installed claude ${installed} matches the pin`);
		else add("WARN", "5", `installed claude is ${installed} but the pin is ${pin}`);
		return results;
	}

	const expected = env.CLAUDE_CODE_EXPECTED_VERSION || pin;
	if (!expected || !VERSION.test(expected)) {
		add("FAIL", "5", `expected claude version "${expected}" is not X.Y.Z`);
	} else if (!installed) {
		add("FAIL", "5", `cannot read the installed claude version, expected ${expected}`);
	} else if (installed !== expected) {
		add("FAIL", "5", `installed claude is ${installed} but ${expected} is expected`);
	} else add("PASS", "5", `installed claude ${installed} is the expected version`);

	if (pin && expected && VERSION.test(expected)) {
		if (pin === expected) add("PASS", "6", `pin ${pin} is the expected version`);
		else add("WARN", "6", `pin ${pin} is behind the expected ${expected}`);
	}
	return results;
}

// Manifest rows are `<64 hex>  <path>` (sha256sum format), paths relative to the manifest.
function readManifest(hashFile) {
	const text = readText(hashFile);
	if (text === null) return null;
	const baseDir = dirname(hashFile);
	const rows = [];
	const malformed = [];
	for (const [index, rawLine] of text.split("\n").entries()) {
		const line = rawLine.replace(/\r$/, "");
		if (line === "" && index === text.split("\n").length - 1) continue;
		const match = line.match(/^([0-9a-f]{64}) {2}(\S.*)$/);
		if (match) rows.push({ hash: match[1], name: match[2], path: resolve(baseDir, match[2]) });
		else malformed.push(index + 1);
	}
	return { rows, malformed };
}

// Check 7: the files under typesDir are exactly the manifest entries plus .gitignore.
// Check 8: every entry's sha256 equals the manifest.
function checkManifest({ typesDir, hashFile }) {
	const results = [];
	const add = (level, id, message) => results.push({ level, id, message });
	const manifest = readManifest(hashFile);

	if (!manifest) {
		add("FAIL", "7", `${hashFile} is missing. Create it with ${REFRESH_HASHES}.`);
		add("FAIL", "8", "cannot compare, manifest missing");
		return results;
	}

	let consistent = true;
	const known = new Set([resolve(typesDir, ".gitignore")]);
	const rows = [];
	for (const line of manifest.malformed) {
		add("FAIL", "7", `${hashFile} line ${line} is not "<sha256>  <path>"`);
		consistent = false;
	}
	for (const row of manifest.rows) {
		const inside = relative(resolve(typesDir), row.path);
		if (inside.startsWith("..") || isAbsolute(inside)) {
			add("FAIL", "7", `manifest entry ${row.name} points outside ${typesDir}`);
			consistent = false;
			continue;
		}
		known.add(row.path);
		rows.push(row);
	}
	const present = new Set(listFiles(typesDir).map((file) => resolve(file)));
	for (const file of [...present].sort()) {
		if (known.has(file)) continue;
		const shown = toPosix(relative(resolve(typesDir), file));
		add(
			"FAIL",
			"7",
			`unexpected file ${shown} under ${typesDir}. New platform package? Review it, \`git add -f\` it, then run ${REFRESH_HASHES}.`,
		);
		consistent = false;
	}
	for (const row of rows) {
		if (present.has(row.path)) continue;
		add("FAIL", "7", `${row.name} is in the manifest but missing on disk. ${REGENERATE}`);
		consistent = false;
	}
	if (consistent) add("PASS", "7", `types directory matches the manifest (${rows.length} files)`);

	const changed = rows.filter((row) => present.has(row.path) && sha256(row.path) !== row.hash);
	for (const row of changed) {
		add(
			"FAIL",
			"8",
			`${row.name} differs from the manifest sha256. If the types were regenerated on purpose, re-read index.d.ts and run ${REFRESH_HASHES}; for CRLF line endings run \`git checkout -- ${row.name}\`. Otherwise ${REGENERATE}`,
		);
	}
	if (!changed.length) add("PASS", "8", `${rows.length} files match the manifest sha256`);
	return results;
}

export function checkTypesDrift({ typesDir, pinFile, hashFile, env, installed }) {
	return outcome([
		...checkPinAndHeader({ typesDir, pinFile }),
		...checkInstalled({ pinFile, env, installed }),
		...checkManifest({ typesDir, hashFile }),
	]);
}

// Writes the manifest, but only from a state that passes checks 1-4 and has the required files.
export function writeHashes({ typesDir, pinFile, hashFile }) {
	const results = checkPinAndHeader({ typesDir, pinFile });
	for (const name of REQUIRED_FILES) {
		if (!existsSync(join(typesDir, name))) {
			results.push({
				level: "FAIL",
				id: "7",
				message: `${join(typesDir, name)} is missing. ${REGENERATE}`,
			});
		}
	}
	if (outcome(results).failed) return { written: false, results, entries: [] };

	const baseDir = dirname(resolve(hashFile));
	const ignore = resolve(typesDir, ".gitignore");
	const entries = listFiles(typesDir)
		.map((file) => resolve(file))
		.filter((file) => file !== ignore)
		.map((file) => ({ name: toPosix(relative(baseDir, file)), hash: sha256(file) }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map((entry) => `${entry.hash}  ${entry.name}`);
	writeFileSync(hashFile, `${entries.join("\n")}\n`);
	return { written: true, results, entries };
}
