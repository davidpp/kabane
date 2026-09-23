---
name: dispatch
description: Turn an ask in {{PROJECT}} into shipped work. Size it first (do it inline, file one cabane issue, or plan a wave), then write issues that are complete briefs, run parallel agents with owned file territories, merge each one behind the gate, and report what is left for a human to check. Use this whenever the user asks to dispatch, plan and run, or parallelize work in this repo (for example `/dispatch` or "dispatch {{ISSUE_PREFIX}}-123"), or asks for a change with more than one independent piece, even if they never say "dispatch".
argument-hint: <cabane issue id | freeform ask>
---

# Dispatch — {{PROJECT}}

For anything larger than an inline change, you are the orchestrator. You investigate just
enough to write precise issues, delegate the implementation and the debugging to agents, merge
what they finish, and report. You do not implement or debug yourself. If you do, your context
fills up with one issue's detail, and you lose the view of the whole plan that only you have.

Every agent you start already loads {{INSTRUCTIONS_FILE}}, which holds the architecture, the
conventions and the commands. A prompt carries only what that file does not say: the issue, the
territory, who else is running, and how to finish. Anything you repeat from it costs tokens on
every agent, and the two copies drift apart.

Work is tracked in cabane, through the `cabane_*` MCP tools, under scope `{{SCOPE_URI}}`. Issues
are the spec, and together with their comments and work logs they are the audit trail. If the
tools are missing from this session, tell the user and stop, because a plan that lives only in
this conversation is gone when the conversation ends.

## Size the ask

Pick one of these three before doing anything else, and say which one in a line:

- **Inline.** One obvious change with nothing to coordinate: make it, run the gate, report. No
  issue, because the commit is record enough.
- **One issue.** One concern that deserves a record. File it (below), give it to a single agent,
  and merge and close it the same way as a wave.
- **A wave.** Two or more pieces that can move independently, or work that crosses territories.

If you are unsure, choose the smaller option. A wave's coordination has to pay for itself.

When the ask is really a question or a trade-off, answer it with evidence and stop there. If
work follows from the answer, file it in `next` without dispatching it, and say which decision
it is waiting on.

## Investigate, then write the issues

Read only what you need to state what is true today: the entry files, the line that proves a
claim, a number you can measure. Confirm the cause of anything called a bug before you file it.
Then think past the literal ask to the neighbouring behaviour a careful user would expect.

Each issue is the entire brief its agent gets, so an agent that reads nothing else can still do
the work. Follow `references/issue-template.md`. It names the files, a "Finding." paragraph with
the evidence, the design, what is out of scope, the verify steps under the project's
constraints, and the conventions. File each one with `cabane_add` (kind `issue`, state `next`,
under {{PARENT}}). A wave holds one issue per concern that can be merged on its own, and five to
seven at most, because past that the merges and seams outgrow one orchestrator's attention.
Real ideas that are not for now become `someday` issues with two lines of description, which
keeps them visible without widening the wave.

## Plan the wave

Record order with `cabane_link`: `blocks` for a hard dependency, `related` otherwise. Give every
issue a territory, meaning the files or globs it owns (`references/specialists.md` has the
project's map). Two issues that reshuffle the same file cannot run in parallel. Two issues that
each add a line to a shared registration file can, provided each agent is told about the other.

A dependency often looks harder than it is:

- If the package graph forbids an import, the consumer takes what it needs as a port or a
  callback, and the caller wires it in. The work goes ahead and the graph stays intact.
- A dependent issue can start early against a stub of the interface its blocker will provide.
  When the blocker merges, tell that agent so it can switch from the stub to the real thing.

Show the user the issues, the DAG, the territories and the waves, and wait for their go-ahead.
They know things about priority and risk that are not in the code.

## Dispatch

Set each unblocked issue to `in_progress` with `cabane_edit`, then start one agent per issue,
all in a single message so they run in parallel. When `.claude/agents/` has a specialist for
the issue's territory, use it (see `references/specialists.md`). Otherwise use a general-purpose
agent. Model: {{MODEL}}.

Each agent works in its own copy of the repo so that parallel edits cannot collide:
{{WORKTREE}}

Build the prompt from `references/agent-prompt.md`. The prompt names the issue, who else is
running, and which files or areas to stay out of. Name each agent after its issue so that
completion notices are easy to read.

## Merge on each completion

Merge each agent's work as soon as it finishes rather than at the end of the wave. An early merge
keeps later conflicts small and unblocks dependents sooner. As each agent finishes:

1. Check `git log` for its commits. The report is a summary, and git is the evidence.
2. Integrate the branch: {{INTEGRATION}}. When two agents' additive edits conflict, keep both.
   When a test module conflicts, it is usually two helpers with the same name: keep one helper
   and both sets of tests.
3. Run the full gate on the merged result, not just on the branch:
   {{GATE}}
4. Remove the agent's working copy, keep its manual-check list, and mark the issue done with
   `cabane_done`.
5. Dispatch whatever that merge unblocked, and tell any agent that was working against a stub.

Anything an agent reports outside its scope, whether a bug it noticed or a workaround it
needed, becomes a new low-priority issue. Do not fix it during the merge. The merge is where
the gate is protecting main, and an unreviewed fix there skips the brief, the review and the
record.

## Close

When the last issue has merged, read the combined diff for the seams no single agent could see:
names that drifted apart, helpers written twice, a contract changed without all of its
consumers. Check that the docs describing changed behaviour ({{DOCS}}) changed along with it.
Real defects get a fix issue and an agent, and the gate runs again.

Your final report is for someone who did not watch the work happen:

- one line per issue saying what landed, with its id;
- the gate's numbers on the final merge;
- what is still running, blocked, or waiting on a decision;
- the manual checks, numbered, with the testing constraints repeated beside them.

Post the same report as a `cabane_comment` on the parent, so that it outlives this session.

## Limits every agent is told about

- {{TESTING_CONSTRAINTS}}
- Agents cannot press keys, click menus or drive a GUI. Checks like that go on the manual list
  from the start, so no agent spends time trying to script them.
- An agent that changes user-level configuration (a harness's MCP config, a dotfile) records the
  original first and restores it before finishing. That configuration belongs to the person, not
  to the repo.
- If a commit fails to sign, or a hook refuses it, the agent stops and reports. It does not retry
  or bypass the check, because the check is the project's control and not the agent's to waive.
