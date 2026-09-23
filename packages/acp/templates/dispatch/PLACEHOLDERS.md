# Filling the dispatch template

The board copilot reads this file on `/setup-dispatch`. It is never copied into the project.
Replace every `{{NAME}}` in `SKILL.md` and `references/` with what the project itself says, so the
written skill contains no `{{` at all. "The project" means the files in the repo. A personal
instructions file loaded from the user's home directory is not part of it, so none of its rules
belong in a skill that everyone who clones the repo will run. When the project says nothing
about a value, write the fallback given here. The fallback is safer than a convention the
project does not actually have, because the skill's agents will follow whatever the skill says
literally.

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
- `{{COMMIT_STYLE}}`: the commit message shape that the instructions or the recent `git log` use,
  including where an issue id goes. If the repo is public and its history carries no ids, the
  shape states that ids stay out of the message and go into `cabane_log` instead.
- `{{GATE}}`: the exact commands that must pass, as a list. Take them from the instructions'
  gate section, or else from the package scripts (lint, typecheck, test). Never list a command
  the project does not have.
- `{{DOCS}}`: the docs that describe behaviour here, such as the README, package READMEs,
  `docs/` and ADRs.
- `{{TESTING_CONSTRAINTS}}`: what agents must never do while testing, taken verbatim from the
  instructions (never deploy, never touch production, which environments are allowed).
  Otherwise use `Ask before anything that leaves this machine: a deploy, a publish, a write to a
  shared service.`
- `{{AGENTS}}`: one line per file in `.claude/agents/`, giving the agent type and the territory
  it takes, from its description. Otherwise use `None. Use a general-purpose agent with the
  few-liners below.`
- `{{TERRITORIES}}`: a table mapping each area to its globs, covering the top-level packages or
  directories, with the agent that owns each one.
