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

- **Migrations** (`db/migrate.ts` runner, `storage/migrations.ts` list): the rule is in `CODING_PRINCIPLE.md`; `SCHEMA_SQL` is migration 1 and is never edited either. `Migrations.SCHEMA_VERSION` rides on every pushed op, and a pull stops before an op from a newer core schema. The one exception to "append a migration" is bookkeeping the runner owns: each version table (`Migrate.ensureVersionTable`) and the data modules' `module_declarations` (`Modules.ensureDeclarations`, at the start of the module pass) are created with `CREATE TABLE IF NOT EXISTS` outside any numbered list, so they move no version, and none of them is ever replicated. Every other schema change is an appended migration. A registered data module's migrations run after core's, in registration order, against its own version table (`schema_migrations_<name>`, a dash becoming an underscore); a module migrating never moves `SCHEMA_VERSION`, and a database a newer build of a module migrated is refused for that module.
- **Data modules** (`module.ts`): a `KabaneModule` is a `name`, its own append-only `migrations`, and the `syncTables` it replicates, each with a resolver `family` (`row-lww` or `append-only`), an optional LWW `clock` column, and `childOfTasks` (its `task_id` names a thread; no foreign key, since `tasks` is a view from migration 14, and a module table that once referenced `tasks(id)` drops the reference in a migration of its own). Modules may also supply `contextSections` (namespaced brief renderers), `kinds` (timeline entry kinds, below), `tools` (MCP tools), and `instructions` (an MCP instructions paragraph). A host checks the `Result` from `Runtime.configure({ modules })` and reads registrations with `Runtime.modules()`. Configure rejects duplicate module/table names, sections outside `<module>.` or colliding with core/registered sections, tools colliding with core/registered tools, and kinds that break the rules under "Timeline entries"; a refusal leaves the previous runtime unchanged. The resolver, apply, capture and backfill consult core's records first, then the registry. A module table's rows carry `updated_by`, `version` and `visibility` like core's, and its storage captures like core's (`Oplog.afterWrite` / `Oplog.afterDelete`); capturing a table no registered module declares is refused, except the delete of a row in a table an unregistered module's recorded declaration names. The recorded declarations (`module_declarations`) are runner bookkeeping (above) and never replicate. Capture and `Replicated.tables` read the registered modules, then the recorded declarations of unregistered ones (`Modules.unregistered`). A task delete is the thread's tombstone and touches no module row. An insert or update on such a table stays refused: nothing writes an unregistered module's rows. A module updating a task in its own transaction uses `Planner.updateTaskIn(db, id, updates)`, never raw SQL on tasks, and emits `TASK_UPDATED` with the returned task only after commit. A module may also declare `onTaskStateChange(db, task, from, to)`: `Planner.updateTaskIn`, the one path every local state change goes through (`updateTask`, so `kabane_done`, `kabane_edit`, the CLI, the board and the loop), calls it in the change's transaction once the task row is written and captured, and only when the state actually moves. Its writes capture like any module write; an `err` rolls the state change back, so `updateTask` runs in `atomic` and a caller of `updateTaskIn` throws on `err` inside its own transaction. Sync apply never calls it: the device that changed the state already captured what the hook wrote.
- **Ports with no-op defaults:** `traced()` (`observability.ts`) delegates to the configured `Tracer`; `Events.emit` to the `Notifier`; `SyncDevice.settings()` to `SyncSettingsSource`.

Tests import `./testing`, which configures the bun:sqlite provider. `packages/sqlite/smoke.test.ts` is the end-to-end smoke over that adapter.

## Task vs Issue

| Aspect | Task (`kind: 'task'`) | Issue (`kind: 'issue'`) |
|--------|----------------------|------------------------|
| Mental model | GTD (inbox → next → done) | Issue tracker |
| Executor | Single human | AI agents (parallel) |
| Completion | Mark done | Verification + review |

Both share the same states with different interpretation: `inbox` = triage (task) / backlog (issue); `next` = ready to work (task) / ready for an agent (issue); `in_progress` = human working (task) / agent working (issue).

A third kind, `job`, is a standing request a schedule runs. A listing that names no kind leaves jobs out (`kabane list`, `kabane_list`, today and the board); naming `job` returns only jobs. Reads by id, search, comments and `done` treat a job like any item.

## GTD states (canonical — 7, hard enum)

`TaskStateSchema` (`schemas/task.ts`) is a closed `z.enum`, the only one in the package: `inbox`, `next`, `in_progress`, `waiting`, `someday`, `done`, `cancelled`. `needs_review` is **not** a state; use the `needsReview` flag.

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

**Capture is a storage-layer step, not a trigger.** `Apply` writes rows directly and never enters the capture path. Consequences for anyone adding a write path: call `Oplog.afterWrite(db, tbl, "insert"|"update", id)` after the statement, snapshot first and `Oplog.afterDelete` after for deletes, and a record row is never deleted (`RecordWrite`, a tombstone instead).

**Every replicated row carries `updated_by`, `version`, `visibility`.** `updated_by` is the actor URI from the `actor` runtime port (`ActorUri` in `actor.ts`: `kabane://actor/human/<name>`, `kabane://actor/agent/<runtime>`; default `kabane://actor/unknown`). `version` starts at 1 and every local update does `version = version + 1`. `visibility` is `shared` by default on every replicated table; **a private row never enters the oplog**, whichever table it lives in — the filter is the column, `SYNC_TABLES` only says which tables the resolver knows a rule for.

**Tie-break chain** (`sync/resolve.ts`): clock, then ULID, then `version` (more writes win), then `updated_by` (lower URI wins), then `device_id`.

- `SyncDevice.connect` (`sync/device.ts`) is the one place settings become a transport, and it **arms capture as a side effect of the first connection**. Device identity is write-once.
- **Nothing already in the database when you enable sync replicates.** `Backfill.run` (`sync/backfill.ts`) seeds the log for an armed device through the same `Oplog.snapshotOp` live capture uses; op ids are `bf:<tbl>:<rowId>:<content hash>`, so a re-run is a no-op, a row edited since is re-emitted, and two devices holding different values of one row send two ops the resolver decides between. Private rows are skipped and counted.
- **`server_seq` has gaps.** Only monotonicity is promised.
- **`throughSeq` comes from the page**, never from `ops.at(-1)`.
- **A module's ops are tagged and parked, never skipped.** Capture tags a module table's op with `module: { name, schema }` (the module's migration count), stored in the oplog, and push sends it beside core's `schema`, whatever is registered by then. A device that has not registered that module, or runs an older version of it, stores the op as pulled in `sync_parked` (local, never replicated) and keeps pulling; only core ops stop a pull. Once an op for a row (table and id) is parked, every later op for that row parks behind it, even one this build can read, so the row's history replays in log order and a delete is never overtaken by an older update. A module that is not registered keeps its tables and rows; what capture needs from it is the recorded declaration (above), and apply parks its ops as for a module this device never had. The next pull after the module registers or migrates first replays the parked ops it can now read, in log order, through the same apply pass, and removes them. `SyncStatus.parkedOps` counts what waits, per module. A replay that raises is retried one op per transaction; the op that fails stays parked with its error (`SyncStatus.parkedFailures` / `parkedFailed`), its row's later ops stay behind it, the rest applies and the pull goes on. It is tried again on every pass, its error and time updated each time it fails, so a transient failure never strands its row. A row's replay can span passes (a delete replays, an op behind it waits for a newer module version), so a replayed delete is kept in `sync_parked_deletes` until nothing for its row is parked, and later replays drop an update older than it, as one pass over both would.
- **Quarantine is a liveness fix.** Only a server content refusal (400/413/500) quarantines; a 401 or a dead network propagates.
- **A log reset is detected from `PushAck.head`.**
- `local-relay.ts` is the permanent test double, so every convergence assertion runs with no Cloudflare.

`Replicated` (`replicated.ts`) is the one declaration of what replicates: the record's tables, `projects` and each registered module's `syncTables`. Capture, backfill and `kabane export` all read it.

**The 2.0 record** (ADR 0006): `threads`, `entries`, `attributes`, `refs` (`RECORD_TABLES`, `schemas/record.ts`), created by migration 13; migration 14 (`storage/record-migration.ts`) moved the task tables into them. `tasks` is a view that assembles the old row over `VISIBLE_THREADS_SQL`, so every read of `TABLES.tasks` keeps working and a deleted thread reads as gone. Writes go through `storage/record-write.ts` (`RecordWrite`): each stamps only the register it changes and captures it, every storage function runs its writes and captures in one transaction (`atomic`), and a local write to a thread that does not show is refused. A task delete is the thread's tombstone, nothing else. What a row is follows from its URI and kind, never a stored field (`storage/families.ts`). Record rows converge by shape, with none of the machinery above: no FK or UNIQUE beyond the primary key, no hard delete (a thread's `deleted_at` is final; a ref's or attribute's `removed_at` is an ordinary write), and no delete evidence, orphan check or receiving device at apply. What shows is decided at read (`storage/record.ts`, `RecordRead`). `sync/record-convergence.test.ts` holds the every-interleaving harness; `wiki/record-primitives.md` ("How the four tables converge") the reasons.

An `upstream` ref holds the external issue a task points at (`upstream_links` until migration 14), and identity only: provider, external id, identifier, url, title. It carries no copy of what the external issue says, which is both why it replicates (a url and a title are less sensitive than the task descriptions already on the wire) and why nothing reading it needs a staleness rule. Whatever matters about the external issue goes in the task's own description when the link is made.

## `assembleContext` — THE agent read entrypoint

One primitive builds an issue's full brief as markdown.

## Timeline entries

An issue has a **timeline** of **entries**. An entry has a **kind**, an author, a time and a freeform markdown body. A comment is an entry of kind `comment`, the default. A kind's **template** is markdown shown to whoever writes one; a kind's **projection** is what the brief shows of it, derived when the brief is read and never stored. Kabane never parses or validates a body, so no kind of work is stuck on a field that does not fit it.

- **Storage.** Entries live in the record's `entries` table since migration 14. The work log's rows are entries of kind `log`, which `getEntries` leaves out unless asked for that kind. `Planner.addEntry(basePath, { taskId, kind, author, authorType, content })`, `Planner.getEntries(basePath, taskId, { kind? })` in time order, `Planner.latestEntry(basePath, taskId, kind)`. `addComment` and `getComments` are the `comment` kind's convenience; `getComments` returns comments only, so a reader of the whole timeline (the board's comments tab, `kabane show`) calls `getEntries`.
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

## Context registry, work logs, links

- **Context refs** (refs that are no link and not `upstream`; one per task and URI, re-adding under another kind removes the old one): the curated input side. Kinds are soft; `promoteToContext` writes the registry row and a work-log ref in one call. A ref's id is its row id (`RecordKey`).
- **Work logs**: append-only URI refs, entries of kind `log` — `session:`, `commit:`, `pr:owner/repo#n`, `issue:`, `file:`, `url:`, `branch:`.
- **Links**: refs to `kabane://thread/<id>`: `blocks`/`blocked_by`, `related`, `duplicate`, `follows`. `parent`/`child` set the child's parent instead.
- **Projects**: a flat `projectId` on the task, not a scope boundary.
- **Scope**: `scopeUri` is a string storage parses and formats (`ScopeUri`) and never resolves. Bare ids normalize to `kabane://scope/<id>`.

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

The low-level SDK `Server` is used deliberately: `McpServer.registerTool` infers
over each zod shape and, fed a generic `ZodRawShape`, tsc recurses until it gives up
(TS2589). Inputs are validated by hand with `z.object(shape).safeParse`, and JSON
schema comes from `zod-to-json-schema`. Handler `err`s become `isError` tool
results, never thrown.
