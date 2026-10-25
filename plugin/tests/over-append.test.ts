// S-01 phase 3: the platform's delivery warnings (held, refused, expired) arrive in the sender's
// conversation as `session.append` rows with door `notice`; the mod matches them to its own sends
// and updates the status. It only observes: every row goes on, whatever it says.

import { expect, mock, test } from "claude-code/testing";
import {
	expiredText,
	heldText,
	noticeRow,
	over,
	pluralText,
	refusedText,
	START,
	world,
} from "./support.js";

const MINUTE = 60_000;

test("a held warning after a send turns the status into held, says so, and the row goes on", async ($, on) => {
	const seen = world(on, []);
	const session = mock.session(on);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	expect(seen.toasts).toEqual([]);

	const stored = await $.session.append(noticeRow(heldText("impl")));
	expect(stored.deny).toBeUndefined();
	expect(session.appended()).toHaveLength(1);
	expect(seen.toasts).toHaveLength(1);
	expect(seen.toasts[0]).toContain("held: impl");
	expect(seen.logs.at(-1)).toContain("held: impl");
	// "Delivered" is not "received": the wording stays on the sender's side of the queue.
	expect(seen.toasts[0]).not.toMatch(/received/);
});

test("refused settles the send as not passed on, and a late held does not reopen it", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");

	await $.session.append(noticeRow(refusedText("impl"), "informational", "r1"));
	expect(seen.toasts).toEqual([
		"not passed on to impl: the recipient refuses cross-session messages",
	]);

	await $.session.append(noticeRow(heldText("impl"), "informational", "r2"));
	await $.session.append(noticeRow(expiredText("impl"), "informational", "r3"));
	expect(seen.toasts).toHaveLength(1);
});

test("held, then expired: the send ends as expired", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await $.session.append(noticeRow(heldText("impl"), "informational", "r1"));
	await $.session.append(noticeRow(expiredText("impl"), "informational", "r2"));
	expect(seen.toasts).toHaveLength(2);
	expect(seen.toasts[1]).toContain("expired: impl");
});

test("rows that are not a warning for one of our sends change nothing and still go on", async ($, on) => {
	const seen = world(on, []);
	const session = mock.session(on);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	const logsBefore = seen.logs.length;

	await $.session.append(noticeRow(heldText("somebody-else"), "informational", "a"));
	await $.session.append(noticeRow("", "turn_duration", "b"));
	await $.session.append(
		noticeRow(
			"Cross-session message released by the user (recipient: @impl).",
			"informational",
			"c",
		),
	);
	await $.session.append(noticeRow("worker finished", "informational", "d"));
	// The mod's own log line comes back as a row, led by the plugin's name: it must not be read as a warning.
	await $.session.append(noticeRow(`cc-over: ${heldText("impl")}`, "informational", "e"));
	await $.session.append(noticeRow(`cc-over: ${seen.logs.at(-1)}`, "informational", "f"));

	expect(session.appended()).toHaveLength(6);
	expect(seen.toasts).toEqual([]);
	expect(seen.logs).toHaveLength(logsBefore);
});

test("a warning for a send older than the match window is not attributed to it", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await seen.clock.advance(31 * MINUTE);
	await $.session.append(noticeRow(heldText("impl")));
	expect(seen.toasts).toEqual([]);
});

test("two open sends to one name: the newest is chosen and the status says it is a guess", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "hand over");
	await over($, "--send impl");
	await over($, "--send impl");
	await $.session.append(noticeRow(heldText("impl")));
	expect(seen.toasts).toHaveLength(1);
	expect(seen.toasts[0]).toContain("several sessions share this name");
});

test("one held line naming two targets of the same name changes both of their records", async ($, on) => {
	const seen = world(on, []);
	await $.session.start(START);
	await over($, "--broadcast heads-up");
	await over($, "--send impl");
	await over($, "--send impl");

	await $.session.append(noticeRow(pluralText("held", ["impl", "impl"])));
	// One record each, not the newest twice: both turn `held`, and nobody is left `passed on`.
	expect(seen.toasts).toHaveLength(2);
	seen.logs.length = 0;
	await over($, "--status");
	expect(seen.logs.slice(-2)).toEqual([
		expect.stringMatching(/^ {2}held: impl has not seen it yet/),
		expect.stringMatching(/^ {2}held: impl has not seen it yet/),
	]);
});
