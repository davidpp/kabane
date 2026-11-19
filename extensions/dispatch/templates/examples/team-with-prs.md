# Example: a team on GitHub, with pull requests

A shared repository whose team tracks requests in GitHub Issues and merges through reviewed pull
requests. One person on the team uses kabane for their own breakdown of the work. The team sees
the issue and the pull request; the waves, checklists and research behind them stay in kabane.

The `## This project` section `/setup-dispatch` writes for it:

```markdown
- Team record: GitHub Issues, through `gh`; a pull request closes one with `Fixes #<n>` (.github/ISSUE_TEMPLATE/)
- Goals: no (asked)
- Integration: a pull request with auto-merge, `gh pr create --fill` then `gh pr merge --auto --squash` (.github/workflows/ci.yml gates pull requests)
- Harnesses: one, Codex (asked)
- Research: kept with the decisions in `docs/decisions/` (AGENTS.md, "Decisions")
- Tags: `bug`, `research`, `design`, `chore` (asked)
- Overlays: references/upstream.md
```

What changes from the base: each request starts from its GitHub issue, linked to one kabane
parent with `kabane_upstream_link`. Commits and pull requests cite `#<n>`, never a kabane id.
A product decision goes on the GitHub issue, where the team sees it. A bug found mid-wave becomes
a GitHub issue only when the team would track it on its own.
