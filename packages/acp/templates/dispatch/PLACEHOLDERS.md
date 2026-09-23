# Filling the dispatch template

The board copilot reads this file on `/setup-dispatch`. It is never copied into the project.
Replace every `{{NAME}}` in `SKILL.md` and `references/` with what the project itself says, so the
written skill contains no `{{` at all. "The project" means the files in the repo. A personal
instructions file loaded from the user's home directory is not part of it, so none of its rules
belong in a skill that everyone who clones the repo will run. When the project says nothing
about a value, write the fallback given here. The fallback is safer than a convention the
project does not actually have, because the skill's agents will follow whatever the skill says
literally.

When the instructions file already states a value (the gate, the commit style, the testing
constraints), point at it instead of copying it: "the gate in CLAUDE.md". Every session loads
that file anyway, and a copy in the skill drifts away from it the first time either one is
edited. Copy a value only when the project leaves it unstated and the fallback below fills it.

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
- `{{INTEGRATION}}`: how finished work reaches main. That is either a local merge (`git merge
  --no-edit <branch>` on main) or a pull request, if the project's history or instructions show
  PRs. Otherwise use the local merge.
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
- `{{AGENTS}}`: one line per file in `.claude/agents/`, giving the agent type and the territory
  it takes, from its description. Otherwise use `None. Use a general-purpose agent with the
  few-liners below.`
- `{{TERRITORIES}}`: a table mapping each area to its globs, covering the top-level packages or
  directories, with the agent that owns each one.
