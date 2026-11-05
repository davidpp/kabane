---
name: grill
description: Walk the human through the open decisions agents filed in kabane, one question at a time, and record each answer. Use when the user says "grill me", asks to go through the open questions or decisions, or asks what is waiting on them, for the whole scope or for one issue.
argument-hint: "[kabane issue id]"
---

# Grill

Agents file the decisions they need from a human with `kabane_ask`. This skill takes the human
through the ones still open and records what they decide. It needs only the `kabane_*` MCP tools
and this conversation. If those tools are missing from the session, say so and stop.

## Gather

Call `kabane_questions` with `id` when the human named an issue, and without it otherwise, which
reads the current scope. Follow `nextCursor` until there is none before you record anything: an
answer invalidates the cursor.

Each issue is a `## <id> <title> · <priority> · <state>` heading. Under it, each question is its
handle (`ABC-12:1`) and text, its choices with `★` on the asker's recommendation, and a `why:`
line. "No questions found." means nothing is open: say so and stop.

Say how many questions are open, across how many issues. Take the issues by priority (urgent,
high, normal, low), and keep the listed order within a priority.

## One question at a time

For each question:

1. Restate it in one line, with its handle.
2. Give the choices, the recommended one and why. `choices only` refuses any other answer;
   `multi-select` takes several, comma-separated. A question can be both:
   `(multi-select, choices only)`.
3. Check what you can yourself first: read the file, the issue (`kabane_context`) or the command
   the question points at, and say what you found when it sharpens or changes the recommendation.
   Do not ask the human what the code can answer.
4. Ask this one question and wait. Where the harness offers a choice prompt (Claude Code's
   AskUserQuestion) you may use it; plain text works everywhere.

Then act on the reply. A handle can shift when sync brings in an earlier question, so just before
recording, re-read that issue (`kabane_questions` with its `id`): if the handle no longer shows the
same question text, use the handle that does and tell the human what moved.

- **A choice, or a free answer the question allows:** `kabane_answer` with the handle, the
  answer and `relayed: true`, and the human's own words as `reasoning` when they gave a reason.
- **Pushback or a question back:** discuss it, then ask again. Record nothing until they decide.
- **"skip":** leave it open and move to the next one.
- **"withdraw":** `kabane_answer` with `withdraw: true`, `relayed: true` and the human's reason
  as `reasoning`; ask for the reason if they gave none.

`relayed: true` credits the decision to the human, not to you: it is their reply, and you are
recording it. If `kabane_answer` refuses it because the connection knows no human, say so and
ask whether to record the answer under your own name instead. If it refuses for any other
reason, say why and ask again. When its result says the issue moved to next,
say so: that was its last open question, and its agent can pick it up again.

Only the human answers. Never record an answer they did not give, the recommended one included,
however obvious it looks.

## Finish

When the questions run out, or the human stops, end with one line: how many were answered,
withdrawn and skipped, and which issues moved to next.
