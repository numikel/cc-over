# cc-over

**Hand off work between parallel Claude Code sessions with one explicit gesture: `/over <intent>`.**

[![CI](https://github.com/numikel/cc-over/actions/workflows/ci.yml/badge.svg)](https://github.com/numikel/cc-over/actions/workflows/ci.yml)
![Claude Code](https://img.shields.io/badge/Claude_Code-mod-D97757?logo=claude&logoColor=white)
![Pinned Claude Code](https://img.shields.io/badge/Claude%20Code-2.1.302-555555)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-lightgrey)

> **Status: first slice (S-01).** One hand-off to one live local session, CLI only. Broadcast, a grouped session list, a persistent status and history are planned (see [Planned](#planned)).

**Sections:**
[About](#about) · [Planned](#planned) · [Requirements](#requirements) · [Installation](#installation) · [Usage](#usage) · [Composing and cost](#composing-and-cost) · [What leaves your session](#what-leaves-your-session) · [What "passed on" means](#what-passed-on-means) · [Known platform behaviour](#known-platform-behaviour) · [Limits](#limits) · [Project structure](#project-structure) · [Development](#development) · [Continuous integration](#continuous-integration) · [Types first](#types-first-rule-for-the-mods-api) · [About this repository](#about-this-repository) · [License](#license)

---

## About

When you run several Claude Code sessions on one task, for example an implementation session and an implementation-review session, you keep passing work between them. Claude Code has cross-session messaging, but the agent rarely uses it on its own (the author's observation: roughly 2–3 out of 10 hand-off requests), and you cannot easily point at the target session.

The usual workarounds are tedious:

- Generate a file and formally instruct the agent to send it, with no easy way to say *where*.
- Copy and paste the reviewer's last answer into the other session.

Both are disorganized and routinely need more workarounds.

**The idea:** the initiative has to sit with the human, as an explicit, cheap gesture. In the session that has the context, type `/over <intent>`. The mod composes a hand-off bundle with a predictable structure, shows a preview, lets you pick one live session, and sends it after you confirm. No copy-paste between terminals.

cc-over is a [Claude Code mod](https://claude.dev/blog/getting-started-with-claude-code-mods/): a plugin built on function hooks. It has no runtime dependencies.

## Planned

Not shipped yet:

- **Broadcast.** The same gesture for coordination notices to other sessions, not only hand-overs.
- **One or many targets.** Today a hand-off goes to exactly one session.
- **A grouped session list.** With ~30 parallel sessions a flat list stops being readable, so a broadcast would pre-select only sessions in the same repo and start the other-project group collapsed.
- **A persistent status and history** of what was sent.

## Requirements

- **Claude Code** with mods support. The repository pins **2.1.302** in `plugin/.claude-code-version`; the mods API itself needs 2.1.287 or later.
- **Node.js 22** (the version CI uses) for the dev tooling.
- **OS**: Linux or Windows (both run in CI).

## Installation

From a clone:

```sh
git clone https://github.com/numikel/cc-over
cd cc-over
claude --plugin-dir plugin
```

`--plugin-dir` is relative to the current directory, so start it from the repo root. The mod has no dependencies. The Desktop app has no `--plugin-dir`; it needs a marketplace install, which is not available yet, and the Desktop app is not verified.

## Usage

| Command | What it does |
|---|---|
| `/over <intent>` | Composes a hand-off from this conversation and the repo, and opens a preview pane with the live sessions. Pick one with `1`-`9` (or click), press `s` to send, `e` to expand the full text, `r` to refresh the list, Esc or Cancel to drop it. |
| `/over --no-fork <intent>` | The same, without asking a model for a summary (see "Composing and cost"). |
| `/over --list` | Prints the sessions a hand-off can go to. |
| `/over --send <session>` | Sends the bundle composed last. The name may contain spaces; when two sessions share a name, use `name [ref]` as `--list` prints it. |

Where nothing can be drawn (`claude -p`, the SDK) the pane does not open: `/over <intent>` logs the preview, and `--list` and `--send` do what the pane buttons do.

The recipient gets a message that starts like this:

```
[claude-over hand-off ovr-...]
Send: 3fa9c21
From: <session name> · repo <repo> · branch <branch> · session <id>
Approved by the user: they reviewed this hand-off in a preview and chose to send it to you. It is not a prompt typed by the user in this session.
Handling: finish your current task first, then pick up the work below. If you are busy, add it to your task list and say so.
```

followed by Summary, Instructions, Changed files and Details. An idle recipient starts working on its own; a busy one reads the message between tool calls. The platform also shows the message in the recipient's history as coming from your session.

## Composing and cost

By default the summary comes from `$.model.fork`: one extra model call on this session's conversation, no tool use, no turn in the conversation. It uses the session's model. When the prompt cache has expired, the whole conversation prefix is billed again, so on a long conversation a fork can cost as much as a normal turn.

- `/over --no-fork <intent>` skips the model for one call.
- `/config` → `cc-over.compose` = `none` skips it for good (`fork` is the default). The bundle then holds your intent and the git data, and says "no conversation summary: none mode".
- A fork that cannot run (nothing to fork in a fresh session, API error, empty reply) falls back to the same bundle, with the reason in the Note.

The changed files are read from git, not from the model: uncommitted changes plus the branch diff against `origin/HEAD` (or `main`), or the commits of this session when you are on the base branch. The list stops at 200 entries. Where the mod cannot run `git` (the Desktop app), the model lists the files and the bundle marks them "unverified".

## What leaves your session

The bundle contains your intent, a model-written summary of this conversation, the repo name, the branch, the changed file names (not their contents), and the session id. It goes to one other local Claude Code session of yours, whose model reads it. Review the preview before pressing send: the recipient is a different conversation, possibly in a different project. A bundle is capped below 1,000,000 characters (the platform limit); an oversized one is trimmed and says so.

## What "passed on" means

`passed on to X (queued)` means the platform accepted the message for X. It does **not** mean X has read it. The mod never says "received".

Right after a send the platform may follow up with a warning in your conversation. Measured on Claude Code 2.1.302 in the CLI:

| Warning | Meaning | Pane status |
|---|---|---|
| `Cross-session message held by the receiving session (recipient: @X)` | X holds incoming messages for its user | `held` |
| `Cross-session message refused (recipient: @X)` | X does not accept messages | `not passed on` |
| `Cross-session message expired without approval (recipient: @X)` | nobody approved it, nothing is waiting in X | `expired` |
| `Cross-session message was dropped at the recipient session's inbox (recipient: @X) ...` | the same text was sent twice | `not passed on` |

The delay ranges from under a second to minutes. The pane follows them only in an interactive CLI session, only for these texts, and only for sends made by the mod. Text from another version is ignored and the status stays `passed on (queued)`. If the target is a Desktop or Remote Control session, nothing may come back at all. The status lives in the mod's memory and is lost when the mod reloads.

## Known platform behaviour

- **The sender's model wakes up.** For each such warning the platform also wakes the sender's model for one turn (about 8 s measured; the cost depends on the model). That model does not know the bundle's text and may offer to send again. The mod cannot turn this off.
- **Every send is unique.** The platform silently drops a second identical message to the same recipient. Each send therefore carries a new `Send: <id>`, while the bundle id stays the same, so sending one bundle again works.
- **A busy or waiting recipient.** A session that waits for its user (`waiting`) can be sent to, but may not read the message for a long time.
- **The sending session needs the `SendMessage` tool.** Without it the platform refuses every send and the mod says so.

## Limits

- Only live local sessions of type `interactive` are listed. Sessions started with `--bare`, WSL sessions in the Desktop app, cloud and Remote Control sessions are not.
- Sessions without a name show the directory name; `/rename` a session to recognise it.
- One target per hand-off. Broadcast, a grouped list, history and a bare `/over` panel are later slices.
- The Desktop app is not verified.

## Project structure

```text
cc-over/
├── plugin/                        # the mod (no dependencies, no node_modules imports)
│   ├── .claude-plugin/
│   │   ├── plugin.json            # manifest: name "cc-over", version 0.1.0
│   │   └── types/                 # committed mods API types, generated by Claude Code
│   ├── hooks/
│   │   ├── hooks.json             # declares the hooks module
│   │   ├── register.ts            # entry point: `register` runs once when the mod loads
│   │   └── *.ts                   # bundle, git, sessions, args and notice logic
│   ├── tests/
│   │   └── *.test.ts              # engine-level tests via claude-code/testing
│   ├── .claude-code-version       # pinned Claude Code version
│   ├── .claude-code-types.sha256  # sha256 manifest of the committed types
│   └── tsconfig.json              # extends the types' tsconfig
├── scripts/
│   ├── check-types-drift.mjs      # CLI for the types drift checks
│   ├── types-drift.mjs            # pure check functions
│   ├── check-types-drift.test.mjs # tests for the drift checks
│   └── acceptance/                # paid end-to-end delivery test (never runs in CI)
├── .github/workflows/ci.yml       # verify ladder on Linux and Windows
├── biome.json                     # lint and format config
└── package.json                   # dev tooling only
```

## Development

Install the dev tools, then run the full ladder:

```sh
npm ci
npm run verify
```

`verify` runs these gates in order:

| Script | What it does |
| --- | --- |
| `npm run drift` | Checks the committed mods types against the version pin and the sha256 manifest |
| `npm run check` | Biome lint and format check, warnings are errors |
| `npm run test:scripts` | Runs the drift script tests with `node --test` and the self-test of the acceptance script |
| `npm run validate` | `claude plugin validate --strict plugin` |
| `npm test` | `claude plugin test plugin`, the engine-level mod tests |
| `npm run typecheck` | `tsc -p plugin` |

`npm run fix` applies Biome fixes. The `validate`, `test` and `drift` (check 5) gates need `claude` on your `PATH`.

`scripts/acceptance/handoff.mjs` is a paid end-to-end test of the delivery between real processes; it never runs in CI (`--dry-run` shows the plan, the header of the file has the details).

### Regenerating the types

The types in `plugin/.claude-plugin/types/` are written by Claude Code itself. To refresh them, run from the repo root:

```sh
claude --plugin-dir plugin --strict-mcp-config
```

Then `/exit`, and refresh the manifest:

```sh
npm run drift -- --write-hashes
```

Bump `plugin/.claude-code-version` only after refreshing the types and re-reading `index.d.ts`.

## Continuous integration

`.github/workflows/ci.yml` runs `npm run verify` with no secrets, on `ubuntu-latest` and `windows-latest`, in two channels:

- **pinned**: installs the Claude Code version from `plugin/.claude-code-version`. It blocks the build on failure.
- **latest**: a drift probe against the newest Claude Code. It never fails push, PR or manual runs, and fails a scheduled run (Mondays, 06:17 UTC) only when a ladder gate breaks.

The resolved version is exported as `CLAUDE_CODE_EXPECTED_VERSION`, so the drift script asserts the installed `claude --version` and warns when the pin is behind.

## Types-first rule for the mods API

The mods API is newer than most model training data. Do not write hook calls from memory: read `plugin/.claude-plugin/types/` first and take event and method names only from there. The drift checks enforce this mechanically: they keep the types in lockstep with the pinned Claude Code version and fail when the files change without a refreshed manifest.

## About this repository

This repository is a generated mirror. The code is developed in a private repository and published here automatically by CI, so commits on `main` come from `cc-over-mirror[bot]` and carry a `Source-Commit:` line that identifies the source revision.

Please report problems and ideas as issues, not as pull requests: anything merged directly here is overwritten by the next publication.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 numikel.
