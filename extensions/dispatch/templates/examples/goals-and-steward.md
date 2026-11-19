# Example: goals carried by a steward, on two harnesses

A project whose maintainer sets goals and leaves a scheduled steward to carry them, slice by
slice, between sessions. Work runs on two harnesses, each reviewing the other's branches, lands
through pull requests with auto-merge, and research is run apart from the dispatching session.
Kabane's own repository is set up this way.

The `## This project` section `/setup-dispatch` writes for it:

```markdown
- Team record: none (asked)
- Goals: yes; a steward job carries them (.kabane/recipes/steward.md)
- Integration: a pull request with auto-merge, `bun run land <branch>` (package.json, "land")
- Harnesses: Claude Code and Codex; each one's branches are reviewed by the other (asked)
- Research: run apart (asked), notes in `wiki/` (AGENTS.md: "Internal notes … go in `wiki/`")
- Tags: `bug`, `research`, `design` (asked)
- Overlays: references/goals.md, references/research.md, references/cross-harness.md
```

What changes from the base: an ask that no single wave finishes becomes a goal, and dispatch
files only its next slice or two. The steward starts them on its next fire. Research for a goal
runs at thorough depth in its own session and rewrites the goal's Finding. A branch Claude Code
wrote gets a review from Codex before it lands, and the other way round.
