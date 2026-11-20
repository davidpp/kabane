# dispatch

A kabane extension that gives your sessions two agent skills:

- **dispatch**, which a coding session follows to turn an ask into kabane issues and into
  shipped work. The extension's setup-dispatch skill fills it for the project: `/setup-dispatch`
  on the board, or any session connected to kabane's MCP server.
- **grill**, which walks you through the questions agents left open with `kabane_ask`, one at a
  time. `kabane mcp` serves it, so ask the copilot, or any session connected to kabane's MCP
  server, to "grill me". Nothing is copied into the project. A copy an earlier version installed
  under `.agents/skills/grill/` is no longer checked; delete it to use the served skill.

Base kabane works without it: with the extension not enabled, `kabane mcp` serves neither
skill, and the copilot does not offer `/setup-dispatch`.

## Install

Build it from a kabane checkout and install it under `$KABANE_HOME/extensions/dispatch`, as
[the extensions guide](../../docs/extensions.md) says. The build holds the templates, the
copilot's files and the two skills `kabane mcp` serves, setup-dispatch and grill. `kabane dispatch stamp` answers once it is enabled.

A skill that `/setup-dispatch` wrote before this extension existed keeps working as written. One
written by 1.0.0-beta.0 carries no `metadata.kabane-template`, and the template has changed
since, so with the extension enabled `kabane doctor` reports `dispatch-skill-unstamped` for it
([upgrading from 1.0.0-beta.0](../../docs/getting-started.md#upgrading-from-100-beta0-the-loop-and-dispatch-are-extensions-you-install)).
One written by a later source build carries a stamp, which compares equal against this
extension's template while the template's bytes are unchanged.

## Setting up the dispatch skill

The extension ships the setup as a skill, `skills/setup-dispatch/`, which `kabane mcp` serves
through `kabane_skillList` and `kabane_skillGet`. Nothing is installed: on the board, type
`/setup-dispatch`; in any other session connected to kabane (Claude Code, Codex, Pi), ask it to
set up dispatch, or to run the setup-dispatch skill.

Run with no option, it shows a menu that leads with what the project needs: `init` when the
project has no dispatch skill, `refresh` when `kabane doctor` says the skill is behind the
template or carries no stamp. It runs nothing until you pick. Name an option to skip the menu:

| Option | What it does |
|---|---|
| `init` | writes a dispatch skill for a project that has none |
| `refresh` | re-fills an existing skill from the current template, keeping its recorded answers and your edits |
| `upstream`, `goals`, `harnesses`, `research` | asks that one question again, then refreshes the skill with the answer |

The setup reads the project's `CLAUDE.md`/`AGENTS.md`, its gate commands and `.claude/agents/`,
asks you what those files leave open, then writes `.agents/skills/dispatch/` from this
extension's template.
Codex, Pi, opencode and Gemini CLI read `.agents/skills/`; Claude Code reads only
`.claude/skills/`, so the setup links `.claude/skills/dispatch` to
`../../.agents/skills/dispatch` when the project already has a `.claude/` directory or you ask,
and otherwise tells you the command that adds the link. On a project with no dispatch skill yet
it writes the skill first, then shows you each file; deleting the directory undoes it. When
`.agents/skills/dispatch/` exists, it shows the diff and writes nothing without your yes. A real
`.claude/skills/dispatch/` directory keeps working; the setup offers to move it and leave the
link.

It settles six questions, and asks you only those the project's files do not answer, through
your harness's choice prompt with the recommended answer first. Every choice a question lists is
offered, whatever the files make likely:

| Question | Recommended | When the answer is not the recommended one |
|---|---|---|
| Team record: none, GitHub Issues or Linear | none | copies `references/upstream.md`: the team's tracker holds the requests, kabane the breakdown below them |
| Goals: is work carried as goals, by a steward? | no | copies `references/goals.md` |
| Integration: local merge, pull request with auto-merge, or pull request a person merges | what the files show, else a local merge | |
| Harnesses: one, or several reviewing each other | one | copies `references/cross-harness.md` |
| Research: kept with the decisions, or run apart and kept elsewhere | with the decisions | copies `references/research.md` |
| Tags: the descriptive tags issues carry | `bug`, `research`, `design` | |

The answers, with the file that settled each one or `asked`, and the overlays copied are
recorded in the skill's `## This project` section. A later refresh reads them back
from there and asks only what is missing; edit a line there to change an answer, and the next
refresh copies or removes the overlay it selects. The template's
[examples](templates/examples/) show that section for three setups: one person landing on main
([solo-on-main](templates/examples/solo-on-main.md)), a team on GitHub with pull requests
([team-with-prs](templates/examples/team-with-prs.md)), and goals carried by a steward on two
harnesses ([goals-and-steward](templates/examples/goals-and-steward.md)). The questions are not
the go-ahead to write: that rule is the one below.

The written `SKILL.md` records which template it was filled from as `metadata.kabane-template`
in its frontmatter, a value such as `dispatch@<12-character hash>`. `kabane dispatch stamp`
prints the current one. Keep the line when you edit the skill, and do not replace it by hand:
the setup skill's `refresh` re-fills the skill while keeping the project's edits.

Each harness lists the skill under its own name and calls it its own way. A session also picks
it up unasked when an ask matches its description.

| Harness | Reads | Calls it |
|---|---|---|
| Claude Code | `.claude/skills/dispatch` (the link) | `/dispatch` |
| Codex | `.agents/skills/dispatch` | `$dispatch`, or `/skills`; Codex has no `/dispatch` command |
| Pi | `.agents/skills/dispatch` | `/skill:dispatch` |
| opencode | `.agents/skills/dispatch` or `.claude/skills/dispatch` | its `skill` tool, by name |
| Gemini CLI | `.agents/skills/dispatch` | `/skills list` shows it; the model activates it when an ask matches |

Codex's `/skills` menu can switch a skill off for every session, which it saves to
`~/.codex/config.toml` as a `[[skills.config]]` entry with `enabled = false`. A switched-off skill
is not listed; switch it back on in the same menu. Pi loads a project's `.agents/skills/` only
in a folder you trust: interactive Pi asks, and its print and RPC modes skip the skill unless the
folder is trusted (`/trust`, saved in `~/.pi/agent/trust.json`) or the run passes `--approve`.

## Doctor

With the extension enabled, `kabane doctor` reports, under the source `dispatch`:

| Finding | Severity | Meaning |
|---|---|---|
| `dispatch-skill-missing` | suggest | no dispatch skill; the setup-dispatch skill writes one |
| `dispatch-skill-location` | route | the skill is a real `.claude/skills/dispatch/` directory; the setup-dispatch skill offers the move |
| `dispatch-skill-unstamped` | route | the skill has no `kabane-template`; the setup-dispatch skill re-fills it |
| `dispatch-skill-behind` | route | the template changed since the skill was filled; the setup-dispatch skill re-fills it |
| `dispatch-template-unavailable` | mention | the extension's own template cannot be read; reinstall it |
| `dispatch-skill-unlinked` | mention | the project has `.claude/` but no `.claude/skills/dispatch` link, so Claude Code does not list the skill; `kabane doctor --fix dispatch/dispatch-skill-unlinked` adds the link. A link that leads anywhere but `.agents/skills/dispatch` is reported with no fix |

Without the extension, a project skill that carries a `kabane-template` stamp is one finding of
base kabane, `project/skill-unchecked`: the skill works as written, and doctor says it cannot
tell whether it is current.
