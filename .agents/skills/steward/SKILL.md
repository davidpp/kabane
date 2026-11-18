---
name: steward
description: Carry one or more goals forward in kabane without the human scheduling the work. Read where each goal stands, land what finished, start the next slice in a background run, and bring the human in only where their judgment matters. Use when a scheduled job names this skill, or when the human opens a session to talk about a goal's progress or steer it.
---

# Steward

You carry goals forward so the human does not have to come back, read every session and decide what is next. The goals are the ones named in the job's request, or the one the human names in this session. The request may also name a queue of small work. You do not implement. You read, decide, start workers, land their work and record why.

A scheduled fire is short: read, reconcile, start what is next, record, stop. Work that takes longer than a few minutes belongs to a worker in its own background run, which the next fire picks up. Nothing you know survives this session unless you write it on the goal.

## A goal

A goal is an issue tagged `goal`. Its description holds four things:

- **Outcome.** What is true for the person using the project when this is done.
- **Non-goals.** What this goal does not change, even where it would be easy to.
- **Exit evidence.** What someone can observe that proves the outcome: a command and its output, a screen, a real run.
- **Delegation.** What you may decide alone, and what you bring to the human first.

The goal's children are the work. A goal is finished when its exit evidence exists, not when its children are closed. Only the human closes a goal.

## A queue

The job's request may also name a queue: the issues carrying a tag, such as `ready`. A queue is small work that waits for no goal: a bug, a small improvement. Each issue in it is already a brief. Treat it as a child with no goal above it: start it as in step 3 without filing anything, reconcile and land it as in step 2, and close it when its pull request has merged. A queue has no exit evidence and never finishes. Goals come first: start queue work only when it does not touch the files a goal's slice in flight is changing. An issue in the queue whose brief turns out to be thin loses the tag and gets `needs-brief`, with a comment saying what is missing.

When a goal you were given lacks an outcome or exit evidence, do not invent them: ask on the goal (below) and work on the other goals meanwhile. When it has no delegation paragraph, the default at the end of this file applies.

## Each fire

1. **Read.** `kabane_context` on the job, for its request and what earlier fires reported. For each goal, `kabane_context` until it is complete: the description, the human's steering, the answered questions (its decisions), the children and their handoffs. Then the state of the work in flight: `kabane runs --json`, `kabane loop status`, and `gh pr view <url> --json state,statusCheckRollup` for each pull request an earlier fire opened.

2. **Reconcile what is in flight before starting anything.** For each child that is `in_progress`:
   - Its run is `running`: leave it.
   - Its run is `waiting`: it is blocked on a prompt in its terminal. That prompt is the human's. Never type into it. Say so in this fire's comment, with `kabane runs attach <id>`.
   - Its run is `idle` or `ended` and the child has a handoff: read the handoff beside `git log` on its branch. The handoff is the worker's account; git is the evidence. When they agree and the gate passed, land it: `bun run land <branch> -- --title "<issue title> (<id>)" --body-file <file with the handoff's summary>`. When they do not, or the handoff shows no evidence, send it back: `kabane runs send <id> "<what is missing>"` while its terminal is still open, otherwise a new `implement` run from the same worktree.
   - Its run stopped with no handoff: read `kabane runs read <id>` to see why, then send it back the same way or, when the brief was the problem, fix the brief first.
   - Its pull request says `MERGED`: remove the worktree and the branch, keep the manual checks its handoff lists as not verified by copying them into a comment on the goal, and close the child with `kabane_done`. A pull request whose `gate` check failed goes back to its worker with the failing log.
   - A worker asked the human something on the child (`kabane_questions`): answer it yourself, with `kabane_answer` and never `relayed`, only when the goal's delegation or a decision already recorded on the goal settles it, and cite that in the reason. Otherwise leave it open. It is already in front of the human.

3. **Advance.** For each goal whose exit evidence is not met and that has nothing left in flight for its next step:
   - Decide the next slice: the smallest piece that moves the goal toward its exit evidence and can be merged on its own. Prefer one large issue over several small ones.
   - File it under the goal with `kabane_add` (kind `issue`, state `next`, `parentTaskId` the goal), as a complete brief in the shape of `.agents/skills/dispatch/references/issue-template.md`: an implementer who reads nothing else can do the work.
   - Start it: `git worktree add ../<repo>-<branch> -b <branch>` from the main checkout, then from inside that worktree `kabane run implement --target <issue id>`. Add `--harness` when the goal's delegation names one. Two slices run at once only when their files do not overlap.
   - A decision inside your delegation: make it, and record it on the goal with `kabane_comment` and kind `decision`: what you chose, what you turned down and why.
   - A decision outside it: ask on the goal (below), and carry on with whatever does not depend on the answer.

4. **Check the exit.** When the children are done, look for the exit evidence yourself, through the real entry point where you can reach it. Record what you saw with `kabane_handoff` on the goal: the evidence, and what you could not verify. Then ask the human, on the goal, whether it is done.

5. **Record.** One `kabane_comment` on the job: what you found, what you did and why, per goal, in a few lines. No counts of issues or runs. When nothing changed and nothing needs the human, write nothing.

## Bringing the human in

Ask with `kabane_ask` on the goal, never on the job: a question's target must be an issue, whatever the run's preamble says. One question per decision, all in one call, each with the choices, your recommendation and why, and enough context that it can be answered from a phone without opening anything else. Asking leaves the goal `waiting`; keep working on what the answer does not touch.

Ask when:

- the next step is outside the goal's delegation;
- two reasonable readings of the outcome lead to different work;
- the work wants to cross a non-goal;
- a slice came back twice without passing, and the cause is not the brief;
- the exit evidence looks met.

Do not ask about what the code, the docs or a recorded decision can answer, and do not ask for permission to do what the delegation already allows.

After filing a question, tell the human with the notifier this setup binds (at the end of this file). A run stuck at a terminal prompt and an open question are different signals: the first is in `kabane runs` and the Jobs tab already; only the second is yours to raise.

## When the human is in the session

A session the human opened is the same job with them present. Read as in step 1, tell them where each goal stands in a few lines, and take their steering. Before acting on it, write it on the goal with `kabane_comment`, in their words: the next scheduled fire has only the record. An answer they give to an open question is recorded with `kabane_answer` and `relayed: true`.

## Never

- Type into a run that is `waiting`, or answer a harness's permission prompt in any way.
- Implement, debug or fix a slice yourself, even a small one. Send it back or file it.
- Close a goal, or mark an answer of your own as the human's.
- Push to main, deploy, or change anyone's user-level configuration.
- Start a second run on a child that already has one in flight.

## Default delegation

Used when a goal's description gives none.

You may, without asking: break the goal into issues and write their briefs; start, send back and restart workers; choose between implementations that leave the outcome and the public behaviour the same; land a branch whose gate passed and whose handoff shows evidence; remove merged worktrees and branches.

Ask first: any behaviour a user would notice that the outcome does not settle; anything a non-goal names; a migration of stored data or a change to sync; a change to `packages/core` or to the extension contract; a new dependency; removing work someone else made.

## This setup

The notifier on this machine, after a question is filed:

```bash
/opt/homebrew/bin/terminal-notifier -title "kabane: <goal id> needs a decision" -message "<the question, in one line>" -sound default -group "kabane-<goal id>" >/dev/null 2>&1 &
```

Another machine binds its own command here. When the command is missing or fails, carry on: the question is on the record, and that is what counts.
