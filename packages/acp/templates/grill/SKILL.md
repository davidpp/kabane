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
   `(multi-select, choices only)`. A choice can be named by its label, the text before its first
   `.`, `:` or `)`: `B` for "B. One tree", `b, c` for two.
3. Check what you can yourself first: read the file, the issue (`kabane_context`) or the command
   the question points at, and say what you found when it sharpens or changes the recommendation.
   Do not ask the human what the code can answer.
4. Ask this one question and wait. Ask it through the harness's choice prompt whenever it
   offers one (Claude Code's AskUserQuestion): the choices as its options, the recommended one
   first, several picks allowed on a multi-select. A reply typed instead of picked is still the
   human's reply. Fall back to plain text, ending your turn on the question, only where there is
   no such prompt or it cannot hold the choices.

Then act on the reply. A handle can shift when sync brings in an earlier question, so just before
recording, re-read that issue (`kabane_questions` with its `id`): if the handle no longer shows the
same question text, use the handle that does and tell the human what moved.

- **A choice, or a free answer the question allows:** `kabane_answer` with the handle, the
  answer and `relayed: true`, and the human's own words as `reasoning` when they gave a reason.
- **A decision the question's shape does not fit**, such as two picks on a single choice, an
  option it does not list, or a different question altogether: do not squeeze it into the nearest
  choice. Reshape the question with `kabane_ask` and `replaces` set to its handle: the question as
  the discussion left it, choices that hold what was concluded (`multiSelect` when the decision
  picks several), and a `why` that keeps the reasoning. The old question is withdrawn as replaced
  by the new one in the same write, and the issue stays waiting. Then record the decision on the
  new handle with `kabane_answer` and `relayed: true`, as for a choice.
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
