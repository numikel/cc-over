import type { BundleKind } from "./bundle.js";

export type OverArgs =
	| { kind: "compose"; intent: string; noFork: boolean; bundleKind: BundleKind }
	| { kind: "list" }
	| { kind: "send"; target: string }
	| { kind: "send-repo" }
	| { kind: "panel" }
	| { kind: "status" }
	| { kind: "history"; index?: number }
	| { kind: "usage"; reason?: string };

// The pane's intent field is one line of free text, so flags are not parsed.
export function intentFromField(value: string): string | undefined {
	const text = value.trim();
	return text === "" ? undefined : text;
}

// Flags count only as the first token, so an intent such as "send the review"
// is never mistaken for a subcommand.
export function parseOverArgs(args: string): OverArgs {
	const text = args.trim();
	if (text === "") return { kind: "panel" };

	const first = text.split(/\s+/)[0] ?? "";
	const afterFirst = text.slice(first.length).trim();

	if (!first.startsWith("--")) {
		return { kind: "compose", intent: text, noFork: false, bundleKind: "hand-off" };
	}

	if (first === "--list") {
		return afterFirst === ""
			? { kind: "list" }
			: { kind: "usage", reason: "--list takes no arguments" };
	}
	if (first === "--status") {
		return afterFirst === ""
			? { kind: "status" }
			: { kind: "usage", reason: "--status takes no arguments" };
	}
	if (first === "--history") {
		if (afterFirst === "") return { kind: "history" };
		// Digits only, 1-50: `Number()` would also take "0x3", "1e1" and " 3".
		return /^[1-9]\d?$/.test(afterFirst) && Number(afterFirst) <= 50
			? { kind: "history", index: Number(afterFirst) }
			: { kind: "usage", reason: "--history takes an entry number (1-50)" };
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
		return { kind: "compose", intent: afterFirst, noFork: true, bundleKind: "hand-off" };
	}
	if (first === "--broadcast") {
		if (afterFirst === "") return { kind: "usage", reason: "--broadcast needs an intent" };
		if (afterFirst.startsWith("--")) {
			return { kind: "usage", reason: `unknown flag: ${afterFirst.split(/\s+/)[0]}` };
		}
		return { kind: "compose", intent: afterFirst, noFork: false, bundleKind: "broadcast" };
	}
	if (first === "--send-repo") {
		return afterFirst === ""
			? { kind: "send-repo" }
			: { kind: "usage", reason: "--send-repo takes no arguments" };
	}
	return { kind: "usage", reason: `unknown flag: ${first}` };
}
