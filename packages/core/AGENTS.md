# @kabane/core

Coordination substrate for agent teams, with humans consuming it to plan and review. Most items are AI-created; the tracker's job is to hold the *structure* agents need — typed timeline entries, work-log refs, curated context, a link DAG — so no consumer reinvents it in prose.

## Design principles

1. **Unix composability.** Every capability is optional at use time. `addTask` touches the tasks table and nothing else. The context registry costs zero when empty; `assembleContext` degrades over whatever exists.
2. **Soft typing.** Freeform TEXT columns with Zod-*suggested* well-known values (entry kinds, context kinds, work-ref schemes) — never CHECK constraints or closed enums. Task `state` is the one hard enum (7 canonical values).
3. **Write structured, read folded.** Agents classify at write time (entry kind, ref kind) so the read path can fold, filter, and assemble.
4. **Curation ≠ record.** Work logs are append-only and complete (outputs). The context registry is maintained and current (inputs). Same URI vocabulary, different lifecycle.

## The Db port and runtime wiring

Storage functions take a `basePath: string`, not a database handle. `Runtime.configure` turns that string into a `Db`:

```ts
import { Runtime } from "@kabane/core";
import { SqliteDb } from "@kabane/sqlite";

Runtime.configure({
  provider: SqliteDb.provider({ dbName: "kabane.db" }),
  tracer, notifier, syncSettings, actor,   // all optional, all no-op by default
  modules: [],                // data modules (below); default none
});                           // a Result: err when the module set is invalid, and nothing changed
await Planner.init(basePath);
```

- **`Db`** (`db/port.ts`) mirrors the `bun:sqlite` subset the code was written against: `query(sql).get/all/run`, `run`, `exec`, `transaction`. A Durable Object adapter implements the same five calls over `SqlStorage`. `run` returns `{ changes }`.
- **`DbProvider.withDb(basePath, fn)`** opens per unit of work and closes after. `basePath` is opaque to the core: a directory for the bun adapter, ignored by a DO that owns one database.
- **`atomic(basePath, fn)`** (`runtime.ts`) runs `fn` inside BEGIN IMMEDIATE / COMMIT with awaits allowed between statements. A provider that cannot issue BEGIN supplies its own `atomic`.
- **Table names** (`db/tables.ts`): `TABLES.x` is the name the DDL creates, SQL addresses and an op's `tbl` carries.
- **Schema** (`db/schema.ts`): one DDL, and `generateFtsSql` builds the FTS5 tables and triggers.
- **Migrations** (`db/migrate.ts` runner, `storage/migrations.ts` list): numbered and append-only, version = index + 1, recorded in `schema_migrations`, each applied once in its own transaction. `Planner.init` is `Migrations.apply`. To change the schema, append a migration (any SQL over `TABLES.x`, backfills and rebuilds included); never edit a shipped one and never edit `SCHEMA_SQL`, which is migration 1, the release baseline. Migration 1 refuses a database that has tables and no version table: it was created before the runner, so before the first release, and kabane 1.0.0-beta.0 is the last build that brings one up to the baseline. `Migrations.SCHEMA_VERSION` rides on every pushed op, and a pull stops before an op from a newer core schema. The one exception to "append a migration" is bookkeeping the runner owns: each version table (`Migrate.ensureVersionTable`) and the data modules' `module_declarations` (`Modules.ensureDeclarations`, at the start of the module pass) are created with `CREATE TABLE IF NOT EXISTS` outside any numbered list, so they move no version, and none of them is ever replicated. Every other schema change is an appended migration. A registered data module's migrations run after core's, in registration order, against its own version table (`schema_migrations_<name>`, a dash becoming an underscore); a module migrating never moves `SCHEMA_VERSION`, and a database a newer build of a module migrated is refused for that module.
- **Data modules** (`module.ts`): a `KabaneModule` is a `name`, its own append-only `migrations`, and the `syncTables` it replicates, each with a resolver `family` (`row-lww` or `append-only`), an optional LWW `clock` column, and `childOfTasks` (its `task_id` names a thread; no foreign key, since `tasks` is a view from migration 14, and a module table that once referenced `tasks(id)` drops the reference in a migration of its own). Modules may also supply `contextSections` (namespaced brief renderers), `kinds` (timeline entry kinds, below), `tools` (MCP tools), and `instructions` (an MCP instructions paragraph). A host checks the `Result` from `Runtime.configure({ modules })` and reads registrations with `Runtime.modules()`. Configure rejects duplicate module/table names, sections outside `<module>.` or colliding with core/registered sections, tools colliding with core/registered tools, and kinds that break the rules under "Timeline entries"; a refusal leaves the previous runtime unchanged. The resolver, apply, capture and backfill consult core's records first, then the registry. A module table's rows carry `updated_by`, `version` and `visibility` like core's, and its storage captures like core's (`Oplog.afterWrite` / `Oplog.afterDelete`); capturing a table no registered module declares is refused, except the delete of a row in a table an unregistered module's recorded declaration names. `Planner.init` records each registered module's declaration (name, schema, each sync table's `family`, `clock` and `childOfTasks`) in `module_declarations` when it first registers and whenever it changes: in the transaction of each module migration that runs (`Migrate.run`'s `after`, `Modules.recordIn`), and otherwise in a transaction of its own that only reads when nothing changed (`Modules.record`). The table is runner bookkeeping (above): `TABLES` lists it, so no module can claim the name, and `SYNC_TABLES` does not, so it never replicates. Capture and `Replicated.tables` read the registered modules, then the recorded declarations of unregistered ones (`Modules.unregistered`). A task delete is the thread's tombstone and touches no module row. An insert or update on such a table stays refused: nothing writes an unregistered module's rows. A module updating a task in its own transaction uses `Planner.updateTaskIn(db, id, updates)`, never raw SQL on tasks, and emits `TASK_UPDATED` with the returned task only after commit. A module may also declare `onTaskStateChange(db, task, from, to)`: `Planner.updateTaskIn`, the one path every local state change goes through (`updateTask`, so `kabane_done`, `kabane_edit`, the CLI, the board and the loop), calls it in the change's transaction once the task row is written and captured, and only when the state actually moves. Its writes capture like any module write; an `err` rolls the state change back, so `updateTask` runs in `atomic` and a caller of `updateTaskIn` throws on `err` inside its own transaction. Sync apply never calls it: the device that changed the state already captured what the hook wrote.
- **Ports with no-op defaults:** `traced()` (`observability.ts`) delegates to the configured `Tracer`; `Events.emit` to the `Notifier`; `SyncDevice.settings()` to `SyncSettingsSource`.

Tests import `./testing`, which configures the bun:sqlite provider. `packages/sqlite/smoke.test.ts` is the end-to-end smoke over that adapter.

## Task vs Issue

| Aspect | Task (`kind: 'task'`) | Issue (`kind: 'issue'`) |
|--------|----------------------|------------------------|
| Mental model | GTD (inbox → next → done) | Issue tracker |
| Executor | Single human | AI agents (parallel) |
| Completion | Mark done | Verification + review |

Both share the same states with different interpretation: `inbox` = triage (task) / backlog (issue); `next` = ready to work (task) / ready for an agent (issue); `in_progress` = human working (task) / agent working (issue).

A third kind, `job`, is a standing request a schedule runs. A listing that names no kind leaves jobs out (`selectTaskQuery` and `selectTodayBucket` in `storage/task-selection.ts`, so `kabane list`, `kabane_list`, today and the board); naming `job` returns only jobs. Reads by id, search, comments and `done` treat a job like any item. `kind` is plain TEXT with no CHECK, so the kind needed no migration.

## GTD states (canonical — 7, hard enum)

`TaskStateSchema` (`schemas/task.ts`) is a closed `z.enum`, the only one in the package: `inbox`, `next`, `in_progress`, `waiting`, `someday`, `done`, `cancelled`. `needs_review` is **not** a state; use the `needsReview` flag. `Planner.updateTask` validates at the top because hosts call storage directly.

## `short_id` is a nickname, not an identity

A thread’s `id` (ULID or plan key) is its identity. `short_id` (`JCAB-42`) is a human-facing label minted from a per-prefix **machine-local** counter, so two devices working offline both hand out `JCAB-42`.

**Projects only.** In a collision the ULID-earlier row keeps the label live; the other is relabelled at apply time. Both devices compute the same winner from the same two ULIDs. `short_id_history` is an **audit trail, not a lookup**: the winner holds the label live, so resolving it never falls through. A stale external reference (a commit message) resolves to the winner.

- Never key on `short_id` across machines. Resolve to the thread ID first (`Planner.resolveTaskId`).
- `sequences` does not replicate. `sync/apply.ts` raises each counter past every label a batch delivered.
- Since migration 14 a task's label is `threads.short_id`, minted as before (`generateShortId`, `storage/helpers.ts`) and looked up through the `tasks` view (`Planner.resolveTaskId`). The rename protocol (`sync/resolve.ts` `rename`, `sync/apply.ts` `executeRename`, `short_id_history`) still covers `projects` only: two threads minted offline under one label both keep it, and a lookup by it takes the first row. Use the thread ID when labels collide. A thread row apply stored raises its counter when its label has the minted form (`mintedLabel` into `reserveBatchLabels`). The label scheme is being reconsidered (JCAB-660 handoff).
- Do not propose block leasing, hash IDs, or an ID format change. Considered and rejected; the rename protocol is the agreed repair.
- `\d+` is hardcoded in `SHORT_ID_PATTERN` in `storage/helpers.ts`. `next_number` stores the *last used* number.
- **An id can come from keys** (`KEYED_ID_PATTERN`, `schemas/plan.ts`): `<plan key>/<thread key>`, lowercase. `Planner.applyPlan` (`storage/plans.ts`) files a plan's threads under such ids and its links, in one transaction, skipping each thread and link that already stands, so a second apply writes nothing; `addTask(..., { key })` does the same for one thread and returns it marked `existed`. `resolveTaskId` takes such an id as is (no label or ULID holds a slash). The thread still gets a minted label. A deleted thread keeps its key for good.

## Multi-device sync

Off by default. The local database stays authoritative; every storage write on a replicated table ends with `Oplog.afterWrite` / `Oplog.afterDelete` (`storage/oplog.ts`), which appends a row snapshot to `sync_oplog`, and a pass ships those ops to a shared ordered log (the Worker) that assigns the total order.

**Capture is a storage-layer step, not a trigger.** Triggers were dropped because `CREATE TRIGGER` is undocumented on Durable Object SQLite and because a trigger fires for every writer, which forced a database guard around the applier. `Apply` writes rows directly and never enters the capture path, so there is nothing to guard; `sync_state.apply_guard` is legacy and unread. Consequences for anyone adding a write path: call `Oplog.afterWrite(db, tbl, "insert"|"update", id)` after the statement, snapshot first and `Oplog.afterDelete` after for deletes, and a record row is never deleted (`RecordWrite`, a tombstone instead).

**Every replicated row carries `updated_by`, `version`, `visibility`.** `updated_by` is the actor URI from the `actor` runtime port (`ActorUri` in `actor.ts`: `kabane://actor/human/<name>`, `kabane://actor/agent/<runtime>`; default `kabane://actor/unknown`). Until schema 12 the prefix was `cabane://actor/`: migration 12 (`storage/actor-scheme.ts`) renamed core's identity columns, each work ref's `addedBy` and the snapshots in the device's own log and parked ops, and each data module that stores actors appends a migration of its own (`ActorScheme.renameColumns`). Nothing reads the old prefix afterwards: the CLI refuses it on input and points at `kabane doctor --fix`, and an op pulled from a device on schema 11 is not translated. `version` starts at 1 and every local update does `version = version + 1`. `visibility` is `shared` by default on every replicated table; **a private row never enters the oplog**, whichever table it lives in — the filter is the column, `SYNC_TABLES` only says which tables the resolver knows a rule for.

**Tie-break chain** (`sync/resolve.ts`): clock, then ULID, then `version` (more writes win), then `updated_by` (lower URI wins), then `device_id`. The last two steps are what make three or more devices converge: the device id alone stood in for "who wrote this", which is exact for two machines and wrong once a third machine compares a row it merely received. `Apply` writes `max(local.version, incoming.version)` and, on `tasks`, leaves a `sync_conflict_resolved` activity (old_value = the local version that lost, new_value = the incoming version) when a local lineage with at least as many writes was overwritten.

- `SyncDevice.connect` (`sync/device.ts`) is the one place settings become a transport, and it **arms capture as a side effect of the first connection**. Device identity is write-once.
- **Nothing already in the database when you enable sync replicates.** `Backfill.run` (`sync/backfill.ts`) seeds the log for an armed device through the same `Oplog.snapshotOp` live capture uses; op ids are `bf:<tbl>:<rowId>:<content hash>`, so a re-run is a no-op, a row edited since is re-emitted, and two devices holding different values of one row send two ops the resolver decides between. Private rows are skipped and counted.
- **`server_seq` has gaps.** Only monotonicity is promised.
- **`throughSeq` comes from the page**, never from `ops.at(-1)`.
- **A module's ops are tagged and parked, never skipped.** Capture tags a module table's op with `module: { name, schema }` (the module's migration count), stored in the oplog, and push sends it beside core's `schema`, whatever is registered by then. A device that has not registered that module, or runs an older version of it, stores the op as pulled in `sync_parked` (local, never replicated) and keeps pulling; only core ops stop a pull. Once an op for a row (table and id) is parked, every later op for that row parks behind it, even one this build can read, so the row's history replays in log order and a delete is never overtaken by an older update. A module that is not registered keeps its tables and rows; what capture needs from it is the recorded declaration (above), and apply parks its ops as for a module this device never had. The next pull after the module registers or migrates first replays the parked ops it can now read, in log order, through the same apply pass, and removes them. `SyncStatus.parkedOps` counts what waits, per module. A replay that raises is retried one op per transaction; the op that fails stays parked with its error (`SyncStatus.parkedFailures` / `parkedFailed`), its row's later ops stay behind it, the rest applies and the pull goes on. It is tried again on every pass, its error and time updated each time it fails, so a transient failure never strands its row. A row's replay can span passes (a delete replays, an op behind it waits for a newer module version), so a replayed delete is kept in `sync_parked_deletes` until nothing for its row is parked, and later replays drop an update older than it, as one pass over both would. A build from before modules existed skips a module's ops as `unknown-table` and moves on: accepted before 1.0.
- **Quarantine is a liveness fix.** Only a server content refusal (400/413/500) quarantines; a 401 or a dead network propagates.
- **A log reset is detected from `PushAck.head`.**
- `local-relay.ts` is the permanent test double, so every convergence assertion runs with no Cloudflare.

Core sync set: the 2.0 record's tables below and `projects`, plus each registered module's `syncTables`. `Replicated` (`replicated.ts`) is the one declaration of what replicates, with each table's thread column: capture looks a table up there (`Replicated.lookup`: the same list `tables` enumerates, unregistered modules' recorded tables included, plus the tables migration 14 retired while the database is still before 14, which only the shipped migrations write), and backfill (record tables first) and `kabane export` enumerate it (`Replicated.tables(db)`). Excluded: `sequences`.

**The 2.0 record** (ADR 0006): `threads`, `entries`, `attributes`, `refs` (`RECORD_TABLES`, `schemas/record.ts`), created by migration 13. Migration 14 (`storage/record-migration.ts`) moved today's task tables into them: a task is a thread, every task column that left the thread row is an attribute under its column name (`tags` one JSON array), `discovered_by` is `created_by`; a comment is an entry with `author_type` in `data`; a work-log row an entry of kind `log` with its refs in `data`; a link a ref to the target thread, `parent`/`child` folded into the thread's parent; a context ref a ref of its own kind, its label the title; a linked issue a ref of kind `upstream` whose URI is `<provider>:<external id>`. `tasks` is renamed `retired_tasks` (a DROP would cascade into module tables that still referenced it) and `tasks` becomes a view that assembles the old row over `VISIBLE_THREADS_SQL`, so every read of `TABLES.tasks` keeps working and a deleted thread reads as gone; `tasks_fts` indexes threads through triggers. Writes go through `storage/record-write.ts` (`RecordWrite`): each stamps only the register it changes and captures it, every storage function runs its writes and captures in one transaction (`atomic`), and a local write to a thread that does not show is refused (sync apply still takes rows in any order). A task delete is the thread's tombstone, nothing else. What a row is follows from its URI and kind, never a stored field (`storage/families.ts`): a ref to `kabane://thread/<id>` is a link, one of kind `upstream` an upstream link, any other a context ref; an entry of kind `log` is the work log's, any other the timeline's. The writers keep the shapes apart (a context ref takes no thread URI and no link or `upstream` kind; a comment takes no kind `log`), and migration 14 refuses a schema-12 row that breaks this, so two families never share a key. A folded parent edge's id is `parent:["<child>","<parent>"]`, which no ref key spells. An attribute written with its thread has counter 0, so the `Task` read's `version` counts each later write, first ones included; a local edit takes a clock past the task's latest register (`taskClock`), so `updatedBy` names its writer even when a stored clock is ahead of this device's. A read of one task (`storage/task-rows.ts`) decides it by its own ancestry over the `task_rows` view; a listing reads `tasks`. A row's identity is its natural key (`RECORD_KEYS`): a thread's or entry's ULID, an attribute's `(thread_id, key)`, a ref's `(thread_id, uri, kind)`. A link between threads is a ref to `kabane://thread/<id>` (`RecordKey.threadUri`) whose kind is the link type. An op's `row_id` is a one-column key's value, or the JSON array of a composite key's parts in `JSON.stringify` form (`RecordKey.rowIdOf` / `partsOf`), and capture and apply find a record row by it. They converge by shape, with none of the machinery above: no FK or UNIQUE beyond the primary key, no hard delete (a thread's `deleted_at` is final; a ref's or attribute's `removed_at` is an ordinary write), and no delete evidence, orphan check or receiving device at apply. `Resolve.decideRecord` merges a pulled row into the held one register by register (a thread has three: the claim, the rest, the delete); a register keeps the greater value by clock, then counter, then writing device, then content. What shows is decided at read (`storage/record.ts`, `RecordRead`): hidden when its thread is deleted, missing, or under a deleted thread, and a link also when the thread it points at is; a missing parent reads as the root; a parent cycle breaks at its lowest id; the claim holder is derived from `claim` and `release` entries. Apply refuses before it compares or stores, counted: a string with ill-formed Unicode (SQLite would store a replacement), a clock not in `toISOString` form (clocks compare as strings), a `row_id` that does not name its row's key in that one form, and a hard delete. Only an untagged op on a record table is a record op: a module-tagged one parks, and record ops never feed today's `short_id` renames. A delete hides along stored parent edges before cycles are broken; a one-thread read walks that thread's ancestry only. Migration 13 refuses a database where a table already holds a record name. A writer stamps the group it changes with a clock no lower than the stored one, a counter one past it, and its device id (empty before sync is armed); `RecordWrite` is that writer. `sync/record-convergence.test.ts` holds the every-interleaving harness and the seeded workload; `wiki/record-primitives.md` ("How the four tables converge") the reasons.

An `upstream` ref holds the external issue a task points at (`upstream_links` until migration 14), and identity only: provider, external id, identifier, url, title. It carries no copy of what the external issue says, which is both why it replicates (a url and a title are less sensitive than the task descriptions already on the wire) and why nothing reading it needs a staleness rule. Whatever matters about the external issue goes in the task's own description when the link is made.

## `assembleContext` — THE agent read entrypoint

One primitive builds an issue's full brief as markdown. Sections in order, empty ones omitted: title + metadata, description (never truncated), position (parent, blockers, blocks, subtask states), context (registry refs, `file:` deref'd inline with caps), prior work (work-log refs), discussion (all human comments, every typed entry, and the AI comments the fold keeps), then each registered module's `contextSections` and `<kind>.latest` sections after the core section they anchor to (`questions.decisions` after discussion), a module's own sections before its kinds', modules in registration order. Caps: `perRefCap` 8KB, `totalRefCap` 24KB, `maxTimelineEntries` 20.

## Timeline entries

An issue has a **timeline** of **entries**. An entry has a **kind**, an author, a time and a freeform markdown body. A comment is an entry of kind `comment`, the default. A kind's **template** is markdown shown to whoever writes one; a kind's **projection** is what the brief shows of it, derived when the brief is read and never stored. Kabane never parses or validates a body, so no kind of work is stuck on a field that does not fit it.

- **Storage.** Entries live in the record's `entries` table since migration 14 (`task_comments` until then, with a `kind` column from migration 9). The work log's rows are entries of kind `log`, which `getEntries` leaves out unless asked for that kind. `Planner.addEntry(basePath, { taskId, kind, author, authorType, content })`, `Planner.getEntries(basePath, taskId, { kind? })` in time order, `Planner.latestEntry(basePath, taskId, kind)`. `addComment` and `getComments` are the `comment` kind's convenience; `getComments` returns comments only, so a reader of the whole timeline (the board's comments tab, `kabane show`) calls `getEntries`.
- **Append-only.** An entry is never edited or deleted on its own; there is no API for either. Deleting a task hides its entries with it (`RecordRead`); they stay stored.
- **A kind is a soft string**: `name` or `name.key`, lowercase (`ENTRY_KIND_PATTERN`), checked on write with a one-line error, stored as TEXT, never a closed list. Any well-formed kind is stored whether or not a module declares it.
- **Kinds are declared as data.** `KabaneModule.kinds` holds `EntryKind`s (`EntryKindSchema`): `name` (the module's name or `<module>.<key>`), `title` (one line, how it reads in the brief), `template`, and `projection`, `"discussion"`, `"none"` (the brief and `getEntries` leave it out: the module shows it in a section of its own) or `{ latest: { after: <core section>, framing: <one line> } }`, and optionally `closedBy`, the reply kinds that close an addressed entry of the kind. It carries no code on purpose: an extension or a project's config, which can only supply data, will declare kinds the same way. `Runtime.configure` refuses a kind that fails the schema, one outside its module's namespace, `comment`, a duplicate, and a `latest` kind whose `<kind>.latest` section name is already taken. `Runtime.entryKind(name)` looks a registered kind up.
- **Kinds core writes.** `log` (the work log), `claim` and `release` (`storage/families.ts`) are refused by `addEntry` and never in `getEntries`. `Planner.updateTaskIn` writes the claim: a state change to `in_progress` on a thread with an assignee writes a `claim` by the writer unless the writer's claim already stands; a change to any state but `in_progress` or `waiting` writes a `release` for each standing claim, in its claimant's name (`re` the claim), because `RecordRead.claimHolder` lets only the claimant's release clear a claim. `Planner.claimHolder` reads the holder's actor; `kabane_edit` and `kabane edit` return it as `claimedBy` when they set `in_progress`.
- **Addressed entries.** An entry may carry `to` (`addressed_to`, a JSON array of actors) and `re` (the entry it replies to). `Planner.addEntryIn(db, …)` writes one in the caller's transaction, for a module (`@kabane/questions` files its questions this way). `Planner.addressed(basePath, actor)` lists the entries addressed to `actor` that no reply has closed: a kind declares the reply kinds that close it (`closedBy`), and without a declaration any reply closes it. `kabane wait addressed <actor>` polls it.
- **The fold.** Every entry whose kind is not `comment` is in the brief, whoever wrote it; plain comments keep their own rules (every human one; the last three AI ones, or none once the work log holds a `session:` ref). A `latest` kind's newest entry renders as its own section `<kind>.latest` after its anchor: a heading with the title, author and time, the framing line, the body verbatim, and a line counting older entries of the kind, which stay out of the Discussion. The section name is valid wherever a module section's is (concise `sections`, the tool's enum, `kabane context --sections`). A `discussion` kind, and any kind no registered module declares (another device's, an older build's, one a runner invented), stays in the Discussion in time order, labelled with its kind, and is never dropped or an error.
- **Writing one.** `kabane_comment` takes an optional `kind` (omitted, `comment`), and the CLI `kabane comment <id> "<text>" --kind <kind>`. The hub serves the same tool.

## Agent sessions

Core keeps none. What a session leaves about the issue is on the record: its outcomes are
timeline entries (`outcome.decision`, `outcome.finding`, `outcome.verification` and
`outcome.summary` in `@kabane/outcome`, `handoff` in `@kabane/handoff`), and the session itself is
a `session:` ref in the issue's work log. Its stream stays with whatever drove it (the loop's own
store, a harness). The brief keys on that ref: a task whose work log holds one keeps none of its
plain AI comments.

Core kept sessions in `agent_sessions` and `agent_activities` until migration 11,
`session-outcomes` (`storage/session-outcomes.ts`), moved each durable activity (`response`,
`decision`, `finding`, `verification`, `handoff`) to a shared entry and each session to a work-log
ref, both under the source row's id with every column taken from the source rows (never the
device's actor or clock, so copies migrated apart converge), and dropped both tables; the stream
went with them. A missing session table, or an id already held by a different row, fails the
migration and nothing is dropped. A
device's first push after it migrates sends rows that never left it before, and a device on
schema 10 or older stops its pull at the first op from schema 11 until it upgrades.

## Context registry, work logs, links

- **Context refs** (refs that are no link and not `upstream`; one per task and URI, re-adding under another kind removes the old one): the curated input side. Kinds are soft; `promoteToContext` writes the registry row and a work-log ref in one call. A ref's id is its row id (`RecordKey`).
- **Work logs**: append-only URI refs, entries of kind `log` — `session:`, `commit:`, `pr:owner/repo#n`, `issue:`, `file:`, `url:`, `branch:`.
- **Links**: refs to `kabane://thread/<id>`: `blocks`/`blocked_by`, `related`, `duplicate`, `follows`. `parent`/`child` set the child's parent instead.
- **Projects**: a flat `projectId` on the task, not a scope boundary.
- **Scope**: `scopeUri` is a string storage parses and formats (`ScopeUri`) and never resolves. Bare ids normalize to `kabane://scope/<id>`. The scheme was `jake://scope/<id>` until schema 10: migration 10 renamed every stored scope and every op in the device's own log (`storage/scope-scheme.ts`), `ScopeUri.parse` and `normalizeScopeUri` still read the old scheme as the same scope, and sync apply renames the scopes of an op pulled from a device on an older schema. Nothing writes it.
- **Resolved scope type** (`scope/schemas.ts`): `ProjectScope` is shared with the extension contract. Detection lives in `packages/cli/src/scope/` and reaches extensions through `host.scope.detect`.
- **Executable discovery** lives in `packages/cli/src/self.ts` and reaches extensions through `host.kabane.executable`.
- **File references** use `RuntimeConfig.fileReader` (`FileReader` / `FileHead` in `runtime.ts`). The host returns a bounded head and total byte size, missing, or pointer; the default is pointer. Core owns caps and notes; the CLI wires `Bun.file`.

## MCP (`mcp/`)

`KABANE_TOOLS` is the shared tracker tool list: name, description, zod input shape, `read` or
`write`, handler over `Planner` returning `Result`. Both servers use
`registeredTools()` to compose it with every registered module's `tools`:
`serveStdio` (`packages/cli/src/mcp-stdio.ts`) and `handleHttpRequest`
(`packages/worker/src/mcp-http.ts`, stateless
Streamable HTTP, fresh server per request). The CLI adds device config tools from
`packages/cli/src/config-tools.ts` to the stdio list; HTTP keeps the shared core
and module surface. Each host registers
`modules` once through `Runtime.configure`; module `instructions` paragraphs are
appended to `SERVER_INSTRUCTIONS`. `createMcpServer` returns `Result<Server>` and
refuses duplicate tool names before serving. `mcp/server.ts` is core's only import of the MCP
SDK and is exported as `@kabane/core/mcp-server`, never from the barrel, so a process that
serves no MCP loads neither the SDK nor its ajv; `callTool` and `registeredTools`
(`mcp/call.ts`) stay on the barrel because `host.record` calls tools in every process. The shared list exposes only replicated data, so
the hub answers every tool a device does. A `ToolContext` carries `basePath`, the `actor`, an optional
`defaultScope`, and `scopeRequired`: a device defaults scope from its directory, the
hub demands it and points at `kabane_scopeList`. It may also carry `humanActor`, the human
the connection relays for: `kabane mcp` passes the device's configured actor before any
`--as`, and the hub passes its Access identity only when Access authenticated a human,
never a service token. A tool that credits the human with a reply an agent relays reads
`humanActorOf(ctx)`, which returns `humanActor` only when it is a
`kabane://actor/human/` URI and never infers one from `actor`.

`kabane_list` accepts `parentTaskId` (short id or ULID) and `includeDeferred`;
`kabane_edit` accepts `needsReview`. The read tools `kabane_linkList`,
`kabane_upstreamList` and `kabane_logList` take `{ id }` and return raw records;
`kabane_logList` also takes an optional `limit` (the newest N, still oldest first).
These input shapes are part of extension API v1, held by review; `mcp/tools.test.ts`
pins the list filters and review flag through handler calls in both response formats.

Modules can contribute `contextSections`, keyed as `<module>.<key>` and anchored
`after` a core section. Full and concise briefs include these by default. Concise
`sections` accepts registered names, rejects unknown names with the valid list,
and preserves canonical order. `contextSectionsOf(modules)` is that order for a
module list, the one implementation behind it, so a host can print the valid
sections (the CLI's usage line) before it configures the runtime. Module content shares the 16KiB pagination budget
and cursor checks; failed module reads are omitted in full briefs and fail selected
concise reads.

The low-level SDK `Server` is used deliberately: `McpServer.registerTool` infers
over each zod shape and, fed a generic `ZodRawShape`, tsc recurses until it gives up
(TS2589). Inputs are validated by hand with `z.object(shape).safeParse`, and JSON
schema comes from `zod-to-json-schema`. Handler `err`s become `isError` tool
results, never thrown.
