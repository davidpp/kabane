# @cabane/checklist

A data module: the steps of one issue, ticked as they land. It owns the `task_checklist_items`
table and its migrations, the tools `kabane_checklistAdd`, `kabane_checklistTick` and
`kabane_checklistEdit`, the brief's checklist section and one MCP instructions paragraph that
carries the item-or-subtask rule. `README.md` describes handles (`JCAB-12.3`), ordinals and
ranks; read it before changing one.

## It depends on core alone and is registered by both hosts

Its layer is `data module`; its entry in `scripts/layers.ts` (`"@cabane/checklist"`) says what
it may list, and `bun run layers` fails anything else. `@cabane/sqlite` is a `devDependency`
for tests only. Two hosts register `checklistModule`: `MODULES` in
`packages/cli/src/context.ts` and the module list in `packages/worker/src/hub.ts`. The board
reads `Checklist` for card progress and the detail, the CLI's `kabane checklist` calls it, and
the loop calls `Checklist.list` and `Checklist.progress` directly today.

JCAB-322 adds read tools to this module, because an extension will reach checklists through
tools instead of `Checklist` (`ARCHITECTURE.md`, "The record half of `host`"). Until then,
expect the loop's direct calls.

## The module seam's rules are core's

`packages/core/AGENTS.md`, "Data modules", holds them: append-only migrations, every write
captured with `Oplog`, a task touched only through `Planner.updateTaskIn`. A removed item keeps
its row with `removed_at` set, so ordinals never shift.

Read before writing: `module.ts`, `storage.ts`, `rank.ts` (fractional ranks for position),
`sync.test.ts`.

## Verify

```bash
bun test packages/checklist
bun run --cwd packages/worker test             # the hub registers this module too
bun run sandbox add "steps" --kind issue
bun run sandbox checklist add <id> "first step"
bun run sandbox checklist <id>
bun run gallery --print detail-checklist --width 80
```

## Mistakes that are easy to make here

- Editing a shipped migration instead of appending one.
- Deleting an item's row. Removal sets `removed_at`; handles count removed items.
- Keying anything on a handle across devices. Sync can shift `JCAB-12.3`; the ULID never moves.
- Growing an item toward a subtask (an assignee, a state, a brief). The README's rule says that
  is a subtask instead.
