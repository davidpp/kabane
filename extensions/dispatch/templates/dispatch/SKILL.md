---
name: dispatch
description: Turn an ask in {{PROJECT}} into shipped work. Size it first (do it inline, file one kabane issue, or plan a wave), then write issues that are complete briefs, run parallel agents with owned file territories, merge each one behind the gate, and report what is left for a human to check. Use this whenever the user asks to dispatch, plan and run, or parallelize work in this repo (for example `/dispatch` or "dispatch {{ISSUE_PREFIX}}-123"), or asks for a change with more than one independent piece, even if they never say "dispatch".
argument-hint: <kabane issue id | freeform ask>
metadata:
  kabane-template: {{TEMPLATE_STAMP}}
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

Work is tracked in kabane, through the `kabane_*` MCP tools, under scope `{{SCOPE_URI}}`. Issues
are the spec, and together with their comments and work logs they are the audit trail. If the
tools are missing from this session, tell the user and stop, because a plan that lives only in
this conversation is gone when the conversation ends.

## This project

{{SETUP_ANSWERS}}

These are the answers the human gave when this skill was set up, or that the project's files
gave. The overlays they list are files in `references/` that extend this skill: read each one
when the work reaches what it covers.

## Intake

Every ask takes one of these paths. Name its path in a line before doing anything else.

| The ask | It ends in | Depth |
|---|---|---|
| A question or a trade-off | an answer with evidence; work that follows is filed, and its open decision asked with `kabane_ask` | what the answer needs |
| An inline change | a commit | none |
| One issue | a brief, one agent, a merge, a handoff | quick, by you |
| A wave | a parent with its decisions, five to seven briefs, a merge each, a handoff on the parent | medium on the parent before slicing; thorough when it touches stored data or a contract |
| A goal | an issue tagged `goal`, its slices filed under it as issues or waves | thorough on the goal, medium per slice |
| Small work that waits for no goal | an issue tagged `ready` when its brief stands, `needs-brief` when it does not | quick, by you |
| Research | a note where research is kept, attached to each issue that relies on it | the depth the ask names, medium otherwise |
| A design decision | a decision record and `kabane_ask` on its issue; no code | medium; thorough when it touches stored data or a contract |
| Something to do on a schedule | a job, `kabane job add` with its `--schedule` and `--request`; it runs only where a scheduler calls `kabane job tick` | none |

Depth is how far you read before writing anything. Quick: the ask and the files it names.
Medium: also the code around each call site, the docs that constrain it, and prior issues on
the same ground (`kabane_search`). Thorough: also what those prior issues decided, and every
consumer of a contract or stored shape the change touches. Research for a wave or a goal lands
in the parent's description, as its Finding, so each slice's brief can cite it.

Before filing anything, look for an open goal the ask serves (`kabane_list` with `tag: "goal"`). Work that
serves a goal is filed under it with `parentTaskId`, because work outside a goal is invisible to
whoever carries the goal. Only the top of the work goes under the goal: one issue, or a wave's
parent. A wave's issues go under the wave's parent, so the goal sees one slice and the parent
rolls up its own issues. `references/tags.md` lists the tags this project uses and what reads
each one. Tag an issue from that list when a tag fits, never from anywhere else, and leave it
untagged when none does.

## Size the ask

For an inline change, one issue or a wave, pick one of these three before doing anything else,
and say which one in a line:

- **Inline.** One obvious change with nothing to coordinate: make it, run the gate, report. No
  issue, because the commit is record enough.
- **One issue.** One concern that deserves a record. File it (below), give it to a single agent,
  and merge and close it the same way as a wave.
- **A wave.** Two or more pieces that can move independently, or work that crosses territories.

If you are unsure, choose the smaller option. A wave's coordination has to pay for itself.

When the ask is really a question or a trade-off, answer it with evidence and stop there. If
work follows from the answer, file it without dispatching it, and ask the open decision on it
with `kabane_ask`: the choices, your recommendation and why, one question per decision, all in
one call. That leaves the issue `waiting`, and answering its last question moves it to `next`.
Comment only what the questions do not carry, such as evidence or a link.

A wave-sized ask sometimes still has open design decisions: a behaviour nobody has specified, or
a trade-off with two reasonable answers. If so, file the wave's parent issue first and ask those
decisions on it the same way, with `kabane_ask`, before filing anything else. Look up anything
the code or docs can answer rather than asking it. Then tell the user they can be grilled on
them now (the grill skill, on the parent's id) or answer them later on the board or with
`kabane answer`, and stop there. Do not do this for inline or one-issue work, because there the
questions cost more than the answers save.

Go ahead once the parent's last question is answered or withdrawn, which moves it back to
`next`. The answers are the decisions record: `kabane_context` on the parent shows them in its
`questions.decisions` section. A child's brief does not carry its parent's decisions, so copy
one into an issue's Decisions paragraph only where that issue needs it.

## Investigate, then write the issues

Read only what you need to state what is true today: the entry files, the line that proves a
claim, a number you can measure. Confirm the cause of anything called a bug before you file it.
Then think past the literal ask to the neighbouring behaviour a careful user would expect.

Each issue is the entire brief its agent gets, so an agent that reads nothing else can still do
the work. Follow `references/issue-template.md`. It names the files, a "Finding." paragraph with
the evidence, the design, what is out of scope, the verify steps under the project's
constraints, and the conventions. File each one with `kabane_add` (kind `issue`, state `next`,
under the wave's parent; a wave's parent or a lone issue goes under the goal it serves, or else
{{PARENT}}; tags from `references/tags.md`). A wave holds one issue per concern that can be merged on its own, and five to
seven at most, because past that the merges and seams outgrow one orchestrator's attention.
Real ideas that are not for now become `someday` issues with two lines of description, which
keeps them visible without widening the wave.

An issue's internal steps go in its checklist, not in sub-issues: `references/issue-template.md`
says how. An item has no assignee, no state beyond done, and no brief; if it needs any of those,
it's a subtask. In a wave, each subtask is one of the wave's issues, with a territory of its own.

Decisions, research and ADRs go where {{INSTRUCTIONS_FILE}} says they go: {{DECISIONS}}. Some
of them may land in an issue's description, and there they are already part of that issue's
brief. For everything that lands elsewhere, attach it to each issue that relies on it with
`kabane_contextAdd` (kind `ADR`, `research`, `doc` or `spec`), so that `kabane_context` puts it
in the implementer's brief. A `file:` reference is inlined into the brief. Any other URI shows up
as a pointer for the agent to follow. A record that no issue links to is a record the agent
never reads.

Research and design asks end there too, and ship no code. Research ends in a note in that place,
attached to every issue that relies on it, with what it did not check. A design ask ends in a
decision record and its open decisions asked on its issue with `kabane_ask`; the build is filed
as its own issue once they are answered, so that the decision is reviewed before any code
exists.

## Plan the wave

Record order with `kabane_link`: `blocks` for a hard dependency, `related` otherwise. Give every
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

Set each unblocked issue to `in_progress` with `kabane_edit`, then start one agent per issue,
all in a single message so they run in parallel. When the harness has project agents (Claude
Code: `.claude/agents/`) and one is a specialist for the issue's territory, use it (see `references/specialists.md`). Otherwise use a general-purpose
agent. Model: {{MODEL}}. A model named for an agent is a tier (frontier, balanced or fast), resolved to the
harness's model with `kabane config get loop.tiers.<harness>.<tier>`; never guess a model id.

Each agent works in its own copy of the repo so that parallel edits cannot collide:
{{WORKTREE}}

Build the prompt from `references/agent-prompt.md`. The prompt names the issue, who else is
running, and which files or areas to stay out of. Name each agent after its issue so that
completion notices are easy to read.

## Merge on each completion

Merge each agent's work as soon as it finishes rather than at the end of the wave. An early merge
keeps later conflicts small and unblocks dependents sooner. As each agent finishes:

1. Read the issue's handoff (`kabane handoff <id>`, or the brief) beside `git log` for its
   commits: the handoff is the agent's account, and git is the evidence. An issue with no
   handoff, or one whose handoff shows no evidence, goes back to its agent with that said, before
   any merge.
2. Integrate the branch: {{INTEGRATION}}. When integration goes through a pull request, the
   issue counts as merged, and its dependents may start, only once that pull request has
   merged. Then, before cleanup or any dispatch, merge the remote's main into local main
   (`git fetch`, then `git merge --no-edit` of the fetched main; never a pull that refuses
   local-only commits or a rebase of main), and rebase a conflicting branch onto the fetched
   main. When two agents' additive edits conflict, keep both. When a test module conflicts, it
   is usually two helpers with the same name: keep one helper and both sets of tests.
3. Run the full gate on the merged result, not just on the branch:
   {{GATE}}
4. Remove the agent's working copy, keep the manual checks its handoff lists as not verified,
   and mark the issue done with `kabane_done`.
5. Dispatch whatever that merge unblocked, and tell any agent that was working against a stub.

Anything an agent reports outside its scope, whether a bug it noticed or a workaround it
needed, becomes a new low-priority issue. Do not fix it during the merge. The merge is where
the gate is protecting main, and an unreviewed fix there skips the brief, the review and the
record.

## Close

When the last issue has merged, review the combined diff through each lens in
`references/lenses/`: each file says what to look for and how to grade it. First read each
lens's frontmatter. Skip a lens whose `applies` line names no change the diff touches, and say
in the final report which lens you skipped and why; never skip a lens marked `always: true`.
You may review through several lenses in one pass. Then read the diff
for the seams no single agent could see: names that drifted apart, helpers written twice, a
contract changed without all of its consumers. Check that the docs describing changed behaviour
({{DOCS}}) changed along with it. Real defects get a fix issue and an agent, and the gate runs
again.

Your final report is for someone who did not watch the work happen:

- one line per issue saying what landed, with its id;
- the gate's numbers on the final merge;
- what is still running, blocked, or waiting on a decision;
- the manual checks, numbered, with the testing constraints repeated beside them.

Record the same report with `kabane_handoff` on the parent, so that it outlives this session:
the line per issue, the gate's numbers as its evidence, and the numbered manual checks with the
testing constraints beside them as what is not verified. What is still running, blocked or
waiting on a decision goes in a `kabane_comment` on the parent instead.

## Limits every agent is told about

- {{TESTING_CONSTRAINTS}}
- Agents cannot press keys, click menus or drive a GUI. Checks like that go on the manual list
  from the start, so no agent spends time trying to script them.
- An agent that changes user-level configuration (a harness's MCP config, a dotfile) records the
  original first and restores it before finishing. That configuration belongs to the person, not
  to the repo.
- If a commit fails to sign, or a hook refuses it, the agent stops and reports. It does not retry
  or bypass the check, because the check is the project's control and not the agent's to waive.
