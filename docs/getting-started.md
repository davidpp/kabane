# Getting started

Cabane is a local-first issue tracker and kanban for you and your coding agents. You work in
a terminal board; Claude Code, Codex and Gemini CLI read and write the same tasks through an
MCP server running on your machine. Everything lives in one SQLite file under `~/.cabane`.

This guide covers one machine with local storage, which is a complete setup on its own.
Syncing several machines through a Cloudflare hub is optional and lives in
[`deploy.md`](deploy.md).

## Prerequisites

- **Bun 1.4 or later.** The repo pins `1.4.0` in `.bun-version`. `bun --version` to check.
- **Read access to the repo.** It is private and has no npm package yet, so ask David to
  add your GitHub account.
- **Optional: a coding harness.** Claude Code, Codex or Gemini CLI on your PATH, logged in.
  Setup wires any it finds, and the board's copilot runs one.

## Install

```bash
git clone git@github.com:davidpp/cabane.git ~/Projects/cabane
cd ~/Projects/cabane && bun install
cd packages/cli && bun link
cabane --help | head -1
```

`bun link` prints `Success! Registered "cabane"`. The last line prints
`cabane — local-first tracker for humans and agent runtimes`. If it prints
`command not found` instead, add `~/.bun/bin` to your PATH. That is where `bun link` puts
the binary.

The link points at your clone, so pulling the clone updates the command. You can put the
clone anywhere; the harness entries record its absolute path.

## Run `cabane`

Run `cabane` from inside a project you want to track. The first run opens a setup screen:

```
cabane · setup
› name   alex                      cabane://actor/human/alex
  device alex-mbp
wire the cabane mcp server into
  [x] Claude Code
  [x] Codex
  [x] Gemini CLI
  [ ] pin this repo's scope · myapp (github.com/alex/myapp)
several machines? cabane init --sync-url … --sync-token … (docs/deploy.md)
tab/↑↓ move · space toggle · enter confirm · esc quit
```

- **name** is prefilled with your OS username. It becomes your actor, the identity stamped
  on everything you write: `cabane://actor/human/<name>`.
- **device** is this machine's name, prefilled with the short hostname.
- **wire the cabane mcp server into** lists the harnesses found on your PATH, all checked.
  Space unchecks one. If none are found, the screen says so and points at
  `cabane mcp install --print`.
- **pin this repo's scope** appears when you run setup inside a git repo. Leave it off.
  Cabane already works out the scope from the git remote (or from the first commit when
  there is no remote) and caches it in `.cabane/scope` at the repo root.

Enter writes `~/.cabane/config.json` and wires each checked harness:

```
✓ wrote /Users/alex/.cabane/config.json

Claude Code    ✓ installed as cabane://actor/agent/claude
Codex          ✓ installed as cabane://actor/agent/codex
Gemini CLI     ✓ installed as cabane://actor/agent/gemini
```

Enter again opens the board. Esc before confirming leaves without writing anything. After
this, `cabane` always opens the board directly.

What setup changed outside `~/.cabane`: one user-scope MCP entry named `cabane` in each
checked harness, added through that harness's own `mcp add`:

| Harness | File | Entry runs |
|---|---|---|
| Claude Code | `~/.claude.json` | `<bun> <clone>/packages/cli/index.ts mcp --as cabane://actor/agent/claude` |
| Codex | `~/.codex/config.toml` | the same, `--as cabane://actor/agent/codex` |
| Gemini CLI | `~/.gemini/settings.json` | the same, `--as cabane://actor/agent/gemini` |

A harness that already has a `cabane` entry shows `· already installed` and is left alone.
`codex mcp add` rewrites the whole of `~/.codex/config.toml` in its own formatting. The
content stays the same, but keep a copy if you diff that file.

## The board

The board shows the scope of the directory you opened it in: the repo's name in the header,
tasks grouped by state. The footer lists the everyday keys, and `?` lists all of them:

- `j`/`k` move, `enter` opens a task, `esc` goes back, `q` quits.
- `[` and `]` move a task through the states (inbox, next, in progress, waiting, done).
  `d` marks it done, `n` next, `s` someday, `x` cancel.
- `/` filters as you type, `f` cycles open, done and cancelled, and review, `i` cycles the
  kind filter.
- `y` copies a task's agent brief to paste into any chat.
- `⌃z` undoes the last change.
- `a` is dispatch, a hook for host apps. On its own, cabane has no dispatcher.

The copilot is `A` (or `:`). It opens a one-line prompt at the bottom of the board and
hands a coding harness what you are looking at: the scope, the selected task, and anything
you marked with `m`. Type a request and press `enter`. The agent runs in the background,
the footer shows its last tool call, and the board reloads as its writes land. `o` opens
its transcript. Typing `/` in the prompt lists the shortcuts: `/triage`, `/refine`,
`/split`, `/duplicates`, `/reparent`, `/check-plan`, `/linear`, `/setup-dispatch`. Each one
expands into editable text, so you can read what will be sent before sending it.

`/setup-dispatch` is the only shortcut that writes files to your project. It reads the
project's `CLAUDE.md`/`AGENTS.md`, its gate commands and `.claude/agents/`, then writes a
dispatch skill under `.claude/skills/dispatch/` that lets your coding sessions turn asks
into cabane issues. It shows each file before writing it.

The copilot has three requirements of its own. Setup does not check any of them:

- **A logged-in harness.** The default is Claude Code: `claude` on PATH, run once to log
  in. To use another harness, add `"copilot": { "harness": "codex" }` (or `"gemini"`) to
  `~/.cabane/config.json`, or run `cabane board --copilot gemini` for a single run.
- **A few seconds on the first turn**, because it starts a pinned ACP adapter through
  `npx`. If that turn fails with an npm resolution error, check `~/.npmrc` for
  `min-release-age`. That setting hides recently published packages, including pinned
  versions. `NPM_CONFIG_USERCONFIG=/dev/null cabane board` bypasses it for one run.
- **A permission mode that does not ask first.** The session inherits your harness
  settings, including its permission mode. The board cannot answer a permission prompt
  yet, so a harness in an ask-first mode has those requests declined, and the transcript
  says so.

More detail is in [`deploy.md`](deploy.md) part 4.7.

## Agents

Setup registered one MCP server, `cabane`, per harness. Each harness writes as its own
actor, so the board and `cabane show` tell you who did what. Check the registration:

```bash
claude mcp get cabane      # Status: ✔ Connected, Args: … mcp --as cabane://actor/agent/claude
codex mcp get cabane       # args: … mcp --as cabane://actor/agent/codex
gemini mcp list            # ✓ cabane: … mcp --as cabane://actor/agent/gemini (stdio) - Connected
```

To wire a harness later, or re-wire one, use `cabane mcp install`. It takes
`--harness claude|codex|gemini` to pick one and `--force` to replace an existing entry.
For any other MCP client (Cursor, Windsurf and others), `cabane mcp install --print`
prints paste-ready config.

The server exposes `cabane_*` tools: `cabane_list`, `cabane_get`, `cabane_context`,
`cabane_add`, `cabane_edit`, `cabane_comment`, `cabane_done`, `cabane_search`,
`cabane_link` and a few more. The agent's working directory sets the default scope, so a
new task lands in the repo the agent is working in.

Agents use the tracker reliably only when the project tells them to. Paste this block into
the project's `CLAUDE.md` (Claude Code), `AGENTS.md` (Codex) or `GEMINI.md` (Gemini CLI):

```markdown
## Tracker

Work is tracked in cabane (MCP server `cabane`). Your assignee name is your harness: `claude`, `codex` or `gemini`.
- Before starting, `cabane_list` with `assignee` set to your name and `state: "next"`; read the task with `cabane_context`.
- Set the task `in_progress` with `cabane_edit` before touching code. Never take a task that is already in progress.
- When finished, `cabane_comment` what landed (files, commits, what is left), then `cabane_done`.
- File new work you find with `cabane_add` instead of doing it unasked.
```

The board shows assignees (`@claude`) but does not set them. Assign with
`cabane add "…" --assignee claude` or `cabane edit <id> --assignee claude`, or ask the
copilot to do it. The assignee is a plain name, not the actor URI, and `list` matches it
exactly: `--assignee cabane://actor/agent/claude` finds nothing.

## The CLI, for scripts and agents

Everything the board does is also a command. Every command takes `--json`:

```bash
cabane add "Write the README" --kind issue --assignee claude --priority high
cabane list                                  # open tasks in this repo's scope
cabane list --assignee claude --state next --json
cabane edit JMYA-1 --state in_progress
cabane comment JMYA-1 "README drafted"
cabane context JMYA-1                        # the full brief an agent reads
cabane done JMYA-1
cabane list --all                            # include done and cancelled
cabane search license
```

```
✓ Created 📥 🟠 🔧JMYA-1  Write the README @claude
```

Outside a repo, `list` and `search` span every scope. `cabane <command> --help` prints that
command's flags, `cabane --help` lists the commands, and
[`packages/cli/README.md`](../packages/cli/README.md) has the full reference.

## Updating

```bash
cd ~/Projects/cabane && git pull && bun install
```

No re-link is needed, and the database upgrades itself when it opens. If you upgrade Bun
through a version manager (mise, asdf), the harness entries still point at the old Bun
binary. Run `cabane mcp install --force` to re-point them.

## Starting over

```bash
rm -rf ~/.cabane
claude mcp remove cabane -s user
codex mcp remove cabane
gemini mcp remove -s user cabane
```

The next `cabane` shows the setup screen again.

## Rough edges

Cabane is unreleased. Known rough edges:

- **Ids and scopes still carry Jake's prefixes.** Cabane was extracted from a planner called
  Jake. Short ids start with `J` plus the first letters of the scope (`JMYA-1` in `myapp`),
  and scopes are `jake://scope/…` URIs (JCAB-70).
- **One machine only.** Sync needs the Cloudflare hub in [`deploy.md`](deploy.md), which is
  only David's for now.
- **Add the git remote before you file tasks.** A repo with no remote is scoped by its first
  commit (`git:<hash>`). Once a remote is added, the scope switches to the remote, and the
  tasks filed under the commit scope stop showing in that repo's board.
- **`a` (dispatch) does nothing** without a host app.
