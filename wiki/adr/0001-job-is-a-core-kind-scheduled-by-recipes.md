# 0001: A job is a core item kind; its schedule and commands live in the recipes extension

- Status: accepted
- Date: 2026-11-16
- Issue: JCAB-426 (question :36 and the decision comment on slice 2), built in JCAB-522 and
  JCAB-523
- Decided by: David

## Context

A job is a standing personal request that runs a recipe on a schedule. The proposal in
`wiki/agent-work-contracts.md` left open whether a job is a table in a data module, a third
value of the core item kind, or a task with a recurrence field. It noted that a module can own a
`jobs` table without touching core, but that `kabane list`, the board, search and the brief read
items, and would not show jobs until each learned to.

Two things were already fixed when slice 2 was designed. The run table and `startRun` are in the
`recipes` extension (JCAB-444:1). And an extension may not depend on another extension
(`ARCHITECTURE.md`, checked by `scripts/layers.ts`).

## Decision

`job` is a third value of the core item kind. David answered JCAB-426:36 with "Job kind", and
confirmed it for slice 2. The job's title, request, scope, tags, state, comments and questions
are the item's own.

The schedule row, `kabane job` and `kabane job tick` are in the `recipes` extension, next to
`startRun`. The reason on record is that firing a job starts a run, the run table is in
`recipes`, and no extension may depend on another.

## Consequences

- Everything that reads items can read a job, and a job needs no state, comment or question
  machinery of its own.
- Adding a kind is a core change, which a module table would have avoided.
- This departs from David's earlier packaging answer (JCAB-426:35), which put jobs and runs in
  data modules. The schedule follows the run table, so it is in an extension for as long as the
  run table is.
- A device that does not load the `recipes` extension has job items with no schedule and no
  `kabane job` command.

## Replaceable by

The schedule and the commands move if JCAB-461 creates a runs capability outside the extension.

## Alternatives rejected

- A `jobs` table in a data module: jobs would be missing from lists, the board, search and the
  brief until each was taught to read them.
- A task with a recurrence field: listed in the proposal's open decisions. No reason for
  rejecting it is on record.
- A separate jobs extension: it would have to call `startRun` in `recipes`, which is one
  extension depending on another.
