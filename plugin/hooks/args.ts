export type OverArgs =
	| { kind: "compose"; intent: string; noFork: boolean }
	| { kind: "list" }
	| { kind: "send"; target: string }
	| { kind: "usage"; reason?: string };

// Flags count only as the first token, so an intent such as "send the review"
// is never mistaken for a subcommand.
export function parseOverArgs(args: string): OverArgs {
	const text = args.trim();
	if (text === "") return { kind: "usage" };

	const first = text.split(/\s+/)[0] ?? "";
	const afterFirst = text.slice(first.length).trim();

	if (!first.startsWith("--")) return { kind: "compose", intent: text, noFork: false };

	if (first === "--list") {
		return afterFirst === ""
			? { kind: "list" }
			: { kind: "usage", reason: "--list takes no arguments" };
	}
	if (first === "--send") {
		return afterFirst === ""
			? { kind: "usage", reason: "--send needs a session name" }
			: { kind: "send", target: afterFirst };
	}
	if (first === "--no-fork") {
		if (afterFirst === "") return { kind: "usage", reason: "--no-fork needs an intent" };
		if (afterFirst.startsWith("--")) {
			return { kind: "usage", reason: `unknown flag: ${afterFirst.split(/\s+/)[0]}` };
		}
		return { kind: "compose", intent: afterFirst, noFork: true };
	}
	return { kind: "usage", reason: `unknown flag: ${first}` };
}
