---
name: tend
description: Review every open issue in this project's tracker once, so the human can see what is worth doing. Close what is already done, with the evidence; put abandoned claims back; mark the small ones that are ready to run; collect what should be dropped into one question; and report a short list of what to look at. Use when a scheduled job names this skill, or when the human asks for a review or cleanup of the tracker or says the board is overwhelming.
---

# Tend

Agents file issues faster than anyone reads them: findings from a review, follow-ups, checks nobody could script, ideas for later. The list grows until the human cannot tell what is current, what is finished and what to start. You go through all of it so they do not have to, and you leave a list short enough to act on.

You change the tracker only where the evidence is in front of you. Everything else is a proposal the human answers in one place. You implement nothing and start no run: the steward does that from what you mark.

## Read

1. `kabane_context` on the job, for its request and what the last review reported.
2. Every open issue in the scope: `kabane list --kind issue --limit 500 --json`, and `kabane_context` on the ones you need to judge. Include `someday`.
3. The goals: `kabane list --tag goal --json`, with each goal's outcome and non-goals. An issue is read against them.
4. What is in flight, so you do not disturb it: `kabane runs --json`, `kabane loop status`, `git worktree list`, `gh pr list --state open`.

## Decide, for each issue

Take the first that applies.

- **Already done.** The change it asks for is on main: a merged commit or pull request names its id (`git log origin/main --grep <id>`), or the behaviour it describes is there when you look at the code or run it in the sandbox. Close it with `kabane_done` after a `kabane_comment` that cites what you saw: the commit, the file and line, or the command and its output. No evidence, no close.
- **A claim nobody holds.** It is `in_progress` and has no live run, no open pull request and no worktree or branch with work on it. Set it back to `next` with a comment saying what you checked. When a branch does hold unmerged work, leave the state and say so in the report.
- **Waiting on the human.** It has an open question, or it is a manual check only they can do. Leave it; it goes in the report's first section.
- **The same as another.** Link the newer to the older with `kabane_link` and type `duplicate`, and put the newer on the drop list.
- **Overtaken.** A later decision, a goal's non-goal or a merged change makes it moot. Put it on the drop list with the reason.
- **Part of a goal.** It serves a goal's outcome and is not yet under it: say so in the report. Moving it under the goal is the human's call, or the steward's when the goal's delegation allows.
- **Small and ready.** One concern, one territory, a brief an implementer could work from as it stands, no open decision, nothing a goal's non-goals rule out, and not a change to `packages/core`, sync, stored data or the extension contract. Add the tag `ready` and set it `next`. A bug or a small improvement does not wait for a goal.
- **Worth doing, not ready.** The brief is thin. Add the tag `needs-brief`. Do not rewrite it here.
- **Parked.** A real idea for later. Make sure it is `someday`, and leave it.

When you cannot tell, leave the issue as it is and name it in the report. A wrong close costs more than an open issue.

## The drop list

Do not cancel anything yourself. Collect the duplicates and the overtaken into one question, on the open issue tagged `tracker-review` (create it once, titled "Tracker review", when there is none): `kabane_ask` with `multiSelect`, one choice per issue as "<id> <title>: <reason in a few words>", your recommendation the ones you are sure of, and "none of these" as the last choice. When an earlier review's question is still open, replace it with the current list instead of adding a second one. When it was answered, cancel the issues the human picked, each with a comment that cites the answer, then ask about the new ones.

## Report

One `kabane_comment` on the job, read on the board in under a minute:

1. **Needs you.** Open questions and manual checks, oldest first, each with its id and one line.
2. **Start next.** At most five issues, in order, each with one line on why now. Prefer what unblocks a goal, then what is `ready`.
3. **What I changed.** Closed with evidence, set back to `next`, tagged, linked: ids and a few words each.
4. **Could not tell.** The issues you left alone and what would settle each.

Ids and reasons, no totals and no percentages. When nothing changed since the last review and nothing needs the human, write nothing.

## Never

- Close an issue without citing the evidence, or cancel one the human did not pick.
- Touch an issue that has a run, a branch with unmerged work or an open pull request, beyond reporting it.
- Change a goal, a job, or an issue's description.
- Start a run, edit code, or land anything.
