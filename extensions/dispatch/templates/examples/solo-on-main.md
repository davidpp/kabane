# Example: one person, landing on main

Someone works alone on the project, with one coding harness, and merges finished branches into
main on their own machine. No team tracker, no goals. This is the base skill with no overlay.

The `## This project` section the setup-dispatch skill writes for it:

```markdown
- Team record: none (asked)
- Goals: no (asked)
- Integration: local merge, `git merge --no-edit <branch>` on main (git log: no pull-request merges)
- Harnesses: one, Claude Code (asked)
- Research: kept with the decisions in `docs/adr/` (CLAUDE.md, "Decisions")
- Tags: `bug`, `research`, `design` (asked)
- Overlays: none
```

What changes from the base: nothing. A wave lands branch by branch on main, and research and
decision records sit together where the instructions file says.
