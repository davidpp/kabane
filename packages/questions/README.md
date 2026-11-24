# @kabane/questions

The decisions an agent needs from a human, filed on an issue and answered whenever the human
gets to them. It is a data module: three entry kinds on the record, the migration that moved its
old table (`task_questions`) onto them, MCP tools and a section of the brief, registered with
`Runtime.configure({ modules: [questionsModule] })`. The CLI and the hub register it; a host that
does not has no decisions, which is not an error.

A question is an entry of kind `questions.ask` on its issue, addressed (`to`) to the human the
asking connection relays for. An answer is a `questions.answer` entry that replies to it (`re`),
a withdrawal a `questions.withdraw` one. The newest reply decides the question's status, answer
and reasoning, so a second answer overwrites the first. The ask kind declares those two as the
replies that close it, which is what `kabane wait addressed` reads. The three kinds are projected
`none`: the brief shows them in `questions.decisions` only, never in the Discussion.

## MCP tools

- `kabane_ask` files 1–10 questions on an issue: the question, its `choices`, the `recommended`
  one (its full text or its label) and `why`. With choices, only a choice is accepted unless
  `allowFreeform` is true; `multiSelect` takes a comma list, so each of its choices needs a label
  without a comma, while the rest of its text may hold anything. The issue goes to `waiting`
  unless `waiting: false`. It returns one line per question: `JCAB-12:1 id:<ULID>`.
- `replaces` on a question reshapes an open one on the same issue, named by handle, ULID or
  `id:<ULID>`: the new question is filed and the old one withdrawn with the reasoning
  `replaced by JCAB-12:2 id:<ULID>`, in one transaction, so the issue stays `waiting`. The grill
  uses it when the human's decision does not fit the choices, such as two picks on a single
  choice.
- `kabane_questions` reads them grouped by issue, open ones by default (`status: "all"` adds
  answered and withdrawn), for one issue (`id`) or a scope, as a page of at most 16KiB with a
  `nextCursor` line when there is more.
- `kabane_answer` answers one by handle, ULID or `id:<ULID>` as a page prints it, or withdraws
  it with `withdraw: true` and `reasoning`. A choice is named by its full text or by its label,
  the text before its first `.`, `:` or `)` when a space follows it (`B` for "B. One tree",
  `yes` for "Yes: one pass", none for "3.5 seconds"), ignoring case; a label two choices share
  is refused with both listed. The full text is what is recorded. Answering the last open question moves a `waiting` issue to `next` in the same
  transaction. An agent recording a reply the human gave it (the grill, the copilot) sets
  `relayed: true`: the answer is credited to the human (`answered_by`) and the write to the
  agent (`updated_by`). It is refused when the connection knows no human: `kabane mcp` relays
  for the device's configured actor, whatever `--as` says, and the hub for the Access identity
  when Access authenticated a human, never for a service token.

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

Questions replicate as the record's entries, which are append-only: two devices that answer the
same question offline both keep both answers, and the newer one reads as the answer on each. A
device without the module stores them and shows them in the Discussion as kinds it does not know.

Migration 4 moved every `task_questions` row onto the record, every value taken from the row: the
question keeps its id, and a closed one gets one reply whose id is derived from the row, so two
devices migrating the same rows write the same entries. The table kept only the last closing of a
question, so a question answered twice migrates with one answer, and `version` (1 plus its
replies) reads 2 where the row said 3. A migrated question has no `to`: the row did not say whom
it asked. An armed device runs `kabane sync backfill` after upgrading, as for core's migration 14.

## Exports

`questionsModule` to register; `Questions.ask`, `Questions.answer` and `Questions.list` over a
store path; `questionRowPage` and `questionPageMarkdown`, the one paging path the tool and the
CLI share; `questionMarkdown` for one question; `parseDecisionBody` and `validateAnswer`, which
every answering surface (the board's form included) judges an answer with.
