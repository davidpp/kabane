---
name: tend
description: Review every open issue in this project's tracker once, so the human can see what is worth doing. Close what is already done, with the evidence; put abandoned claims back; mark the small ones that are ready to run; collect what should be dropped into one question; and report a short list of what to look at. Use when a scheduled job names this skill, or when the human asks for a review or cleanup of the tracker or says the board is overwhelming.
---

# Tend

Agents file issues faster than anyone reads them: findings from a review, follow-ups, checks nobody could script, ideas for later. The list grows until the human cannot tell what is current, what is finished and what to start. You go through all of it so they do not have to, and you leave a list short enough to act on.

You change the tracker only where the evidence is in front of you. Everything else is a proposal the human answers in one place. You implement nothing and start no run: the steward does that from what you mark.

## What `next` means

`next` is the dispatch queue: what the steward or the human's next dispatch should start soon. It is not "worth doing" and not "filed recently". Agents file into `next` by default, so it fills with everything; you keep it to what is about to run. An issue earns `next` only when one of these holds:

- it is a goal, or a child of one that the goal's next slices need;
- it is `ready` (below) and fits under the limit;
- it blocks a release, or it broke something for real: a red gate on main, a regression someone hit;
- the human asked for it: they set it `next`, or a comment or answer of theirs calls for it now.

Everything else in `next` goes to `someday`, with a comment of one line saying why. That includes research, design, epics and `needs-brief` issues with no goal above them. `someday` is not a drop: the issue keeps its brief and tags and comes back when a goal or the human pulls it. Moving it is reversible, so you do it without asking.

Keep `next` to about ten issues outside a goal's children. When more qualify, keep release blockers and what the human asked for, then the `ready` ones that are smallest or oldest, and move the rest to `someday` with their `ready` tag kept, so a later review can bring them back as the queue drains.

## Read

1. `kabane_context` on the job, for its request, what the last review reported and the decisions page's link among its context refs. Then apply what the human answered on that page since the last review (see "The decisions page") before you judge any issue.
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
- **Small and ready.** One concern, one territory, a brief an implementer could work from as it stands, no open decision, nothing a goal's non-goals rule out, and not a change to `packages/core`, sync, stored data or the extension contract. Add the tag `ready`, and set it `next` when "What `next` means" leaves room. A bug or a small improvement does not wait for a goal.
- **Worth doing, not ready.** The brief is thin. Add the tag `needs-brief` and set it `someday` unless it earns `next` for another reason. Do not rewrite it here.
- **Parked.** Anything left in `next` that does not earn it under "What `next` means", and every real idea for later. Make sure it is `someday`, and leave it.

When you cannot tell, leave the issue as it is and name it in the report. A wrong close costs more than an open issue.

## Calls that are the human's

When the human can settle something you cannot, ask it: `kabane_ask` on the issue it is about, with the choices, your recommendation when you have one, why, the evidence in a sentence, and `allowFreeform: true`. "Done or not is your call", "needs your read" and "possibly overtaken" are questions, never lines in the report. One question per issue per decision; when that issue already has an open question from an earlier review on the same decision, pass `replaces` instead of adding a second one.

The drop list is these questions too: on each duplicate or overtaken issue, "Cancel <id>? <reason in a few words>", choices "Cancel" and "Keep", recommended "Cancel" only when you are sure. Do not cancel anything yourself. When the human answered "Cancel", cancel that issue with a comment that cites the answer.

## The decisions page

The human answers on one standing claude.ai page, so a decision comes with its evidence and reaches them away from the board. The tracker stays the record: the page shows and collects, and every answer goes back through `kabane_answer`.

Load the `artifact-design` and `artifact-capabilities` skills before you write the page. It declares the `db` capability, and each answer is one document keyed by the question's id (the `id:<ULID>` from `kabane_questions`): the choices picked, the Other text and a comment.

- **Find it.** The job's context refs hold one `doc` ref titled "Decisions page" with the artifact's URL. When there is none, publish the page and attach its URL with `kabane_contextAdd` on the job.
- **Apply first.** Read the page's answers with `ArtifactData`. For each one whose question is still open, `kabane_answer` by `id:<ULID>` with `relayed: true` and, as the answer, the choices picked (a comma list) or the Other text. A comment the human wrote goes on that issue as a `kabane_comment` that quotes them. Then act on the answer under the rules above. An answer to a question that is already closed was overtaken on the board: drop it and say so in the report.
- **Republish last.** Every open question in the scope, from any agent, not only yours (`kabane_questions` with the scope and `status: "open"`). The ones that block a release or a goal first. Each shows the issue's id and title, the question, why it is asked, what you saw (commit, file and line, command and output), the choices with your recommendation marked, an Other box and a comment box. Say on the page that answers are applied at the next review and that anything urgent is answered on the board. Delete the answer documents you applied.

This page is a trial of what kabane should do itself (JCAB-440). When something about it was awkward or missing during this review, a `kabane_comment` on JCAB-440 says what and where, once per finding.

## Report

One `kabane_comment` on the job, read on the board in under a minute:

1. **Needs you.** The decisions page's link, the question handles you filed or replaced this time, and the manual checks, oldest first, each with its id and one line.
2. **Start next.** At most five issues, in order, each with one line on why now. Prefer what unblocks a goal, then what is `ready`.
3. **What I changed.** Closed with evidence, set back to `next`, tagged, linked: ids and a few words each. Issues moved from `next` to `someday` go on one line of ids, grouped by reason. Then what `next` holds now.
4. **Could not tell.** The issues you left alone that no answer from the human would settle, and what would.

Ids and reasons, no totals and no percentages. When nothing changed since the last review and nothing needs the human, write nothing.

## Never

- Close an issue without citing the evidence, or cancel one the human did not pick.
- Touch an issue that has a run, a branch with unmerged work or an open pull request, beyond reporting it.
- Change a goal, a job (beyond attaching the decisions page's link), or an issue's description.
- Start a run, edit code, or land anything.
