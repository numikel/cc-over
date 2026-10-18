// Shared units of the live acceptance run (handoff.mjs): stream-json line reduction, cost caps,
// command line, process arguments and `Session`, one claude process. No side effects on import;
// plain Node ESM, no dependencies. The pure parts are covered by `--selftest`.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { allStrings, isProbeTarget, TARGET_PREFIX } from "./checks.mjs";

export class UsageError extends Error {}

// ---------------------------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------------------------

export const money = (value) => `$${value.toFixed(4)}`;

// total_cost_usd of a process is cumulative: the run's cost is the largest figure its results
// reported, never their sum.
export const runCostOf = (costs) => costs.reduce((max, cost) => (cost > max ? cost : max), 0);

// `spent` is what is already committed (the finished processes plus the budgets reserved for the
// running ones), `runCost` the cumulative figure of the sender. Exceeding means strictly greater.
export function capReason({ spent, runCost, cap }) {
	if (spent + runCost <= cap) return null;
	return {
		kind: "cap",
		text: `cumulative cost ${money(spent + runCost)} exceeds the cap ${money(cap)}`,
	};
}

export const shouldStartRun = (spent, cap) => !(spent > cap);

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

function parseNumber(name, raw, min) {
	const value = Number(raw);
	if (raw === "" || !Number.isFinite(value) || value < min) {
		throw new UsageError(`--${name} must be a number >= ${min}`);
	}
	return value;
}

export function parseCli(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			strict: true,
			allowPositionals: false,
			options: {
				model: { type: "string", default: "haiku" },
				"max-cost": { type: "string", default: "2" },
				"step-timeout": { type: "string", default: "180" },
				"hold-wait": { type: "string", default: "120" },
				claude: { type: "string" },
				"dry-run": { type: "boolean", default: false },
				selftest: { type: "boolean", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	const v = parsed.values;
	if (v.model.trim() === "") throw new UsageError("--model is empty");
	return {
		model: v.model,
		maxCost: parseNumber("max-cost", v["max-cost"], 0.01),
		stepTimeoutMs: parseNumber("step-timeout", v["step-timeout"], 5) * 1000,
		holdWaitMs: parseNumber("hold-wait", v["hold-wait"], 5) * 1000,
		claude: v.claude,
		dryRun: v["dry-run"],
		selftest: v.selftest,
		help: v.help,
	};
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

// The sender keeps its default tools: `$.session.send` is refused when the session has no
// SendMessage tool (evidence E2), so it must not be disallowed. Nothing allows the model to call
// it either, which in `-p` means its own attempts to send are denied.
export function senderArgs({ pluginDir, model, debugFile, budget }) {
	return [
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--strict-mcp-config",
		"--plugin-dir",
		pluginDir,
		"--model",
		model,
		"--debug-file",
		debugFile,
		"--max-budget-usd",
		String(budget),
	];
}

// A receiver is a throwaway `-p` session named probe-handoff-*, limited to `sleep`, that keeps
// itself alive in a loop so the sender has somebody to talk to. The prompt goes right after `-p`:
// `--allowedTools` is variadic and would swallow a positional argument after it.
export function receiverArgs({ name, mode, model, budget, prompt }) {
	if (!isProbeTarget(name))
		throw new Error(`a receiver must be named ${TARGET_PREFIX}*, got "${name}"`);
	if (mode !== "accept" && mode !== "hold") throw new Error(`unknown receiver mode "${mode}"`);
	return [
		"-p",
		prompt,
		"--name",
		name,
		"--settings",
		JSON.stringify({ crossSessionInbound: mode }),
		"--allowedTools",
		"Bash(sleep:*)",
		"--model",
		model,
		"--max-budget-usd",
		String(budget),
		"--output-format",
		"stream-json",
		"--verbose",
		"--strict-mcp-config",
	];
}

// Parses one stdout line of `--output-format stream-json`; anything else is null.
export function parseStreamLine(line) {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	try {
		const value = JSON.parse(trimmed);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

// Reduces a stream object to what the harness reads (or null for everything else):
//   result            { numTurns, cost, text, isError }
//   system/ui_log     { text, plugin }
//   other system      { subtype, text }  (text = every string field, joined by newlines)
export function toEvent(obj) {
	if (obj === null) return null;
	if (obj.type === "result") {
		return {
			kind: "result",
			numTurns: typeof obj.num_turns === "number" ? obj.num_turns : undefined,
			cost: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
			text: typeof obj.result === "string" ? obj.result : "",
			isError: obj.is_error === true,
		};
	}
	if (obj.type === "system" && obj.subtype === "ui_log" && typeof obj.text === "string") {
		return { kind: "ui_log", text: obj.text, plugin: obj.plugin };
	}
	if (obj.type === "system") {
		const { type: _type, subtype, ...rest } = obj;
		return { kind: "system", subtype, text: allStrings(rest).join("\n") };
	}
	return null;
}

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

export const say = (tag, message) => console.log(`${tag} ${message}`);

export function tempBase() {
	const fromEnv = process.env.TMPDIR;
	if (
		fromEnv !== undefined &&
		fromEnv !== "" &&
		path.isAbsolute(fromEnv) &&
		fs.existsSync(fromEnv)
	) {
		return fromEnv;
	}
	return os.tmpdir();
}

// The mod under test: <repo>/plugin, resolved from this file so the run works from any cwd.
export function pluginDirOf() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "..", "..", "plugin");
}

// `claude` is an .exe on Windows (spawn finds it with shell: false); a .cmd/.bat shim would need
// a shell, so it is refused with a pointer to --claude instead of being guessed at.
export function resolveClaude(override) {
	if (override !== undefined) return override;
	if (process.platform !== "win32") return "claude";
	const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
	for (const ext of [".exe", ".cmd", ".bat"]) {
		for (const dir of dirs) {
			const candidate = path.join(dir, `claude${ext}`);
			if (!fs.existsSync(candidate)) continue;
			if (ext === ".exe") return candidate;
			throw new UsageError(`claude resolves to ${candidate}: pass --claude <path to claude.exe>`);
		}
	}
	return "claude";
}

export function killTree(proc) {
	if (proc.pid === undefined || proc.exitCode !== null) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
	} else {
		proc.kill("SIGKILL");
	}
}

const liveSessions = new Set();

export function killAll() {
	for (const session of liveSessions) session.kill();
}

// kind: "timeout" | "exited" | "cap" | "spawn"
export class RunError extends Error {
	constructor(kind, message) {
		super(message);
		this.kind = kind;
	}
}

// ---------------------------------------------------------------------------------------------
// One claude process
// ---------------------------------------------------------------------------------------------

const CLOSE_GRACE_MS = 30_000;
const POLL_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A `claude -p` process whose stdout is read line by line. With `hasInput` it is the sender, fed
// one stream-json user message at a time; without, it is a receiver that runs its own prompt.
// `texts` holds every string of every stdout object, because the event that carries a
// cross-session message has no documented shape and the checks search by text.
export class Session {
	constructor({ command, args, cwd, env, streamPath, stderrPath, costGuard, hasInput }) {
		this.command = command;
		this.args = args;
		this.cwd = cwd;
		this.env = env;
		this.streamPath = streamPath;
		this.stderrPath = stderrPath;
		this.costGuard = costGuard;
		this.hasInput = hasInput;
		this.events = [];
		this.texts = [];
		this.resultCount = 0;
		this.costs = [];
		this.waiters = [];
		this.buffer = "";
		this.closed = false;
		this.failure = undefined;
		this.proc = undefined;
	}

	get cost() {
		return runCostOf(this.costs);
	}

	start() {
		const proc = spawn(this.command, this.args, {
			cwd: this.cwd,
			env: this.env,
			stdio: [this.hasInput ? "pipe" : "ignore", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
		});
		this.proc = proc;
		liveSessions.add(this);
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		proc.stdin?.on("error", () => {});
		proc.stdout.on("data", (chunk) => this.onStdout(chunk));
		proc.stderr.on("data", (chunk) => fs.appendFileSync(this.stderrPath, chunk));
		proc.on("error", (error) => {
			this.failure = new RunError("spawn", `cannot start claude: ${error.message}`);
			this.pump();
		});
		proc.on("close", (code) => {
			this.closed = true;
			this.exitCode = code;
			liveSessions.delete(this);
			if (this.buffer.trim() !== "") this.onLine(this.buffer);
			this.buffer = "";
			this.pump();
		});
	}

	onStdout(chunk) {
		fs.appendFileSync(this.streamPath, chunk);
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			this.onLine(line);
			index = this.buffer.indexOf("\n");
		}
	}

	onLine(line) {
		const parsed = parseStreamLine(line);
		if (parsed !== null) this.texts.push(...allStrings(parsed));
		else if (line.trim() !== "") this.texts.push(line);
		if (this.sessionId === undefined && typeof parsed?.session_id === "string") {
			this.sessionId = parsed.session_id;
		}
		const event = toEvent(parsed);
		if (event === null) return;
		this.events.push(event);
		if (event.kind === "result") {
			this.resultCount++;
			if (event.cost !== undefined) this.costs.push(event.cost);
			const reason = this.costGuard?.(this.cost);
			if (reason) this.abort(new RunError(reason.kind, reason.text));
		}
		this.pump();
	}

	pump() {
		for (const waiter of [...this.waiters]) {
			let outcome;
			if (this.failure !== undefined) outcome = { error: this.failure };
			else if (this.resultCount >= waiter.count) outcome = { value: true };
			else if (this.closed) {
				outcome = {
					error: new RunError("exited", `claude exited (code ${this.exitCode}) before the result`),
				};
			}
			if (outcome === undefined) continue;
			clearTimeout(waiter.timer);
			this.waiters.splice(this.waiters.indexOf(waiter), 1);
			if (outcome.error) waiter.reject(outcome.error);
			else waiter.resolve();
		}
	}

	abort(error) {
		this.failure = error;
		this.kill();
		this.pump();
	}

	kill() {
		if (this.proc) killTree(this.proc);
	}

	// Sends one user message and resolves with its `result` event and every event since the send.
	async turn(text, timeoutMs, label) {
		const startIndex = this.events.length;
		const count = this.resultCount + 1;
		const done = new Promise((resolve, reject) => {
			const waiter = { count, resolve, reject, timer: undefined };
			waiter.timer = setTimeout(() => {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				this.kill();
				reject(
					new RunError("timeout", `${label}: no result within ${Math.round(timeoutMs / 1000)} s`),
				);
			}, timeoutMs);
			this.waiters.push(waiter);
		});
		this.proc.stdin.write(
			`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
		);
		await done;
		const events = this.events.slice(startIndex);
		return { result: events.find((e) => e.kind === "result"), events };
	}

	// Polls `predicate` until it is true (resolves true), the process is gone or the time is up
	// (resolves false). For events that arrive without a turn of ours, like a delivery warning.
	async waitFor(predicate, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.failure !== undefined) throw this.failure;
			if (predicate()) return true;
			if (this.closed) return predicate();
			await sleep(POLL_MS);
		}
		return predicate();
	}

	// Ends stdin and waits for the process to exit; a straggler is killed.
	async finish() {
		this.proc.stdin?.end();
		if (this.closed) return;
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.kill();
				resolve();
			}, CLOSE_GRACE_MS);
			this.proc.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

export const delay = sleep;

// The transcript of a session, from <config dir>/projects/<any project>/<session id>.jsonl, or ""
// when there is none yet. Only the file name is relied on, not the project directory's name.
export function readTranscript(sessionId) {
	if (sessionId === undefined) return "";
	const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
	const projects = path.join(configDir, "projects");
	if (!fs.existsSync(projects)) return "";
	for (const dir of fs.readdirSync(projects)) {
		const file = path.join(projects, dir, `${sessionId}.jsonl`);
		if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
	}
	return "";
}
