# @cabane/core

Coordination substrate for agent teams, with humans consuming it to plan and review. Most items are AI-created; the tracker's job is to hold the *structure* agents need — sessions, typed activities, curated context, a link DAG — so no consumer reinvents it in prose.

Extracted from Jake's planner, a host app that still consumes this package. Public storage function names were kept so Jake's CLI and tRPC router compile against it unchanged.

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
  provider: SqliteDb.provider({ dbName: "kabane.db" }),
  tablePrefix: "",            // "planner_" when sharing a database with other modules
  tracer, notifier, scopeResolver, syncSettings, actor,   // all optional, all no-op by default
  modules: [],                // data modules (below); default none
});                           // a Result: err when the module set is invalid, and nothing changed
await Planner.init(basePath);
```

- **`Db`** (`db/port.ts`) mirrors the `bun:sqlite` subset the code was written against: `query(sql).get/all/run`, `run`, `exec`, `transaction`. A Durable Object adapter implements the same five calls over `SqlStorage`. `run` returns `{ changes }`.
- **`DbProvider.withDb(basePath, fn)`** opens per unit of work and closes after. `basePath` is opaque to the core: a directory for the bun adapter, ignored by a DO that owns one database.
- **`atomic(basePath, fn)`** (`runtime.ts`) runs `fn` inside BEGIN IMMEDIATE / COMMIT with awaits allowed between statements. A provider that cannot issue BEGIN supplies its own `atomic`.
- **Table names** (`db/tables.ts`): `TABLES.x` are getters over a runtime prefix. Never capture `TABLES.x` into a module-level constant — it evaluates at import, before configuration. `physicalTable(logical)` and `tablePrefix()` exist for names built in code (triggers, indexes).
- **Schema** (`db/schema.ts`): one DDL with logical names, `prefixSql` rewrites CREATE TABLE / INDEX / REFERENCES / ON, `generateFtsSql` builds the FTS5 tables and triggers. `prefixSql` does NOT rewrite CREATE TRIGGER, which is why capture triggers are built in `storage/oplog.ts` from physical names.
- **Migrations** (`db/migrate.ts` runner, `storage/migrations.ts` list): numbered and append-only, version = index + 1, recorded in `schema_migrations` (behind the prefix), each applied once in its own transaction. `Planner.init` is `Migrations.apply`. To change the schema, append a migration (any SQL over `TABLES.x`, backfills and rebuilds included); never edit a shipped one and never edit `SCHEMA_SQL`, which is migration 1, the release baseline. Migration 1 also carries `PreRelease.upgrade`, the old column-guarded steps, for databases created before the runner; delete it once every database created before the runner is stamped. `Migrations.SCHEMA_VERSION` rides on every pushed op, and a pull stops before an op from a newer core schema. A registered data module's migrations run after core's, in registration order, against its own version table (`schema_migrations_<name>`, a dash becoming an underscore); a module migrating never moves `SCHEMA_VERSION`, and a database a newer build of a module migrated is refused for that module.
- **Data modules** (`module.ts`): a `KabaneModule` is a `name`, its own append-only `migrations`, and the `syncTables` it replicates, each with a resolver `family` (`row-lww` or `append-only`), an optional LWW `clock` column, and `childOfTasks` (its `task_id` references `tasks(id) ON DELETE CASCADE`). Modules may also supply `contextSections` (namespaced brief renderers), `tools` (MCP tools), and `instructions` (an MCP instructions paragraph). A host checks the `Result` from `Runtime.configure({ modules })` and reads registrations with `Runtime.modules()`. Configure rejects duplicate module/table names, sections outside `<module>.` or colliding with core/registered sections, and tools colliding with core/registered tools; a refusal leaves the previous runtime unchanged. The resolver, apply, capture, `Oplog.cascadeOf` and backfill consult core's records first, then the registry. A module table's rows carry `updated_by`, `version` and `visibility` like core's, and its storage captures like core's (`Oplog.afterWrite` / `Oplog.afterDelete`); capturing a table no registered module declares is refused. A module updating a task in its own transaction uses `Planner.updateTaskIn(db, id, updates)`, never raw SQL on tasks, and emits `TASK_UPDATED` with the returned task only after commit. A module may also declare `onTaskStateChange(db, task, from, to)`: `Planner.updateTaskIn`, the one path every local state change goes through (`updateTask`, so `kabane_done`, `kabane_edit`, the CLI, the board and the loop), calls it in the change's transaction once the task row is written and captured, and only when the state actually moves. Its writes capture like any module write; an `err` rolls the state change back, so `updateTask` runs in `atomic` and a caller of `updateTaskIn` throws on `err` inside its own transaction. Sync apply never calls it: the device that changed the state already captured what the hook wrote.
- **Ports with no-op defaults:** `traced()` (`observability.ts`) delegates to the configured `Tracer`; `Events.emit` to the `Notifier`; `Runtime.scopeResolver()` is a host hook no core code calls (Jake keys its session defaults with it); `SyncDevice.settings()` to `SyncSettingsSource`.

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

**Every replicated row carries `updated_by`, `version`, `visibility`.** `updated_by` is the actor URI from the `actor` runtime port (`cabane://actor/human/<name>`, `cabane://actor/agent/<runtime>`; default `cabane://actor/unknown`). `version` starts at 1 and every local update does `version = version + 1`. `visibility` is `shared` by default on every replicated table; **a private row never enters the oplog**, whichever table it lives in — the filter is the column, `SYNC_TABLES` only says which tables the resolver knows a rule for. Old databases get the columns through `runMigrations` (guarded `ALTER TABLE`), and `storage/migrations.test.ts` boots new code on a pre-column table.

**Tie-break chain** (`sync/resolve.ts`): clock, then ULID, then `version` (more writes win), then `updated_by` (lower URI wins), then `device_id`. The last two steps are what make three or more devices converge: the device id alone stood in for "who wrote this", which is exact for two machines and wrong once a third machine compares a row it merely received. `Apply` writes `max(local.version, incoming.version)` and, on `tasks`, leaves a `sync_conflict_resolved` activity (old_value = the local version that lost, new_value = the incoming version) when a local lineage with at least as many writes was overwritten.

- `SyncDevice.connect` (`sync/device.ts`) is the one place settings become a transport, and it **arms capture as a side effect of the first connection**. Device identity is write-once.
- **Nothing already in the database when you enable sync replicates.** `Backfill.run` (`sync/backfill.ts`) seeds the log for an armed device through the same `Oplog.snapshotOp` live capture uses; op ids are `bf:<tbl>:<rowId>:v<version>`, so a re-run is a no-op and a row edited since is re-emitted. Private rows are skipped and counted.
- **`server_seq` has gaps.** Only monotonicity is promised.
- **`throughSeq` comes from the page**, never from `ops.at(-1)`.
- **A module's ops are tagged and parked, never skipped.** Capture tags a module table's op with `module: { name, schema }` (the module's migration count), stored in the oplog, and push sends it beside core's `schema`, whatever is registered by then. A device that has not registered that module, or runs an older version of it, stores the op as pulled in `sync_parked` (local, never replicated) and keeps pulling; only core ops stop a pull. Once an op for a row (table and id) is parked, every later op for that row parks behind it, even one this build can read, so the row's history replays in log order and a delete is never overtaken by an older update. The next pull after the module registers or migrates first replays the parked ops it can now read, in log order, through the same apply pass, and removes them. `SyncStatus.parkedOps` counts what waits, per module. A replay that raises is retried one op per transaction; the op that fails stays parked with its error (`SyncStatus.parkedFailures` / `parkedFailed`), its row's later ops stay behind it, the rest applies and the pull goes on. It is tried again on every pass, its error and time updated each time it fails, so a transient failure never strands its row. A row's replay can span passes (a delete replays, an op behind it waits for a newer module version), so a replayed delete is kept in `sync_parked_deletes` until nothing for its row is parked, and later replays drop an update older than it, as one pass over both would. A build from before modules existed skips a module's ops as `unknown-table` and moves on: accepted before 1.0.
- **Quarantine is a liveness fix.** Only a server content refusal (400/413/500) quarantines; a 401 or a dead network propagates.
- **A log reset is detected from `PushAck.head`.**
- `local-relay.ts` is the permanent test double, so every convergence assertion runs with no Cloudflare.

Core sync set: `tasks`, `task_links`, `task_comments`, `task_work_log`, `projects`, `task_context_refs`, `upstream_links`, plus each registered module's `syncTables`. Excluded: `agent_sessions`/`agent_activities`, `sequences`.

`upstream_links` holds the external issue a task points at, and identity only: provider, external id, identifier, url, title. It carries no copy of what the external issue says, which is both why it replicates (a url and a title are less sensitive than the task descriptions already on the wire) and why nothing reading it needs a staleness rule. Whatever matters about the external issue goes in the task's own description when the link is made.

## `assembleContext` — THE agent read entrypoint

One primitive builds an issue's full brief as markdown. Sections in order, empty ones omitted: title + metadata, description (never truncated), position (parent, blockers, blocks, subtask states), context (registry refs, `file:` deref'd inline with caps), prior work (work-log refs), discussion (all human comments merged with the durable machine signal), then each registered module's `contextSections` after the core section they anchor to (`questions.decisions` after discussion). Caps: `perRefCap` 8KB, `totalRefCap` 24KB, `maxTimelineEntries` 20.

## Agent sessions

`agent_sessions` + `agent_activities`, CASCADE from tasks, soft TEXT. State machine in `storage/sessions.ts`: `start → active`, a `question` activity → `awaiting_input`, any non-question activity once no question is unanswered → `active`, `end(complete|error)` compacts ephemerals and emits a `response` activity from the summary, an `active` session idle > 24h → `stale` via `sweepStaleSessions` (an `awaiting_input` one waits on a human and is never swept).

Ephemeral rows are a query-time filter plus compact-on-close. The shared fold is `Planner.selectDurableActivities`: keeps `response`/`finding`/`verification`/`decision`/`handoff`, drops the rest plus all-but-latest ephemeral.

**Questions and answers.** A `question` activity's body carries answerable metadata as a leading fenced `json` block (`schemas/question-body.ts`); one that relays a harness permission request also carries `permission`, the tool call's title and the harness's options verbatim (id, label, kind), with the labels as its `choices`. An activity answers a question when its `context` is exactly `answers <questionId>`, whatever its type. `Planner.answerQuestion(basePath, { questionId, answer })` writes that activity, body the answer, in the same transaction as the lookup: an `answer` for a question carrying `permission` (approving a tool call unblocks the session and is no decision, so it stays out of the durable fold and the brief) and a `decision` for any other question, the human's choice on the record. Either carries the runtime actor as `author` (migration 7's column; activities written before it have none), and `assembleContext` renders a decision answering a question as the question, then `→ <choice>`, under that author. It rejects an id that is not a `question` activity, a blank answer, and an ended session. The session leaves `awaiting_input` only once every question on it is answered. Re-answering appends another: the latest one is the answer in force and the earlier ones stay on the record, never erased. Migration 6 deleted the permission answers written as decisions before this, with their requests. A question nobody is left to answer (its harness withdrew the request, or the run stopped waiting) is closed by a `withdrawn` activity with the same `answers <questionId>` context, body the reason: every queue lets go of it as of an answer, and like an `answer` it stays out of the durable fold and the brief. `answerQuestion` and `addActivity` share one transaction body (`appendActivity`), so both move the state machine the same way.

## Context registry, work logs, links

- **Context refs** (`task_context_refs`, `UNIQUE(task_id, uri)` upsert): the curated input side. Kinds are soft; `promoteToContext` writes the registry row and a work-log ref in one call.
- **Work logs**: append-only URI refs — `session:`, `commit:`, `pr:owner/repo#n`, `issue:`, `file:`, `url:`, `branch:`.
- **Links**: `blocks`/`blocked_by`, `parent`/`child`, `related`, `duplicate`, `follows`. `UNIQUE(source_id, target_id, type)`.
- **Projects**: a flat `projectId` on the task, not a scope boundary.
- **Scope**: `scopeUri` is a string storage parses and formats (`ScopeUri`) and never resolves. Bare ids normalize to `jake://scope/<id>`; the scheme is kept for wire compatibility with existing data.
- **Scope detection** (`scope/detect.ts`, `@cabane/core/scope`): turns a cwd into a scope — marker walk, then git; pin → legacy pin → remote → first commit → path. Deliberately OFF the package barrel: it spawns `git` and reads the filesystem, so importing it from the Worker would break the hub. `Runtime.scopeResolver` is unrelated and stays the host's override.
- **Self** (`self.ts`, `@cabane/core/self`): how a device runs kabane again (an MCP entry, a session server, the loop's runner) and where its shipped `templates/` are, for a script and for a `bun build --compile` binary, whose own entry is a virtual `/$bunfs/root/…` path. Off the barrel for the same reason: it reads the Bun process.

## MCP (`mcp/`)

`KABANE_TOOLS` is the shared tracker tool list: name, description, zod input shape, `read` or
`write`, handler over `Planner` returning `Result`. Both servers use
`registeredTools()` to compose it with every registered module's `tools`:
`serveStdio` (the CLI's `kabane mcp`) and `handleHttpRequest` (the hub, stateless
Streamable HTTP, fresh server per request). The CLI adds device config tools from
`packages/cli/src/config-tools.ts` to the stdio list; HTTP keeps the shared core
and module surface. Each host registers
`modules` once through `Runtime.configure`; module `instructions` paragraphs are
appended to `SERVER_INSTRUCTIONS`. `createMcpServer` returns `Result<Server>` and
refuses duplicate tool names before serving. The shared list exposes only replicated data —
no session tools, because sessions do not sync and the hub would have nothing to
answer with. A `ToolContext` carries `basePath`, the `actor`, an optional
`defaultScope`, and `scopeRequired`: a device defaults scope from its directory, the
hub demands it and points at `kabane_scopeList`.

Modules can contribute `contextSections`, keyed as `<module>.<key>` and anchored
`after` a core section. Full and concise briefs include these by default. Concise
`sections` accepts registered names, rejects unknown names with the valid list,
and preserves canonical order. Module content shares the 16KiB pagination budget
and cursor checks; failed module reads are omitted in full briefs and fail selected
concise reads.

The low-level SDK `Server` is used deliberately: `McpServer.registerTool` infers
over each zod shape and, fed a generic `ZodRawShape`, tsc recurses until it gives up
(TS2589). Inputs are validated by hand with `z.object(shape).safeParse`, and JSON
schema comes from `zod-to-json-schema`. Handler `err`s become `isError` tool
results, never thrown.

## Not moved from Jake (host adapters)

`parser/` (AI extraction), `workflows/`, `hooks/`, `trpc/`, `cli/`, `widgets/`, `jake-module.ts`, `db-registration.ts`. `storage/schema.sql.ts` was dead and was not ported. The `proposals` surface moved as-is and was dropped by migration 2 once Jake retired its consumers.
