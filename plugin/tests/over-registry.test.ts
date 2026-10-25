// S-03 phase 3: each session running the mod keeps one entry about itself in the shared store, so
// the panel can show repo, worktree, branch and last activity. These tests cover what the mod
// writes, when, and what it prunes; the pane that reads the entries is in over-pane.test.ts.

import { expect, test } from "claude-code/testing";
import { PRUNE_MAX_AGE_MS, registryKey } from "../hooks/registry.js";
import { entry, NOW, ROOT, SESSION_ID, START, stored, world } from "./support.js";

const turn = { answer: "", durationMs: 1, isAborted: false, reason: "answer" as const };

test("session.start records this session with its repo, branch and the name and ref from the list header", async ($, on) => {
	const seen = world(on, ["terminal"]);
	await $.session.start(START);

	expect(seen.store[registryKey(SESSION_ID)]).toEqual({
		v: 1,
		sessionId: SESSION_ID,
		name: "sender-1",
		ref: "a2f9f3",
		root: ROOT,
		repoRoot: ROOT,
		branch: "feat/x",
		lastActivityAt: NOW,
		updatedAt: NOW,
	});
});

test("a main-loop turn moves lastActivityAt with no git and no ListAgents; a subagent's turn leaves it", async ($, on) => {
	const seen = world(on, ["terminal"]);
	await $.session.start(START);
	const ranBefore = seen.ran.length;
	const listedBefore = seen.listed;
	const key = registryKey(SESSION_ID);

	await seen.clock.advance(60_000);
	await $.turn.start({ text: "go", turnId: "t1", agentId: "sub-1" });
	await $.turn.complete({ ...turn, turnId: "t1", agentId: "sub-1" });
	await seen.clock.settle();
	expect(seen.store[key]).toMatchObject({ lastActivityAt: NOW });

	await $.turn.start({ text: "go", turnId: "t2" });
	await seen.clock.settle();
	expect(seen.store[key]).toMatchObject({ lastActivityAt: NOW + 60_000 });

	await seen.clock.advance(30_000);
	await $.turn.complete({ ...turn, turnId: "t2" });
	await seen.clock.settle();
	expect(seen.store[key]).toMatchObject({
		name: "sender-1",
		ref: "a2f9f3",
		branch: "feat/x",
		lastActivityAt: NOW + 90_000,
	});
	expect(seen.ran.length).toBe(ranBefore);
	expect(seen.listed).toBe(listedBefore);
});

test("after /clear the entry is written under the session id of the event, not the one $ still reports", async ($, on) => {
	const seen = world(on, ["terminal"], { sessionId: "old-session" });
	await $.classic.SessionStart({ source: "clear", session_id: "new-session" });
	await seen.clock.settle();

	expect(seen.store[registryKey("new-session")]).toMatchObject({
		sessionId: "new-session",
		ref: "a2f9f3",
		root: ROOT,
		lastActivityAt: NOW,
	});
	expect(seen.store[registryKey("old-session")]).toBeUndefined();

	await seen.clock.advance(15_000);
	await $.turn.complete({ ...turn, turnId: "t-after-clear" });
	await seen.clock.settle();
	expect(seen.store[registryKey("new-session")]).toMatchObject({
		lastActivityAt: NOW + 15_000,
	});
	expect(seen.store[registryKey("old-session")]).toBeUndefined();
});

test("pruning drops entries untouched for over 15 days, never this session or a value it cannot read", async ($, on) => {
	const old = NOW - PRUNE_MAX_AGE_MS - 1;
	const seen = world(on, ["terminal"], {
		entries: {
			...stored(
				entry({ sessionId: "stale", updatedAt: old, lastActivityAt: old }),
				entry({ sessionId: "fresh", updatedAt: NOW - 1000 }),
				entry({ sessionId: SESSION_ID, updatedAt: old, lastActivityAt: old }),
			),
			[registryKey("junk")]: "not an entry",
			"someone-elses-key": { keep: true },
		},
	});
	await $.session.start(START);
	await seen.clock.settle();

	expect(seen.store[registryKey("stale")]).toBeUndefined();
	expect(seen.store[registryKey("fresh")]).toBeDefined();
	expect(seen.store[registryKey(SESSION_ID)]).toMatchObject({ updatedAt: NOW });
	expect(seen.store[registryKey("junk")]).toBe("not an entry");
	expect(seen.store["someone-elses-key"]).toEqual({ keep: true });
});
