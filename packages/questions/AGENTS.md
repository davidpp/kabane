# @cabane/questions

A data module: the decisions an agent asks a human for, filed on an issue and answered from any
surface. It owns the `task_questions` table and its migrations, the tools `kabane_ask`,
`kabane_questions` and `kabane_answer`, the brief's `questions.decisions` section, one MCP
instructions paragraph, and an `onTaskStateChange` hook that withdraws open questions when their
issue closes. `README.md` describes the tools and their rules; read it before changing one.

## It depends on core alone and is registered by both hosts

Its layer is `data module`; its entry in `scripts/layers.ts` (`"@cabane/questions"`) says what
it may list, and `bun run layers` fails anything else. `@cabane/sqlite` is a `devDependency`
for tests only. Two hosts register `questionsModule`, in the same order, beside the other
modules: `MODULES` in `packages/cli/src/context.ts` and the module list in
`packages/worker/src/hub.ts`. A change to what the module declares reaches both. The board and
the CLI also call its exports (`Questions`, the page and markdown renderers).

## The module seam's rules are core's

`packages/core/AGENTS.md`, "Data modules", holds them: append-only migrations against the
module's own version table, every write captured with `Oplog.afterWrite` or
`Oplog.afterDelete`, a task's state changed only through `Planner.updateTaskIn` inside the
module's transaction with `TASK_UPDATED` emitted after the commit. `storage.ts` shows each one
(`atomic`, then `Oplog.afterWrite`, then `Planner.updateTaskIn` when the last answer moves the
issue to `next`).

Read before writing: `module.ts`, `storage.ts`, `sync.test.ts` (two devices through the
in-process relay, with and without the module registered).

## Verify

```bash
bun test packages/questions
bun run --cwd packages/worker test      # the hub registers this module too
bun run sandbox add "decide" --kind issue
bun run sandbox mcp                     # then tools/call kabane_ask and kabane_answer over stdio
bun run gallery --print question-open --width 80   # how the board shows one
```

## Mistakes that are easy to make here

- Editing a shipped migration in `migrations.ts` instead of appending one. Devices and the hub
  have already run it.
- Writing a row without capturing it, which keeps it off every other device. `sync.test.ts`
  fails when a write path forgets.
- Writing to `tasks` with SQL. A state change goes through `Planner.updateTaskIn`, so every
  module's `onTaskStateChange` runs.
- Crediting the human with an answer an agent chose. `relayed: true` is only for a reply the
  human gave; the README says what `kabane mcp` and the hub do when no human is known.
