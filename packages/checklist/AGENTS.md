# @kabane/checklist

A data module: the steps of one issue, ticked as they land. It owns the `task_checklist_items`
table and its migrations, the tools `kabane_checklist`, `kabane_checklistAdd`,
`kabane_checklistTick` and `kabane_checklistEdit`, the brief's checklist section and one MCP
instructions paragraph that carries the item-or-subtask rule. `README.md` describes handles (`JCAB-12.3`), ordinals and
removal; read it before changing one.

## Verify

```bash
bun test packages/checklist
bun run --cwd packages/worker test             # the hub registers this module too
bun run sandbox init                           # once per fresh sandbox
bun run sandbox add "steps" --kind issue
bun run sandbox checklist add <id> "first step" "second step"   # one item per argument
bun run sandbox checklist <id>
bun run gallery --print detail-checklist --width 80
```

## Mistakes that are easy to make here

- Capturing only the items you inserted. Inserting between tied ranks re-ranks the run it lands
  in; `place` returns those as `moved`, and each one is written and captured.
- Deleting an item's row. Removal sets `removed_at`; handles count removed items.
- Keying anything on a handle across devices. Sync can shift `JCAB-12.3`; the ULID never moves.
