# @cabane/questions

The decisions an agent needs from a human, filed on an issue and answered whenever the human
gets to them. It is a data module: its own table (`task_questions`), migrations, MCP tools and a
section of the brief, registered with `Runtime.configure({ modules: [questionsModule] })`. The
CLI and the hub register it; a host that does not has no decisions, which is not an error.

## MCP tools

- `kabane_ask` files 1–10 questions on an issue: the question, its `choices`, the `recommended`
  one and `why`. With choices, only a choice is accepted unless `allowFreeform` is true;
  `multiSelect` takes a comma list. The issue goes to `waiting` unless `waiting: false`. It
  returns one line per question: `JCAB-12:1 id:<ULID>`.
- `kabane_questions` reads them grouped by issue, open ones by default (`status: "all"` adds
  answered and withdrawn), for one issue (`id`) or a scope, as a page of at most 16KiB with a
  `nextCursor` line when there is more.
- `kabane_answer` answers one by handle or ULID, or withdraws it with `withdraw: true` and
  `reasoning`. Choices match ignoring case. Answering the last open question moves a `waiting`
  issue to `next` in the same transaction. An agent recording a reply the human gave it (the
  grill, the copilot) sets `relayed: true`: the answer is credited to the human (`answered_by`)
  and the write to the agent (`updated_by`). It is refused when the connection knows no human:
  `kabane mcp` relays for the device's configured actor, whatever `--as` says, and the hub for
  the Access identity when Access authenticated a human, never for a service token.

Closing an issue (`done` or `cancelled`, from any surface) withdraws its open questions with
the reasoning "issue closed", in the same transaction. Reopening it restores none of them.

A question reads as its handle, its text, its mode, and its id:

```
## JCAB-12 Pick a store · normal · waiting

JCAB-12:1 Which store? (choices only) id:01K9Z3V4Q8M2D6E7F8G9H0J1K2
- SQLite ★
- Remote
why: the hub syncs it anyway
```

The mode is `(choices only)`, `(multi-select)`, or both. The handle is the issue's short id and
the question's ordinal on it, counting closed ones, so answering never renumbers. Sync can bring
in an earlier question from another device and shift it; the ULID never moves.

## On the CLI and in the brief

`kabane questions [<id>]` prints the same page, and `--json` gives it as `{ items, hasMore,
nextCursor }`, each item a `QuestionView` (camelCase, with `handle`, the issue's `title`,
`priority` and `state`). `kabane answer <handle> <answer…> [--reason <text>]` answers one.

The brief (`kabane_context`, `kabane show`) carries the `questions.decisions` section after the
discussion: each decision made, `question → answer (who, reasoning)`, and the open ones. A
question too large for a page is read there, with `responseFormat: "concise"` and `sections:
["questions.decisions"]`.

## Sync

Questions replicate like tasks, last writer wins on `updated_at`, and go with their issue. A
device that has not registered the module, or runs an older one, parks their ops and keeps
pulling ([`docs/deploy.md`](../../docs/deploy.md)).

## Exports

`questionsModule` to register; `Questions.ask`, `Questions.answer` and `Questions.list` over a
store path; `questionRowPage` and `questionPageMarkdown`, the one paging path the tool and the
CLI share; `questionMarkdown` for one question; `parseDecisionBody` and `validateAnswer`, which
every answering surface (the board's form included) judges an answer with.
