# @cabane/checklist

The steps of one issue, ticked as they land. It is a data module: its own table
(`task_checklist_items`), migrations, MCP tools and a section of the brief, registered with
`Runtime.configure({ modules: [checklistModule] })`. The CLI and the hub register it; a host that
does not has no checklists, which is not an error.

An item has no assignee, no state beyond done, and no brief; if it needs any of those, it's a
subtask. A separate deliverable is a subtask too.

## MCP tools

- `kabane_checklistAdd` adds 1–50 items to an issue, in the order given, at the end or from a
  1-based `position`. It returns one line: `JCAB-12 0/2 · added JCAB-12.1 id:<ULID>, JCAB-12.2 id:<ULID>`.
- `kabane_checklistTick` ticks items of one issue by handle or ULID; `done: false` unticks them.
  An item already in that state is left alone, who ticked it included. It returns
  `JCAB-12 2/2 · ticked JCAB-12.1, JCAB-12.2`.
- `kabane_checklistEdit` changes one item's `text`, its `position`, or both, or removes it with
  `remove: true` alone. It returns `JCAB-12 1/2 · moved JCAB-12.2 to 1`.

The module's MCP instructions carry the item-or-subtask rule.

## Handles

`JCAB-12.3` is the issue's short id and the item's ordinal on it, in creation order. Ordinals
count removed items, so moving or removing an item renumbers none; a removed item keeps its row
with `removed_at` set. Sync can bring in an earlier item from another device and shift a handle;
the ULID never moves, and every surface takes it bare or as `id:<ULID>`. A question's handle,
`JCAB-12:3`, is refused with the item form to use instead.

## Order

Each item carries a fractional `rank` (base-36, ordered bytewise), then its id breaks ties. A move
or an insert writes the item alone. Two devices that append at once can take one rank; the id
orders them the same way everywhere, and the next insert between the pair re-ranks the tied run.

## On the CLI and in the brief

`kabane checklist <id>` prints the list, `kabane checklist add <id> <text…>` adds an item,
`kabane checklist tick <item…>` ticks, and `kabane checklist edit <item>` edits; `--json` gives
`ChecklistItemView`s (camelCase, with `handle` and `done`).

The brief (`kabane_context`, `kabane show`) carries the `checklist.items` section after the
description, and omits it when the issue has no items:

```
## Checklist 1/2

- [x] JCAB-12.1 Write the migration id:01K9Z3V4Q8M2D6E7F8G9H0J1K2
- [ ] JCAB-12.2 Add the tools id:01K9Z3V4Q8M2D6E7F8G9H0J1K3
```

## Sync

Items replicate like tasks, last writer wins on `updated_at`, and go with their issue. A device
that has not registered the module, or runs an older one, parks their ops and keeps pulling.

## Exports

`checklistModule` to register; over a store path, `Checklist.list` (an issue's live items in
order), `Checklist.progress` (done and total per task ULID, for every task with items),
`Checklist.add`, `Checklist.tick`, `Checklist.edit` and `Checklist.resolve`. Each write returns a
`ChecklistChange`: the items it changed, the issue's label and its progress. `checklistMarkdown`,
`itemMarkdown`, `changeReceipt` and `editReceipt` are the lines every surface prints.
