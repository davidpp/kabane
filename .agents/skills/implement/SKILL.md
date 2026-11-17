---
name: implement
description: Implement one kabane issue from its brief in the working copy the run started in, run the gate, commit, and hand it off without merging. Use when a run names this skill with a target issue.
---

# Implement

You are given a target issue. Its brief is everything you were asked for; `AGENTS.md` holds the project's conventions, its gate and its limits for agents. You were started in a working copy prepared for this issue, on its own branch. Whoever started you lands the work; you do not.

1. Read the brief with `kabane_context` on the target issue until it is complete, and its open questions with `kabane_questions`. Set the issue `in_progress` with `kabane_edit` if it is not already.

2. Check where you are: `git branch --show-current`. On `main`, stop and say so as a comment on the issue: this skill never commits on main. Otherwise run `bun install`.

3. Do the work the brief describes, inside the territory it names. Read the files it points to before your first edit, and the `AGENTS.md` of each package you touch. What the brief leaves out of scope stays out; something you notice there goes in a `kabane_comment` on the issue.

4. A decision the brief does not settle and that changes what gets built belongs to the human: file it with `kabane_ask` on the issue (the choices, your recommendation and why), finish whatever does not depend on it, then stop. Do not decide it yourself, and do not write the options into the code.

5. Verify as the brief's Verify paragraph says, through the real entry point: `bun run sandbox` for the CLI and the board, never `~/.kabane`. Tests cover the logic you added; a passing test of a stand-in is not evidence that the real path works.

6. Run the gate from `AGENTS.md` and commit, one concern per commit. When a hook refuses a commit, or a commit fails to sign, stop and report it. Do not retry around it.

7. Hand the issue off with `kabane_handoff`: what landed, the evidence of what you ran and what you saw, and what you did not verify, manual checks included. Record the branch and each commit with `kabane_log` (`branch:<name>`, `commit:<sha>`). Leave the issue open and the working copy in place.

Do not push, open a pull request, merge, or touch another issue.
