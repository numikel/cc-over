// Shared test world: every `$` call the mod makes is answered beneath it (the kit's `$` answers
// only `$.state`, `$.ui.invalidate` and `$.session.append` itself). Not a test file: `claude plugin
// test` runs only *.test.ts, and each test file imports this one. Fixtures are anonymised.

import type { On, PaneOpenArgs, RenderSurface, SessionSendResult, UiOpenResult } from "claude-code";
import { type Engine, type MockClock, mock } from "claude-code/testing";

export const SESSION_ID = "6f1d2c3a-1111-2222-3333-444455556666";
export const ROOT = "/proj";
export const NOW = 1_792_274_900_000;
export const PRESENTATION = { isFullscreen: false, columns: 80 } as const;
export const COMPOSER = { kind: "composer" } as const;
export const START = { cwd: ROOT, surface: "terminal", isInteractive: false } as const;

export const LISTING =
	"This session is sender-1 [a2f9f3] — the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).\n\nPeer sessions (3):\n  impl [c03940]  ·  interactive  ·  idle  ·  started 12h ago\n  repo-a | review [9f271c]  ·  interactive  ·  busy  ·  started 2h ago\n  cloud-1 [ab12cd]  ·  remote  ·  idle  ·  started 1h ago";

export const ROWS = [
	{ name: "impl", ref: "c03940", type: "interactive", status: "idle" },
	{ name: "repo-a | review", ref: "9f271c", type: "interactive", status: "busy" },
	{ name: "cloud-1", ref: "ab12cd", type: "remote", status: "idle" },
];

export type Run = { exitCode: number; stdout: string; stderr?: string };

// What git answers in a repo on a feature branch, by the argv joined with spaces.
export const GIT: Record<string, Run> = {
	"git status --porcelain=v1": { exitCode: 0, stdout: " M src/a.ts\n?? notes.md\n" },
	"git rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "feat/x\n" },
	"git rev-parse --short HEAD": { exitCode: 0, stdout: "abc1234\n" },
	"git rev-parse HEAD": { exitCode: 0, stdout: "bbbb\n" },
	"git rev-parse --abbrev-ref origin/HEAD": { exitCode: 128, stdout: "origin/HEAD\n" },
	"git merge-base -- HEAD main": { exitCode: 0, stdout: "aaaa\n" },
	"git diff --name-status main...HEAD": { exitCode: 0, stdout: "M\tsrc/b.ts\n" },
};

export const FORK_TEXT =
	"### SUMMARY\nReview done, two findings.\n\n### INSTRUCTIONS\nFix the two findings.\n\n### DETAILS\nSee src/a.ts.";

export type Seen = {
	toasts: string[];
	logs: string[];
	registered: { name: string; argumentHint?: string }[];
	opened: PaneOpenArgs[];
	closed: string[];
	forks: string[];
	sent: { to: unknown; text: string }[];
	ran: string[];
	clock: MockClock;
};

export type WorldOptions = {
	refuseRegister?: boolean;
	rows?: typeof ROWS;
	/** Rows a second ListAgents call answers (a session closed in between). */
	rowsAfterFirst?: typeof ROWS;
	/** What `$.model.fork` answers; default: an answered, well-formed reply. */
	fork?: unknown;
	/** `ListAgents` is refused (the tool call throws). */
	listFails?: true;
	/** The fork answers only once this settles: the bundle stays "composing" until then. */
	forkGate?: Promise<void>;
	/** What `$.session.send` answers; default: delivered. */
	send?: { isDelivered: boolean; reason?: string };
	/** Git answers by joined argv; default: GIT. A value `"reject"` makes the call reject. */
	git?: Record<string, Run | "reject">;
	/** `$.config.list` rows: the `cc-over.compose` value, or undefined for no row (as in `-p`). */
	compose?: "fork" | "none";
	open?: UiOpenResult;
	sessionId?: string;
};

export function world(on: On, surfaces: readonly RenderSurface[], options: WorldOptions = {}) {
	const seen: Seen = {
		toasts: [],
		logs: [],
		registered: [],
		opened: [],
		closed: [],
		forks: [],
		sent: [],
		ran: [],
		clock: mock.clock(on, { now: NOW }),
	};
	let listCalls = 0;
	const git = options.git ?? GIT;

	on("session.start", (_$, e) => ({ cwd: e.cwd }));
	on("session.id", () => ({ value: options.sessionId ?? SESSION_ID }));
	on("session.root", () => ({ value: ROOT }));
	on("session.surfaces", () => ({ value: surfaces }));
	on("ui.toast", (_$, e) => {
		seen.toasts.push(e.text);
		return { value: undefined };
	});
	on("ui.log", (_$, e) => {
		seen.logs.push(e.text);
		return { value: undefined };
	});
	on("ui.open", (_$, e) => {
		seen.opened.push(e);
		return { value: options.open ?? { isPlaced: true as const } };
	});
	on("ui.close", (_$, e) => {
		seen.closed.push(e.id);
		return { value: undefined };
	});
	on("command.register", (_$, e) => {
		if (options.refuseRegister) return { deny: "taken by a built-in" };
		seen.registered.push({ name: e.name, argumentHint: e.argumentHint });
		return { value: { command: e.name } };
	});
	on("config.list", () => ({
		value:
			options.compose === undefined
				? []
				: [
						{
							key: "cc-over.compose",
							label: "Compose mode",
							kind: "choice" as const,
							value: options.compose,
							options: ["fork", "none"],
							provider: { plugin: "cc-over@inline", tier: "user" as const },
							isLocked: false,
						},
					],
	}));
	on("tool.call", (_$, e) => {
		if (options.listFails) return { deny: "ListAgents is not available" };
		listCalls += 1;
		const rows =
			listCalls > 1 && options.rowsAfterFirst ? options.rowsAfterFirst : (options.rows ?? ROWS);
		return {
			result: { listing: LISTING, sections: [{ kind: "sessions", total: rows.length, rows }] },
			text: e.tool,
		};
	});
	on("process.run", (_$, e) => {
		const key = e.argv.join(" ");
		seen.ran.push(key);
		const run = git[key];
		if (run === "reject") throw new Error("spawn git ENOENT");
		const { exitCode, stdout, stderr = "" } = run ?? { exitCode: 128, stdout: "" };
		return {
			value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
		};
	});
	on("model.fork", async (_$, e) => {
		seen.forks.push(e.prompt);
		await options.forkGate;
		return {
			value: (options.fork ?? {
				isAnswered: true,
				text: FORK_TEXT,
				usage: { input_tokens: 1, output_tokens: 1 },
			}) as never,
		};
	});
	on("session.send", (_$, e) => {
		seen.sent.push({ to: e.to, text: e.text });
		return (options.send ?? { isDelivered: true }) as SessionSendResult;
	});
	return seen;
}

export function over($: Engine, args: string) {
	return $.command.run({ command: "over", args, origin: COMPOSER, presentation: PRESENTATION });
}

// The pane as the surface hands it to the mod: mounted on the terminal, the way a person opens it.
export const PANE_PROPS = {
	title: "Hand-off",
	isFocused: true,
	bodyColumns: 80,
	placement: "inline",
	scroll: { offset: 0, bodyRows: 40 },
	view: {},
} as const;

export function mountPane($: Engine) {
	return $.ui.mount({
		plugin: "cc-over",
		surface: "terminal",
		component: "Pane",
		requestId: "over",
		props: PANE_PROPS,
	});
}

// A promise the test settles by hand: `gate.release()` lets what waits on `gate.promise` go on.
export function gate(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

// The warnings the platform writes into the sender's conversation, verbatim from evidence.md § E1
// (only the recipient is ours). Each is the text of one `system` / `informational` row.
export const heldText = (to: string) =>
	`Cross-session message held by the receiving session (recipient: @${to}). Claude in that session hasn't seen it. The usual cause is that the two sessions are in different permission modes: a terminal session then asks for approval there, but the desktop app and non-interactive sessions can't ask, so there the message expires undelivered unless the modes come to match. A session can also be set to hold every message.`;
export const refusedText = (to: string) =>
	`Cross-session message refused (recipient: @${to}). That session is not accepting cross-session messages (the feature is off there, or a setting or policy there refuses them); it was not delivered.`;
export const expiredText = (to: string) =>
	`Cross-session message expired without approval (recipient: @${to}). It was never approved, so it wasn't delivered and nothing is waiting in that session. Claude was told.`;

// One row as `session.append` hands it for a platform warning: door `notice`, the engine's own.
export function noticeRow(text: string, name = "informational", uuid = "row-1") {
	return {
		message: {
			type: "system" as const,
			name,
			content: text === "" ? [] : [{ type: "text" as const, text }],
		},
		door: "notice" as const,
		origin: { kind: "engine" as const },
		uuid,
	};
}
