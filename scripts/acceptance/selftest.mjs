// Self checks of the pure logic behind `handoff.mjs` (`node scripts/acceptance/handoff.mjs
// --selftest`). No process is spawned, nothing is paid for, and it runs in CI via `test:scripts`.
// Every case runs even when an earlier one failed: a runner that stops at the first failure hides
// the cases behind it.

import assert from "node:assert/strict";
import {
	allStrings,
	composeVerdict,
	deliveryVerdict,
	findHeaders,
	holdVerdict,
	isProbeTarget,
	noticeVerdict,
	sendVerdict,
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
	toEvent,
	UsageError,
} from "./lib.mjs";

// The header exactly as `renderBundle` writes it (plugin/hooks/bundle.ts, `render`).
const HEADER = [
	"[claude-over hand-off ovr-mq1f2k-0a1b]",
	"Send: 3fa9c21",
	"From: impl · repo demo · branch main · session 0a1b2c3d-0000-4000-8000-000000000000",
	"Approved by the user: they reviewed this hand-off in a preview and chose to send it to you. It is not a prompt typed by the user in this session.",
	"Handling: finish your current task first, then pick up the work below.",
].join("\n");
const SECOND = HEADER.replace("3fa9c21", "b7d0e55");

// The compose preview as `-p` logs it: one ui_log line per line (the send id is a placeholder).
const PREVIEW_LINES = [
	"branch main · files: 1 (uncommitted-only)",
	"[claude-over hand-off ovr-mq1f2k-0a1b]",
	"Send: <send-id>",
	"Approved by the user: they reviewed this hand-off in a preview.",
	"## Summary",
	"Added the greeting.",
	"## Instructions",
	"Review it.",
	"## Changed files (git, uncommitted changes only)",
	"- M greeting.txt (uncommitted)",
];

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
			const preview = HEADER.replace("Send: 3fa9c21", "Send: <send-id>");
			assert.deepEqual(findHeaders(preview), [{ bundleId: "ovr-mq1f2k-0a1b" }]);
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
			assert.equal(config.maxCost, 2);
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
		"targets: only probe-handoff-* names may be sent to",
		() => {
			assert.equal(isProbeTarget("probe-handoff-accept"), true);
			assert.equal(isProbeTarget("probe-handoff-hold"), true);
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
