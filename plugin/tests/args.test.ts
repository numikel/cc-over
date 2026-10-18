import { expect, test } from "claude-code/testing";
import { parseOverArgs } from "../hooks/args.js";

test("plain text is a compose intent that keeps the fork", () => {
	expect(parseOverArgs("przekaż handoff do sesji impl")).toEqual({
		kind: "compose",
		intent: "przekaż handoff do sesji impl",
		noFork: false,
	});
});

test("an intent that merely starts with send or list stays a compose intent", () => {
	expect(parseOverArgs("send the review to the implementer")).toEqual({
		kind: "compose",
		intent: "send the review to the implementer",
		noFork: false,
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
	});
});

test("--list stands alone", () => {
	expect(parseOverArgs(" --list ")).toEqual({ kind: "list" });
	expect(parseOverArgs("--list extra words").kind).toBe("usage");
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

test("empty arguments are usage without a reason (bare /over belongs to S-05)", () => {
	expect(parseOverArgs("")).toEqual({ kind: "usage" });
	expect(parseOverArgs("   ")).toEqual({ kind: "usage" });
});
