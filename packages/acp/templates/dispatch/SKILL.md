---
name: dispatch
description: Turn an ask in {{PROJECT}} into shipped work — do it inline, file one issue, or plan a wave of parallel agents over a cabane issue tree — and never call it done before QA, docs and the gate pass. Use whenever the user says /dispatch, "dispatch this", "dispatch {{ISSUE_PREFIX}}-123", "run a team on this", "parallelize this", "spawn agents for", or asks for any change in this repo that has two or more independent pieces.
argument-hint: <cabane issue id | freeform ask>
---

# Dispatch — {{PROJECT}}

Every sub-agent you start auto-loads this repo's {{INSTRUCTIONS_FILE}}: the architecture, the
conventions and the commands are already in its head. A prompt carries only the **delta** — the
specialist, the issue, the territory, the gate. Never paste {{INSTRUCTIONS_FILE}} or a design doc
into a prompt; the file the agent already loaded says it better.

Tracker state goes through the cabane MCP tools (`cabane_*`) under scope `{{SCOPE_URI}}`. If those
tools are not in this session, say so and stop — do not keep the plan in prose instead.

## 1. Size the ask

Decide before doing anything else, and say which one you picked in one line:

- **Inline** — one file or one obvious change, nothing to coordinate. Do it, run the gate, report.
  No issue.
- **One issue** — a single concern worth a record: `cabane_add` (kind `issue`, state `next`,
  `parentTaskId` {{PARENT}} when it belongs to that work) with a description that is the brief,
  then do it yourself or hand it to one agent, and close it with the gate below.
- **A wave** — two or more pieces that can move independently, or anything touching more than one
  territory. Continue at step 2.

When in doubt between two sizes, take the smaller one. A wave has overhead the ask must pay for.

## 2. Plan the issues

1. Scout: one read-only `Explore` agent maps what the ask touches — exact file paths, coupling
   points, and an ordered breakdown (title, two or three sentences naming files, dependencies).
   Skip it when the input is already an issue id with subtasks: read it with `cabane_context`.
2. Create a parent issue with `cabane_add`, then one sub-issue per concern with `parentTaskId` set
   to it. Each description is a brief an implementer can act on cold: what is true today, what
   should change, what is out of scope, how it will be verified.
3. Record order with `cabane_link` (`blocks` for a hard dependency, `related` otherwise) so the DAG
   is queryable instead of buried in prose.
4. Assign every sub-issue a territory — the globs it owns. Two sub-issues that edit the same file
   are sequential, smaller first; settle an ambiguous owner by who changes the callee (a call-site
   search, not a guess).

**Present the plan — issues, DAG, territories, waves — and wait for the user to confirm.** Never
dispatch without it.

## 3. Dispatch a wave

Waves follow the DAG: sequential across waves, parallel within one. Launch every agent of a wave in
a single message, named `{specialist}-{issueId}`, each with its own working copy:
{{WORKTREE}}

Pick the specialist from `references/specialists.md`. The prompt is this and nothing more:

```
{specialist few-liner}

## Assignment
{issueId} — {title}
{description, plus any comments from cabane_context}

## Territory
Own: {globs}. Do NOT touch: {the other agents' globs this wave}.

## Workflow
1. cabane_edit {issueId} to in_progress, assignee yourself.
2. Read one or two exemplar files in your territory before writing anything.
3. Implement. Match the surrounding style.
4. Run the gate (below); fix what you broke.
5. Commit: {{COMMIT_STYLE}}
6. cabane_log {issueId} with commit:<sha> for each commit, cabane_comment a two-line note
   (what changed, what the next wave should know). Do not mark it done — the dispatcher does.
Final message: files changed, gate result, open concerns. Terse.
```

As each agent reports, check `git log` for its commits rather than trusting the report. An agent
that failed → tell the user and let them choose retry, skip or abort; never auto-advance.

## 4. QA, docs, gate — before anything is done

This step is not optional and not skippable for a small ask.

1. **Gate.** From the repo root, all clean:
   {{GATE}}
2. **Review.** Read the combined diff for seams between agents: naming drift, duplicated helpers,
   two edits to one shared file that disagree, a contract changed without its consumers. Any real
   defect → a fix agent with the finding and its file:line, then re-run the gate.
3. **Docs.** Every behaviour or interface that changed is reflected in the docs that describe it
   ({{DOCS}}). Stale docs are a defect, fixed in the same wave.
4. **Constraints.** {{TESTING_CONSTRAINTS}}
5. **Manual checks.** List what no agent could script — a UI to click, a deploy to run — as a
   `cabane_comment` on the parent. Name them; do not pretend they were done.

Only then: `cabane_done` on each sub-issue whose work landed, a summary `cabane_comment` on the
parent, and a report to the user — what shipped, gate result, manual checks, follow-ups filed.
Follow-ups are new sub-issues under the parent, not a sentence in the report.

## Invariants

- The user confirms the plan and decides on failures.
- Agents never write outside their territory.
- Every commit is verified from git, and linked to its issue with `cabane_log`.
- Nothing is done until step 4 has passed.
