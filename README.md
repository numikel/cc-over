# cc-over

**Hand off work between parallel Claude Code sessions with one explicit gesture: `/over <intent>`.**

[![CI](https://github.com/numikel/cc-over/actions/workflows/ci.yml/badge.svg)](https://github.com/numikel/cc-over/actions/workflows/ci.yml)
![Claude Code](https://img.shields.io/badge/Claude_Code-mod-D97757?logo=claude&logoColor=white)
![Pinned Claude Code](https://img.shields.io/badge/Claude%20Code-2.1.310-555555)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-lightgrey)

> **Status: first slices (S-01 to S-07).** One hand-off to one live local session, or a short broadcast to several, with an acknowledgement coming back, picked from a session list grouped by project, a status per target that survives a mod reload, and a history of the bundles you sent. The sender runs in the CLI; any local session, Desktop included, can receive.

**Sections:**
[About](#about) · [Planned](#planned) · [Requirements](#requirements) · [Installation](#installation) · [Usage](#usage) · [The session list](#the-session-list) · [Composing and cost](#composing-and-cost) · [What leaves your session](#what-leaves-your-session) · [Sent history](#sent-history) · [Bundle format](#bundle-format) · [What "passed on" and "received" mean](#what-passed-on-and-received-mean) · [Known platform behaviour](#known-platform-behaviour) · [Limits](#limits) · [Project structure](#project-structure) · [Development](#development) · [Continuous integration](#continuous-integration) · [Types first](#types-first-rule-for-the-mods-api) · [About this repository](#about-this-repository) · [License](#license)

---

## About

When you run several Claude Code sessions on one task, for example an implementation session and an implementation-review session, you keep passing work between them. Claude Code has cross-session messaging, but the agent rarely uses it on its own (the author's observation: roughly 2–3 out of 10 hand-off requests), and you cannot easily point at the target session.

The usual workarounds are tedious:

- Generate a file and formally instruct the agent to send it, with no easy way to say *where*.
- Copy and paste the reviewer's last answer into the other session.

Both are disorganized and routinely need more workarounds.

**The idea:** the initiative has to sit with the human, as an explicit, cheap gesture. In the session that has the context, type `/over <intent>`. The mod composes a hand-off bundle with a predictable structure, shows a preview, lets you pick one live session, and sends it after you confirm. No copy-paste between terminals. The same gesture sends a short broadcast notice to several sessions at once.

cc-over is a [Claude Code mod](https://claude.dev/blog/getting-started-with-claude-code-mods/): a plugin built on function hooks. It has no runtime dependencies.

## Planned

Not shipped yet:

- **Sending again from the history**, and a history of the bundles you received.

## Requirements

- **Claude Code** with mods support. The repository pins **2.1.310** in `plugin/.claude-code-version`; the mods API itself needs 2.1.287 or later.
- **Node.js 22** (the version CI uses) for the dev tooling.
- **OS**: Linux or Windows (both run in CI).

## Installation

From a clone:

```sh
git clone https://github.com/numikel/cc-over
cd cc-over
claude --plugin-dir plugin
```

`--plugin-dir` is relative to the current directory, so start it from the repo root. The mod has no dependencies.

### From the marketplace

This repository is also a plugin marketplace named `cc-over`, with one plugin, also named `cc-over`. In Claude Code run:

```text
/plugin marketplace add numikel/cc-over
/plugin install cc-over@cc-over
/reload-plugins
```

The Desktop app has no `--plugin-dir`, so it uses the marketplace install. Desktop as a sender is not verified yet. A Desktop session as a recipient needs no install and was verified on 2026-10-19: it picked the hand-off up and acknowledged it.

## Usage

| Command | What it does |
|---|---|
| `/over` | Opens the pane with the live sessions and an intent field. Type the intent and press Enter to compose; from there it works as `/over <intent>`. To change the intent, cancel and run `/over` again. The `Type (y)` switch is next to the intent field. Under the sessions, a folded **History (h)** section lists the bundles sent from this project (see "Sent history"); `h` opens it and a click on a row opens that bundle's summary, instructions and files. |
| `/over <intent>` | Composes a hand-off from this conversation and the repo, and opens a preview pane with the live sessions. Pick one with `1`-`9` (or click), press `s` to send, `y` to switch the type to a broadcast, `e` to expand the full text, `r` to refresh the list, `t` and `o` to fold "This project" and "Other sessions", Esc or Cancel to drop it. |
| `/over --no-fork <intent>` | The same, without asking a model for a summary (see "Composing and cost"). |
| `/over --broadcast <intent>` | Composes a broadcast: a short notice that holds your intent word for word and its source, with no summary, no files and no model call. The preview opens with the type already set to broadcast (see "Hand-off or broadcast"). |
| `/over --list` | Prints the sessions a hand-off can go to, in the same groups as the pane, all unfolded. |
| `/over --send <session>` | Sends the bundle composed last, hand-off or broadcast, to one more session. Run it once per target to send one bundle to several sessions. The name may contain spaces; when two sessions share a name, use `name [ref]` as `--list` prints it. The bundle lives in the mod's memory: after a mod reload or in a new process, compose it again. |
| `/over --send-repo` | Sends the broadcast composed last to every other session of this repository (the "This project" group). A session that already has a send of this bundle is skipped (`already sent to <name>`). It refuses a hand-off: compose a broadcast with `--broadcast` first. |
| `/over --status` | Prints the sends of this session, grouped by bundle: a `HH:MM <intent>` heading (`HH:MM broadcast: <intent>` for a broadcast) and one status line per target under it (see "What passed on and received mean"). |
| `/over --history [n]` | Prints the bundles sent from this project in the last 14 days, newest first, one numbered row each. With a number from 1 to 50 it prints that entry in full: intent, place, targets with their status, summary, instructions and files. It is the same list as the pane's History section (see "Sent history"). |

Where nothing can be drawn (`claude -p`, the SDK) the pane does not open: `/over <intent>` and `/over --broadcast <intent>` log the preview, and `--list`, `--send`, `--send-repo`, `--status` and `--history` do what the pane shows and its buttons do. A bare `/over` prints the usage line.

### Hand-off or broadcast

A bundle has a type. A **hand-off** asks one session to pick up work and is the default. A **broadcast** is a notice for several sessions: it says what you said, in your words, and asks the recipients to take note and carry on, not to start work because of it. The type is never guessed from your intent: it is a hand-off until you change it, either with the `Type: hand-off (y)` button next to the intent field (press `y`) or by starting with `/over --broadcast <intent>`. The switch works while you type the intent, while the bundle is composing and in the preview. A broadcast is composed at once from your intent: it does not call the model and it does not attach a git summary. The From line still reads the branch name with one git call.

In broadcast mode the session rows are toggles (`●` selected, `○` not) instead of a single choice, and the send button names what it will do, for example `Send to 2 sessions: impl, repo-a | review (s)` (it lists at most three names and then `…`). The sessions of this project are ticked once, when you switch to a broadcast (or open one with `--broadcast`) and the list is first loaded; a refresh afterwards only removes sessions that have closed and never ticks a new one. Sessions of other projects, and sessions without the mod, are never ticked for you. Before sending, each ticked session is checked again by its reference: if one has closed, or another session has taken its name, nothing is sent and the pane says which. Switching back to a hand-off keeps the selection only when it holds one session; otherwise you pick one again. The sends go one after the other, and the toast reports `broadcast passed on to <k> of <n> sessions`.

The recipient gets a message that starts like this:

```
[claude-over hand-off ovr-...]
Send: 3fa9c21
From: <session name> · repo <repo> · branch <branch> · session <id>
Approved by the user: they reviewed this hand-off in a preview and chose to send it to you. It is not a prompt typed by the user in this session.
Handling: finish your current task first, then pick up the work below. If you do not pick it up, tell your user why. Leave any step that needs your user's permission (such as a commit) for them to confirm, and do the rest.
Acknowledge now, before anything else: call the SendMessage tool with `to` set to the exact value of the `from` attribute of the cross-session-message envelope around this text, and `message` set to `over-ack ovr-... 3fa9c21`. This single call does not interrupt your current task; carry on with it afterwards.
```

followed by Summary, Instructions, Changed files and Details (see "Bundle format"). An idle recipient starts working on its own; a busy one reads the message between tool calls, acknowledges, finishes its task and then picks the work up. The platform also shows the message in the recipient's history as coming from your session. The recipient needs no mod: everything it has to do is in the text.

## The session list

The pane groups the live local sessions:

```
From the platform's session list; details only from sessions running cc-over. Some sessions are not listed (see README). hidden: 1 (not local)
▼ This project: my-repo (t)
  ├─ ○ impl · main · idle · 2m ago (1)
  └─ ○ review · my-worktree (feat/foo) · busy · 5s ago (2)
▶ Other sessions: 6 (o)
```

- **This project** holds the sessions that run in the same repository as the sender, worktrees included. Each row shows the session name, the branch (or `worktree (branch)`), the status and the time of its last turn.
- **Other sessions** starts folded on every new preview. Unfolded, it lists the other repositories alphabetically, each with its sessions, and at the end `no details (mod not running there)`.
- `t` and `o` fold the groups, `1`-`9` number the rows that are visible, so the numbers shift when a group is folded. The selected session stays selected when its group is folded.
- The list refreshes when the pane opens, on `r`, and every 10 seconds while the pane is open.

The platform's session list says only who is alive, with a name and a status. The repository, the branch and the last activity come from a small registry: every session that runs cc-over writes an entry about itself to the plugin's shared store (`session:<session id>`: root directory, repository, branch, name and the time of its last turn; no conversation text and no bundle: what you sent is kept apart, see "Sent history"). A session without the mod has no entry, so it lands under `no details` with the `started … ago` time from the platform's listing. The mod does not read the platform's own session files or transcripts. Entries untouched for 15 days, and the oldest ones above 3 MiB of store, are pruned, never the current session's.

The "last activity" is the end of the session's last turn: an idle session writes nothing in the background.

## Composing and cost

By default the summary comes from `$.model.fork`: one extra model call on this session's conversation, no tool use, no turn in the conversation. It uses the session's model. When the prompt cache has expired, the whole conversation prefix is billed again, so on a long conversation a fork can cost as much as a normal turn.

- `/over --no-fork <intent>` skips the model for one call.
- `/config` → `cc-over.compose` = `none` skips it for good (`fork` is the default). The bundle then holds your intent and the git data, and says "no conversation summary: none mode".
- A fork that cannot run (nothing to fork in a fresh session, API error, empty reply) falls back to the same bundle, with the reason in the Note.

The changed files are read from git, not from the model: uncommitted changes plus the branch diff against `origin/HEAD` (or `main`), or the commits of this session when you are on the base branch. The list stops at 200 entries. Where the mod cannot run `git` (the Desktop app), the model lists the files and the bundle marks them "unverified".

## What leaves your session

A hand-off contains your intent, a model-written summary of this conversation, the repo name, the branch, the changed file names (not their contents), and the session id. A broadcast contains only your intent, the repo name, the branch and the session id. A hand-off goes to one other local Claude Code session of yours, a broadcast to as many as you tick, and the model of each recipient reads it. Review the preview before pressing send: the recipients are different conversations, possibly in different projects. A bundle is capped below 1,000,000 characters (the platform limit); an oversized one is trimmed and says so. A preview of each bundle you send also stays in the plugin's store on this machine: see "Sent history", which says what is kept and how to turn it off.

## Sent history

Every bundle you send leaves a preview in the plugin's shared store, under `history:<session id>` (the session the bundle was sent from; after `/clear` that key keeps the old id). The history is read per project: bare `/over` shows it under **History (h)**, and `/over --history [n]` prints it where nothing can be drawn.

- **Kept:** the intent (cut to 500 characters), the summary and the instructions (1,000 each), the names of up to 30 changed files (a path longer than 120 characters loses its beginning, so the file name stays), the repository name, the branch, the project's directory, up to 20 targets with their status, its reason and times, and the time of the send.
- **Not kept:** the Details section, diffs, file contents, the source session's id and the full text of the bundle.
- **Limits:** 50 bundles per session and 14 days (counted from the newest send of the bundle), and at most 8,000 characters per entry: a field that does not fit is shortened, files first, then the instructions and the summary. The oldest entries go first. The store as a whole is pruned as described above (15 days untouched, 3 MiB), never the current session's.
- **The view:** the bundles of this project from all of its sessions, so a bundle sent before `/clear` or from another session of the same repository is there too, newest first, at most 50. A bundle sent again, also after `/clear`, is one row with all its targets. A target's status follows the same warnings and acknowledgements as `/over --status`, as long as the sending session still tracks the send; after `/clear` it keeps the status it had.
- **Turning it off:** `/config` → `cc-over.history` = off. Nothing new is saved or listed, and a status change is not written. Entries that are already saved are not deleted: they age out with the pruning above.

## Bundle format

Every bundle starts with the same six lines. A broadcast differs from a hand-off in line 1 (`broadcast` instead of `hand-off`), in one word of line 4 (the type it names), and in line 5, the Handling text: a hand-off asks the recipient to pick up the work, a broadcast says it is a notice, not a task.

1. `[claude-over <hand-off|broadcast> <bundle-id>]`
2. `Send: <send-id>`: new for every send; the bundle id stays the same
3. `From: <name> · repo <repo> · branch <branch> · session <session-id>`
4. `Approved by the user: …`
5. `Handling: …`: what the recipient does with the work; the text depends on the type
6. the acknowledgement line: asks the recipient to send `over-ack <bundle-id> <send-id>` back to the `from` address of the envelope

After the header, a hand-off has the sections Summary, Instructions, Changed files and Details. A broadcast has one section instead, `## Message`, which holds your intent word for word.

## What "passed on" and "received" mean

`passed on to X (queued)` means the platform accepted the message for X. It does **not** mean X has read it. The mod says `received by X (acknowledged)` only when X has sent the acknowledgement from line 6 back, and an acknowledgement means "received", not "done". It is best-effort: a recipient may not send it (for example when its own instructions say to ignore incoming messages), and its absence is not an error. The mod takes an exact acknowledgement for its own send without a model turn; a reply with a note added, and every other reply, still reaches your session's model as an ordinary message.

Right after a send the platform may follow up with a warning in your conversation. The `held`, `refused`, `expired` and `dropped` texts were measured on Claude Code 2.1.302 in the CLI, the `released` and `denied` texts on 2.1.310:

| Warning | Meaning | Status |
|---|---|---|
| `Cross-session message held by the receiving session (recipient: @X)` | X holds incoming messages for its user | `held` |
| `Cross-session message released after approval (recipient: @X)` | X's user approved a held message | `passed on to X (approved by the recipient, queued)` |
| `Cross-session message denied (recipient: @X)` | X's user declined a held message | `not passed on to X: the recipient's user declined it` |
| `Cross-session message refused (recipient: @X)` | X does not accept messages | `not passed on` |
| `Cross-session message expired without approval (recipient: @X)` | nobody approved it, nothing is waiting in X | `expired` |
| `Cross-session message was dropped at the recipient session's inbox (recipient: @X) ...` | the same text was sent twice | `not passed on` |
| an `over-ack <bundle-id> <send-id>` reply from X (not a platform warning) | X has acknowledged this send | `received by X (acknowledged)` |

The platform may also report several messages in one line, for example `Cross-session messages (2) expired without approval (recipients: @X, @Y)`; each named target is updated. When two sends to one name are still open, the newest is updated and the line says that it is unclear which one is meant.

The delay ranges from under a second to minutes. The status follows the platform warnings only in an interactive CLI session, only for these texts, and only for sends made by the mod. Text from another version is ignored and the status stays `passed on (queued)`. If the target is a Desktop or Remote Control session, no warning may come back; an acknowledgement can (verified from a Desktop recipient), and the mod takes it in any session, `-p` included.

A `held` send can be settled much later, and the outcome may never reach your session (for example when the recipient closes). After 10 minutes without news the status line says so: `held: X has not seen it yet, waiting for the recipient's approval (no news since HH:MM; a later outcome may not reach this session)`. The mod never guesses `expired` from the time that has passed.

**Where to see it.** After a send the pane shows one line per send of this bundle, updated on every change, and each change also shows as a toast and a line in your conversation. `/over --status` prints every send of this session, also in `claude -p`.

**Kept across reloads.** Each send is saved in the plugin's shared store under `sends:<session id>`: the bundle id, the send id, the target's name, the intent cut to 60 characters, the status, its reason and two times; never the bundle text (a preview of the bundle is kept separately, see "Sent history"). The last 50 sends of a session are kept. After the mod reloads, a late warning or acknowledgement still updates the saved send, and `/over --status` still lists it. Entries are pruned together with the session registry (15 days, 3 MiB), never the current session's.

## Known platform behaviour

- **The sender's model wakes up.** For each such warning the platform also wakes the sender's model for one turn (about 8 s measured; the cost depends on the model). That model does not know the bundle's text and may offer to send again. The mod cannot turn this off.
- **Every send is unique.** The platform silently drops a second identical message to the same recipient. Each send therefore carries a new `Send: <id>`, while the bundle id stays the same, so sending one bundle again works.
- **Two kinds of "held".** A recipient whose permission mode differs from the sender's asks its user to deliver or deny the message; unanswered, it expires after the recipient's `dialogExpiry` (5 minutes by default). A recipient set to hold every message (`crossSessionInbound: hold`) asks nothing and keeps it until it exits. The sender cannot tell the two apart, which is why the mod never turns a long `held` into `expired`.
- **A busy or waiting recipient.** A session that waits for its user (`waiting`) can be sent to, but may not read the message for a long time.
- **The sending session needs the `SendMessage` tool.** Without it the platform refuses every send and the mod says so.

## Limits

- Only live local sessions of type `interactive` are listed. Not listed (measured): `--bare` sessions. Not listed, per the documentation: WSL sessions in the Desktop app, cloud sessions, Remote Control sessions and sessions on other machines.
- Details (repository, branch, last activity) come only from sessions running cc-over. Other sessions are listed under `no details`.
- Sessions without a name show the directory name; `/rename` a session to recognise it.
- A hand-off goes to one session; a broadcast goes to as many as you tick.
- The history lists what you sent, not what you received, and a bundle cannot be sent again from it yet. It holds at most 50 bundles per session, 14 days and 8,000 characters per entry (see "Sent history").
- The delivery warning may list only some names. When the platform reports a warning for several recipients at once, it can name only the first few of them, so after a large broadcast some recipients may keep the status `passed on (queued)` although a warning concerned them.
- Several sends to the same session name share one warning match. A warning counts the messages but names the session once, so only one of those sends changes status. `/over --send-repo` also skips by session name, so a second session with the same name as one already sent to is skipped too.
- Switching a draft from a hand-off to a broadcast after `/over --send` keeps the same bundle. `/over --send-repo` then skips a session that already received it, and `/over --status` titles the group from that first send.
- The Desktop app is not verified as a sender. As a recipient it works (verified 2026-10-19): the acknowledgement came back to a CLI sender, while the warnings of the table above may not.

## Project structure

```text
cc-over/
├── .claude-plugin/
│   └── marketplace.json           # plugin marketplace "cc-over", points at ./plugin
├── plugin/                        # the mod (no dependencies, no node_modules imports)
│   ├── .claude-plugin/
│   │   ├── plugin.json            # manifest: name "cc-over", version 0.2.0
│   │   └── types/                 # committed mods API types, generated by Claude Code
│   ├── hooks/
│   │   ├── hooks.json             # declares the hooks module
│   │   ├── register.ts            # entry point: `register` runs once when the mod loads
│   │   └── *.ts                   # bundle, git, sessions, registry, groups, args, notice, ack, sendlog, history.ts, and the pane section history-pane.ts
│   ├── tests/
│   │   └── *.test.ts              # engine-level tests via claude-code/testing, including history.test.ts, over-history.test.ts and over-pane-history.test.ts
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
| `npm run validate` | `claude plugin validate --strict` on `plugin` and on the marketplace file in the repo root |
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
