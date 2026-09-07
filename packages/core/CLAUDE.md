# @cabane/core

Coordination substrate for agent teams, with humans consuming it to plan and review. Most items are AI-created; the tracker's job is to hold the *structure* agents need — sessions, typed activities, curated context, a link DAG — so no consumer reinvents it in prose.

Extracted from Jake's planner (`~/Projects/jake/packages/planner`, JCAB-3). Public storage function names were kept so Jake's CLI and tRPC router compile against this package unchanged.

## Design principles

1. **Unix composability.** Every capability is optional at use time. `addTask` touches the tasks table and nothing else. Sessions never gate commenting; the context registry costs zero when empty; `assembleContext` degrades over whatever exists.
2. **Soft typing.** Freeform TEXT columns with Zod-*suggested* well-known values (`SESSION_STATES`, `ACTIVITY_TYPES`, context kinds) — never CHECK constraints or closed enums. Task `state` is the one hard enum (7 canonical values).
3. **Write structured, read folded.** Agents classify at write time (activity type, severity, ref kind) so the read path can fold, filter, and assemble.
4. **Curation ≠ record.** Work logs are append-only and complete (outputs). The context registry is maintained and current (inputs). Same URI vocabulary, different lifecycle.

## The Db port and runtime wiring

Storage functions take a `basePath: string`, not a database handle. `Runtime.configure` turns that string into a `Db`:

```ts
import { Runtime } from "@cabane/core";
import { SqliteDb } from "@cabane/sqlite";

Runtime.configure({
  provider: SqliteDb.provider({ dbName: "cabane.db" }),
  tablePrefix: "",            // "planner_" when sharing a database with other modules
  tracer, notifier, scopeResolver, syncSettings, actor,   // all optional, all no-op by default
});
await Planner.init(basePath);
```

- **`Db`** (`db/port.ts`) mirrors the `bun:sqlite` subset the code was written against: `query(sql).get/all/run`, `run`, `exec`, `transaction`. A Durable Object adapter implements the same five calls over `SqlStorage`. `run` returns `{ changes }`.
- **`DbProvider.withDb(basePath, fn)`** opens per unit of work and closes after. `basePath` is opaque to the core: a directory for the bun adapter, ignored by a DO that owns one database.
- **`atomic(basePath, fn)`** (`runtime.ts`) runs `fn` inside BEGIN IMMEDIATE / COMMIT with awaits allowed between statements. A provider that cannot issue BEGIN supplies its own `atomic`.
- **Table names** (`db/tables.ts`): `TABLES.x` are getters over a runtime prefix. Never capture `TABLES.x` into a module-level constant — it evaluates at import, before configuration. `physicalTable(logical)` and `tablePrefix()` exist for names built in code (triggers, indexes).
- **Schema** (`db/schema.ts`): one DDL with logical names, `prefixSql` rewrites CREATE TABLE / INDEX / REFERENCES / ON, `generateFtsSql` builds the FTS5 tables and triggers. `prefixSql` does NOT rewrite CREATE TRIGGER, which is why capture triggers are built in `storage/oplog.ts` from physical names.
- **Migrations** (`storage/helpers.ts` `runMigrations`): `columnExists`-guarded `ALTER TABLE`s, one contract. New tables go in `SCHEMA_SQL` (IF NOT EXISTS re-runs on every init); column adds go here. Order in `Planner.init`: schema, migrations, capture triggers — the triggers read the live column list.
- **Ports with no-op defaults:** `traced()` (`observability.ts`) delegates to the configured `Tracer`; `Events.emit` to the `Notifier`; session-defaults' scope fallback to the `ScopeResolver`; `SyncDevice.settings()` to `SyncSettingsSource`.

Tests import `./testing`, which configures the bun:sqlite provider with plain names. The smoke test in `packages/sqlite/smoke.test.ts` runs the same flow under `""` and `"planner_"`.

## Task vs Issue

| Aspect | Task (`kind: 'task'`) | Issue (`kind: 'issue'`) |
|--------|----------------------|------------------------|
| Mental model | GTD (inbox → next → done) | Issue tracker |
| Executor | Single human | AI agents (parallel) |
| Completion | Mark done | Verification + review |

Both share the same states with different interpretation: `inbox` = triage (task) / backlog (issue); `next` = ready to work (task) / ready for an agent (issue); `in_progress` = human working (task) / agent working (issue).

## GTD states (canonical — 7, hard enum)

`TaskStateSchema` (`schemas/task.ts`) is a closed `z.enum`, the only one in the package: `inbox`, `next`, `in_progress`, `waiting`, `someday`, `done`, `cancelled`. `needs_review` is **not** a state; use the `needsReview` flag. `Planner.updateTask` validates at the top because hosts call storage directly.

## `short_id` is a nickname, not an identity

`id` (ULID) is identity. `short_id` (`JCAB-42`) is a human-facing label minted from a per-prefix **machine-local** counter, so two devices working offline both hand out `JCAB-42`.

**Ruling.** In a collision the ULID-earlier row keeps the label live; the other is relabelled at apply time. Both devices compute the same winner from the same two ULIDs. `short_id_history` is an **audit trail, not a lookup**: the winner holds the label live, so resolving it never falls through. A stale external reference (a commit message) resolves to the winner.

- Never key on `short_id` across machines. Resolve to the ULID first (`Planner.resolveTaskId`).
- `sequences` does not replicate. `sync/apply.ts` raises each counter past every label a batch delivered.
- Do not propose block leasing, hash IDs, or an ID format change. Considered and rejected; the rename protocol is the agreed repair.
- `\d+` is hardcoded in `commit-linker/patterns.ts` and `SHORT_ID_PATTERN` in `storage/helpers.ts`. `next_number` stores the *last used* number.

## Multi-device sync

Off by default. The local database stays authoritative; every storage write on a replicated table ends with `Oplog.afterWrite` / `Oplog.afterDelete` (`storage/oplog.ts`), which appends a row snapshot to `sync_oplog`, and a pass ships those ops to a shared ordered log (the Worker) that assigns the total order.

**Capture is a storage-layer step, not a trigger.** Triggers were dropped because `CREATE TRIGGER` is undocumented on Durable Object SQLite and because a trigger fires for every writer, which forced a database guard around the applier. `Apply` writes rows directly and never enters the capture path, so there is nothing to guard; `sync_state.apply_guard` is legacy and unread. `Planner.init` drops the old `sync_cap_*` triggers so an upgraded database does not capture twice. Consequences for anyone adding a write path: call `Oplog.afterWrite(db, tbl, "insert"|"update", id)` after the statement, snapshot first and `Oplog.afterDelete` after for deletes, and for a task delete use `Oplog.cascadeOf` so the FK cascade is captured children-first.

**Every replicated row carries `updated_by`, `version`, `visibility`.** `updated_by` is the actor URI from the `actor` runtime port (`cabane://actor/human/<name>`, `cabane://actor/agent/<runtime>`; default `cabane://actor/unknown`). `version` starts at 1 and every local update does `version = version + 1`. `visibility` is `shared` by default on the seven replicated tables and fixed `private` on `upstream_links`; **a private row never enters the oplog**, whichever table it lives in — the filter is the column, `SYNC_TABLES` only says which tables the resolver knows a rule for. Old databases get the columns through `runMigrations` (guarded `ALTER TABLE`), and `storage/migrations.test.ts` boots new code on a pre-column table.

**Tie-break chain** (`sync/resolve.ts`): clock, then ULID, then `version` (more writes win), then `updated_by` (lower URI wins), then `device_id`. The last two steps are what make three or more devices converge: the device id alone stood in for "who wrote this", which is exact for two machines and wrong once a third machine compares a row it merely received. `Apply` writes `max(local.version, incoming.version)` and, on `tasks`, leaves a `sync_conflict_resolved` activity (old_value = the local version that lost, new_value = the incoming version) when a local lineage with at least as many writes was overwritten.

- `SyncDevice.connect` (`sync/device.ts`) is the one place settings become a transport, and it **arms capture as a side effect of the first connection**. Device identity is write-once.
- **Nothing already in the database when you enable sync replicates.** `Backfill.run` (`sync/backfill.ts`) seeds the log for an armed device through the same `Oplog.snapshotOp` live capture uses; op ids are `bf:<tbl>:<rowId>:v<version>`, so a re-run is a no-op and a row edited since is re-emitted. Private rows are skipped and counted.
- **`server_seq` has gaps.** Only monotonicity is promised.
- **`throughSeq` comes from the page**, never from `ops.at(-1)`.
- **Quarantine is a liveness fix.** Only a server content refusal (400/413/500) quarantines; a 401 or a dead network propagates.
- **A log reset is detected from `PushAck.head`.**
- `local-relay.ts` is the permanent test double, so every convergence assertion runs with no Cloudflare.

Sync set: `tasks`, `task_links`, `focus_lists`, `task_comments`, `task_work_log`, `projects`, `task_context_refs`. Excluded: `task_activity`, `agent_sessions`/`agent_activities`, `proposals`, `sequences`, `upstream_links` (private by schema).

## `assembleContext` — THE agent read entrypoint

One primitive builds an issue's full brief as markdown. Sections in order, empty ones omitted: title + metadata, description (never truncated), position (parent, blockers, blocks, subtask states), context (registry refs, `file:` deref'd inline with caps), prior work (work-log refs), discussion (all human comments merged with the durable machine signal). Caps: `perRefCap` 8KB, `totalRefCap` 24KB, `maxTimelineEntries` 20.

## Agent sessions

`agent_sessions` + `agent_activities`, CASCADE from tasks, soft TEXT. State machine in `storage/sessions.ts`: `start → active`, a `question` activity → `awaiting_input`, any non-question activity once no question is unanswered → `active`, `end(complete|error)` compacts ephemerals and emits a `response` activity from the summary, idle > 24h → `stale` via `sweepStaleSessions`.

Ephemeral rows are a query-time filter plus compact-on-close. The shared fold is `Planner.selectDurableActivities`: keeps `response`/`finding`/`verification`/`decision`/`handoff`, drops the rest plus all-but-latest ephemeral.

**Questions and answers.** A `question` activity's body carries answerable metadata as a leading fenced `json` block (`schemas/question-body.ts`). `answerQuestion` writes a `decision` activity whose `context` is exactly `answers <questionActivityId>`. The session unblocks only once every question is answered. Re-answering supersedes, never erases.

## Context registry, work logs, links

- **Context refs** (`task_context_refs`, `UNIQUE(task_id, uri)` upsert): the curated input side. Kinds are soft; `promoteToContext` writes the registry row and a work-log ref in one call.
- **Work logs**: append-only URI refs — `session:`, `commit:`, `pr:owner/repo#n`, `issue:`, `file:`, `url:`, `branch:`.
- **Links**: `blocks`/`blocked_by`, `parent`/`child`, `related`, `duplicate`, `follows`. `UNIQUE(source_id, target_id, type)`.
- **Projects**: a flat `projectId` on the task, not a scope boundary.
- **Scope**: `scopeUri` is a string the core parses and formats (`ScopeUri`) and never resolves. Bare ids normalize to `jake://scope/<id>`; the scheme is kept for wire compatibility with existing data.

## Not moved from Jake (host adapters)

`parser/` (AI extraction), `workflows/`, `hooks/`, `trpc/`, `cli/`, `widgets/`, `jake-module.ts`, `db-registration.ts`. `storage/schema.sql.ts` was dead and was not ported. The `proposals` surface is retired in Jake (JJAK-982) but still consumed by its CLI, router and dashboard, so it moved as-is; drop it once those consumers are gone.
