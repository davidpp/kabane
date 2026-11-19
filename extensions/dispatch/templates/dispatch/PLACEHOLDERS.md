# Filling the dispatch template

The board copilot reads this file on `/setup-dispatch`. It is never copied into the project.
Replace every `{{NAME}}` in `SKILL.md` and `references/` with what the project itself says, so the
written skill contains no `{{` at all. `references/lenses/` holds none: copy its files as they
are. "The project" means the files in the repo. A personal
instructions file loaded from the user's home directory is not part of it, so none of its rules
belong in a skill that everyone who clones the repo will run. When the project says nothing
about a value, write the fallback given here. The fallback is safer than a convention the
project does not actually have, because the skill's agents will follow whatever the skill says
literally.

When the instructions file already states a value (the gate, the commit style, the testing
constraints), point at it instead of copying it: "the gate in CLAUDE.md". Every session loads
that file anyway, and a copy in the skill drifts away from it the first time either one is
edited. Copy a value only when the project leaves it unstated and the fallback below fills it.

- `{{TEMPLATE_STAMP}}`: the exact value kabane gives in the procedure, as DISPATCH TEMPLATE STAMP;
  never computed by hand. It tells a later kabane which template the skill was filled from.
- `{{PROJECT}}`: the project's name, from its package manifest or its instructions file.
- `{{ISSUE_PREFIX}}`: the prefix of this scope's issue ids as the board context block shows them
  (`ABC` for `ABC-12`). Take it from those ids and not from an example in the docs.
- `{{INSTRUCTIONS_FILE}}`: the file the harness loads automatically. That is `CLAUDE.md`,
  `AGENTS.md`, or both named together.
- `{{SCOPE_URI}}`: the scope from the board context block.
- `{{PARENT}}`: the project's standing parent issue, if its instructions name one (a PRD or a
  roadmap issue). Otherwise use `a parent issue created for the ask`.
- `{{MODEL}}`: the model rule from the project's instructions file, if it has one. Otherwise use
  `the session's model; name another one only when the user asks for it`.
- `{{WORKTREE}}`: how the instructions create a working copy per branch, including the setup
  step after it (an install), and how that copy is removed. Otherwise use `git worktree add
  ../<repo>-<branch> -b <branch>, then the project's install step; git worktree remove when
  merged`.
- `{{INTEGRATION}}`: how finished work reaches main. When the project's package scripts,
  Makefile or instructions define a land command, that command with the branch, as the project
  runs it (for example `bun run land <branch>`). Otherwise the local merge, `git merge
  --no-edit <branch>` on main.
- `{{GATE}}`: a pointer to the instructions' gate section when it has one. Otherwise, the
  commands the package scripts provide (lint, typecheck, test), as a list. Never list a command
  the project does not have.
- `{{DECISIONS}}`: where the instructions put decisions, research and ADRs, whether that is
  `docs/adr/`, a vault path, a wiki or something else. Otherwise use `a Decisions section in
  the description of the issue they govern, with the full record in the parent issue for a
  wave`.
- `{{DOCS}}`: the docs that describe behaviour here, such as the README, package READMEs,
  `docs/` and ADRs.
- `{{TESTING_CONSTRAINTS}}`: a pointer to what the instructions say agents must never do while
  testing (never deploy, never touch production, which environments are allowed). Otherwise
  use `Ask before anything that leaves this machine: a deploy, a publish, a write to a
  shared service.`
- `{{AGENTS}}`: one line per project agent file (Claude Code's `.claude/agents/`), giving the agent type and the territory
  it takes, from its description. Otherwise use `None. Use a general-purpose agent with the
  few-liners below.`
- `{{TERRITORIES}}`: a table mapping each area to its globs, covering the top-level packages or
  directories, with the agent that owns each one.
- `{{SETUP_ANSWERS}}`: one line per question below, as `- <topic>: <answer> (<source>)`, where the
  source is the file and line that settled it, or `asked` when the human answered. Then a line
  `- Overlays: <paths>` naming each overlay copied, or `- Overlays: none`. A refresh reads this
  list back instead of asking again.
- `{{TAGS}}`: one line per descriptive tag, as `` - `<tag>`: <what it marks> ``, from the
  answer to the tags question. Otherwise use `` - `bug`: something that worked, or should have,
  and does not. ``, `` - `research`: an ask that ends in a note. `` and `` - `design`: an ask that
  ends in a decision record. ``.
- `{{STEWARD}}` (goals overlay): who carries a goal between sessions. When a steward runs on a
  schedule (a job that names a steward skill), say so, and that dispatch leaves the slices it
  files `next` for the steward rather than starting them unasked. Otherwise use `The human, who
  opens a session and asks for the next slice.`
- `{{RESEARCH_HOME}}` (research overlay): where research notes are kept, from the answer to the
  research question: a repo directory, or a path or URL outside the repo.
- `{{HARNESSES}}` (cross-harness overlay): the harnesses the project uses, how each one is started
  for an issue (a loop run's tag, a CLI, a subagent), and which one reviews which.
- `{{TEAM_RECORD}}` (upstream overlay): the team's tracker, the tool agents reach it with (`gh`,
  an MCP server), and the form a commit or pull request cites a request in (`Fixes #123`,
  `ENG-123`).

## Overlays

`references/goals.md`, `references/research.md`, `references/cross-harness.md` and
`references/upstream.md` are overlays: copy each one only when an answer below selects it, and
fill its placeholders. Every other file in `references/` is copied always. The base skill reads
correctly with no overlay at all.

## Questions

Settle each question from the project's files when they answer it, and record which file did.
Ask the human only the ones the files leave open, in one go, each with its recommended answer
first. On a refresh, an answer already recorded in the skill's `## This project` section is
kept, not asked again.

1. **Team record.** Does a team tracker hold this project's requests: none, GitHub Issues, or
   Linear? Files that settle it: the instructions naming a tracker, `.github/ISSUE_TEMPLATE/`,
   upstream ids in the git log (`Fixes #12`, `ENG-123`). Recommended: none. GitHub Issues or Linear
   selects the upstream overlay and fills `{{TEAM_RECORD}}`.
2. **Goals.** Is some work carried as goals across many slices, and does a steward run them?
   Files that settle it: issues tagged `goal` in this scope, a steward skill or job. Recommended:
   no. Yes selects the goals overlay and fills `{{STEWARD}}`.
3. **Integration.** How does finished work reach main: a local merge, or a pull request with
   auto-merge? Files that settle it: a land script, a CI workflow that gates pull requests,
   merge commits from pull requests in the git log. Recommended: what the git log shows, else a
   local merge. Fills `{{INTEGRATION}}`.
4. **Harnesses.** One coding harness, or several, with each one's work reviewed by another?
   Files that settle it: instructions that name more than one harness's workflow, `loop.tiers`
   mappings for more than one harness. Recommended: one harness. Several selects the
   cross-harness overlay and fills `{{HARNESSES}}`.
5. **Research.** Is research kept with the decisions (`{{DECISIONS}}`) and done in the dispatching
   session, or run apart and kept somewhere else? Files that settle it: instructions that name a
   research directory or an outside store. Recommended: kept with the decisions. Run apart
   selects the research overlay and fills `{{RESEARCH_HOME}}`.
6. **Tags.** Which descriptive tags should issues carry? Files that settle it: the tags already
   on this scope's issues (`kabane_list`), when a few recur. Recommended: `bug`, `research`,
   `design`. Fills `{{TAGS}}`.
