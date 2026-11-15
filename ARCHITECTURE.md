# Architecture

The rules for what may depend on what in kabane, what belongs in `packages/core`, and what an
extension gets from kabane. Read it before you add a package, a dependency between packages, a
file to `packages/core`, or a field to the extension contract.

`PRODUCT.md` says why kabane exists and what it refuses to be. `CODING_PRINCIPLE.md` holds the
coding rules and the invariants of storage and sync; this file does not repeat them. The
reasoning behind what follows, with the inventory it was built from and the alternatives that
lost, is in `wiki/extension-api.md`.

Where today's code breaks a rule below, the rule names the exception and the issue that removes
it, and the full list is under "The code breaks these rules today in named places". A rule that
nothing checks says so.

## The layer table is `scripts/layers.ts`, and the gate fails a dependency it does not list

Every workspace package has one layer. Which workspace packages each one may list in
`dependencies` is written once, as data, in `scripts/layers.ts`, and `bun run check` fails a
`package.json` that lists anything else. That file and its check arrive with JCAB-318. This file
says what each layer is for; it does not copy the table, because the two would drift apart.
Kabane's predecessor wrote its layer table twice, in an ADR and in its `ARCHITECTURE.md`, and
ten days later the two disagreed on what its second layer held; nothing checked either.

The table lists the edges that exist. An edge the layers below allow is added to it in the
change that first needs it. An edge they forbid is never added; where one exists today it is a
named exception with the issue that removes it, and the check fails once the exception goes
stale, so that list only shrinks.

Kabane's layers, from the bottom:

| Layer | Packages | Owns |
|---|---|---|
| core | `@cabane/core` | The record, its sync, the module seam and the MCP tool definitions. Runs in Bun and in Workers. |
| storage adapter | `@cabane/sqlite` | The `Db` port over `bun:sqlite`, for devices. |
| data module | `@cabane/questions`, `@cabane/checklist`, `@cabane/handoff` | One feature's own record, as a `KabaneModule`. |
| extension contract | `@cabane/extension` | The types an extension and the host exchange, and the argument, outcome and settings helpers every command is written with. |
| harness client | `@cabane/acp` | Driving a coding harness over ACP: the harness registry, the session runner, tool calls, elicitation forms. |
| client | `@cabane/board` | A UI over the record. |
| host | `kabane` (`packages/cli`) | A device's process: commands, `kabane mcp` over stdio, settings layers, scope detection, how kabane runs itself again, the extension loader and the `host` object. |
| hub | `cabane-worker` (`packages/worker`) | The hub's process: the sync log and the cloud device, serving MCP over HTTP. |
| extension | `extensions/*` | Optional features loaded at runtime. The loop is the first. |

Each layer depends only on layers listed before it in this table, never on a package of its own
layer, with four narrowings:

- **The contract and the harness client depend on core alone.** Neither may depend on a client:
  a second client could not exist without the first if they did. Both do today (JCAB-320).
- **Only a host depends on the storage adapter at runtime.** A data module or a client may use it
  in tests, as a `devDependency`; at runtime the host picks the adapter.
- **The hub depends on core and the data modules alone.** It runs in Workers, which cannot run
  the storage adapter, the harness client or a client.
- **An extension depends at runtime on no `@cabane/*` package except a harness client, which it
  bundles into its own build** (JCAB-316:2: the extension brings its own harness client). The
  loop takes `@cabane/acp` from the workspace, where it stays (JCAB-316:3); how an extension
  outside this repository gets a harness client belongs to distribution, which is not designed.
  From the rest of kabane it imports types only, with `import type`, which the compiler erases;
  every value it needs from kabane arrives on `host`. The loop lists five workspace packages
  today (JCAB-326).

A client may use the harness client as a library. The board does not list `@cabane/acp` today;
the change that moves the copilot into the board adds that edge (see "Ports").

A client uses only what another client could: the exports of core, the data modules, the contract
and the harness client. It never reaches into a host or another client, and it never reads a
table or a file another package owns except through that package's exports. No check holds this
rule (see the end of this file).

A first-party package that has a layer moves its code in the change that creates it. Kabane's
predecessor created its layer packages as re-exports of its core and never moved the code: the
primitives package was 120 lines over a 68,311-line core when the project stopped.

## Core keeps only what passes four questions

A thing belongs in `packages/core` when the answer to all four is yes:

1. **Is it the record, how the record replicates, or the definition every reader of the record
   goes through?** The record is what outlives the process that wrote it: tasks, timeline
   entries, links, the work log, context refs, upstream links, projects. The definitions are
   the `Db` port, `Runtime`, the module seam (`module.ts`) and the MCP tool definitions
   (`mcp/tools.ts`).
2. **Do two or more packages, in different layers, use it today?** A thing with one consumer
   lives with that consumer, even if that costs some repetition later. Something new starts in
   the package that needs it and moves to core when a package in another layer needs it too.
3. **Does it run in Workers as well as Bun?** No Bun, Node or process call is reachable from the
   package barrel, except the ones `CODING_PRINCIPLE.md` names as never called by the hub.
4. **Is kabane the only tool that keeps it?** Git keeps commits, a harness keeps its
   transcript, a team tracker keeps the team record; for those the answer is no, and kabane keeps
   a URI to them: a work-log ref, an upstream link.

Where an answer is no, the thing goes elsewhere:

- No to 3 alone: the host (`packages/cli` on a device, `packages/worker` on the hub), which
  offers it to extensions on `host` when one needs it.
- No to 2: the one package that uses it.
- No to 1, and it is a feature's own record: a data module.
- No to 4: a URI on the record, never a copy.

**A new replicated table goes in a data module, never in core's migrations.** A first-party one
is a package in the data module layer, registered by the host (`packages/cli/src/context.ts:54`,
`MODULES`). An extension's own table is a `KabaneModule` it contributes from the modules
entry its manifest names (below, JCAB-323), with its own migrations and `syncTables`; its rows then
replicate through the oplog like a first-party module's. A change to the task row itself stays a
core migration. `packages/core/AGENTS.md` ("Data modules") holds the module seam's rules.

The verdicts for what core holds today that is not obviously the record:

| In core | 1 | 2 | 3 | 4 | Verdict |
|---|---|---|---|---|---|
| `lint/` | no: it computes advice from a plan and stores nothing | no: one consumer, the loop (`extensions/loop/src/commands.ts:568`, `advice.ts:113`); `lint/index.ts:1` says "used by the loop's briefing" | no: `Bun.Glob` at `lint/collectors.ts:52` | yes | Moves into the loop extension (JCAB-326). |
| `commit-linker/` | no | no: nothing outside core calls it | no: `Bun.spawn` at `commit-linker/namespace.ts:47` | no: git keeps commits | Deleted (JCAB-228). |
| `scope/detect.ts` | no: it turns a directory into a scope and stores nothing | yes: the CLI (`packages/cli/src/context.ts:115`) and the loop (`commands.ts:310`) | no: `node:child_process` at `scope/detect.ts:9` | yes | Moves to the host and reaches extensions as `host.scope.detect` (JCAB-328). `scope/uri.ts`, which parses and formats the stored field, stays. |
| `self.ts` | no | yes: the CLI (`packages/cli/src/commands/mcp-install.ts:1`), `@cabane/acp` (`src/copilot.ts:17`) and the loop (`src/extension.ts:5`) | no: `Bun.main` at `self.ts:29` | yes | Moves to the host and reaches extensions as `host.kabane.executable` (JCAB-328). |
| `mcp/tools.ts` | yes: the definition of every operation on the record, and `KabaneModule.tools` takes its `ToolDef` (`module.ts:118`) | yes: both hosts and every data module | yes | yes | Stays. |
| `mcp/server.ts`, `createMcpServer` | yes: it composes the tool list both hosts serve | yes: the CLI and the hub | yes | yes | Stays. |
| `mcp/server.ts`, `serveStdio` | no | no: the CLI alone (`packages/cli/src/commands/mcp.ts:38`) | no: `StdioServerTransport` at `server.ts:22` | yes | Moves to the CLI (JCAB-328). |
| `mcp/server.ts`, `handleHttpRequest` | no | no: the hub alone (`packages/worker/src/hub.ts:137`) | yes | yes | Moves to the worker (JCAB-328). |
| `storage/sessions.ts` | partly: its rows outlive the process but never leave the device; `SYNC_TABLES` (`schemas/sync.ts:28-36`) omits `agent_sessions` and `agent_activities` | yes: the board and the loop | yes | partly: the harness keeps the session's transcript | Open: JCAB-316:7. |

### What core keeps of an agent session is open, and each outcome moves a different amount

JCAB-316:7 asks what kabane keeps of an agent session; JCAB-329 carries out the answer. The rows
mix the session's own stream (tool activity, progress, permission prompts) with outcomes about
the issue (findings, decisions, verification, handoffs), which `assembleContext` folds into the
brief as the durable machine signal. Nothing in this file depends on the answer except the
session rows of the inventory in `wiki/extension-api.md`. What each outcome does to the layers:

- **Split** (the recommendation on the question, and the maintainer's lean in the planning
  conversation: "should we just hold uri and not the data itself? but questions and decisions
  are related to the issue, similar to what you would see in a human tracker like linear"). The
  outcomes become timeline entries, which core already holds and replicates. The session becomes
  a `session:` URI in the work log, which core already takes. The stream stays with whatever
  drove it: the loop's own store, a harness. `storage/sessions.ts` leaves core, and the board's
  live lanes read from whoever drives the session. `host.record` needs no session operation.
- **A first-party data module, replicated or device-only.** The tables leave core for a module;
  the durable fold becomes that module's `contextSections`. The loop reaches sessions through the
  module's tools on `host.record.call`.
- **Sessions stay in core, unsynced.** `storage/sessions.ts` stays as a named exception to
  questions 1 and 4, and `host.record` needs session operations that no MCP tool offers today.

## Ports

### Nothing below the board imports the board, and each port type moves to the package that produces it

Today the contract and the harness client import the board: `packages/extension/contract.ts:7-11`
and `settings.ts:12-16` import `@cabane/board/ports`; so do `packages/acp/src/client.ts:27-32`,
`copilot.ts:9-15`, `tool-calls.ts:5` and `instructions.ts:8`, and `copilot.ts:8` imports a value,
`BoardContext`, from `@cabane/board/context`. JCAB-320 removes these edges. The types move by
who produces them and who reads them:

- **To `@cabane/extension`**, because an extension produces them and any client reads them: the
  activity types (`ActivityStatus`, `ActivityCard`, `CardAction`, `ActivityDiff`,
  `ActivityToolDetail`, `NoticeSeverity`, `ActivityEvent`, `ActivitySource`), the dispatch types
  (`TriggerInput`, `TriggerDescriptor`, `DispatchTarget`, `Dispatcher`), the panel types
  (`PanelTone`, `PanelPart`, `PanelLine`), the settings field types `settings.ts` uses
  (`SettingValue`, `SettingKind`, `SettingField`), and `CopilotShortcut`, which an extension
  contributes (below). A constant an extension compares against, such as `STOP_ACTION`
  (`packages/board/src/ports.ts:63`, `"stop"`), becomes a string literal type in the contract.
- **To `@cabane/acp`**, because they are the shape of an ACP elicitation: the form field types
  (`CopilotFormField`, `CopilotFormOption`, `CopilotFormValue`, `CopilotElicitationAnswer`, which
  `AcpClient.ElicitationField` already aliases at `client.ts:121`) and `FormField`, which judges a
  typed answer against one. Two readers judge those answers today, the board's form and the loop's
  tracker questions (`packages/board/src/form-field.ts:1-3`); the loop reaches them through its
  own harness client, and the board through the harness client as a library. `ToolCalls` declares
  its own detail type instead of importing `ActivityToolDetail`; the two are the same shape, so
  an extension passes one where the other is asked for.
- **The board keeps** what only it uses or what a host plugs into it: the `Copilot` port and its
  update union, `BoardContext`, `Announcer`, `OpenRequests`, the settings screen's port
  (`SettingsSource`, `SettingRow`, `SettingChange`), the no-op defaults, the keymap and the theme.

`packages/acp/src/copilot.ts` and `instructions.ts` are the board's copilot: they implement the
board's `Copilot` port over a harness and render `BoardContext` into every prompt. They are client
code inside the harness client package. They move to the board, which then depends on the harness
client as a library. The path kabane runs as, which `copilot.ts:17` reads from `Self` today, comes
from the host as an argument once `Self` lives in the host (JCAB-328); the dispatch and grill
templates they point at leave with JCAB-327.

### An extension describes a card header as lines of toned parts

`CardHeader` is a React component (`packages/board/src/ports.ts:81-87`), the one port that takes
a component, and the loop's header renders with the board's `useTheme` and OpenTUI
(`extensions/loop/src/header.tsx:12-18`). A component binds an extension to the board's React and
OpenTUI versions, and a second client could not draw it. In API v1 a header is data:

```ts
type HeaderView = { width: number; expanded: boolean };
type Header = (
	card: ActivityCard,
	view: HeaderView,
) => Promise<Result<readonly PanelLine[]>>;
// BoardPorts.headers?: Readonly<Record<string, Header>>, by card kind
```

The board calls it while the card's tab is open, as the loop's header polls today, and draws the
lines with its own palette. `PanelTone` has six roles (`ports.ts:177-183`); the loop's header uses
seven tones, adding `faint` (`header.tsx:33-40`), and colors each session by the theme's series
at its claim's place (`header.tsx:11`). Those two join `PanelTone` when the loop's header is ported
(JCAB-326).

## Extension API v1

### The host passes values and the extension imports types only

User code cannot import a kabane package at runtime. Every `@cabane/*` package is
`"private": true`, the build inlines them into the one `kabane` package, and the `@cabane` npm
scope belongs to someone else (2026-11-04 research). JCAB-316:1 settles it: kabane loads the
extension into its own process and hands it a versioned object.

An extension is a directory whose `package.json` has a `kabane` field naming its entry and the API
it targets. The entry's default export is a factory:

```ts
// package.json: { "name": "...", "kabane": { "extension": "./index.ts", "api": 1, "modules"?: "./modules.ts" } }
// index.ts: kabane/extension is the published path of @cabane/extension's types
import type { Extension, Host } from "kabane/extension";
export default (host: Host): Extension => ({ name: "...", commands: [...] });
```

The types ship inside the published `kabane` package under a kabane-owned import path (JCAB-322).
An `import type` compiles to nothing, so the extension never resolves that path at runtime.

### What `host` carries in api 1

`host` carries the record, settings and what the harness needs to start, never a session API
(JCAB-316:2). It is built once per process from the runtime the host already configured. Each
member below exists because the loop's inventory needs it (`wiki/extension-api.md`); JCAB-322
does not widen it beyond that.

```ts
type Host = {
	/** The API this host gives. Additions within a major are optional members to feature-detect. */
	readonly api: 1;
	readonly kabane: {
		readonly version: string;
		/** A path that runs this kabane with nothing in front of it, for a detached runner or a session's MCP server. */
		readonly executable: string;
	};
	readonly record: Host.Record;
	readonly scope: {
		/** The project scope of a directory: marker walk, then git. */
		detect(dir: string): Promise<Result<ProjectScope | null>>;
		/** The id of a stored scope URI, either scheme. */
		idOf(uri: string): Result<string>;
	};
	/** For an extension's own data modules only (the manifest's modules entry). */
	readonly store: Host.Store;
	/** The host's zod. Settings schemas and tool input shapes are built with it. */
	readonly z: typeof z;
	readonly result: { ok; err; tryCatch; trySync };
	readonly args: { flagBool; flagString; flagList; flagCsv };
	readonly outcome: { success; conciseSuccess; failure; usage };
	readonly settings: { fields; groupsOf; lookOf; options };
};
```

The helpers on `result`, `args`, `outcome` and `settings` keep their signatures in
`packages/core/result.ts` and `packages/extension/index.ts`. `Extension.Ctx` keeps its fields
(`contract.ts:38-53`): `home`, `store`, `cwd`, `actor`, `harnessMode` and the `settings` port.
`ctx.store` stays the path of the database's directory; `host.store` is the storage kit bound to
it.
`harnessMode` is the harness config the host owns; which command runs a harness, and with which
overrides, is the extension's own setting, as the loop's is today.

`z` is on `host` because the host introspects the schemas an extension hands it:
`Settings.fields` walks the schema of a settings namespace (`settings.ts:290`), and the MCP
server validates a tool's input with `z.object(shape).safeParse`. A schema built with another copy
of zod is untested against both (H3 of the 2026-11-04 research).

### The record half of `host` is the MCP tools' operations

`host.record` offers the operations the MCP tools expose, with the tools' input shapes, called in
the host's process under `ctx.actor`, and returns the structured value a tool computes before it
serializes it for an agent:

```ts
namespace Host {
	export type Record = {
		get(input: { id: string }): Promise<Result<Task>>; // kabane_get
		list(input: ListInput): Promise<Result<Task[]>>; // kabane_list, full format
		edit(input: EditInput): Promise<Result<Task>>; // kabane_edit
		done(input: { id: string }): Promise<Result<Task>>; // kabane_done
		comment(input: { id: string; body: string; kind?: string }): Promise<Result<TaskEntry>>; // kabane_comment
		log(input: { id: string; refs: readonly WorkRef[]; note?: string }): Promise<Result<void>>; // kabane_log
		context(input: ContextInput): Promise<Result<string>>; // kabane_context
		upstreamLink(input: UpstreamLinkInput): Promise<Result<UpstreamLink>>; // kabane_upstream_link
		/** Any registered tool by name, a data module's included; an unregistered name is an err. */
		call(tool: string, input: unknown): Promise<Result<unknown>>;
	};
}
```

The input types are the tools' zod shapes in `packages/core/mcp/tools.ts`. The rule that keeps
this surface honest: **`host.record` has no operation an agent cannot perform through a tool.**
An extension that needs a read no tool offers gets a new tool, so agents gain it too. The loop's
inventory finds four such reads: a task's links (`Planner.getLinksForTask`), its upstream links,
its work log, and a structured checklist (`Checklist.list`, `Checklist.progress`); today these
reach an agent only as markdown inside `kabane_context`. JCAB-322 adds them as read tools or
records why one is not needed.

Why the tools and not `Planner`: opencode made its plugin context "essentially an OpenCode server
client", and that keeps a host API from growing shortcuts only internal code can take. `Planner`
is storage internals: it takes a `basePath`, and its module-facing calls take a `Db` inside a
transaction. The tools already validate input at the boundary and return `Result`, and their tests
cover what an extension would call. The cost is that renaming a tool or changing its input breaks
extensions, so a tool's input shape is part of api 1. Sessions and activities have no tool
(`packages/core/AGENTS.md`, "MCP": "no session tools, because sessions do not sync"); what the
loop needs of them waits on JCAB-316:7, above.

### An extension's data modules get a storage kit on `host.store`

A module's storage has to capture its writes through the oplog and change a task's state through
the one path that runs every module's `onTaskStateChange` (`packages/core/AGENTS.md`, "Data
modules"). The first-party modules import those from `@cabane/core`; an extension gets them on
`host.store`, with the store's path already bound:

```ts
namespace Host {
	export type Store = {
		withDb<T>(fn: (db: Db) => T | Promise<T>): Promise<Result<T>>;
		atomic<T>(fn: (db: Db) => T | Promise<T>): Promise<Result<T>>;
		afterWrite(db: Db, table: string, op: "insert" | "update", id: string): void;
		snapshot(db: Db, table: string, id: string): Result<Row | undefined>;
		afterDelete(db: Db, rows: readonly { tbl: string; row: Row }[]): void;
		updateTaskIn(db: Db, id: string, updates: TaskUpdate): Result<Task | null>;
	};
}
```

These are `withDb` and `atomic` (`packages/core/runtime.ts:152`, `:167`), `Oplog.afterWrite`,
`Oplog.snapshot` and `Oplog.afterDelete` (`packages/core/storage/oplog.ts:340`, `:381`, `:351`),
and `Planner.updateTaskIn` (`packages/core/storage/tasks.ts:407`).

## An extension contributes through six fields on `Extension`, a modules entry and copilot files

```ts
type Extension = {
	/** What `extensions` in config.json enables it by; prefixes its board ids and MCP tool names. */
	name: string;
	settings?: z.ZodTypeAny; // built with host.z
	looks?: Settings.Looks;
	commands?: readonly Extension.Command[];
	board?: (ctx: Extension.Ctx) => Promise<Extension.BoardPorts>;
	doctor?: (ctx: Extension.Ctx) => Promise<Doctor.Finding[]>;
	mcp?: (ctx: Extension.Ctx) => Promise<{ instructions?: string; tools?: readonly ToolDef[] }>;
};
```

- **`commands`, `settings`, `looks`** are unchanged from `contract.ts:17-34`. Built-in commands
  win a name.
- **`board`** keeps `activity` and `dispatcher` and takes headers as data (above).
- **`doctor`** arrives with JCAB-266 on the JCAB-263 branch, typed there as
  `Doctor.Source["doctor"]`: findings with a stable `id`, a severity of `auto`, `mention`,
  `suggest` or `route`, and an optional `fix` returning `Result<string>`. A check that throws
  becomes a `check-failed` finding instead of failing the run.
- **`mcp`** is JCAB-275: tools named `kabane_<extension>_<verb>` and one instructions paragraph,
  served by `kabane mcp` after the device's config tools. The hub never serves them: it cannot
  load an extension.
- **Data modules** (JCAB-323) are `KabaneModule`s the extension builds with `host.store`, from an
  entry of their own that the manifest names (below). Their ops replicate and park like a
  first-party module's (`packages/core/module.ts:10-15`), and the hub, which cannot register
  them, parks them.
- **Copilot procedures, `/` shortcuts and templates** are files in the extension's directory
  (below).

### Every process that opens the database registers the same modules

Today the CLI registers a fixed module list once per process (`packages/cli/src/context.ts:54`,
`:61-62`) and imports an extension only when a command or the board needs it, so `kabane list`
loads no extension code (`packages/cli/src/extensions.ts:4-5`). An extension's modules cannot
follow that. A process without the module would delete a task without capturing the module rows
the foreign key cascades away, change a task's state without the module's `onTaskStateChange`,
and park on a pull the ops it could apply. So every process that opens the database, `kabane list`
included, registers every enabled extension's modules before `Runtime.configure`.

To keep that off the common path (North Star 2, "Instant"), the manifest names the modules as an
entry of their own, `"kabane": { "modules": "./modules.ts" }`, whose default export is
`(host) => KabaneModule[]`. A process imports that file alone; the extension's commands, board and
React stay unloaded until used. The factory only builds the module objects, so it can run before
`Runtime.configure`; the `host.store` calls inside them run later, on a configured runtime. The cost is one import per enabled extension that has modules, on
every command. JCAB-323 measures it against `kabane list` on main.

### Procedures and shortcuts are markdown files, because the loop's need no code

The copilot's procedures and shortcuts are constants in `packages/acp/src/instructions.ts`, and
base kabane's describe the loop by name (`instructions.ts:66`, and the "STARTING A LOOP RUN"
procedure at `:76`; `packages/board/src/setup.tsx:136` offers "turns on the loop"). In API v1 an
extension ships them as files, as opencode ships commands (`.opencode/commands/<name>.md`):

- `copilot/procedures/<name>.md`: frontmatter `title`; the body is appended to the copilot's
  instructions after base kabane's own, under a heading naming the extension. An extension cannot
  replace or reorder base kabane's text.
- `copilot/shortcuts/<name>.md`: frontmatter `hint`; the body, one line, is the template dropped
  into the prompt line as `/name`. A built-in name wins; two extensions with one name are both
  refused with a diagnostic, because a human types it.
- `templates/<name>/`: skill templates a procedure tells the copilot to copy into a project.

Every loop procedure today is fixed text plus how this machine runs kabane, which the host's own
"KABANE ON THIS MACHINE" block already states (`instructions.ts:107`). Text that must be computed
at runtime would need a code slot; nothing needs one yet, so v1 has none. A file has no field for
harness mode, allow lists or MCP entries, so a procedure cannot carry a permission policy in its
type, though its text can still ask for anything (JCAB-324).

## An extension loads from `$KABANE_HOME/extensions/<name>/` when `extensions` names it

1. **Where.** Only `$KABANE_HOME/extensions/<name>/`, a directory with a `package.json` carrying
   the `kabane` field. Nothing loads from a repository or a working directory, so opening a board
   in a clone runs none of the clone's code. A project's `.kabane/<name>.json` holds settings
   only.
2. **Enabled.** `config.json`'s existing `extensions` list names it. A directory alone loads
   nothing.
3. **The `api` check.** The host reads the manifest before importing anything. A major it does not
   support refuses that extension with one line naming both versions, and its code never runs.
4. **Import and factory.** The entry is imported with `import()` and its own `node_modules`
   resolve normally. The factory's `name` must equal the directory's.
5. **A load failure** (a missing or invalid manifest, an unsupported `api`, an import or factory
   that throws, a name mismatch) refuses that one extension with one line naming it and why: on
   stderr for the CLI and `kabane mcp`, as a notice on the board. The others load, and the board,
   `kabane --help` and `kabane mcp` open. Today `Extensions.loadAll` returns the first error
   (`packages/cli/src/extensions.ts:82-92`) and the board refuses to open on it
   (`packages/cli/src/commands/board-runtime.ts:327-328`) (JCAB-321).
6. **A call failure** (a command's `run`, a board port, an MCP handler, a doctor check, a module
   hook) becomes a one-line error naming the extension. A module's `onTaskStateChange` that returns
   `err` rolls back the state change, as a first-party module's does.

Long work runs in a detached process the board only observes, as the loop's runner does
(`extensions/loop/index.ts:5-7`), because a host cannot interrupt a synchronous loop in its own
process.

This follows the 2026-11-04 research note except in three places:

- **`api` sits in the manifest**, read before the import, where the note put it on the exported
  object. An incompatible extension then runs no code at all.
- **There are no official extensions inside the bundle.** The note kept official extensions on
  internals because they ship in lockstep with the CLI (`OFFICIAL`, `extensions.ts:21-23`).
  JCAB-316:3 builds the loop as an external extension against API v1 alone, so the `OFFICIAL` list
  goes and an official name has no precedence to defend.
- **A single `<name>.ts` file is not an extension.** The note accepted one; a directory is the one
  shape, as opencode requires for configured local paths, so a later install command has a single
  thing to put in place.

## The code breaks these rules today in named places

| Rule | Where the code breaks it | Removed by |
|---|---|---|
| The contract and the harness client do not depend on a client | `@cabane/extension` and `@cabane/acp` list `@cabane/board` (`packages/extension/contract.ts:11`, `packages/acp/src/client.ts:32`) | JCAB-320 |
| An extension imports no `@cabane/*` value except from the harness client it bundles | The loop lists `@cabane/acp`, `board`, `checklist`, `core` and `extension` (`extensions/loop/package.json`) and imports values from them in 30 source files | JCAB-326 |
| A host depends on no extension | `packages/cli/package.json` lists `@cabane/loop`, which `OFFICIAL` bundles (`packages/cli/src/extensions.ts:21-23`) | JCAB-326 |
| Core keeps only what passes the four questions | `lint/`, re-exported at `packages/core/index.ts:61` | JCAB-326 |
| | `commit-linker/`, re-exported at `index.ts:20-31` | JCAB-228 |
| | `scope/detect.ts`, `self.ts`, `serveStdio`, `handleHttpRequest` | JCAB-328 |
| | `storage/sessions.ts` | JCAB-316:7, then JCAB-329 |
| Core needs no Bun types | `packages/worker/tsconfig.json:8-10` lists `bun` "only because @cabane/core's commit-linker, lint collectors and file-ref deref use Bun globals" | JCAB-228, JCAB-326, JCAB-328 |
| Base kabane does not describe an extension | `packages/acp/src/instructions.ts:66`, `:76`; `packages/board/src/setup.tsx:136` | JCAB-324 |
| | The dispatch and grill templates in `packages/acp/templates/` | JCAB-327 |
| A broken extension does not take the board down | `packages/cli/src/commands/board-runtime.ts:327-328` | JCAB-321 |
| Extensions load from `$KABANE_HOME/extensions` | Only names in `OFFICIAL` load (`packages/cli/src/extensions.ts:21-23`) | JCAB-321, JCAB-322 |

These rules have no check yet, and say so here so that a missing guard is not taken for an
oversight:

- **The layer table** is checked once JCAB-318 lands `scripts/layers.ts` in `bun run check`.
  Until then review holds it.
- **Core runs in Workers.** The hub's typecheck and its vitest pool run core under Workers types,
  but `bun` stays in `packages/worker/tsconfig.json` until JCAB-328, so a Bun call on the barrel
  type-checks. Review holds it until then.
- **An extension imports types only, apart from the harness client it bundles.** Nothing checks it until JCAB-326 adds a check on the loop.
- **Core keeps only what passes the four questions,** and **a client uses only what another
  client could.** No mechanical check can answer either; review holds them, with the lens and the
  per-package `AGENTS.md` files JCAB-325 adds.
