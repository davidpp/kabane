# Getting started

Kabane is a local-first issue tracker and kanban for you and your coding agents. You work in
a terminal board; Claude Code, Codex and Gemini CLI read and write the same tasks through an
MCP server running on your machine. Everything lives in one SQLite file under `~/.kabane`.

This guide covers one machine with local storage, which is a complete setup on its own.
Syncing several machines through a Cloudflare hub is optional and lives in
[`deploy.md`](deploy.md).

## Prerequisites

- **Bun 1.4.4 or later** only to build an extension or run kabane from source, the version the
  repo pins in `.bun-version`. A release binary carries its own Bun.
- **git**, for detecting project scopes. You do not need to clone Kabane for local use.
- **Optional: a coding harness.** Claude Code, Codex or Gemini CLI on your PATH, logged in.
  Setup wires any it finds, and the board's copilot runs one.

## Install

Install kabane one of these ways. Each installs the standalone binary from
[GitHub Releases](https://github.com/davidpp/kabane/releases), which carries its own Bun.

```bash
brew install davidpp/tap/kabane                  # Homebrew (recommended)
curl -fsSL https://github.com/davidpp/kabane/releases/latest/download/install.sh | sh
mise use -g github:davidpp/kabane                # mise's GitHub backend
kabane --help | head -1
```

The last line prints `kabane — local-first tracker for humans and agent runtimes`. If it
prints `command not found` instead, add the directory the install used to your PATH:
`$(brew --prefix)/bin`, or `~/.local/bin` for the installer (it says so when it is missing).
Install before setup registers coding agents: their MCP entries point at the
installed file. A Homebrew install registers `$(brew --prefix)/bin/kabane`, which
`brew upgrade` keeps. To work on Kabane itself from source, use the
[clone and `bun link` path](../README.md#install).

Homebrew installs stable releases only. For a beta, run that release's installer,
`curl -fsSL https://github.com/davidpp/kabane/releases/download/vX.Y.Z-beta.N/install.sh | sh -s -- --version X.Y.Z-beta.N`,
or use `mise use -g github:davidpp/kabane@X.Y.Z-beta.N`. A beta updates along its own channel
([beta installs](#beta-installs)).

The README's [install section](../README.md#install) says what the installer and mise check
and how to install a release archive by hand. Binaries cover macOS arm64/x64 and Linux
arm64/x64 with glibc; Linux x64 uses Bun's baseline CPU target. git and your chosen harness's
runtime requirements still apply.

### Moving from a Bun install

`1.0.0-beta.0` and earlier were published to npm, and `bun add -g kabane` installed them. Later
releases are on GitHub only, so a Bun install gets no newer release, and `kabane update` on it
says so and prints the commands below. Move to one of the installs above:

```bash
brew install davidpp/tap/kabane    # or the curl installer above
bun remove -g kabane
kabane --version                   # the new install, from its own directory
kabane mcp install --force         # point your coding agents' MCP entries at it
```

Your tracker in `~/.kabane` stays as it is. Extensions you built and installed under
`KABANE_HOME/extensions` stay too; rebuild them from the tag of the release you installed
([extensions](extensions.md#build-them-from-a-kabane-checkout)).

## Run `kabane`

Run `kabane` from inside a project you want to track. The first run opens on one card
about what kabane is, under a `kabane` wordmark (the bold word on a pane narrower than 31
columns). Enter moves on to the setup screen; esc quits without writing anything. The form
and what enter will change each sit on a raised panel, the focused row highlighted across
it:

```
kabane · setup

› name   alex
         signs what you write

  agents [x] Claude Code
         [x] Codex
         [x] Gemini CLI
         checked ones get kabane's tools

  enter  saves ~/.kabane/config.json
         adds kabane to 3 agents
         files one issue for claude
         opens the board

space toggle · enter confirm · esc quit
```

- **name** is prefilled with your OS username. It becomes your actor, the identity stamped
  on everything you write: `kabane://actor/human/<name>`, lowercased with spaces as dashes.
- **agents** lists the harnesses found on your PATH, all checked. Tab or the arrow keys
  move between rows, and space unchecks one. Each checked harness gets a `kabane` entry in
  its user-level MCP config (its own `mcp add`). With none on your PATH the row reads
  `none found on PATH`; install one, then run `kabane mcp install`. With `KABANE_HARNESSES`
  set and nothing it names on your PATH, the row reads `install off` instead (that is what
  `bun run sandbox` shows).
- **extensions** lists the [extensions](extensions.md) that come with a release install (the
  standalone binary from Homebrew, mise or the installer): `dispatch`, `jobs` and `loop`,
  each with what it adds, cut to one line until its row has focus. None is checked; space
  checks the ones you want on, and enter adds them to `extensions` and links each into
  `~/.kabane/extensions/`. Run from a source checkout, kabane ships none, and the section is
  not there.
- The lines under **enter** follow the form: uncheck every agent and the `adds` and
  `files` lines go, and a checked extension adds a `turns on` line. Outside a project, there
  is no `files` line. A long config path is cut
  from the left, `…/.kabane/config.json`, to fit the pane.

The screen does not ask for a device name: setup saves the short hostname. It only matters
once sync is set up, and [deploy.md](deploy.md) says how to change it before the first push.
To change your name later, edit `actor` in `~/.kabane/config.json`; to add an agent later,
run `kabane mcp install`; to turn on an extension later, see
[extensions.md](extensions.md#turn-on-the-ones-that-came-with-kabane).

Enter saves the config, adds kabane to each checked harness, turns on the checked extensions
and files your first issue. What happened and the first issue each get a panel, with the
phrase to say highlighted. Each extension turned on has a row with its first step:

```
✓ saved ~/.kabane/config.json

Claude Code    ✓ installed
Codex          ✓ installed
Gemini CLI     ✓ installed

dispatch tab, then /setup-dispatch
jobs     tab, then "schedule a job"
loop     press a on an issue to run it

✓ filed WIDG-1 for claude
  Add kabane to CLAUDE.md

next: in a new claude session here,
say "take the next kabane issue" and
watch WIDG-1 move on the board.
```

A failed install shows the last line of the harness's error under its row; `kabane mcp
install` prints the whole of it. The first issue goes to the first agent whose install
landed, as a `next` issue assigned to it. Its brief is the tracker block from
[Agents](#agents) below, with the ask to add it to the harness's instruction file
(`CLAUDE.md`, `AGENTS.md` or `GEMINI.md`) at the project root. The agent works it the way
the block says, so you watch its first pass through the tracker on the board. It has to be
a new session, because a harness loads its MCP servers when a session starts. Enter again
opens the board. With no agent and no extension checked, enter opens the board straight
away. Esc on the
setup screen, before confirming, leaves without writing anything. After this, `kabane`
always opens the board directly.

What setup changed outside `~/.kabane`: one user-scope MCP entry named `kabane` in each
checked harness, added through that harness's own `mcp add`:

| Harness | File | Entry runs |
|---|---|---|
| Claude Code | `~/.claude.json` | `<bun> <installed kabane bin> mcp --as kabane://actor/agent/claude` |
| Codex | `~/.codex/config.toml` | the same, `--as kabane://actor/agent/codex` |
| Gemini CLI | `~/.gemini/settings.json` | the same, `--as kabane://actor/agent/gemini` |

A harness that already has a `kabane` entry shows `· already installed` and is left alone.
`codex mcp add` rewrites the whole of `~/.codex/config.toml` in its own formatting. The
content stays the same, but keep a copy if you diff that file.

## The board

The board shows the scope of the directory you opened it in: the repo's name in the header,
tasks grouped by state. A scope with nothing open says so, and how to file the first task.
The footer lists the everyday keys of where you are: the board, a task, the transcript, a
card's tab or the copilot each has its own. `?` opens a sheet along the bottom with every key of
the view you are in, then the ones that work everywhere, and `j`/`k` (and the paging keys below)
scroll it when it is taller than the pane. A key that does nothing right now (no row selected, no linked issue) shows faint:

- `j`/`k` move, `enter` opens a task, `esc` goes back, `q` quits. The detail view pins the
  task at a glance, where it sits as one row (`↑` its parent, `⊘` a blocker still open, the
  rest counted) and any question waiting on you, then shows one section at a time: `now` (its
  checklist, the decisions made, its subtasks, the latest handoff whole and its links,
  where `J/K` move a cursor and `enter` opens the issue under it), the description (with its curated context), the comments, and the log of work
  and agent activity. It opens on `now` when anything besides links is in it, otherwise on the
  description. `1`-`4` or `h`/`l` switch
  sections. `j`/`k` scroll a section, `ctrl+d`/`ctrl+u` by half a page, and `g`/`G` go to its
  top and its end; the `?` sheet and the transcript scroll the same way.
- A long handoff on `now` is read by scrolling the section; nothing is folded. A part of `now`
  that changed while the detail was open reads `✦` until you have looked at it.
- `[` and `]` move a task through the states (inbox, next, in progress, waiting, done).
  `d` marks it done, `n` next, `s` someday, `x` cancel.
- `/` filters as you type, `f` cycles open, done and cancelled, and review, `i` cycles the
  kind filter.
- `y` copies a task's agent brief to paste into any chat.
- `⌃z` undoes the last change.
- `a` on an issue offers to start a coding run once the [loop extension](extensions.md) is
  enabled. Without it, `a` does nothing.
- `,` lists every setting, its value and where it comes from: `default`, `global` (every
  project on this device), `shared` (the file in the repo) or `local` (this project, only
  you). `h`/`l` step a setting with choices, and `enter` types a string or a number; on a
  setting you can't change, `enter` shows the file it is in and what the other layers set
  under it. `tab` picks the layer the change is saved to, `local` first inside a project and
  `global` outside one, and `enter` saves it. `x` removes a setting from a layer. A save to
  `shared`, which writes into the repo, or to a protected setting such as the hub's URL asks
  `y`/`n` first. A secret is typed without being shown. The copilot changes settings too, and
  `kabane config set` adds and removes a record's entries, such as a loop's gates.
- `O` opens a task's linked issue. On the board, `space` and `h`/`l` fold subtasks, and `r`
  refreshes. `tab` moves between the board and the copilot.
- The top row is the tab bar: the tracker, then one tab per piece of running work that asks
  for one (an extension's run, say). `{` and `}` switch tabs, as does a tab's number from the board, the
  Jobs tab or a card's tab with no question to answer; `w` closes a finished one.
  `?n` on a tab counts the agent questions waiting on you there.
- `!` goes to the next question waiting on you, oldest first. It opens the question's task
  with the question pinned over it, and a digit answers it. From a run's tab, `o` does the
  same for the question that run's agents asked, and `b` goes back to the run.
- Decisions an agent filed on an issue (`kabane_ask`) wait for whenever you get to them. Each
  issue's row counts its open ones (`?2`), and `u` shows only the issues that have one (`esc`
  shows the rest again). An issue's detail asks them one at a time under its header: pick a
  choice with a digit (`★` marks the one the agent recommends), or `↑↓` and `enter`; on a
  multi-select `space` toggles and `enter` sends; then type an Other answer or a reason, or
  press `enter` to skip. Answering the last one moves the issue back to next.

The copilot is `A` (or `:`). It opens a one-line prompt at the bottom of the board and
hands a coding harness what you are looking at: the scope, the selected task, and anything
you marked with `m`. Type a request and press `enter`. The agent runs in the background,
the footer shows its last tool call, and the board reloads as its writes land. `o` opens
its transcript. Typing `/` in the prompt lists the shortcuts: `/triage`, `/refine`,
`/split`, `/duplicates`, `/reparent`, `/check-plan`, `/linear`, `/github`, `/setup`,
`/settings`, `/doctor`, and those of the extensions you enabled. Each one
expands into editable text, so you can read what will be sent before sending it.

The [dispatch extension](../extensions/dispatch/README.md) adds the setup-dispatch skill, which
writes a dispatch skill under `.agents/skills/dispatch/` that lets your coding sessions turn asks
into kabane issues. `/setup-dispatch` runs it on the board; any session connected to kabane's MCP
server can run it too, by asking for the dispatch setup. It asks you the few setup questions your project's files leave open, such as
whether a team tracker holds the requests, and records the answers in the skill. It also serves the grill skill: ask the copilot, or any session
connected to kabane's MCP server, to "grill me" and it walks you through the questions agents left
open, one at a time. Without it, `kabane mcp` serves neither skill, and the copilot does not offer
`/setup-dispatch`. A skill an
earlier kabane wrote keeps working without the extension; `kabane doctor` then says it cannot
tell whether that skill is current. [Extensions](extensions.md) says how to install it.

`/doctor` checks that what kabane wrote is current: see [Keeping kabane current](#keeping-kabane-current).

`/linear`, `/github`, `/setup`, `/settings` and `/doctor` follow kabane's own `kabane` skill,
which kabane's MCP server serves to any session connected to it. Outside the board, ask a
session to "link this issue to Linear ENG-1" or "check that kabane is current" and it fetches
the same skill.

The copilot has three requirements of its own. Setup does not check any of them:

- **A logged-in harness.** The default is Claude Code: `claude` on PATH, run once to log
  in. To use another harness, add `"copilot": { "harness": "codex" }` (or `"gemini"`) to
  `~/.kabane/config.json`, or run `kabane board --copilot gemini` for a single run.
- **A few seconds on the first turn**, because it starts a pinned ACP adapter through
  `npx`. If that turn fails with an npm resolution error, check `~/.npmrc` for
  `min-release-age`. That setting hides recently published packages, including pinned
  versions. `NPM_CONFIG_USERCONFIG=/dev/null kabane board` bypasses it for one run.
- **Nothing, for the permission mode.** A session that opens in the harness's manual,
  ask-first mode is moved to the harness's own auto mode (Claude Code `auto`, Codex
  `agent`), where the harness decides which tool calls need you; any other mode your
  harness settings chose is kept. Whatever the harness still asks shows in the transcript
  for you to answer. `"harness": { "mode": "default" }` in `~/.kabane/config.json` turns
  this off.

More detail is in [`deploy.md`](deploy.md) part 4.7.

## Agents

Setup registered one MCP server, `kabane`, per harness. Each harness writes as its own
actor, so the board and `kabane show` tell you who did what. Check the registration:

```bash
claude mcp get kabane      # Status: ✔ Connected, Args: … mcp --as kabane://actor/agent/claude
codex mcp get kabane       # args: … mcp --as kabane://actor/agent/codex
gemini mcp list            # ✓ kabane: … mcp --as kabane://actor/agent/gemini (stdio) - Connected
```

To wire a harness later, or re-wire one, use `kabane mcp install`. It takes
`--harness claude|codex|gemini` to pick one and `--force` to replace an existing entry.
For any other MCP client (Cursor, Windsurf and others), `kabane mcp install --print`
prints paste-ready config.

The server exposes `kabane_*` tools: `kabane_list`, `kabane_get`, `kabane_context`,
`kabane_add`, `kabane_edit`, `kabane_comment`, `kabane_done`, `kabane_search`,
`kabane_link` and a few more. The agent's working directory sets the default scope, so a
new task lands in the repo the agent is working in.

For MCP comments, use `body` for Markdown. `text` is also accepted, and legacy `content`
remains supported. Supply at least one nonempty string; if you supply several aliases, their values
must be **exactly equal**, including whitespace. The stored content is not trimmed or rewritten.
A comment is not edited or deleted on its own; deleting the issue removes its comments. Add
`kind` (lowercase `name` or `name.key`, such as `review`) for a report meant to last: the brief
keeps a comment of any kind but `comment` whoever wrote it, labelled with its kind, where a
plain agent comment can drop out. A kind a module lifts into its own section shows only its
newest comment there, under that kind's title, and counts the older ones.

When an agent finishes its part of an issue, whatever the work was (a code change, a research
note, a design), it hands it off with `kabane_handoff`: a markdown `body` under the headings
Summary, Evidence, Not verified and Risk, which the tool's description carries. Evidence is what
was seen, not what was concluded: an output, a quoted source, a screenshot's `file:` ref. A
handoff changes nothing else on the issue, so closing it is still `kabane_done`. The next
reader's brief opens with the latest handoff, after the description, and counts the earlier
ones; `kabane handoff <id> --all` prints every one.

```jsonl
{"name":"kabane_comment","arguments":{"id":"JMYA-1","body":"Drafted the README; the install section is next."}}
{"name":"kabane_handoff","arguments":{"id":"JMYA-1","body":"### Summary\n\nThe README now opens with install, then the board.\n\n### Evidence\n\nFollowed the install section on a clean machine: `kabane --version` printed `1.0.0-beta.0`.\n\n### Not verified\n\nThe Windows steps.\n\n### Risk\n\nEasy to walk back: one file."}}
{"name":"kabane_log","arguments":{"id":"JMYA-1","commit":"abc123","note":"Implementation commit"}}
{"name":"kabane_log","arguments":{"id":"JMYA-1","refs":[{"uri":"commit:abc123","label":"Implementation"},{"uri":"file:src/index.ts"}]}}
```

`kabane_log` requires `commit` or a nonempty `refs` array of `{uri, label?}`. `commit` is a
nonempty bare SHA or revision (for example `HEAD~1`), shorthand for `commit:<value>`. You may
supply both: explicit refs and labels are preserved, and the shorthand is appended only if
that exact commit URI is absent. Existing duplicates in `refs` are not removed. Comment
authorship still comes from the connected identity. Check each write result for errors
before issuing dependent writes or `kabane_done`.

Agents use the tracker reliably only when the project tells them to. In the project you ran
setup in, the first issue has your agent add this block. For any other project, paste it
into the project's `CLAUDE.md` (Claude Code), `AGENTS.md` (Codex) or `GEMINI.md` (Gemini
CLI):

```markdown
## Tracker

Work is tracked in kabane (MCP server `kabane`). Your assignee name is your harness: `claude`, `codex` or `gemini`.
- Before starting, `kabane_list` with `assignee` set to your name, `state: "next"`, and `responseFormat: "concise"`. If no suitable task is on the page and `hasMore` is true, follow `nextCursor` with the same filters; only assert no work remains after `hasMore` is false. Read the chosen task with `kabane_context` and `responseFormat: "concise"`; consume every preceding chunk and continue with `nextCursor` until `selectedComplete`, `descriptionComplete`, and `humanSteeringComplete` are true before starting work. Use the same id/options; request any omitted required sections.
- Set the task `in_progress` with `kabane_edit` and `responseFormat: "concise"` before touching code. Never take a task that is already in progress.
- When finished, hand the task off with `kabane_handoff`: what landed, the evidence of what you checked, and what you did not verify. `kabane_comment` is for notes along the way. Check write results for errors before `kabane_done` with `responseFormat: "concise"`.
- File new work you find with `kabane_add` and `responseFormat: "concise"` instead of doing it unasked. Use `kabane_get` for full own fields.
```

The board shows assignees (`@claude`) but does not set them. Assign with
`kabane add "…" --assignee claude` or `kabane edit <id> --assignee claude`, or ask the
copilot to do it. The assignee is a plain name, not the actor URI, and `list` matches it
exactly: `--assignee kabane://actor/agent/claude` finds nothing.

## The CLI, for scripts and agents

Everything the board does is also a command. Every command takes `--json`:

```bash
kabane add "Write the README" --kind issue --assignee claude --priority high
kabane list                                  # open tasks in this repo's scope
kabane list --assignee claude --state next --format concise
kabane edit JMYA-1 --state in_progress --format concise
kabane comment JMYA-1 "README drafted"
kabane comment JMYA-1 "Reviewed: rollback is covered" --kind review
kabane handoff JMYA-1 --from handoff.md      # body under kabane handoff --template's headings
kabane context JMYA-1 --format concise      # finish required description/steering
kabane context JMYA-1 --format concise --cursor '<nextCursor>'  # same flags
kabane done JMYA-1 --format concise
kabane list --all                            # include done and cancelled
kabane search license --format concise
```

A script can wait for a change on this device. The command checks immediately and then
once per second. By default it waits until the condition holds or the process is stopped.

```sh
kabane wait answered JMYA-1:1 --timeout 30s
kabane wait state JMYA-1 done cancelled --timeout 10m
kabane wait ready JMYA-2 --timeout 2h
kabane wait addressed kabane://actor/human/ana --timeout 1h
```

Exit 0 prints one JSON line. Wherever it appears, `taskId` is a thread ID (a ULID or a plan key).

| Condition | Result fields | When it returns |
|---|---|---|
| `answered` | `condition`, `questionId`, `taskId`, `status` | The question was answered or withdrawn. Accepts the same handle or `id:<ULID>` as `kabane answer`. |
| `state` | `condition`, `taskId`, `state`, `claimedBy` | The thread reaches a requested state. The claim holder is null when nobody holds it. |
| `ready` | `condition`, `taskId` | Every incoming `blocks` and outgoing `blocked_by` or `follows` dependency is done or cancelled. A thread with no blockers is ready immediately. |
| `addressed` | `condition`, `actor`, `entries` | The actor has open addressed entries. Each entry carries its `id`, `taskId` and `kind`. |

Exit 1 means the timeout expired. Other errors exit 2 with a message on stderr.

### Claims

Setting a task `in_progress` with an assignee claims it for whoever made the edit, and the
result says who holds the claim (`claimedBy`). When two agents claim the same task, on one
device or on two that were offline, the earlier claim holds on every device once both have
synced, and the later one reads someone else in `claimedBy` (and `claimHeld: false` on its edit): that agent leaves the task. An agent that claimed offline learns it lost from `kabane wait state <id> in_progress` once its device has synced, and a loop run launches no session for a task whose claim another agent holds. A
claim lasts while the task is `in_progress` or `waiting`; putting it back in any other state
releases it. A claim never expires on its own.

### File a plan in one step

A plan is a JSON file of threads, each with a key you choose, and the links between them:

```json
{
  "threads": [
    { "key": "decide", "title": "Pick the store", "state": "next", "assignee": "claude" },
    { "key": "build", "title": "Build it", "parent": "decide" }
  ],
  "links": [{ "from": "decide", "to": "build", "type": "blocks" }]
}
```

```sh
kabane apply plan.json --key store-v2
```

Each thread's id is `<plan key>/<thread key>` (`store-v2/decide`), and it gets a label as any
task does. A thread is an `issue` unless it says otherwise. A link's ends and a `parent` are a
key in the file or an existing task's label or ULID. The plan lands in one transaction, and
applying the same file again creates nothing and says what was already there, so a retry after
a crash is safe. The MCP tool `kabane_apply` takes the same document, and
`kabane add --key store-v2/review` adds one more thread to it.

For agent reads, select concise explicitly: concise output is opt-in, and without it a command
prints its human text, or its full records with `--json`
([what changed in them since 1.0.0-beta.0](#upgrading-from-100-beta0-comment-kinds-and-handoffs)).
Concise list/search return bounded pages (`items`, `hasMore`,
`nextCursor`), not raw arrays. Continue with `--cursor '<nextCursor>'` and the same
filters/scope. `--format full --json` retrieves legacy raw records. See
[concise reads](concise-reads.md) for budgets, truncation markers and stale-cursor
semantics and lossless bounded context retrieval. Context chunks concatenate exactly;
completeness assumes all preceding chunks were consumed. Full context remains
available without a new size bound; its subtask rollup now includes all children.

```
✓ Created 📥 🟠 🔧JMYA-1  Write the README @claude
```

Kabane writes nothing into your repo to find its scope. It remembers the scope it detected
for each checkout under `~/.kabane`, so a checkout keeps its tasks when its remote is renamed.
A clone made after the rename resolves by the new remote. To name a project's scope yourself,
run `kabane init --scope <id>` in it: the pin is kept under `~/.kabane`, for you on this device,
and still nothing lands in the repo. To pin it for everyone who clones the repo, add `--shared`,
which writes `.kabane/scope` for you to check in. Your own pin wins over the repo's.

Outside a repo, `list` and `search` span every scope. `kabane <command> --help` prints that
command's flags, `kabane --help` lists the commands, and
[`packages/cli/README.md`](../packages/cli/README.md) has the full reference.

### Due dates and your timezone

`--due` (and an agent's `dueDate`) takes one of two kinds of deadline:

- **A date**, `--due 2026-02-06`: due by the end of that day where you are. It is stored as the
  date itself, so it never slips to the day before.
- **A time**, `--due 2026-02-06T17:00`: 17:00 your time, stored as that moment. An ISO time
  with `Z` or an offset (`2026-02-06T22:00:00Z`) is taken as written.

"Where you are" is your system timezone. To pin another, add an IANA name to
`~/.kabane/config.json`: `"timezone": "America/Montreal"`. It decides which day is today, when a
date deadline's day ends, and how a time is shown. A name kabane does not know is an error, not
a silent UTC.

## Updating

Each install updates with its own command:

| Installed with | Update with |
|---|---|
| Homebrew | `brew upgrade kabane` |
| the installer, or an extracted release archive | `kabane update` |
| mise | `mise up github:davidpp/kabane` |
| `bun add -g` (up to `1.0.0-beta.0`) | move to another install ([moving from a Bun install](#moving-from-a-bun-install)) |

### Hearing about a release

The board says when a release your install would update to is out: a line over its footer,
`kabane <version> is out · run kabane update`, until `esc` or a click on it dismisses it. A
Homebrew install says `run brew upgrade kabane` instead, a binary mise installed names mise's
upgrade for the tool as mise knows it (`run mise up github:davidpp/kabane`), a Bun install says
`releases moved to GitHub, run kabane update`, and an install `kabane update` would refuse says
`update it the way you installed it`. It is the newest release on your channel and within your
major (minor for `0.x`), the one `kabane update --check` names on a binary.
The board reads the latest release and the betas from
[GitHub releases](https://github.com/davidpp/kabane/releases), where the binaries download
from, at most once a day, after its first frame, and keeps them in
`KABANE_HOME/update-check.json`.
When GitHub cannot be reached, nothing is shown and the board carries on. Only the board
checks: `kabane mcp`, a piped command and every other command never do, and a run from a
source checkout never shows the line. The check itself installs nothing. To turn
it off:

```bash
kabane config set updates.check false
```

Before the board opens, `kabane` and `kabane board` ask about the same release, as a plain
question: `kabane 1.0.1 is out (you have 1.0.0). Upgrade now with "brew upgrade kabane"? [Y]es /
[n]o, continue / [s]kip this version`. `y` or Enter runs that command, its output on screen, and
opens the board on the new version; if it fails, kabane says how and opens the board on the
version you have. `n` opens the board and the line over its footer stays away for that start.
`s` records the version in `update-check.json`, and kabane names it neither here nor on the board
again; a later release is offered as usual. An install kabane cannot update names the release
page instead. It asks only at a terminal, never under `CI`, never from a source checkout or a main
build, and not at all with `updates.check` false. It gives GitHub 1.5 seconds a request rather than 5; a
slower answer reaches the board's line instead.

### Keeping kabane current

An update can leave behind what an older kabane wrote: a setting under a retired key, a
Tracker block that predates handoffs, a
harness's MCP entry that launches a kabane you no longer have. `kabane doctor` lists each
one with its fix, and enabled extensions add their own checks:

```bash
kabane doctor                        # report drift without applying its repairs
kabane doctor --fix                  # apply the findings that need no decision (severity auto)
kabane doctor --fix <source>/<id>    # apply a named fix: copy the source/id from the report
kabane doctor --json                 # the same report, for scripts and agents
```

Doctor opens an existing tracker to let extensions inspect issues. Like other commands,
it applies pending database migrations on the first run after an update, even without
`--fix`. Back up the database before that first run; returning to an older version may
require restoring that backup. Reporting findings does not apply their offered repairs.

The source identifies the check owner: `kabane` for settings and MCP, `project` for
project files, and an extension name such as `loop` or `dispatch`. For example,
`kabane doctor --fix dispatch/dispatch-skill-unlinked` applies the dispatch extension's offered
repair.

Each finding has a severity that says what to do with it, not how bad it is: `auto` needs no
decision, `mention` is worth knowing and has a fix you can choose to run, `suggest` is a better
setting rather than a broken one, and `route` names the skill that repairs it, such as
the dispatch extension's setup-dispatch skill. Findings are not errors, and the command succeeds when it has some.

In the board, `/doctor` has the copilot run the same report and act on it: it applies the
`auto` fixes without asking, tells you each `mention` and `suggest` and waits for your yes,
and offers the skill a `route` names. It never rewrites a harness's MCP entry itself; it
gives you the `kabane doctor --fix` command to run.

Scripts reading `kabane mcp install --json` must accept `reports[].status: "stale"`
for an existing entry whose launch differs from this installation. It previously returned
`present`; the exit code remains 0 and the entry is unchanged. Text now says
`registered with another command` instead of `already installed` for that state.
Use `--force` or the named doctor repair only when you want to re-point it.

### Standalone binaries

This applies to a binary the installer put in place or one you extracted yourself.

```bash
kabane update --check        # metadata only: the candidate from GitHub releases
kabane update               # download, verify and replace this binary
```

A binary follows the channel and version policy in [subsequent updates](#subsequent-updates) and
[beta installs](#beta-installs). It reads the candidate from the GitHub releases API over HTTPS:
`latest` is the latest release, `beta` the highest `X.Y.Z-beta.N` prerelease. `kabane update`
downloads `kabane-<os>-<arch>.tar.gz` and `SHA256SUMS` from that version's
[GitHub release](https://github.com/davidpp/kabane/releases) and refuses on any checksum
mismatch. It extracts into a temporary directory beside the executable, runs the new
`kabane --version` and requires the candidate version, then renames the new executable,
`templates/` (empty now that kabane ships no template) and `extensions/` over the old ones. An
archive from a release before extensions shipped leaves the installed `extensions/` as it is. A symlink on PATH is followed to the real executable, so
harness MCP entries that point at it keep working. A failure before the rename leaves the old
install as it was. The executable needs `templates/` beside it, as extracted from the release,
and its directory must be writable; otherwise replace the directory with a verified download
by hand. Restart running board/MCP sessions afterwards.

When Homebrew or mise owns the executable, `kabane update` reports the candidate and leaves the
file to them: `brew upgrade kabane` for one in Homebrew's `Cellar/kabane/`, and `mise up <tool>`
for one under a mise installs directory (`$MISE_DATA_DIR`, `$XDG_DATA_HOME/mise` or
`~/.local/share/mise`), with the tool named as mise names it (`github:davidpp/kabane`, or
`kabane` from mise's registry). No tracker DB is opened and no harness entry is rewired.

### Upgrading from 1.0.0-beta.0: settings layers and scope pins

1.0.0-beta.0 read a project's settings from the repo only: the loop from `.kabane/loop.json`, the
pin from `.kabane/scope`, which `kabane init --scope` wrote. Now your settings for a project and
your pin are kept under `KABANE_HOME`, outside the repo, and the repo's files are written only when
you name them. Updating itself does not move or rewrite these settings files.

- **What stays, and is still read.** `.kabane/loop.json` is the *shared* layer, for everyone who
  clones the repo, and `.kabane/scope` is the repo's pin. Kabane never moves or deletes either.
- **Where a write goes now.** `kabane config set` (and the copilot's `kabane_configSet`) sets an
  extension's keys too, such as `loop.model`. With no `--layer`, it writes inside a project to
  `KABANE_HOME/projects/<slug>/<namespace>.json` (*local*: yours, on this device, never in the
  repo) and outside one to `config.json` (*global*: every project). Name `--layer shared` to
  write the repo's `.kabane/loop.json`.
- **The pin.** `kabane init --scope <uri>` writes your own pin, `KABANE_HOME/projects/<slug>/scope`,
  which wins over the repo's. `--shared` writes the repo's `.kabane/scope`, as `init --scope` did
  in 1.0.0-beta.0.
- **From a source build since 1.0.0-beta.0.** Those builds called the layers `user`, `scope` and
  `project`, and kept local settings under `scopes.<scope id>` in `config.json`. The old names are
  still accepted on input, but JSON output says `global`, `local` and `shared`. The `scopes`
  blocks are still read, as local just under the new file. `kabane doctor` reports them.
  `kabane doctor --fix` moves this project's blocks into its local files and removes the old
  blocks from `config.json` when the destination is absent or identical. A different local
  value refuses the move. Other checkouts sharing that scope then lose the old block; review
  their settings before applying this repair. Blocks for other scopes are reported for manual migration.
- **Running processes.** A board, `kabane mcp` or loop runner started by an older version does
  not read the new files. It misses local and global settings the new CLI writes, and a pin
  written without `--shared`, so it can file tasks under another scope than new processes do.
  Stop them before updating and start them again after; do not run both versions on one
  device.
- **Going back.** First restore the database backup
  ([comment kinds and handoffs](#upgrading-from-100-beta0-comment-kinds-and-handoffs)). Then
  1.0.0-beta.0 still reads the repo's `.kabane/loop.json` and `.kabane/scope`, but nothing in
  `config.json`'s extension keys or under `KABANE_HOME/projects/`: put the settings you need
  into `.kabane/loop.json` and pin the scope with `kabane init --scope <uri>`, which writes
  `.kabane/scope` in that version.

### Upgrading from 1.0.0-beta.0: comment kinds and handoffs

A comment now has a kind, and an agent that finishes its part of an issue hands it off
([Agents](#agents)). This changes the database: the new version migrates it the first time it
opens it. Before that, stop every board, `kabane mcp` and loop runner the old version started,
let a running `kabane sync` finish, stop any app that embeds the old version's core, and back
the database up as [subsequent updates](#subsequent-updates) describes. Start them again once
the new version is in place.

- **What is kept.** Every comment, with its author, time and text. Each one becomes a comment
  of kind `comment`.
- **JSON output.** `kabane show --json` lists every entry on the issue under `comments`, each
  with a `kind`: plain comments are `"comment"`, and handoffs (`"handoff"`) and other kinds
  (`"review"`) are listed beside them. A script that reads `comments` as plain comments should
  keep only those whose `kind` is `"comment"`. `kabane comment --json` and the `kabane_comment`
  tool return the new comment with its `kind` too. `kabane show` without `--json` prints the
  latest handoff in its own section after the comments.
- **No going back.** 1.0.0-beta.0 refuses a database the new version has opened: `newer than
  this kabane knows (7); update kabane before opening it`. Going back takes the backup.
- **Sync: the hub and every device in one go.** A device still on 1.0.0-beta.0 stops pulling
  at the first change an updated device pushes, whatever it changed, and fails with `Update
  kabane on this device and sync again`. It skips nothing and catches up once updated. The hub
  is one of those devices, and Claude.ai and ChatGPT get `kabane_handoff` only once it is
  redeployed. Redeploying is a manual step: follow
  [the hub first, then each device](deploy.md#58-upgrade-kabane-across-devices-the-hub-first-then-each-device).
- **Why stop them first.** Only a process started after the update is refused. One left
  running from 1.0.0-beta.0 keeps reading and writing the migrated database, still without
  `kabane_handoff`, and reads every entry as a plain comment: its board lists a handoff among
  the comments, and its brief can leave an agent's handoff out, as it does an older agent
  comment. A sync still running from the old version can send new comments on without their
  kind, and a device still on the old version then keeps them that way.
- **What your agents are told.** The Tracker block from 1.0.0-beta.0 has an agent finish with
  `kabane_comment`, which still works but leaves no handoff: replace it with the block under
  [Agents](#agents). A dispatch skill that `/setup-dispatch` wrote with 1.0.0-beta.0 reports the
  same way once the [dispatch extension](../extensions/dispatch/README.md) is enabled; run
  `/doctor` in the copilot, which finds it and offers to write it again from the current
  template.

### Upgrading from 1.0.0-beta.0: scope URIs, and one place for the database

A scope's URI was `jake://scope/<id>`, after the planner kabane was extracted from. It is
`kabane://scope/<id>` now. This changes the database too: the new version renames every stored
scope the first time it opens it, in the same step as the
[comment kinds](#upgrading-from-100-beta0-comment-kinds-and-handoffs) migration, so stop the
old version's processes and back the database up as that section says.

- **What is kept.** Every task and project stays in its scope, under the same scope id and
  the same short id. Only the scheme in front of the id changes.
- **The old scheme is still read.** `--scope jake://scope/myapp`, a tool's `scopeUri`
  argument and a bare id (`myapp`) all name the same scope as `kabane://scope/myapp`. Pins
  hold the bare id and need no change.
- **Output says `kabane://scope/…`.** `scopeUri` in `--json` output and in tool results is the
  new URI. A script that compares it to a `jake://scope/…` string has to change; one that
  passes it back to kabane does not.
- **Sync.** A device still on the old version stops pulling at an updated device's first
  change, as for comment kinds. What it pushes meanwhile still carries the old scheme, and an
  updated device renames it as it pulls, so both versions' tasks land in one scope.
- **The `db` block is gone.** `kabane init --db-path … --table-prefix …` and the `db` block in
  `config.json` let a device open another application's database, with prefixed tables. The
  database is always `KABANE_HOME/kabane.db` now. A config that still has a `db` block is
  refused, with a message, so that it is not read as an empty tracker: if the file it names
  has unprefixed tables, move it to `KABANE_HOME/kabane.db` and remove the block. A database
  with prefixed tables is not opened by this version.
- **A database from before 0.1.0.** One created by a source build older than the first
  release, and not opened since, is refused: open it once with 1.0.0-beta.0, then update.

### Upgrading: agent sessions leave the database

Kabane no longer keeps agent sessions in its own tables. What a session decided, found, verified,
handed off or summed up becomes an entry on the issue's timeline, and the session itself a
`session:` ref in the issue's work log. The new version moves them the first time it opens the
database and then removes the two session tables. **Back up `kabane.db` before that first
boot**, with every board, `kabane mcp`, loop runner and `kabane sync` of the old version stopped,
as [subsequent updates](#subsequent-updates) describes: removing the tables cannot be undone
without that backup.

- **What is kept.** Every decision (a human's answer reads as its question, then `→` the choice,
  under who chose), finding, verification, handoff and session summary, with its author and
  time, as an `outcome.decision`, `outcome.finding`, `outcome.verification`, `handoff` or
  `outcome.summary` entry. The board shows them on the issue's comments tab, and the brief in
  its Discussion. Each session is a line in the issue's log, under the agent that ran it.
- **What is lost.** Everything else a session recorded along the way: a question still open on
  a session that was running when you upgrade, progress notes, tool-approval answers,
  withdrawn questions, and the action and error lines the board's log showed. A finding or
  other row written as ephemeral is lost too, including the latest one the brief used to show.
  A loop run started since the loop kept its own sessions is not affected: its questions and
  events are in its own run directory.
- **The brief.** An issue with a `session:` ref leaves out its plain AI comments, as an issue
  with a session did before; the outcome entries are always in it.
- **Sync.** The moved entries and refs replicate: the first push after the upgrade sends rows
  that never left the device before. A device still on the old version stops pulling at the
  first change an updated device pushes and catches up once updated. Two devices that upgrade
  copies of one database write identical rows, so syncing them keeps one of each.
- **When it refuses.** A database missing one of the two session tables, or already holding a
  different row under an id the move would write, is not migrated: kabane says what it found
  and changes nothing.
- **No going back.** The old version refuses a database the new version has opened. Going back
  takes the backup.

### Upgrading from 1.0.0-beta.0: actor URIs

An actor, the identity stamped on everything you and your agents write, was
`cabane://actor/human/<name>` or `cabane://actor/agent/<harness>`, after the project's earlier
name. It is `kabane://actor/…` now. The database, `config.json` and the harness entries
`kabane mcp install` wrote all hold one, and this version reads only the new prefix.

**Back up first**, with every board, `kabane mcp`, loop runner and `kabane sync` of the old
version stopped: a consistent copy of the database
(`sqlite3 ~/.kabane/kabane.db "VACUUM INTO '<backup path>'"`), `~/.kabane/config.json`, and the
harness configs the repair rewrites: `~/.claude.json`, `~/.codex/config.toml` and
`~/.gemini/settings.json`, where present. Then run:

```bash
kabane doctor --fix
```

It migrates the database, rewrites `actor` in `config.json`, and re-registers each harness entry
whose only difference is its old `--as` actor. Until you run it, every other command stops with
a message that names it. Keep the old version's processes stopped until it has run: one still
running writes the old prefix into the migrated database, where nothing renames it again. Then
start them again, harness sessions included, so each `kabane mcp` starts with its new `--as`.

- **What is kept.** Every task, comment, question, checklist item and log entry, with its
  author and time. The columns that name who wrote a row (authors, `updated_by` and the like)
  move to the new prefix; no version or time moves. Text that quotes an old URI, in a
  description, a comment or a question, stays as written, and so do authors with no URI
  (`claude`, `agent:claude`).
- **Output says `kabane://actor/…`.** `kabane config get actor`, `--json` output, tool results
  and every brief name the new prefix. A script that compares an author to a `cabane://actor/…`
  string has to change.
- **The old prefix is refused.** `--as cabane://actor/…`, or a `config.json` actor under it,
  stops the command with a pointer to `kabane doctor --fix`. A harness entry that also runs
  another command, such as one `mise up` left on an older binary, is reported as
  `mcp-entry-stale-<harness>` instead, which a bare `--fix` does not apply:
  `kabane doctor --fix kabane/mcp-entry-stale-<harness>` re-registers it with the new actor.
  An entry that sets more than its command, such as an `env` with its own `KABANE_HOME`, is
  reported as `mcp-entry-actor-kept-<harness>` and left alone, because re-registering would
  drop the rest: replace the old actor after `--as` in the file it names, by hand.
- **Extensions you installed from a clone.** Rebuild and reinstall each one
  ([extensions.md](extensions.md), "Update an extension"): an older loop starts its sessions as
  `cabane://actor/agent/<harness>`, which this version refuses, and an older recipes leaves its
  tables under the old prefix. On a main build, `kabane update` rebuilds them for you.
- **The jobs extension.** Its runs and jobs move when it is enabled. A device with it
  disabled keeps the old prefix in those tables until it is enabled again.
- **Sync: every device before the next sync.** A device still on the old version stops pulling
  at an updated device's first change. What it pushes meanwhile carries the old prefix, and an
  updated device stores it as it came. So stop writing, sync every device until nothing is left
  to pull while all of them still run the old version, then update every device, and the hub,
  before syncing again. A hub deployed as `cabane-worker` moves to `kabane-worker`
  ([deploy.md, 5.9](deploy.md#59-move-a-hub-deployed-as-cabane-worker--manual)).
- **No going back.** The old version refuses a database this one has opened: `newer than this
  kabane knows`. Going back takes all three backups: the database, `config.json` and the
  harness configs.

### Upgrading: the recipes extension is now jobs

The extension behind `kabane run`, `kabane runs` and `kabane job` was called `recipes`; it is
`jobs`. The commands, recipe files in `.kabane/recipes/` and the word "recipe" are unchanged. A
device that had it enabled still names `recipes` in `config.json`, so the extension does not
load; while `~/.kabane/extensions/recipes` still resolves to a directory with no
`package.json`, every command that opens the database stops with a pointer to:

```bash
kabane doctor --fix
```

It links `~/.kabane/extensions/jobs` to this kabane's own copy of the extension, moves the
`recipes.*` settings (`harness`, `onAttention`) to `jobs.*` in `~/.kabane/projects/` and in the
`.kabane/recipes.json` of the project you run it in, removes the old `recipes` link, and only then
renames the `recipes` entry in `extensions` and its settings in `config.json`. A
`~/.kabane/extensions/recipes` you copied rather than linked stays, and doctor says so: remove it
once you no longer need it. When a destination is already taken (a `jobs.json` beside a
`recipes.json`, a `jobs` key beside `recipes`), or this kabane has no `jobs` copy to link, it
changes nothing, says why and exits 1. The next command that opens the database
moves the extension's tables, with every run and job, to their new names. Run doctor once more
and apply what it reports, such as a `job` skill in `~/.agents/skills/job` that now differs
from the one the extension ships. Restart the board and harness sessions afterwards: a process
started before the rename still uses the old names.

- **Sync.** An op a device on the old version pushes is tagged with the old names, and an
  updated device parks it for good. Update every device before the next sync.
- **No going back.** The old version finds none of its tables in a database the new one opened.

### Upgrading from 1.0.0-beta.0: the loop and dispatch are extensions you install

In 1.0.0-beta.0 the loop came inside kabane, and `"extensions": ["loop"]` in `config.json` turned
it on. The dispatch skill's template and `/setup-dispatch` came with the copilot. Now the loop
and the [dispatch extension](../extensions/dispatch/README.md), which holds the dispatch and grill
skills and `/setup-dispatch`, are extensions: a release install ships them beside the binary, and
from npm or a checkout you build and install them yourself. Updating kabane turns neither on. The grill skill is now served by `kabane mcp`
rather than copied into a project: a copy under a project's `.agents/skills/grill/` is no longer
checked and drifts from the served one, so delete it.

With `loop` still in `extensions` and nothing installed, the record commands (`kabane list`,
`kabane add` and the others) work as before and say nothing about it. `kabane --help`,
`kabane config`, `kabane doctor`, `kabane mcp` and any command kabane does not know start with
this line on stderr, with your kabane home's path in it. A harness that starts `kabane mcp` shows
it in its MCP server logs:

```text
Extension loop: not installed; put it in /…/.kabane/extensions/loop/; or remove it from extensions with `kabane config set extensions <names> --layer global`.
```

`kabane loop` is one of the commands kabane no longer knows. After that line it prints the
following and exits with status 2:

```text
Error: Unknown command: loop
Usage: kabane <command> [args]
```

The loop's settings are unknown keys until it loads again, so `kabane config get loop.model`
exits with status 1:

```text
Error: Unknown config key: loop.model. Run `kabane config list` or call kabane_configGet without a key for known keys.
```

`kabane doctor` reports the missing directory as `loop/extension-refused`: under `auto` on a
release install, which ships the loop, and under `mention` otherwise. The
board writes nothing on stderr; it shows `Extension loop refused: not installed` over its footer
until you press `esc`. On the board, `a` starts no run, and the copilot no longer offers
`/setup-dispatch`.

Kabane deletes nothing of the loop's. Its settings stay where you wrote them, `.kabane/loop.json`
in a project included, and are read again once the loop is installed and enabled. Its runs stay
under `KABANE_HOME/loops/`. Stop a loop runner the old version started before you update, as the
sections above say for every process of the old version.

On a release install (Homebrew, mise, the installer or an extracted archive), `kabane doctor
--fix` links the loop it ships, and `kabane config set extensions loop,dispatch --layer global`
links each one it names; the build below is not needed.

From a checkout, get the loop back by building it from a clone of this repository. This needs git
and [Bun](https://bun.sh) 1.4 or later.
Build from the tag of the kabane you run: `kabane --version` prints its version, and every
release is tagged `v<version>`. Stop the board first. From the directory you want the clone in:

```bash
git clone https://github.com/davidpp/kabane.git
cd kabane
git checkout v<version>
bun install
bun run --cwd extensions/loop build
mkdir -p "${KABANE_HOME:-$HOME/.kabane}/extensions/loop"
cp -R extensions/loop/dist/. "${KABANE_HOME:-$HOME/.kabane}/extensions/loop/"
```

`loop` is already in your `extensions`, so this is all the loop needs. The dispatch extension is
optional: install it the same way if you used `/setup-dispatch`, and add it to the list, which a
`set` replaces whole:

```bash
bun run --cwd extensions/dispatch build
mkdir -p "${KABANE_HOME:-$HOME/.kabane}/extensions/dispatch"
cp -R extensions/dispatch/dist/. "${KABANE_HOME:-$HOME/.kabane}/extensions/dispatch/"
kabane config set extensions loop,dispatch --layer global
```

```text
extensions = ["loop","dispatch"] (global)
```

Start the board again, and restart the coding sessions whose `kabane mcp` should see the
extensions. The line is gone, `kabane loop status` answers again, and `kabane config get
loop.model` prints your setting. [Extensions](extensions.md) has the same steps, and how to
update an extension later.

A dispatch skill that `/setup-dispatch` wrote with 1.0.0-beta.0 keeps working as written. It
carries no template stamp, so once dispatch is enabled, `kabane doctor` run in that project
routes it:

```text
route:
  dispatch/dispatch-skill-unstamped: .agents/skills/dispatch/SKILL.md has no kabane-template in its frontmatter metadata, so which template it was filled from is unknown. The setup-dispatch skill re-fills it from dispatch@aee0f7efee11, keeping the project's own edits, and shows the diff before writing. → the setup-dispatch skill (/setup-dispatch on the board)
```

Type `/setup-dispatch` in the copilot, or ask any session connected to kabane to refresh the
dispatch skill, when you want the current template.

If you do not want the loop, empty the list instead, and the line goes away. `""` turns off
every extension:

```bash
kabane config set extensions "" --layer global
```

### Upgrading to 2.0.0-beta.0 (schema 14)

Back up the database before the first open. The beta runs migrations through schema 14.
Migration 13 creates `threads`, `entries`, `attributes` and `refs`, then migration 14 moves
tasks, comments, work logs, links, context refs and linked issues into those tables.
If an extension already uses one of the four table names, migration 13 names the conflict.
Resolve it before retrying.

- **What you see.** `list`, `show`, `context`, `questions` and the board read as they did. A
  `parent` or `child` link becomes the child's parent, so the child shows as a subtask. The id of
  a link, a context ref or a linked issue changes: it is now made from what the row points at,
  so take ids from a fresh read (`kabane_linkList`, `kabane_contextList`, `kabane_upstreamList`);
  a context ref's old id still removes it.
- **When it refuses.** Migration 14 rolls back and names the rows when a child's `parent`
  or `child` links name two parents, when such a link's visibility differs from its child's, or
  when a stored time cannot be read as an instant. Restore the pre-upgrade backup before using the old version to fix those rows.
- **When it refuses before changing anything.** Parked legacy question ops, and comments whose
  kind is a question entry kind, stop the upgrade before any migration runs, so the database
  stays at its old version. Sync with the previous release and the questions module enabled, or
  change those comments' kind with it, then open this version again.
- **Sync: back up, update every device and the hub, then re-seed.** The ops this device had not
  pushed yet are dropped: they named the old tables. Enable every extension whose rows you
  want on the other devices first (backfill seeds only the tables of enabled ones, and a run
  after you enable one more seeds its rows then). Run `kabane sync backfill` on the
  device whose copy you keep, then `kabane sync push`; the others pull. A device still on
  schema 13 stops pulling at the first op from 14, until it updates.
- **Extensions with their own tables.** An extension table that referenced `tasks(id)` is
  rebuilt without that reference by the extension's own update. One that is not enabled keeps
  pointing at the old table, renamed `retired_tasks`, until it is.
- **No going back.** The old version refuses a database this one has opened. Going back takes a
  backup made before the first open.

### Subsequent updates

```bash
kabane update --check        # the candidate from GitHub releases; installs nothing
kabane update               # download, verify and replace this binary
```

A stable install takes the latest stable release, within the installed major; `0.x` stays
within its minor. A beta install follows its own channel ([beta installs](#beta-installs)). The
installed version picks the channel: there is no channel option, force, implicit downgrade or
major (pre-1.0 minor) jump. Crossing that boundary means reading the compatibility notes and
installing the release you chose by hand. A Homebrew or mise install is left to its manager, and
`kabane update` names the command. Source links and installs it does not recognize are refused,
with `Unsupported installation; ...` (status `unsupported` in `--json`) and exit 1.

No tracker config/DB is opened, migrated or deleted by check/update, and no harness entry
is rewired. `kabane mcp` makes no network check; the board's release notice is the only
check that runs on its own ([hearing about a release](#hearing-about-a-release)).

**Data compatibility is separate from installing the executable.** Before the first normal
open of a release with schema changes, stop board/MCP and all other shared-data writers,
read compatibility notes, and make a consistent backup of the **actual configured database**
(including externally shared DBs), config and WAL state. Use SQLite backup or a closed,
checkpointed DB; copying an arbitrary live main file alone is not a reliable backup. Normal
commands may migrate on open. Reinstalling an older binary is not database rollback; after
a migration, only a compatible binary or a coordinated backup restore is safe. The updater
does not orchestrate backup/restore/downgrade.

Restart running board/MCP sessions after a verified update. Source-pinned harness commands
still point at source and need deliberate manual rewiring if desired. If you separately
upgrade Bun through mise/asdf, existing harness entries can still point at the old Bun;
review and explicitly run `kabane mcp install --force` when you want to re-point them;
`kabane doctor` names each entry that no longer launches this kabane.

### Beta installs

A beta install runs a `X.Y.Z-beta.N` version. `kabane update` reads the newest beta and the latest
release and takes the higher by SemVer precedence, so `1.0.0-beta.1` moves to `1.0.0-beta.2` and
then to `1.0.0` when it ships; from there it follows the latest release like any stable install.
When neither is newer than the installed beta, the reply is **current**. The same major
boundary and verified replacement apply, and nothing older than the installed version is
installed. A prerelease other than `beta.N` is refused with manual guidance. A stable install
never takes a beta; to try one, install it by its version ([install](#install)).

## Starting over

```bash
rm -rf ~/.kabane
claude mcp remove kabane -s user
codex mcp remove kabane
gemini mcp remove -s user kabane
```

The next `kabane` shows the setup screen again.

## Rough edges

Known rough edges:

- **Short ids start with `J`.** A short id is `J` plus the first letters of the scope
  (`JMYA-1` in `myapp`), whatever the project is called.
- **Sync means hosting a hub.** More than one machine needs the Cloudflare hub in
  [`deploy.md`](deploy.md), on your own Cloudflare account and domain.
- **Add the git remote before you file tasks.** A repo with no remote is scoped by its first
  commit (`git:<hash>`). Once a remote is added, the scope switches to the remote, and the
  tasks filed under the commit scope stop showing in that repo's board.

## Export and rebuild the record

Run `kabane export <dir> --check` to back up the whole device’s replicated rows across all scopes
and test the rebuild. The argument names the output directory. Scoped export is proposed.
Choose a directory without an existing `record.jsonl` or `manifest.json`.
The JSON Lines file starts with the format and schema versions, followed by
one document per replicated row, including private rows. Protect the directory
accordingly. The manifest records each table's row count and SHA-256 digest in
row ID order. The check prints those values and ends with `match` (exit 0) or
`differ` (exit 1). Omit `--check` to just write the files.

Run `kabane import <dir> --into <home>` with the
same core and registered module schema versions. It rebuilds the database
through normal migrations and checks the manifest before creating
`<home>/kabane.db`. An existing database is refused. Device configuration,
sync history, and tables outside the registered replication set are excluded.
