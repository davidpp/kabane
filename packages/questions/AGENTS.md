# @kabane/questions

A data module: the decisions an agent asks a human for, filed on an issue and answered from any
surface. It owns three entry kinds on the record (`kinds.ts`), the migrations that moved its old
`task_questions` table onto them, the tools `kabane_ask`,
`kabane_questions` and `kabane_answer`, the brief's `questions.decisions` section, one MCP
instructions paragraph, and an `onTaskStateChange` hook that withdraws open questions when their
issue closes. `README.md` describes the tools and their rules; read it before changing one.

## Verify

```bash
bun test packages/questions
bun run --cwd packages/worker test         # the hub registers this module too
bun run sandbox init                       # once per fresh sandbox
bun run sandbox add "decide" --kind issue
bun run sandbox mcp                        # initialize, then tools/call kabane_ask on the issue
bun run sandbox questions                  # the question as a human reads it
bun run sandbox answer <id>:1 B            # answering the last one moves the issue to next
bun run gallery --print question-open --width 80
```

`kabane_ask` has no CLI command, so filing a question goes through `kabane mcp` over stdio.

## Mistakes that are easy to make here

- Returning an `err` from inside an `atomic` callback. `atomic` commits whatever the callback
  returns, an `err` included; only a throw rolls back.
- Writing raw SQL on `entries`. Write through `Planner.addEntryIn`, so each write is stamped
  and captured.
- Crediting the human with an answer an agent chose. `relayed: true` is only for a reply the
  human gave; the README says what `kabane mcp` and the hub do when no human is known.
