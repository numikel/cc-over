import { expect, test } from "claude-code/testing";
import { intentFromField, parseOverArgs } from "../hooks/args.js";

test("plain text is a compose intent that keeps the fork", () => {
	expect(parseOverArgs("przekaż handoff do sesji impl")).toEqual({
		kind: "compose",
		intent: "przekaż handoff do sesji impl",
		noFork: false,
		bundleKind: "hand-off",
	});
});

test("an intent that merely starts with send or list stays a compose intent", () => {
	expect(parseOverArgs("send the review to the implementer")).toEqual({
		kind: "compose",
		intent: "send the review to the implementer",
		noFork: false,
		bundleKind: "hand-off",
	});
	expect(parseOverArgs("list open risks for the other session")).toMatchObject({
		kind: "compose",
	});
});

test("--no-fork combines with the intent that follows it", () => {
	expect(parseOverArgs("--no-fork  hand off the work ")).toEqual({
		kind: "compose",
		intent: "hand off the work",
		noFork: true,
		bundleKind: "hand-off",
	});
});

test("--broadcast composes a broadcast bundle that keeps the fork", () => {
	expect(parseOverArgs("--broadcast  tell everyone the build is frozen ")).toEqual({
		kind: "compose",
		intent: "tell everyone the build is frozen",
		noFork: false,
		bundleKind: "broadcast",
	});
});

test("--broadcast without an intent, or followed by another flag, is a usage error", () => {
	expect(parseOverArgs("--broadcast")).toEqual({
		kind: "usage",
		reason: "--broadcast needs an intent",
	});
	expect(parseOverArgs("--broadcast   ")).toEqual({
		kind: "usage",
		reason: "--broadcast needs an intent",
	});
	expect(parseOverArgs("--broadcast --no-fork freeze")).toEqual({
		kind: "usage",
		reason: "unknown flag: --no-fork",
	});
	expect(parseOverArgs("--no-fork --broadcast freeze")).toEqual({
		kind: "usage",
		reason: "unknown flag: --broadcast",
	});
});

test("--broadcast counts as a flag only as the first token and only when spelled exactly", () => {
	expect(parseOverArgs("tell them --broadcast")).toEqual({
		kind: "compose",
		intent: "tell them --broadcast",
		noFork: false,
		bundleKind: "hand-off",
	});
	expect(parseOverArgs("--broadcasts freeze").kind).toBe("usage");
});

test("--send-repo stands alone", () => {
	expect(parseOverArgs(" --send-repo ")).toEqual({ kind: "send-repo" });
	expect(parseOverArgs("--send-repo")).toEqual({ kind: "send-repo" });
});

test("--send-repo takes no arguments", () => {
	expect(parseOverArgs("--send-repo impl")).toEqual({
		kind: "usage",
		reason: "--send-repo takes no arguments",
	});
	expect(parseOverArgs("--send-repo --list")).toEqual({
		kind: "usage",
		reason: "--send-repo takes no arguments",
	});
	expect(parseOverArgs("--send-repos").kind).toBe("usage");
});

test("--list stands alone", () => {
	expect(parseOverArgs(" --list ")).toEqual({ kind: "list" });
	expect(parseOverArgs("--list extra words").kind).toBe("usage");
});

test("--status stands alone and reports the sends of this session", () => {
	expect(parseOverArgs(" --status ")).toEqual({ kind: "status" });
	expect(parseOverArgs("--status x")).toEqual({
		kind: "usage",
		reason: "--status takes no arguments",
	});
	expect(parseOverArgs("--statuses").kind).toBe("usage");
});

test("--history alone lists the entries, with a number it opens one", () => {
	expect(parseOverArgs(" --history ")).toEqual({ kind: "history" });
	expect(parseOverArgs("--history 3")).toEqual({ kind: "history", index: 3 });
	expect(parseOverArgs("--history   50 ")).toEqual({ kind: "history", index: 50 });
	expect(parseOverArgs("--history 1")).toEqual({ kind: "history", index: 1 });
});

test("--history rejects anything but an entry number from 1 to 50", () => {
	for (const args of [
		"--history 0",
		"--history 51",
		"--history x",
		"--history 2 3",
		"--history -1",
		"--history 03",
		"--history 1.5",
		"--history 1e1",
		"--history 0x3",
	]) {
		expect(parseOverArgs(args)).toEqual({
			kind: "usage",
			reason: "--history takes an entry number (1-50)",
		});
	}
});

test("an intent that merely starts with history, and --histories, are not --history", () => {
	expect(parseOverArgs("history of the change")).toEqual({
		kind: "compose",
		intent: "history of the change",
		noFork: false,
		bundleKind: "hand-off",
	});
	expect(parseOverArgs("--histories").kind).toBe("usage");
});

test("--send takes the rest as the target, spaces and pipes included", () => {
	expect(parseOverArgs("--send repo-a | impl | feature-x")).toEqual({
		kind: "send",
		target: "repo-a | impl | feature-x",
	});
	expect(parseOverArgs("--send   alpha-1 [c03940] ")).toEqual({
		kind: "send",
		target: "alpha-1 [c03940]",
	});
});

test("--send without a target, an unknown flag and a flag-only --no-fork are usage errors", () => {
	for (const args of ["--send", "--send   ", "--bogus x", "--no-fork", "--no-fork --list"]) {
		const parsed = parseOverArgs(args);
		expect(parsed.kind).toBe("usage");
		if (parsed.kind === "usage") expect(parsed.reason).toBeTruthy();
	}
});

test("a flag glued to more letters is not that flag", () => {
	expect(parseOverArgs("--listing").kind).toBe("usage");
	expect(parseOverArgs("--sender bob").kind).toBe("usage");
});

test("empty or blank arguments open the pane", () => {
	expect(parseOverArgs("")).toEqual({ kind: "panel" });
	expect(parseOverArgs("   ")).toEqual({ kind: "panel" });
	expect(parseOverArgs(" \t ")).toEqual({ kind: "panel" });
});

test("intentFromField trims the field value into an intent", () => {
	expect(intentFromField("  hand over  ")).toBe("hand over");
	expect(intentFromField("a\nb")).toBe("a\nb");
});

test("intentFromField returns undefined for an empty or blank field", () => {
	expect(intentFromField("")).toBeUndefined();
	expect(intentFromField("  \t ")).toBeUndefined();
});

test("intentFromField does not parse flags", () => {
	expect(intentFromField("--list")).toBe("--list");
});
