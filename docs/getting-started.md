# Getting started

Kabane is a local-first issue tracker and kanban for you and your coding agents. You work in
a terminal board; Claude Code, Codex and Gemini CLI read and write the same tasks through an
MCP server running on your machine. Everything lives in one SQLite file under `~/.kabane`.

This guide covers one machine with local storage, which is a complete setup on its own.
Syncing several machines through a Cloudflare hub is optional and lives in
[`deploy.md`](deploy.md). The project was called Cabane; [the README](../README.md) explains
why some internal names still use it.

## Prerequisites

- **Bun 1.4.4 or later**, the version the repo pins in `.bun-version`. `bun --version` to check.
- **git**, for detecting project scopes. You do not need to clone Kabane for local use.
- **Optional: a coding harness.** Claude Code, Codex or Gemini CLI on your PATH, logged in.
  Setup wires any it finds, and the board's copilot runs one.

## Install

Install the npm package with Bun:

```bash
bun add -g kabane
kabane --help | head -1
```

The last line prints `kabane — local-first tracker for humans and agent runtimes`. If it
prints `command not found` instead, add `~/.bun/bin` to your PATH. Install globally before
setup registers coding agents: their MCP entries point at the installed file. To work on
Kabane itself from source, use the [clone and `bun link` path](../README.md#install).

`bun add -g kabane@beta` installs the current beta, which updates along its own channel
([beta installs](#beta-installs)).

Standalone binaries arrive with the first release that ships binary assets; until then,
install with Bun as above. From such a release, download its `kabane-<os>-<arch>.tar.gz` and
`SHA256SUMS` from that [GitHub release](https://github.com/davidpp/kabane/releases), verify and
extract it following [the README](../README.md#install), and add the extracted directory to
PATH. macOS arm64/x64 and Linux arm64/x64 are planned; Linux x64 uses Bun's baseline CPU
target. Keep the extracted directory whole: `kabane update` knows a release by the
`templates/` directory beside the executable. A binary does not need the Bun prerequisite
above; git and your chosen harness's runtime requirements still apply.

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
  on everything you write: `cabane://actor/human/<name>`, lowercased with spaces as dashes.
  The scheme keeps the project's earlier name, Cabane, because every row stores it.
- **agents** lists the harnesses found on your PATH, all checked. Tab or the arrow keys
  move between rows, and space unchecks one. Each checked harness gets a `kabane` entry in
  its user-level MCP config (its own `mcp add`). With none on your PATH the row reads
  `none found on PATH`; install one, then run `kabane mcp install`. With `KABANE_HARNESSES`
  set and nothing it names on your PATH, the row reads `install off` instead (that is what
  `bun run sandbox` shows).
- The lines under **enter** follow the form: uncheck every agent and the `adds` and
  `files` lines go. Outside a project, there is no `files` line. A long config path is cut
  from the left, `…/.kabane/config.json`, to fit the pane.

The screen does not ask for a device name: setup saves the short hostname. It only matters
once sync is set up, and [deploy.md](deploy.md) says how to change it before the first push.
To change your name later, edit `actor` in `~/.kabane/config.json`; to add an agent later,
run `kabane mcp install`.

Enter saves the config, adds kabane to each checked harness, and files your first issue.
What happened and the first issue each get a panel, with the phrase to say highlighted:

```
✓ saved ~/.kabane/config.json

Claude Code    ✓ installed
Codex          ✓ installed
Gemini CLI     ✓ installed

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
opens the board. With no agent checked, enter opens the board straight away. Esc on the
setup screen, before confirming, leaves without writing anything. After this, `kabane`
always opens the board directly.

What setup changed outside `~/.kabane`: one user-scope MCP entry named `kabane` in each
checked harness, added through that harness's own `mcp add`:

| Harness | File | Entry runs |
|---|---|---|
| Claude Code | `~/.claude.json` | `<bun> <installed kabane bin> mcp --as cabane://actor/agent/claude` |
| Codex | `~/.codex/config.toml` | the same, `--as cabane://actor/agent/codex` |
| Gemini CLI | `~/.gemini/settings.json` | the same, `--as cabane://actor/agent/gemini` |

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
  checklist, the latest handoff as a digest, the decisions made, its subtasks and its links,
  where `J/K` move a cursor and `enter` opens the issue under it), the description (with its curated context), the comments, and the log of work
  and agent activity. It opens on `now` when anything is in it. `1`-`4` or `h`/`l` switch
  sections. `j`/`k` scroll a section, `ctrl+d`/`ctrl+u` by half a page, and `g`/`G` go to its
  top and its end; the `?` sheet and the transcript scroll the same way.
- `r` on a task's detail reads its latest handoff in full, `[`/`]` jump between its headings,
  `esc` closes it. A part of `now` that changed while the detail was open reads `✦` until you
  have looked at it.
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
open, one at a time. Without it, the copilot offers neither. A skill an
earlier kabane wrote keeps working without the extension; `kabane doctor` then says it cannot
tell whether that skill is current. [Extensions](extensions.md) says how to install it.

`/doctor` checks that what kabane wrote is current: see [Keeping kabane current](#keeping-kabane-current).

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
claude mcp get kabane      # Status: ✔ Connected, Args: … mcp --as cabane://actor/agent/claude
codex mcp get kabane       # args: … mcp --as cabane://actor/agent/codex
gemini mcp list            # ✓ kabane: … mcp --as cabane://actor/agent/gemini (stdio) - Connected
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
exactly: `--assignee cabane://actor/agent/claude` finds nothing.

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

### Hearing about a release

The board says when a release your install would update to is out: a line over its footer,
`kabane <version> is out · run kabane update`, until `esc` or a click on it dismisses it. A binary mise
installed says `run mise up kabane` instead, and an install `kabane update` would refuse says
`update it the way you installed it`. It is the release
`kabane update --check` would name, on your channel and within your major (minor for `0.x`).
The board reads npm's `latest` and `beta` dist-tags at most once a day, after its first
frame, and keeps them in `KABANE_HOME/update-check.json`. Bun's registry and proxy settings
do not apply to that read. When the registry cannot be reached, nothing is shown and the board
carries on. Only the board checks: `kabane mcp`, a piped command and every other command never
do, and a run from a source checkout never shows the line. The check installs nothing. To turn
it off:

```bash
kabane config set updates.check false
```

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
setting rather than a broken one, and `route` names the procedure that repairs it, such as
the dispatch extension's setup-dispatch skill. Findings are not errors, and the command succeeds when it has some.

In the board, `/doctor` has the copilot run the same report and act on it: it applies the
`auto` fixes without asking, tells you each `mention` and `suggest` and waits for your yes,
and offers the procedure a `route` names. It never rewrites a harness's MCP entry itself; it
gives you the `kabane doctor --fix` command to run.

Scripts reading `kabane mcp install --json` must accept `reports[].status: "stale"`
for an existing entry whose launch differs from this installation. It previously returned
`present`; the exit code remains 0 and the entry is unchanged. Text now says
`registered with another command` instead of `already installed` for that state.
Use `--force` or the named doctor repair only when you want to re-point it.

### Standalone binaries

This applies once a release ships binaries ([install](#install)).

```bash
kabane update --check        # metadata only: the candidate from npm's dist-tags
kabane update               # download, verify and replace this binary
```

A binary follows the same channel and version policy as a Bun install
([subsequent updates](#subsequent-updates), [beta installs](#beta-installs)); it reads npm's
dist-tags over HTTPS, so Bun's registry and proxy settings do not apply. `kabane update`
downloads `kabane-<os>-<arch>.tar.gz` and `SHA256SUMS` from that version's
[GitHub release](https://github.com/davidpp/kabane/releases) and refuses on any checksum
mismatch. It extracts into a temporary directory beside the executable, runs the new
`kabane --version` and requires the candidate version, then renames the new executable and
`templates/` (empty now that kabane ships no template) over the old ones. A symlink on PATH is followed to the real executable, so
harness MCP entries that point at it keep working. A failure before the rename leaves the old
install as it was. The executable needs `templates/` beside it, as extracted from the release,
and its directory must be writable; otherwise replace the directory with a verified download
by hand. Restart running board/MCP sessions afterwards.

When the executable sits under a mise installs directory (`$MISE_DATA_DIR`, `$XDG_DATA_HOME/mise` or
`~/.local/share/mise`), `kabane update` reports the candidate and leaves the file to mise: run
`mise up kabane`. No tracker DB is opened and no harness entry is rewired.

### Upgrading: kabane needs Bun 1.4.4

Releases before this one declared `engines.bun` `>=1.4.0`. This one declares `engines.bun` `>=1.4.4`, and each
release now asks for the Bun the repo pins in `.bun-version`. On an older Bun, `kabane update`
installs nothing: `--check` answers `manual_only` with the Bun it needs, and `--json` gives it
as `requiredBun`:

```text
Latest stable <version> needs Bun 1.4.4 or later; this Bun is 1.4.1. Run bun upgrade, then kabane update again. Eligibility is policy-unverified.
```

Upgrade Bun first, then update kabane. If a version manager such as mise installed that Bun,
upgrade it there, and see [subsequent updates](#subsequent-updates) for harness entries that
still point at the old Bun. The standalone binary carries its own Bun and is not affected.

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

### Upgrading from 1.0.0-beta.0: the loop and dispatch are extensions you install

In 1.0.0-beta.0 the loop came inside kabane, and `"extensions": ["loop"]` in `config.json` turned
it on. The dispatch skill's template and `/setup-dispatch` came with the copilot. Kabane now
bundles neither: the loop and the [dispatch extension](../extensions/dispatch/README.md), which
holds the dispatch and grill skills and `/setup-dispatch`, are directories you build and install
yourself. Updating kabane does not install them.

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

`kabane doctor` reports the missing directory as `loop/extension-refused` under `mention`. The
board writes nothing on stderr; it shows `Extension loop refused: not installed` over its footer
until you press `esc`. On the board, `a` starts no run, and the copilot no longer offers
`/setup-dispatch`.

Kabane deletes nothing of the loop's. Its settings stay where you wrote them, `.kabane/loop.json`
in a project included, and are read again once the loop is installed and enabled. Its runs stay
under `KABANE_HOME/loops/`. Stop a loop runner the old version started before you update, as the
sections above say for every process of the old version.

To get the loop back, build it from a clone of this repository. This needs git and
[Bun](https://bun.sh) 1.4 or later, also when you run the npm package or the standalone binary.
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

### One-time upgrade from 0.1.0

Version 0.1.0 predates `kabane update`. For an existing **Bun global registry install**, stop
running board/MCP sessions, read the new release's compatibility notes, then install that
published version once:

```bash
version='<published-version>'  # replace with the version from the new release
bun add --global --exact "kabane@$version"
kabane --version              # must print the selected version
kabane update --check
```

Do not run this against a source `bun link` installation: it would replace your development
link. Keep source-linked installations on the contributor checkout/build/link path. No
tracker reset or `mcp install --force` is needed for an existing registry installation whose
harness command still points to the same global executable; restart its board/MCP processes.

If the selected version is still registry `latest`, `update --check` reports **current**;
`kabane update` is then a no-op, not an upgrade. A later eligible release produces a
**candidate**, and `kabane update` performs the policy preflight and verified installation.
`--check` never installs and does not certify that Bun's policy will allow installation.

### Try the registry flow without replacing a development link

After the new version is published, run this in a subshell. It installs into disposable
Bun directories while preserving your registry/auth/release-age configuration. It does
not use your real tracker, change PATH, register harnesses or replace your existing bin.

```bash
(
  set -eu
  version='<published-version>'  # replace before running
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  export BUN_INSTALL="$work/bun"
  export BUN_INSTALL_GLOBAL_DIR="$work/global"
  export BUN_INSTALL_BIN="$work/bin"
  export BUN_INSTALL_CACHE_DIR="$work/cache"
  export BUN_RUNTIME_TRANSPILER_CACHE_PATH="$work/transpile-cache"
  export KABANE_HOME="$work/tracker"
  export KABANE_HARNESSES=
  mkdir -p "$work/bin"
  bun add --global --exact "kabane@$version" --linker hoisted
  "$work/bin/kabane" --version
  "$work/bin/kabane" update --check
  "$work/bin/kabane" update
)
```

Installing the current latest tests bootstrap, ownership detection and the current/no-op
path. It cannot demonstrate a real version transition until a newer eligible release exists.
If Bun blocks a fresh release under your release-age policy, wait; do not weaken the policy.

### Subsequent updates

```bash
kabane update --check        # metadata-only candidate, eligibility unknown/policy-unverified
kabane update               # explicit policy preflight, exact install, owned-bin verification
```

Supported: positively identified **hoisted Bun global registry installs**, including proven
explicit global-directory overrides. Source `bun link`, development, local-tarball,
other-manager and unknown/missing-global-bin layouts are refused with manual guidance, and
`--check` is refused with them: it reads registry metadata only for an install `kabane update`
could replace, so on these layouts both commands print `Unsupported installation; ...` (status
`unsupported` in `--json`), exit 1 and make no registry request. A tarball installed with
`bun add -g ./kabane-<version>.tgz`, as the release smoke test does, is one of them.
No internal-bin/PATH fallback or link repair is performed. This is not a claim that every
Bun isolated layout is broken; unverified layouts are simply outside this updater's support.

A stable install selects registry `latest`, stable only, within the installed major; `0.x`
stays within its minor. A beta install follows its own channel ([beta installs](#beta-installs)).
The installed version picks the channel: no historical fallback, prerelease/channel/force
option, implicit downgrade or major/pre-1.0 minor jump. Crossing that boundary requires
reviewing compatibility notes and choosing an explicit manual `bun add -g kabane@<version>`;
do not overwrite a source link.
Check and current/no-op results do **not** validate installation eligibility. Update uses
Bun's exact-target policy-enforcing dry-run before installation; exact requests honor release
age but bypass Bun's range-resolution stability heuristic. Metadata/runtime caches may be
maintained; preflight can download/extract into external package-manager cache. No age,
integrity, registry/proxy settings or user config are weakened. A configured Bun dry-run
requests no installation and is conservatively refused by explicit update.

No tracker config/DB is opened, migrated or deleted by check/update, and no harness entry
is rewired. `kabane mcp` makes no network check; the board's release notice is the only
check that runs on its own ([hearing about a release](#hearing-about-a-release)). A manager failure, timeout, missing bin
or mismatched installed version is nonzero and may have changed the executable partially;
inspect the installation manually, without automatic rollback/repair.

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

A `kabane@beta` install runs a `X.Y.Z-beta.N` version. `kabane update` reads both registry
`beta` and `latest` and takes the higher by SemVer precedence, so `1.0.0-beta.0` moves to
`1.0.0-beta.1` and then to `1.0.0` when it ships; from there it follows `latest` like any
stable install. When neither tag is newer than the installed beta, the reply is **current**.
The same major boundary, Bun engine check, policy preflight and verified exact install apply,
and nothing older than the installed version is installed. A prerelease on either tag other
than `beta.N` is refused with manual guidance. A stable install never reads `beta`; to move
one onto the beta, install it explicitly with `bun add -g kabane@beta`.

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
