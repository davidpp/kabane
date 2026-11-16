# dispatch

A kabane extension that gives a project two agent skills, and keeps them current:

- **dispatch**, which a coding session follows to turn an ask into kabane issues and into
  shipped work. The board's copilot fills it for the project with `/setup-dispatch`.
- **grill**, which walks you through the questions agents left open with `kabane_ask`, one at a
  time. Ask the copilot to "grill me"; any harness with the kabane MCP can follow it.

Base kabane works without it: with the extension not enabled, the copilot neither offers
`/setup-dispatch` nor knows about these skills.

## Install

The extension is a directory extension, built separately from kabane. From a kabane source
checkout with dependencies installed:

```bash
bun run --cwd extensions/dispatch build
mkdir -p "${KABANE_HOME:-$HOME/.kabane}/extensions/dispatch"
cp -R extensions/dispatch/dist/. "${KABANE_HOME:-$HOME/.kabane}/extensions/dispatch/"
```

Add `"dispatch"` to the `extensions` array in `$KABANE_HOME/config.json` (default
`~/.kabane/config.json`), keeping any extensions already there. If the list is empty,
`kabane config set extensions dispatch --layer global` enables it. Restart a running board or
MCP server after installing or enabling it.

The artifact holds the templates and the copilot's files; the compiled binary loads only the
built `dist/`. A source checkout can instead be symlinked from `extensions/dispatch` into
`$KABANE_HOME/extensions/dispatch` when kabane runs through Bun. `bun run sandbox` makes that link
in its disposable home.

Upgrading from a kabane that shipped these skills itself changes nothing in your projects: a
skill `/setup-dispatch` wrote then keeps working, and its stamp compares equal against this
extension's template, which is the same bytes.

## Setting up the dispatch skill

`/setup-dispatch` in the copilot reads the project's `CLAUDE.md`/`AGENTS.md`, its gate commands
and `.claude/agents/`, then writes `.agents/skills/dispatch/` from this extension's template.
Codex and Pi read `.agents/skills/`; Claude Code reads only `.claude/skills/`, so the copilot links
`.claude/skills/dispatch` to `../../.agents/skills/dispatch` when the project already has a
`.claude/` directory or you ask, and otherwise tells you the command that adds the link. On a
project with no dispatch skill yet it writes the skill first, then shows you each file; deleting
the directory undoes it. When `.agents/skills/dispatch/` exists, it shows the diff and writes
nothing without your yes. A real `.claude/skills/dispatch/` directory keeps working; the copilot
offers to move it and leave the link.

The written `SKILL.md` records which template it was filled from as `metadata.kabane-template`
in its frontmatter, a value such as `dispatch@<12-character hash>`. `kabane dispatch stamp`
prints the current one. Keep the line when you edit the skill, and do not replace it by hand:
`/setup-dispatch` refreshes the skill while keeping the project's edits.

## Doctor

With the extension enabled, `kabane doctor` reports, under the source `dispatch`:

| Finding | Severity | Meaning |
|---|---|---|
| `dispatch-skill-missing` | suggest | no dispatch skill; `/setup-dispatch` writes one |
| `dispatch-skill-location` | route | the skill is a real `.claude/skills/dispatch/` directory; `/setup-dispatch` offers the move |
| `dispatch-skill-unstamped` | route | the skill has no `kabane-template`; `/setup-dispatch` re-fills it |
| `dispatch-skill-behind` | route | the template changed since the skill was filled; `/setup-dispatch` re-fills it |
| `dispatch-template-unavailable` | mention | the extension's own template cannot be read; reinstall it |
| `grill-skill-behind` | mention | a copy of the grill skill differs; `kabane doctor --fix dispatch/grill-skill-behind` copies the template over it |

Without the extension, a project skill that carries a `kabane-template` stamp is one finding of
base kabane, `project/skill-unchecked`: the skill works as written, and doctor says it cannot
tell whether it is current.
