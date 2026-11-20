---
name: setup-dispatch
description: Write or refresh this project's dispatch skill (.agents/skills/dispatch/) from the dispatch extension's template, or change one of its setup answers (team record, goals, harnesses, research). Use when the human asks to set up dispatch, refresh or update the dispatch skill, or connect it to GitHub Issues or Linear, when /setup-dispatch is typed, or when kabane doctor routes a dispatch-skill finding here.
argument-hint: "[init | refresh | upstream | goals | harnesses | research]"
---

# Setting up a dispatch skill

A dispatch skill is how a coding session in this project turns an ask into issues on this board and into shipped work. The dispatch extension ships a generic one at {{extension}}/templates/dispatch: SKILL.md and references/ are the skill, except the overlays PLACEHOLDERS.md lists under ## Overlays, which are copied only when an answer selects them. PLACEHOLDERS.md says what fills each {{NAME}} and which questions settle the project's setup.

The project root is your working directory. Every kabane command below is `{{kabane}}`, written as it stands: it is the kabane, and the home, that the MCP server serving this skill runs, which a `kabane` on PATH may not be.

## Options

| Option | What it does | Reference |
|---|---|---|
| `init` | Writes a dispatch skill for a project that has none | [references/init.md](references/init.md) |
| `refresh` | Re-fills an existing skill from the current template, keeping its recorded answers and the project's edits | [references/refresh.md](references/refresh.md) |
| `upstream` | Asks the team record question again: none, GitHub Issues or Linear | [references/upstream.md](references/upstream.md) |
| `goals` | Asks the goals question again: is work carried as goals, by a steward? | [references/goals.md](references/goals.md) |
| `harnesses` | Asks the harnesses question again: one, or several reviewing each other | [references/harnesses.md](references/harnesses.md) |
| `research` | Asks the research question again: kept with the decisions, or run apart | [references/research.md](references/research.md) |

Read a reference with `kabane_skillGet` and `name: "setup-dispatch"`, its path from the skill's directory as `file` (`references/init.md`); a link inside a reference is relative to `references/`. Read only the one the option needs.

## Routing

- **An option named, or clearly implied** ("refresh the dispatch skill", "we use Linear" for `upstream`): read its reference and follow it. When two fit, ask which.
- **No option:** build the menu below, show it, and ask which option to run. A bare "set up dispatch" or `/setup-dispatch` names no option. Never run one before the human picks: the menu is a suggestion, and the pick is the request the write rule below speaks of.

The menu leads with what the project shows:

1. No `.agents/skills/dispatch/SKILL.md` and no `.claude/skills/dispatch/SKILL.md`: lead with `init`, in one line saying the project has no dispatch skill.
2. Otherwise run `{{kabane}} doctor --json` and read the findings under the source `dispatch`. `dispatch-skill-behind` or `dispatch-skill-unstamped`: lead with `refresh`, quoting the stamp the skill carries and the template's. `dispatch-skill-location`: lead with `refresh`, which offers the move.
3. Nothing to lead with: show the answers the skill's `## This project` section records, one line each, so the human sees which one to change.

Then the full options table. Ask through your harness's own choice prompt whenever it has one, the lead option first, and in plain text, ending your turn on it, only where it has none.

## Reading the project

Read what the project says about itself before writing anything: CLAUDE.md and AGENTS.md, the package manifest's scripts and the gate the instructions name, .claude/agents/, any testing constraints, where it keeps decisions, research and docs, how it names branches, worktrees and commits, and whether the recent git log merges locally or through pull requests.

PLACEHOLDERS.md takes the scope and the issue prefix from the board context block. A session outside the board has none: take the scope's `scopeUri` from `{{kabane}} scope --json`, run in the project root, and the prefix from this scope's issue ids (`kabane_list`). When the scope has no issue yet, file the handoff issue below first and take the prefix from the id it returns.

## Asking the questions

Settle the questions under ## Questions in PLACEHOLDERS.md. Answer each one from the project's files where they settle it, and note the file that did. When the project already has a dispatch skill, read its ## This project section first and keep every answer it records, so a refresh asks only what it leaves unanswered. Ask the ones that remain together, in as few prompts as your harness allows: through your harness's own choice prompt whenever it has one, each question's choices as its options and the recommended one first, and in plain text, ending your turn on it, only where it has none. Write nothing until they are answered.

Offer every choice the question lists, as PLACEHOLDERS.md words it. Never drop, merge or reword a choice, and never leave one out because the project's files make it look unlikely: an answer the files did not settle is the human's to pick from the whole list. A choice the human's request already names ("we use Linear") is not yet their answer: still ask that question, with the named choice as the recommended one and every other choice offered after it, so they confirm it from the whole list.

{{extension}}/templates/examples/ shows the ## This project section for three setups: one person landing on main, a team on GitHub with pull requests, and goals carried by a steward. The answers fill {{SETUP_ANSWERS}}, each with its source, and select the overlays: copy an overlay only when an answer selects it, and on a refresh an overlay the answers no longer select is removed, which the diff shows. The answers are about the project, not permission to write: the write rule below still decides whether you write without asking.

## Filling the template

Fill every placeholder from what you read and what the human answered. Only the project's own files count: your harness may also have loaded the human's personal instructions, and those are theirs, not something a project skill should hand to everyone who clones the repo. {{TEMPLATE_STAMP}} takes what `{{kabane}} dispatch stamp` prints, run in the project root and copied exactly: it records which template the skill was filled from, so never compute it or carry over an older one. When that command fails, report its error, ask the human to reinstall the dispatch extension, and never invent a stamp. Every coding session here will follow the written skill literally, so it must contain no {{, nothing about a project that is not this one, and no convention you inferred where PLACEHOLDERS.md gives a fallback.

## Writing

Write only under .agents/skills/dispatch/ in the project root, plus the one link below: the rest of the project is the code the issues describe, which stays the coding session's to change. When neither .agents/skills/dispatch/ nor a real .claude/skills/dispatch/ directory exists yet, being asked to set the skill up is the go-ahead: write the files without asking, then show the content of each one, so the human reads what every future session will be told, and say that deleting the directory undoes it. If .agents/skills/dispatch/ already exists, show the diff and write nothing without an explicit yes, because it may hold their own edits. Codex, Pi, opencode and Gemini read .agents/skills/; Claude Code reads only .claude/skills/, so it reaches the skill through a relative symlink: .claude/skills/dispatch pointing to ../../.agents/skills/dispatch. Create that link when the project root already has a .claude/ directory or the human asks for it; otherwise say in your report that `ln -s ../../.agents/skills/dispatch .claude/skills/dispatch`, run from the project root after creating .claude/skills/, adds it. Write it once; never copy or sync skills between harness directories. When .claude/skills/dispatch/ is a real directory rather than that link, it is the human's existing skill: offer to move it to .agents/skills/dispatch/ and leave the link in its place, show the diff against what you would write, and move or write nothing without an explicit yes.

## Handing off

Finish by handing off what you generated with kabane_handoff on the selected issue; when nothing is selected, first file one in this scope with kabane_add and hand off on the id it returns. The handoff names the files written, the overlays copied, each answer and whether the project's files or the human gave it, the gate commands and agents the skill uses, and, as not verified, any placeholder you had to fall back on.
