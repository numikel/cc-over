// Self checks of the pure logic behind `handoff.mjs` (`node scripts/acceptance/handoff.mjs
// --selftest`). No process is spawned, nothing is paid for, and it runs in CI via `test:scripts`.
// Every case runs even when an earlier one failed: a runner that stops at the first failure hides
// the cases behind it.

import assert from "node:assert/strict";
import {
	ackVerdict,
	allStrings,
	broadcastVerdict,
	composeVerdict,
	deliveryVerdict,
	findHeaders,
	holdVerdict,
	isProbeTarget,
	noticeVerdict,
	resumeVerdict,
	sendVerdict,
	statusVerdict,
	transcriptStrings,
} from "./checks.mjs";
import {
	capReason,
	parseCli,
	parseStreamLine,
	receiverArgs,
	runCostOf,
	senderArgs,
	shouldStartRun,
	statusArgs,
	toEvent,
	UsageError,
} from "./lib.mjs";

// The header exactly as `renderBundle` writes it (plugin/hooks/bundle.ts, `render`).
const HEADER = [
	"[claude-over hand-off ovr-mq1f2k-0a1b]",
	"Send: 3fa9c21",
	"From: impl · repo demo · branch main · session 0a1b2c3d-0000-4000-8000-000000000000",
	"Approved by the user: they reviewed this hand-off in a preview and chose to send it to you. It is not a prompt typed by the user in this session.",
	"Handling: finish your current task first, then pick up the work below. If you do not pick it up, tell your user why. Leave any step that needs your user's permission (such as a commit) for them to confirm, and do the rest.",
	"Acknowledge now, before anything else: call the SendMessage tool with `to` set to the exact value of the `from` attribute of the cross-session-message envelope around this text, and `message` set to `over-ack ovr-mq1f2k-0a1b 3fa9c21`. This single call does not interrupt your current task; carry on with it afterwards.",
].join("\n");
// The send id appears twice (the `Send:` line and the acknowledgement line); both change.
const SECOND = HEADER.replaceAll("3fa9c21", "b7d0e55");

// The compose preview as `-p` logs it: one ui_log line per line (the send id is a placeholder).
const PREVIEW_LINES = [
	"branch main · files: 1 (uncommitted-only)",
	"[claude-over hand-off ovr-mq1f2k-0a1b]",
	"Send: <send-id>",
	"Approved by the user: they reviewed this hand-off in a preview.",
	"Handling: finish your current task first, then pick up the work below.",
	"Acknowledge now, before anything else: call the SendMessage tool with `message` set to `over-ack ovr-mq1f2k-0a1b <send-id>`.",
	"## Summary",
	"Added the greeting.",
	"## Instructions",
	"Review it.",
	"## Changed files (git, uncommitted changes only)",
	"- M greeting.txt (uncommitted)",
];

const ACCEPT_NAME = "probe-handoff-accept";
const HOLD_NAME = "probe-handoff-hold";
const NOTE_NAME = "probe-handoff-note";
const STATUS_INTENT = "przekaż handoff do sesji, która implementuje zmianę w greeting.txt";
const STATUS_OPTS = { intent: STATUS_INTENT, accept: ACCEPT_NAME, hold: HOLD_NAME };
// `/over --status` as `-p` logs it (phase-3 `statusReport`): a header per bundle, then one
// indented line per target.
const STATUS_LINES = [
	`14:02 ${STATUS_INTENT}`,
	`  received by ${ACCEPT_NAME} (acknowledged)`,
	`  passed on to ${HOLD_NAME} (queued)`,
];
const asQueued = (lines) =>
	lines.map((line) =>
		line.replace(
			`received by ${ACCEPT_NAME} (acknowledged)`,
			`passed on to ${ACCEPT_NAME} (queued)`,
		),
	);

// A broadcast exactly as `renderBundle` writes it (plugin/hooks/bundle.ts, `render`, kind
// "broadcast"): the same six header lines, then one `## Message` with the intent.
const BROADCAST_ID = "ovr-mq1f2k-0b2c";
const BROADCAST_INTENT =
	"FYI: I'm migrating the test database now; it will be down for about 10 minutes";
const broadcastWith = (sendId) =>
	[
		`[claude-over broadcast ${BROADCAST_ID}]`,
		`Send: ${sendId}`,
		"From: impl · repo demo · branch main · session 0a1b2c3d-0000-4000-8000-000000000000",
		"Approved by the user: they reviewed this broadcast in a preview and chose to send it to you. It is not a prompt typed by the user in this session.",
		"Handling: this is a notice, not a task. Keep it in mind and carry on with what you were doing; do not start new work because of it, and do not reply beyond the acknowledgement.",
		`Acknowledge now, before anything else: call the SendMessage tool with \`to\` set to the exact value of the \`from\` attribute of the cross-session-message envelope around this text, and \`message\` set to \`over-ack ${BROADCAST_ID} ${sendId}\`. This single call does not interrupt your current task; carry on with it afterwards.`,
		"",
		"## Message",
		BROADCAST_INTENT,
	].join("\n");
const BROADCAST_A = broadcastWith("5ac01de");
const BROADCAST_B = broadcastWith("9e3b7f2");
const BROADCAST_OPTS = {
	accept: ACCEPT_NAME,
	note: NOTE_NAME,
	bundleId: BROADCAST_ID,
	intent: BROADCAST_INTENT,
};
// What each receiver carried: the envelope the platform puts around the message, and a stream line.
const wrapped = (text) =>
	`<cross-session-message from="uds:x" from-name="impl">\n${text}\n</cross-session-message>`;
const BROADCAST_SEEN = {
	[ACCEPT_NAME]: [wrapped(BROADCAST_A), "sleep 15"],
	[NOTE_NAME]: [BROADCAST_B],
};

const asEvent = (kind, text, extra = {}) => ({ kind, text, ...extra });
const eventOf = (obj) => toEvent(parseStreamLine(JSON.stringify(obj)));

const cases = [
	[
		"stream: a ui_log line keeps its text and plugin",
		() => {
			assert.deepEqual(
				eventOf({ type: "system", subtype: "ui_log", text: "hello", plugin: "cc-over" }),
				{ kind: "ui_log", text: "hello", plugin: "cc-over" },
			);
		},
	],
	[
		"stream: a result line carries turns, cost and the error flag",
		() => {
			const event = eventOf({
				type: "result",
				num_turns: 0,
				total_cost_usd: 0,
				result: "",
				is_error: false,
			});
			assert.equal(event?.kind, "result");
			assert.equal(event?.numTurns, 0);
			assert.equal(event?.cost, 0);
			assert.equal(event?.isError, false);
		},
	],
	[
		"stream: a system/informational line becomes a system event with all its text",
		() => {
			const event = eventOf({
				type: "system",
				subtype: "informational",
				content: "Cross-session message held by the receiving session (recipient: @x).",
			});
			assert.equal(event?.kind, "system");
			assert.equal(event?.subtype, "informational");
			assert.match(event?.text ?? "", /^Cross-session message held by the receiving session/);
		},
	],
	[
		"stream: junk and non-objects are ignored",
		() => {
			assert.equal(parseStreamLine("not json"), null);
			assert.equal(parseStreamLine("[1,2]"), null);
			assert.equal(toEvent(null), null);
		},
	],
	[
		"allStrings: walks nested objects and arrays",
		() => {
			const found = allStrings({ a: "x", b: [{ c: "y" }, 3, null], d: { e: { f: "z" } } });
			assert.deepEqual([...found].sort(), ["x", "y", "z"]);
		},
	],
	[
		"headers: finds bundle id and send id inside a longer message",
		() => {
			const text = `<cross-session-message from="uds:x" from-name="review">\n${HEADER}\n\n## Summary\nDo it.`;
			assert.deepEqual(findHeaders(text), [{ bundleId: "ovr-mq1f2k-0a1b", sendId: "3fa9c21" }]);
		},
	],
	[
		"headers: the preview placeholder gives a bundle id without a send id",
		() => {
			const preview = HEADER.replaceAll("3fa9c21", "<send-id>");
			assert.deepEqual(findHeaders(preview), [{ bundleId: "ovr-mq1f2k-0a1b" }]);
		},
	],
	[
		"headers: a broadcast header has the same grammar as a hand-off one",
		() => {
			const broadcast = HEADER.replace("[claude-over hand-off ", "[claude-over broadcast ");
			assert.deepEqual(findHeaders(broadcast), [
				{ bundleId: "ovr-mq1f2k-0a1b", sendId: "3fa9c21" },
			]);
			assert.deepEqual(findHeaders(broadcast.replaceAll("3fa9c21", "<send-id>")), [
				{ bundleId: "ovr-mq1f2k-0a1b" },
			]);
		},
	],
	[
		"headers: two deliveries in one text are both found, in order",
		() => {
			assert.deepEqual(findHeaders(`${HEADER}\n---\n${SECOND}`), [
				{ bundleId: "ovr-mq1f2k-0a1b", sendId: "3fa9c21" },
				{ bundleId: "ovr-mq1f2k-0a1b", sendId: "b7d0e55" },
			]);
		},
	],
	[
		"headers: text without the marker has none",
		() => {
			assert.deepEqual(findHeaders("passed on to probe-handoff-accept (queued)"), []);
		},
	],
	[
		"compose: a full preview passes and names the bundle",
		() => {
			const verdict = composeVerdict(PREVIEW_LINES, { fileName: "greeting.txt" });
			assert.equal(verdict.ok, true, verdict.problems.join("; "));
			assert.equal(verdict.bundleId, "ovr-mq1f2k-0a1b");
		},
	],
	[
		"compose: a missing section, header or file name is reported",
		() => {
			const noSection = PREVIEW_LINES.filter((line) => line !== "## Instructions");
			assert.match(
				composeVerdict(noSection, { fileName: "greeting.txt" }).problems.join(),
				/Instructions/,
			);
			assert.match(
				composeVerdict(PREVIEW_LINES, { fileName: "other.txt" }).problems.join(),
				/other\.txt/,
			);
			const none = composeVerdict(["could not compose the bundle: boom"], { fileName: "a" });
			assert.equal(none.ok, false);
			assert.match(none.problems.join(), /header/);
		},
	],
	[
		"compose: a fork that fell back is flagged but does not fail",
		() => {
			const lines = [...PREVIEW_LINES, "Note: no conversation summary: nothing-to-fork"];
			const verdict = composeVerdict(lines, { fileName: "greeting.txt" });
			assert.equal(verdict.ok, true);
			assert.match(verdict.fallbackNote ?? "", /nothing-to-fork/);
		},
	],
	[
		"send: 'passed on to <target> (queued)' passes, 'not passed on' does not",
		() => {
			const queued = ["passed on to probe-handoff-accept (queued)"];
			assert.equal(sendVerdict(queued, "probe-handoff-accept").ok, true);
			const refused = [
				"not passed on to probe-handoff-accept: this session has no SendMessage tool",
			];
			assert.equal(sendVerdict(refused, "probe-handoff-accept").ok, false);
			assert.equal(sendVerdict([], "probe-handoff-accept").ok, false);
			assert.equal(sendVerdict(queued, "probe-handoff-hold").ok, false);
		},
	],
	[
		"delivery: two sends of one bundle with different send ids pass",
		() => {
			const verdict = deliveryVerdict([`${HEADER}\n\n## Summary`, SECOND], "ovr-mq1f2k-0a1b");
			assert.equal(verdict.ok, true, verdict.problems.join("; "));
			assert.deepEqual(verdict.sendIds, ["3fa9c21", "b7d0e55"]);
		},
	],
	[
		"delivery: the same delivery echoed twice counts once, so one delivery fails",
		() => {
			const verdict = deliveryVerdict([HEADER, `echo: ${HEADER}`], "ovr-mq1f2k-0a1b");
			assert.equal(verdict.ok, false);
			assert.match(verdict.problems.join(), /2 distinct send ids/);
		},
	],
	[
		"delivery: another bundle id, no header or no approval block fails",
		() => {
			assert.equal(deliveryVerdict([HEADER, SECOND], "ovr-other-0000").ok, false);
			assert.equal(deliveryVerdict(["nothing here"], "ovr-mq1f2k-0a1b").ok, false);
			const noApproval = HEADER.replace(/^Approved by the user:.*$/m, "");
			const verdict = deliveryVerdict(
				[noApproval, SECOND.replace(/^Approved by the user:.*$/m, "")],
				"ovr-mq1f2k-0a1b",
			);
			assert.match(verdict.problems.join(), /Approved by the user/);
		},
	],
	[
		"hold: a receiver that never saw a header passes, one that did fails",
		() => {
			assert.equal(holdVerdict(["sleep 15", "done"]).ok, true);
			assert.equal(holdVerdict(["sleep 15", HEADER]).ok, false);
		},
	],
	[
		"notices: the held warning is read from system events only",
		() => {
			const held = asEvent(
				"system",
				"Cross-session message held by the receiving session (recipient: @r).",
				{
					subtype: "informational",
				},
			);
			assert.deepEqual(noticeVerdict([held]), { isHeld: true, isDropped: false });
			const quoted = asEvent("assistant", "Cross-session message held by the receiving session");
			assert.deepEqual(noticeVerdict([quoted]), { isHeld: false, isDropped: false });
			const dropped = asEvent(
				"system",
				"Cross-session message was dropped at the recipient session's inbox (recipient: @r) and not delivered — it repeated your previous message.",
				{ subtype: "informational" },
			);
			assert.equal(noticeVerdict([dropped]).isDropped, true);
		},
	],
	[
		"ack: a 'received by <target> (acknowledged)' log line with no new sender turn passes",
		() => {
			const events = [
				asEvent("result", "", { numTurns: 1 }),
				asEvent("result", "", { numTurns: 0 }),
				asEvent("ui_log", "received by probe-handoff-accept (acknowledged)"),
				asEvent("ui_log", "received by probe-handoff-accept (acknowledged)"),
			];
			const verdict = ackVerdict(events, "probe-handoff-accept", { before: 2 });
			assert.equal(verdict.ok, true, verdict.problems.join("; "));
			assert.equal(verdict.received, 2);
			assert.equal(verdict.extraTurns, 0);
		},
	],
	[
		"ack: no such line fails, and only the mod's own ui_log lines count",
		() => {
			const results = [asEvent("result", ""), asEvent("result", "")];
			const none = ackVerdict(results, "probe-handoff-accept", { before: 2 });
			assert.equal(none.ok, false);
			assert.equal(none.received, 0);
			assert.match(none.problems.join(), /received by probe-handoff-accept/);
			// the model quoting the line, or an ack for another target, is not the proof
			const quoted = [
				...results,
				asEvent("assistant", "received by probe-handoff-accept (acknowledged)"),
				asEvent("ui_log", "received by probe-handoff-hold (acknowledged)"),
				asEvent("ui_log", "passed on to probe-handoff-accept (queued)"),
			];
			assert.equal(ackVerdict(quoted, "probe-handoff-accept", { before: 2 }).ok, false);
		},
	],
	[
		"ack: a sender turn after the ack means the model got the message and fails",
		() => {
			const events = [
				asEvent("result", ""),
				asEvent("result", ""),
				asEvent("ui_log", "received by probe-handoff-accept (acknowledged)"),
				asEvent("result", ""),
			];
			const verdict = ackVerdict(events, "probe-handoff-accept", { before: 2 });
			assert.equal(verdict.ok, false);
			assert.equal(verdict.extraTurns, 1);
			assert.match(verdict.problems.join(), /1 turn/);
		},
	],
	[
		"ack: a target name with regex characters is matched literally",
		() => {
			const dotted = [asEvent("ui_log", "received by probe-handoff-a.b (acknowledged)")];
			assert.equal(ackVerdict(dotted, "probe-handoff-a.b", { before: 0 }).ok, true);
			// an unescaped '.' would take the other receiver's line for this one's
			const other = [asEvent("ui_log", "received by probe-handoff-axb (acknowledged)")];
			assert.equal(ackVerdict(other, "probe-handoff-a.b", { before: 0 }).ok, false);
		},
	],
	[
		"cost: the run cost is the largest cumulative figure, never the sum",
		() => {
			assert.equal(runCostOf([0.01, 0.04, 0.03]), 0.04);
			assert.equal(runCostOf([]), 0);
		},
	],
	[
		"cost: the cap speaks only when strictly exceeded",
		() => {
			assert.equal(capReason({ spent: 0.8, runCost: 1.2, cap: 2 }), null);
			assert.match(capReason({ spent: 0.8, runCost: 1.21, cap: 2 })?.text ?? "", /exceeds the cap/);
			assert.equal(shouldStartRun(2, 2), true);
			assert.equal(shouldStartRun(2.01, 2), false);
		},
	],
	[
		"cli: defaults, and a bad number or an unknown flag is a usage error",
		() => {
			const config = parseCli([]);
			assert.equal(config.model, "haiku");
			assert.equal(config.maxCost, 2.5);
			assert.equal(parseCli(["--max-cost", "0.5"]).maxCost, 0.5);
			assert.throws(() => parseCli(["--max-cost", "abc"]), UsageError);
			assert.throws(() => parseCli(["--max-cost", "0"]), UsageError);
			assert.throws(() => parseCli(["--nope"]), UsageError);
			assert.equal(parseCli(["--selftest"]).selftest, true);
		},
	],
	[
		"args: a receiver has a probe name, its inbound mode and only the sleep tool",
		() => {
			const args = receiverArgs({
				name: "probe-handoff-hold",
				mode: "hold",
				model: "haiku",
				budget: 0.4,
				prompt: "p",
			});
			const at = (flag) => args[args.indexOf(flag) + 1];
			assert.equal(at("--name"), "probe-handoff-hold");
			assert.deepEqual(JSON.parse(at("--settings")), { crossSessionInbound: "hold" });
			assert.equal(at("--allowedTools"), "Bash(sleep:*)");
			assert.equal(at("--max-budget-usd"), "0.4");
			assert.ok(!args.includes("SendMessage"));
			assert.throws(
				() =>
					receiverArgs({ name: "impl", mode: "accept", model: "haiku", budget: 0.4, prompt: "p" }),
				/probe-handoff-/,
			);
			assert.throws(
				() =>
					receiverArgs({
						name: "probe-handoff-x",
						mode: "open",
						model: "haiku",
						budget: 0.4,
						prompt: "p",
					}),
				/mode/,
			);
		},
	],
	[
		"args: an accepting receiver may acknowledge (SendMessage + ToolSearch); the others may not",
		() => {
			const base = { name: "probe-handoff-accept", mode: "accept", model: "haiku", budget: 0.4 };
			const tools = (args) => {
				const from = args.indexOf("--allowedTools") + 1;
				const to = args.findIndex((arg, i) => i >= from && arg.startsWith("--"));
				return args.slice(from, to);
			};
			assert.deepEqual(tools(receiverArgs({ ...base, prompt: "p", ack: true })), [
				"Bash(sleep:*)",
				"SendMessage",
				"ToolSearch",
			]);
			assert.deepEqual(tools(receiverArgs({ ...base, prompt: "p" })), ["Bash(sleep:*)"]);
			// SendMessage is deferred: without ToolSearch the model cannot load it
			assert.ok(!receiverArgs({ ...base, prompt: "p" }).includes("SendMessage"));
			// the prompt must stay right after -p: --allowedTools is variadic and swallows it
			const args = receiverArgs({ ...base, prompt: "the prompt", ack: true });
			assert.equal(args[args.indexOf("-p") + 1], "the prompt");
		},
	],
	[
		"args: a receiver runs in default mode, so tools off the list are denied, and cannot list sessions",
		() => {
			// In `auto` (the author's default) tools off --allowedTools still run, and a probe with
			// SendMessage could reach a real session; `default` in `-p` denies them instead.
			for (const ack of [true, false]) {
				const args = receiverArgs({
					name: "probe-handoff-accept",
					mode: "accept",
					model: "haiku",
					budget: 0.4,
					prompt: "p",
					ack,
				});
				assert.equal(args[args.indexOf("--permission-mode") + 1], "default");
				assert.equal(args[args.indexOf("--disallowedTools") + 1], "ListAgents");
			}
		},
	],
	[
		"args: the sender keeps SendMessage, which the mod's send needs (evidence E2)",
		() => {
			const args = senderArgs({ pluginDir: "/p", model: "haiku", debugFile: "/d", budget: 1 });
			assert.ok(!args.includes("--disallowedTools"));
			assert.ok(!args.some((arg) => arg.includes("SendMessage")));
			assert.equal(args[args.indexOf("--plugin-dir") + 1], "/p");
			assert.ok(args.includes("--input-format"));
		},
	],
	[
		"transcript: every string of every JSON line, junk lines skipped",
		() => {
			const jsonl = [
				JSON.stringify({ type: "attachment", attachment: { text: HEADER } }),
				"not json",
				"",
				JSON.stringify({ type: "queue-operation", content: [{ text: SECOND }] }),
			].join("\n");
			const found = transcriptStrings(jsonl);
			assert.ok(found.includes(HEADER));
			assert.ok(found.includes(SECOND));
			const verdict = deliveryVerdict(found, "ovr-mq1f2k-0a1b");
			assert.equal(verdict.ok, true, verdict.problems.join("; "));
			assert.deepEqual(transcriptStrings(""), []);
		},
	],
	[
		"delivery: the source the platform names is reported",
		() => {
			const wrapped = `<cross-session-message from="uds:x" from-name="repo-cf" from-mode="prompting">\n${HEADER}\n</cross-session-message>`;
			const verdict = deliveryVerdict([wrapped, SECOND], "ovr-mq1f2k-0a1b");
			assert.equal(verdict.fromName, "repo-cf");
			assert.equal(deliveryVerdict([HEADER, SECOND], "ovr-mq1f2k-0a1b").fromName, undefined);
		},
	],
	[
		"args: no process starts the user's MCP servers",
		() => {
			const sender = senderArgs({ pluginDir: "/p", model: "haiku", debugFile: "/d", budget: 1 });
			const receiver = receiverArgs({
				name: "probe-handoff-accept",
				mode: "accept",
				model: "haiku",
				budget: 0.4,
				prompt: "p",
			});
			assert.ok(sender.includes("--strict-mcp-config"));
			assert.ok(receiver.includes("--strict-mcp-config"));
		},
	],
	[
		"status: the phase-3 report passes (received by accept, passed on to hold, header with the intent)",
		() => {
			const verdict = statusVerdict(STATUS_LINES, { ...STATUS_OPTS, ackSeen: true });
			assert.equal(verdict.ok, true, verdict.problems.join("; "));
		},
	],
	[
		"status: without an ack seen, 'passed on to <accept>' and 'received by <accept>' both pass",
		() => {
			assert.equal(
				statusVerdict(asQueued(STATUS_LINES), { ...STATUS_OPTS, ackSeen: false }).ok,
				true,
			);
			assert.equal(statusVerdict(STATUS_LINES, { ...STATUS_OPTS, ackSeen: false }).ok, true);
		},
	],
	[
		"status: with an ack seen, 'passed on to <accept>' is not enough",
		() => {
			const verdict = statusVerdict(asQueued(STATUS_LINES), { ...STATUS_OPTS, ackSeen: true });
			assert.equal(verdict.ok, false);
			assert.match(verdict.problems.join(), /received by probe-handoff-accept/);
		},
	],
	[
		"status: a missing hold line fails and names the receiver",
		() => {
			const lines = STATUS_LINES.filter((line) => !line.includes(HOLD_NAME));
			const verdict = statusVerdict(lines, { ...STATUS_OPTS, ackSeen: true });
			assert.equal(verdict.ok, false);
			assert.match(verdict.problems.join(), /passed on to probe-handoff-hold/);
		},
	],
	[
		"status: any 'not passed on' line fails, and is not taken for the hold line",
		() => {
			const extra = [...STATUS_LINES, "  not passed on to probe-handoff-x: the session is gone"];
			const first = statusVerdict(extra, { ...STATUS_OPTS, ackSeen: true });
			assert.equal(first.ok, false);
			assert.match(first.problems.join(), /not passed on/);
			const refused = STATUS_LINES.map((line) =>
				line.replace(`passed on to ${HOLD_NAME} (queued)`, `not passed on to ${HOLD_NAME}: no`),
			);
			const second = statusVerdict(refused, { ...STATUS_OPTS, ackSeen: true });
			assert.equal(second.ok, false);
			assert.ok(
				second.problems.includes('no "passed on to probe-handoff-hold" line in the status report'),
			);
		},
	],
	[
		"status: no header with the intent fails (empty report, other intent, no time)",
		() => {
			const body = STATUS_LINES.slice(1);
			for (const lines of [
				body,
				["no sends recorded for this session"],
				["14:02 some other intent", ...body],
				[STATUS_INTENT, ...body],
			]) {
				const verdict = statusVerdict(lines, { ...STATUS_OPTS, ackSeen: true });
				assert.equal(verdict.ok, false, lines[0]);
				assert.match(verdict.problems.join(), /header/);
			}
		},
	],
	[
		"status: an intent cut to 60 characters with an ellipsis still matches its header",
		() => {
			const long = "przekaż handoff do sesji, która implementuje zmianę w greeting.txt i dalej";
			const opts = { intent: long, accept: ACCEPT_NAME, hold: HOLD_NAME, ackSeen: true };
			const cut = `${long.slice(0, 59)}…`;
			assert.equal(statusVerdict([`14:02 ${cut}`, ...STATUS_LINES.slice(1)], opts).ok, true);
			const other = cut.replace("handoff", "hand-off");
			assert.equal(statusVerdict([`14:02 ${other}`, ...STATUS_LINES.slice(1)], opts).ok, false);
		},
	],
	[
		"status: a plugin prefix, indentation and one multi-line log event are tolerated",
		() => {
			const opts = { ...STATUS_OPTS, ackSeen: true };
			const prefixed = STATUS_LINES.map((line) => `cc-over: ${line}`);
			assert.equal(statusVerdict(prefixed, opts).ok, true);
			assert.equal(statusVerdict([STATUS_LINES.join("\n")], opts).ok, true);
		},
	],
	[
		"status: receiver names are matched literally and whole (accept2 is not accept)",
		() => {
			const longer = STATUS_LINES.map((line) => line.replace(ACCEPT_NAME, `${ACCEPT_NAME}2`));
			assert.equal(statusVerdict(longer, { ...STATUS_OPTS, ackSeen: true }).ok, false);
			const other = STATUS_LINES.map((line) => line.replace(ACCEPT_NAME, "probe-handoff-axb"));
			const dotted = { ...STATUS_OPTS, accept: "probe-handoff-a.b", ackSeen: true };
			assert.equal(statusVerdict(other, dotted).ok, false);
			// control: the exact dotted name does pass, so the negatives above prove something
			const exact = STATUS_LINES.map((line) => line.replace(ACCEPT_NAME, "probe-handoff-a.b"));
			assert.equal(statusVerdict(exact, dotted).ok, true);
		},
	],
	[
		"args: the status process resumes the sender's session and runs /over --status",
		() => {
			const args = statusArgs({ pluginDir: "/p", model: "haiku", sessionId: "sid-1", budget: 0.2 });
			assert.deepEqual(args, [
				"-p",
				"/over --status",
				"--resume",
				"sid-1",
				"--output-format",
				"stream-json",
				"--verbose",
				"--strict-mcp-config",
				"--plugin-dir",
				"/p",
				"--model",
				"haiku",
				"--max-budget-usd",
				"0.2",
			]);
			// it takes no input and is given no tools to send with
			assert.ok(!args.includes("--input-format"));
			assert.ok(!args.includes("--allowedTools"));
		},
	],
	[
		"resume: the status process must report the sender's own session id",
		() => {
			assert.equal(resumeVerdict("sid-1", "sid-1").ok, true);
			const moved = resumeVerdict("sid-1", "sid-2");
			assert.equal(moved.ok, false);
			assert.match(moved.problems.join(), /--resume in -p assigned a new id/);
			assert.equal(resumeVerdict(undefined, "sid-1").ok, false);
			assert.equal(resumeVerdict("sid-1", undefined).ok, false);
		},
	],
	[
		"broadcast: both receivers hold the header, a `## Message` with the intent and no hand-off section",
		() => {
			const verdict = broadcastVerdict(BROADCAST_SEEN, BROADCAST_OPTS);
			assert.equal(verdict.ok, true, verdict.problems.join("; "));
		},
	],
	[
		"broadcast: a missing header at one receiver fails and names it",
		() => {
			for (const lacking of [ACCEPT_NAME, NOTE_NAME]) {
				const seen = { ...BROADCAST_SEEN, [lacking]: ["sleep 15", "done"] };
				const verdict = broadcastVerdict(seen, BROADCAST_OPTS);
				assert.equal(verdict.ok, false, lacking);
				assert.equal(verdict.problems.length, 1, verdict.problems.join("; "));
				assert.match(verdict.problems[0], new RegExp(`^${lacking} never saw`));
			}
			// no receiver at all in the map is the same failure, not an exception
			assert.equal(broadcastVerdict({}, BROADCAST_OPTS).problems.length, 2);
		},
	],
	[
		"broadcast: a `## Summary` in the broadcast fails (a hand-off body does not pass for one)",
		() => {
			const withSummary = `${BROADCAST_B}\n\n## Summary\nDo it.`;
			const verdict = broadcastVerdict(
				{ ...BROADCAST_SEEN, [NOTE_NAME]: [withSummary] },
				BROADCAST_OPTS,
			);
			assert.equal(verdict.ok, false);
			assert.match(
				verdict.problems.join(),
				/probe-handoff-note: a broadcast must not carry "## Summary"/,
			);
			// a hand-off with the same bundle id is not a broadcast: no broadcast header, no pass
			const handOff = HEADER.replace("ovr-mq1f2k-0a1b", BROADCAST_ID).replace("3fa9c21", "9e3b7f2");
			const asHandOff = broadcastVerdict(
				{ ...BROADCAST_SEEN, [NOTE_NAME]: [`${handOff}\n\n## Summary\nDo it.`] },
				BROADCAST_OPTS,
			);
			assert.equal(asHandOff.ok, false);
			assert.match(asHandOff.problems.join(), /probe-handoff-note never saw/);
		},
	],
	[
		"broadcast: only the broadcast's own part of a text is judged, in either order with a hand-off",
		() => {
			const earlier = `${HEADER}\n\n## Summary\nDo it.\n\n## Instructions\nGo.\n\n${BROADCAST_B}`;
			const later = `${BROADCAST_B}\n\n---\n${HEADER}\n\n## Summary\nDo it.`;
			for (const text of [earlier, later]) {
				const verdict = broadcastVerdict(
					{ ...BROADCAST_SEEN, [NOTE_NAME]: [text] },
					BROADCAST_OPTS,
				);
				assert.equal(verdict.ok, true, verdict.problems.join("; "));
			}
		},
	],
	[
		"broadcast: no `## Message`, another intent, another bundle id or no bundle id fails",
		() => {
			const noMessage = BROADCAST_B.replace("## Message", "## Note");
			assert.match(
				broadcastVerdict(
					{ ...BROADCAST_SEEN, [NOTE_NAME]: [noMessage] },
					BROADCAST_OPTS,
				).problems.join(),
				/no "## Message" section that holds the intent/,
			);
			const otherIntent = BROADCAST_B.replace(BROADCAST_INTENT, "something else");
			assert.equal(
				broadcastVerdict({ ...BROADCAST_SEEN, [NOTE_NAME]: [otherIntent] }, BROADCAST_OPTS).ok,
				false,
			);
			// the intent above the `## Message` heading (in the header) is not the message
			const intentFirst = `${BROADCAST_INTENT}\n${BROADCAST_B.replace(BROADCAST_INTENT, "")}`;
			assert.equal(
				broadcastVerdict({ ...BROADCAST_SEEN, [NOTE_NAME]: [intentFirst] }, BROADCAST_OPTS).ok,
				false,
			);
			assert.equal(
				broadcastVerdict(BROADCAST_SEEN, { ...BROADCAST_OPTS, bundleId: "ovr-other-0000" }).ok,
				false,
			);
			const none = broadcastVerdict(BROADCAST_SEEN, { ...BROADCAST_OPTS, bundleId: undefined });
			assert.equal(none.ok, false);
			assert.match(none.problems.join(), /no bundle id/);
		},
	],
	[
		"targets: only probe-handoff-* names may be sent to",
		() => {
			assert.equal(isProbeTarget("probe-handoff-accept"), true);
			assert.equal(isProbeTarget("probe-handoff-hold"), true);
			assert.equal(isProbeTarget("probe-handoff-note"), true);
			for (const name of [
				"",
				"probe-handoff-",
				"impl",
				"probe-s01-x",
				"xprobe-handoff-a",
				"probe-handoff-a b",
				"probe-handoff-a [1f2e3d]",
			]) {
				assert.equal(isProbeTarget(name), false, name);
			}
			assert.equal(isProbeTarget(undefined), false);
		},
	],
];

export function runSelftest(log = console.log) {
	let failed = 0;
	for (const [name, run] of cases) {
		try {
			run();
			log(`ok    ${name}`);
		} catch (error) {
			failed++;
			log(`FAIL  ${name}`);
			log(`      ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
		}
	}
	log(`${cases.length - failed}/${cases.length} self checks passed`);
	return failed === 0;
}
