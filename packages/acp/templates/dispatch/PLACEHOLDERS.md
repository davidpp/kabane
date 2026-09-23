# Filling the dispatch template

Read by the board copilot on `/setup-dispatch`, never copied into the project. Every `{{NAME}}` in
`SKILL.md` and `references/specialists.md` is replaced from what the project itself says; the
written skill contains no `{{` at all. When the project says nothing about one, write the plain
fallback given here rather than inventing a convention it does not have.

- `{{PROJECT}}` — the project's name, from its package manifest or its instructions file.
- `{{ISSUE_PREFIX}}` — the prefix of this scope's issue ids as the board shows them (`ABC` for
  `ABC-12`).
- `{{INSTRUCTIONS_FILE}}` — the file the harness auto-loads: `CLAUDE.md`, `AGENTS.md`, or both
  named together.
- `{{SCOPE_URI}}` — the scope from the board context block.
- `{{PARENT}}` — the project's standing parent issue if its instructions name one (a PRD or
  roadmap issue); otherwise `the parent issue the user names, if any`.
- `{{WORKTREE}}` — the command the instructions give for a working copy per branch, with the
  setup step after it (an install). Otherwise `a git worktree per agent (git worktree add), or the
  main checkout when the wave has a single agent`.
- `{{COMMIT_STYLE}}` — the commit message shape the instructions or the recent `git log` use,
  including where an issue id goes, or that it never goes in a public repo's messages.
- `{{GATE}}` — the exact commands that must pass, from the instructions' gate section or else the
  package scripts (lint, typecheck, test), as a list. Never a command the project does not have.
- `{{DOCS}}` — the docs that describe behaviour here: README, package READMEs, docs/, ADRs.
- `{{TESTING_CONSTRAINTS}}` — what agents must never do while testing, from the instructions
  (never deploy, never touch production, no network in tests). Otherwise `None stated beyond the
  gate; ask before anything that leaves this machine.`
- `{{AGENTS}}` — one line per file in `.claude/agents/`: the agent type, and the work it takes
  (from its description). Otherwise `None — use the few-liners below.`
- `{{TERRITORIES}}` — a table of area → globs for the top-level packages or directories, each
  owned by one specialist.
