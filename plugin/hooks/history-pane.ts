// The "History (h)" section of the bare `/over` pane, drawn from what `readHistory` gave. Pure: no
// `$` here. The elements are not importable (a surface hands out its own table through
// `$.ui.resolve`), so the caller passes them in, and so it passes what a press should do.

import type { ElementTable, RenderElement } from "claude-code";
import { type HistoryView, historyDetail, historyRow } from "./history.js";

type Parts = Pick<ElementTable, "Box" | "Text" | "Button">;

export type HistorySectionView = {
	/** Undefined until the first read has finished. */
	history: HistoryView | undefined;
	isCollapsed: boolean;
	/** The `bundleId` whose entry is open; only one at a time. */
	openBundleId?: string;
	onToggle: () => void;
	onOpen: (bundleId: string) => void;
};

const HOTKEY = "h";
/** One indent step, in columns: the rows under the header, the detail under its row, the lists under their heading. */
const INDENT = 2;

// The same arrows as the session groups: ▶ folded, ▼ open. The count only once it is known.
function heading(view: HistorySectionView): string {
	const count = view.history?.state === "ready" ? ` (${view.history.entries.length})` : "";
	return `${view.isCollapsed ? "▶" : "▼"} History${count} (${HOTKEY})`;
}

// One line per Text, a run of `- ` lines in a Box one indent deeper: no markdown, so the indent
// is ours and a list never falls back to the left edge.
function detail(parts: Parts, text: string): RenderElement {
	const { Box, Text } = parts;
	const nodes: RenderElement[] = [];
	let items: RenderElement[] = [];
	const flush = () => {
		if (items.length === 0) return;
		nodes.push(Box({ flexDirection: "column", paddingLeft: INDENT, children: items }));
		items = [];
	};
	for (const line of text.split("\n")) {
		if (line.startsWith("- ")) {
			items.push(Text({ children: line }));
			continue;
		}
		flush();
		nodes.push(Text({ children: line }));
	}
	flush();
	return Box({ flexDirection: "column", paddingLeft: INDENT, children: nodes });
}

function body(parts: Parts, view: HistorySectionView): RenderElement[] {
	const { Text, Button } = parts;
	const history = view.history;
	if (history === undefined) return [Text({ dimColor: true, children: "Reading the history…" })];
	if (history.state === "off") {
		return [Text({ dimColor: true, children: "History is off (see /config: cc-over.history)" })];
	}
	if (history.state === "error") {
		return [Text({ color: "red", children: `could not read the history (${history.reason})` })];
	}
	if (history.entries.length === 0) {
		return [
			Text({ dimColor: true, children: "No bundles sent from this project in the last 14 days" }),
		];
	}
	return history.entries.flatMap((entry) => {
		const isOpen = entry.bundleId === view.openBundleId;
		return [
			Button({
				key: `history:${entry.bundleId}`,
				label: `${isOpen ? "▼" : "▶"} ${historyRow(entry, history.now)}`,
				onPress: () => view.onOpen(entry.bundleId),
			}),
			...(isOpen ? [detail(parts, historyDetail(entry, history.now))] : []),
		];
	});
}

/** The header button and, when it is open, the rows; the caller spreads it into the pane. */
export function historySection(parts: Parts, view: HistorySectionView): RenderElement[] {
	return [
		parts.Button({
			key: "group:history",
			label: heading(view),
			hotkey: HOTKEY,
			onPress: view.onToggle,
		}),
		...(view.isCollapsed
			? []
			: [parts.Box({ flexDirection: "column", paddingLeft: INDENT, children: body(parts, view) })]),
	];
}
