# Architecture

The rules for what may depend on what in kabane, what belongs in `packages/core`, and what an
extension gets from kabane. Read it before you add a package, a dependency between packages, a
file to `packages/core`, or a field to the extension contract.

`PRODUCT.md` says why kabane exists and what it refuses to be. `CODING_PRINCIPLE.md` holds the
coding rules and the invariants of storage and sync; this file does not repeat them. The
reasoning behind what follows, with the inventory it was built from and the alternatives that
lost, is in `wiki/extension-api.md`.

Where the code breaks a rule below, the rule names the exception and the issue that removes it,
and the full list is under "The code breaks these rules in named places". A rule that nothing
checks says so.

## The layer table is `scripts/layers.ts`, and the gate fails a dependency it does not list

Every workspace package has one layer. Which workspace packages each one may list in
`dependencies` is written once, as data, in `scripts/layers.ts`, and `bun run check` fails a
`package.json` that lists anything else. This file says what each layer is for; it does not copy
the table, because the two would drift apart.
Kabane's predecessor wrote its layer table twice, in an ADR and in its `ARCHITECTURE.md`, and
ten days later the two disagreed on what its second layer held; nothing checked either.

The table lists the edges that exist. An edge the layers below allow is added to it in the
change that first needs it. An edge they forbid is never added; where one exists today it is a
named exception with the issue that removes it, and the check fails once the exception goes
stale, so that list only shrinks. A package imports another by its package name: the check
also fails a relative import that reaches into another package, unless `scripts/layers.ts`
names it as an exception with its issue.

Kabane's layers, from the bottom:

| Layer | Packages | Owns |
|---|---|---|
| core | `@kabane/core` | The record, its sync, the module seam and the MCP tool definitions. Runs in Bun and in Workers. |
| storage adapter | `@kabane/sqlite` | The `Db` port over `bun:sqlite`, for devices. |
| data module | `@kabane/questions`, `@kabane/checklist`, `@kabane/handoff`, `@kabane/outcome` | One feature's own record, as a `KabaneModule`. |
| extension contract | `@kabane/extension` | The types an extension and the host exchange, and the argument, outcome and settings helpers every command is written with. |
| harness client | `@kabane/acp` | Driving a coding harness over ACP: the harness registry, the session runner, tool calls, elicitation forms. |
| client | `@kabane/board` | A UI over the record. |
| host | `kabane` (`packages/cli`) | A device's process: commands, `kabane mcp` over stdio, settings layers, scope detection, how kabane runs itself again, the extension loader and the `host` object. |
| hub | `kabane-worker` (`packages/worker`) | The hub's process: the sync log and the cloud device, serving MCP over HTTP. |
| extension | `extensions/*` | Optional features loaded at runtime. The loop is the first. |

Each layer depends only on layers listed before it in this table, never on a package of its own
layer, with four narrowings:

- **The contract and the harness client depend on core alone.** Neither may depend on a client:
  a second client could not exist without the first if they did.
- **Only a host depends on the storage adapter at runtime.** A data module or a client may use it
  in tests, as a `devDependency`; at runtime the host picks the adapter.
- **The hub depends on core and the data modules alone.** It runs in Workers, which cannot run
  the storage adapter, the harness client or a client.
- **An extension depends at runtime on no `@kabane/*` package except a harness client, which it
  bundles into its own build** (JCAB-316:2: the extension brings its own harness client). It
  lists that package in its `dependencies`, and `scripts/layers.ts` allows exactly that edge
  for the loop. The loop takes `@kabane/acp` from the workspace, where it stays (JCAB-316:3); how an extension
  outside this repository gets a harness client belongs to distribution, which is not designed.
  From the rest of kabane it imports types only, with `import type`, which the compiler erases;
  every value it needs from kabane arrives on `host`. The loop lists `acp` as its only workspace runtime dependency;
  `checklist`, `core` and `extension` are development dependencies for types and tests.
  Its runtime imports use ACP capability subpaths (`/client`, `/harnesses`, `/tool-calls`,
  `/form-field`), keeping instructions and templates out of the bundle. ACP takes result
  helpers from `@kabane/core/result`; `result.ts` is the only core source emitted in the
  loop build, enforced by its real-build metafile test.

A client may use the harness client as a library. The board lists `@kabane/acp` for
its copilot (`packages/board/src/copilot.ts`; see "Ports").

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
is a package in the data module layer, registered by the host (`MODULES` in
`packages/cli/src/context.ts`). An extension's own table is a `KabaneModule` it contributes from the modules
entry its manifest names (below), with its own migrations and `syncTables`; its rows then
replicate through the oplog like a first-party module's. A change to the task row itself stays a
core migration. `packages/core/AGENTS.md` ("Data modules") holds the module seam's rules.

The verdicts for what core holds that is not obviously the record:

| In core | 1 | 2 | 3 | 4 | Verdict |
|---|---|---|---|---|---|
| `file:` deref in `storage/assemble-context.ts` | yes: it inlines a context ref into the brief, which every reader gets | yes: every brief | yes: the host reads through `RuntimeConfig.fileReader` | yes | Assembly stays in core; the CLI wires the bounded reader. |
| `mcp/tools.ts` | yes: the definition of every operation on the record, and `KabaneModule.tools` takes its `ToolDef` | yes: both hosts and every data module | yes | yes | Stays. |
| `mcp/server.ts`, `createMcpServer` | yes: it composes the tool list both hosts serve | yes: the CLI and the hub | yes | yes | Stays. |

`scope/uri.ts`, which parses and formats the stored scope field, stays in core. So does
`scope/git-fixture.ts`, test support for the CLI's and the loop's tests, which `scripts/layers.ts`
refuses in a production file. What failed a question lives with its one consumer or its host:
scope detection, executable discovery (`Self`) and `serveStdio` in the CLI
(`packages/cli/src/scope/`, `self.ts`, `mcp-stdio.ts`), reaching extensions as
`host.scope.detect`, `host.kabane.executable` and `host.kabane.current`; `handleHttpRequest` in the hub
(`packages/worker/src/mcp-http.ts`); plan lint in the loop (`extensions/loop/src/lint/`). Core
keeps no agent session (below).

### Core reaches a device's files through a port with a no-op default

The brief inlines a `file:` context ref through `RuntimeConfig.fileReader`, set by
`Runtime.configure`. `FileReader` takes the filesystem path stripped from the `file:` URI and
a byte cap, and returns `Promise<FileHead>`: `{ status: "read", head: string, size: number }`,
`{ status: "missing" }`, or `{ status: "pointer" }`. `size` is the total byte size. The no-op
default returns `pointer`; the hub wires no reader and never opens a device file.
The CLI wires the bounded read over `Bun.file` in `packages/cli/src/context.ts`.
Core keeps the per-ref and total caps, truncation and missing notes, and pointer fallback.
`ProjectScope` stays in `scope/schemas.ts` and on core's barrel as the shared resolved-scope
type; scope detection and executable discovery belong to the CLI host.

Core's production barrel needs no Bun types. The Worker's `tsconfig.json` excludes `bun`
from `types`, so `bun run typecheck` (which includes the Worker) rejects a Bun global reachable
from that barrel. The Worker test script also typechecks before running its Workers pool.
Core's explicit test-support exports still use Bun and are not imported by the hub.

### What core keeps of an agent session: outcomes and a URI

JCAB-316:7 settled **Split**. Outcomes about the issue are timeline entries, which core already
holds and replicates. A session is a `session:` URI in the work log. Its stream stays with
whatever drove it: the loop's own store, a harness, or a World. `host` carries no session API
(JCAB-316:2).

- The first-party data module `@kabane/outcome` declares `outcome.decision`, `outcome.finding`,
  `outcome.verification` and `outcome.summary`, all projected into Discussion. `handoff` stays
  with `@kabane/handoff`. Both hosts register outcome after handoff. The board reads questions
  and sends answers through `ActivitySource.questions` and `answer`; question ids and card ids
  are namespaced by the source merger. A question names its card and optional lane directly, so
  cards carry no session ids.
- The loop keeps a session's lifecycle in `run.json` claims, its stream in `events.jsonl`, and
  questions with their answers or withdrawals in `questions.jsonl`, under
  `$KABANE_HOME/loops/<runId>/`. It mints session ids with `crypto.randomUUID()`. Only the
  runner writes the stream and the question journal; answer surfaces submit the human's answer
  and actor through `inbox.jsonl`. Summaries and non-permission decisions become
  `outcome.summary` and `outcome.decision` entries through `host.record.comment`; session URIs
  go through `host.record.log`. Runs without a question journal still load.
- Core's migration `session-outcomes` (`storage/session-outcomes.ts`) moves what an older
  database's session tables held onto the record, then drops them. It writes each durable
  activity (`response`, `decision`, `finding`, `verification`, `handoff`) as a shared
  `outcome.summary`, `outcome.decision`, `outcome.finding`, `outcome.verification` or `handoff`
  entry, and each session as a `session:` ref in its issue's work log, both under the source
  row's id and with every column taken from the source rows, so a re-run writes nothing and two
  devices that migrate copies of one database converge. A missing session table or an id
  another row holds fails the migration before anything is dropped. The stream (progress,
  questions, answers, withdrawals) is dropped with `agent_sessions` and `agent_activities`.
- The brief keeps every typed entry; a task whose work log holds a `session:` ref keeps none of
  its AI comments, any other its last three, a rule every device and the hub read alike. The
  board's detail log shows work-log refs and the host's live cards; outcomes are on its
  comments tab.

## Ports

### Nothing below the board imports the board, and each port type lives with the package that produces it

The contract and the harness client do not import the board. The types live with whoever
produces them and are imported directly by their readers:

- **In `@kabane/extension`**, because an extension produces them and any client reads them: the
  activity types (`ActivityStatus`, `ActivityCard`, `CardAction`, `ActivityDiff`,
  `ActivityToolDetail`, `NoticeSeverity`, `ActivityEvent`, `ActivitySource`, and the card's map:
  `ActivityStep`, `ActivityStepState`, `ActivitySession`, `ActivityLeft` and `ActivityFact`), the dispatch types
  (`TriggerInput`, `TriggerDescriptor`, `DispatchTarget`, `Dispatcher`), the panel types
  (`PanelTone`, `PanelPart`, `PanelLine`), the header types (`Header`, `HeaderView`,
  `HeaderPart`), the job types (`JobRunState`, `JobRun`, `JobFacts`, `JobSource`), the settings field types `settings.ts` uses
  (`SettingValue`, `SettingKind`, `SettingField`), and `CopilotShortcut`, which an extension
  contributes (below). A constant an extension compares against, such as `STOP_ACTION`
  (`"stop"`), is the string literal type `StopAction` in the contract; the board and loop
  each keep their own typed constant. An `ActivityEvent` keeps its owning `lane` and may set
  `run: true` to appear in the card's run-wide activity as well. Its optional `includes` lists
  earlier sequence numbers the event incorporates in its transcript row.
- **In `@kabane/acp`**, because they are the shape of an ACP elicitation: the form field types
  (`CopilotFormField`, `CopilotFormOption`, `CopilotFormValue`, `CopilotElicitationAnswer`, which
  `AcpClient.ElicitationField` aliases) and `FormField`, which judges a typed answer against one.
  Two readers judge those answers, the board's form and the loop's
  tracker questions (`packages/acp/src/form-field.ts`); the loop reaches them through its
  own harness client, and the board through the harness client as a library. `ToolCalls` declares
  its own detail type instead of importing `ActivityToolDetail`; the two are the same shape, so
  an extension passes one where the other is asked for.
- **The board keeps** what only it uses or what a host plugs into it: the `Copilot` port and its
  update union, `BoardContext`, `Announcer`, `OpenRequests`, the settings screen's port
  (`SettingsSource`, `SettingRow`, `SettingChange`), the no-op defaults, the keymap and the theme.

`packages/board/src/copilot.ts` implements the board's `Copilot` port over the harness client
and renders `BoardContext` into every prompt. `mailbox.ts` lives beside it. The CLI imports
`BoardCopilot` from `@kabane/board`; acp has no dependency on the board.

Of `instructions.ts`, the prose lives in the board as `packages/board/src/copilot-instructions.ts`
(`BLOCK`, `Setup`, `setup`, `systemPrompt`, `SHORTCUTS`), and acp keeps a
`CopilotInstructions` with two names the board reads: `actorUri` and `SERVER_NAME`. The loop keeps
its own copies (`extensions/loop/src/session-identity.ts`). The dispatch template and the grill
skill belong to the dispatch extension, which reads them from its own directory. The path kabane runs
as is required in `BoardCopilot.Options.kabaneBin`; the CLI passes `Self.executable()`, so the
board never imports `Self`, which lives in the CLI host. The CLI imports
`@kabane/board/copilot-instructions` in `copilot-files.ts` to refuse a package.json description
that contains one of base kabane's headings and a shortcut named like one of its shortcuts, and
in `skills.ts` for `shellWord`, so `{{kabane}}` quotes the executable and home as the copilot's
instructions do. The
copilot tests use the ACP SDK's in-process agent, so the board declares the SDK as a development
dependency.

### An extension describes a card header as lines of toned parts, and the board owns its layout

Headers are data returned by an extension's `Header` port. The board renders them
(`packages/board/src/card-header.tsx`), and the loop's header returns that data
(`extensions/loop/src/header.ts`). Keeping React and OpenTUI in
the board lets a second client draw the same header without those dependencies:

```ts
type HeaderView = { width: number; expanded: boolean };
type HeaderPart = PanelPart | { text: string; series: number; bold?: boolean };
type Header = (
	card: ActivityCard,
	view: HeaderView,
) => Promise<Result<readonly (readonly HeaderPart[])[]>>;
// BoardPorts.headers?: Readonly<Record<string, Header>>, by card kind
```

The board owns everything about how a header sits on screen, so extensions do not duplicate
its layout:

- **Block.** The header is one block above the card's events, on the theme's raised surface, with
  one column of padding left and right, and it never shrinks when the tab runs out of rows.
  `view.width` preserves the headline budget: the pane width less the reserved scrollbar
  column and the two padding columns. The block itself stretches across the pane.
- **Rows.** Each line is exactly one row, cut at `view.width` with a trailing `…` rather than
  wrapped. This differs from `PanelLine` in a trigger's preview, which wraps.
- **Tones.** `PanelTone` includes `faint` and `secondary` alongside the other semantic roles.
  The board maps those roles to its theme for both headers and trigger previews.
- **Series.** A part that carries `series: n` takes the theme's n-th series color through
  `Theme.seriesOf(theme, n)`, so a session keeps the color of its lane's tag.
- **Polling and failure.** The board calls the header while the tab is open, once a second and
  immediately when expansion or width changes. It keeps the last good lines when a call fails,
  or shows a bare muted `loading…` before the first result.

The loop's header is one row, the run's state in words. Where the run is (its steps and
sessions) is card data, `ActivityCard.steps`, which the board draws as a map with a cursor: a
header row has no cursor, no click and no fitting of its own, and a second client gets the steps
without parsing toned text.

## Extension API v1

### The host passes values and the extension imports types only

User code cannot import a kabane package at runtime. Every `@kabane/*` package is
`"private": true` and the build inlines them into the one `kabane` package. JCAB-316:1 settles it: kabane loads the
extension into its own process and hands it a versioned object.

An extension is a directory whose `package.json` has a `kabane` field naming its entry and the API
it targets. The entry's default export is a factory:

```ts
// package.json: { "name": "...", "kabane": { "extension": "./index.ts", "api": 1, "modules"?: "./modules.ts" } }
// index.ts: kabane/extension is the published path of @kabane/extension's types
import type { Extension, Host } from "kabane/extension";
export default (host: Host): Extension => ({ name: "...", commands: [...] });
```

The types ship inside the published `kabane` package under the import path `kabane/extension`.
An `import type` compiles to nothing, so the extension never resolves that path at runtime.

### What `host` carries in api 1

`host` carries the record, settings and what the harness needs to start, never a session API
(JCAB-316:2). Each extension gets its own `host`: every member is shared except `store`, which
is scoped to that extension's modules, so the kit knows whose tables a write may touch. It is
built in two stages (see "Every process that opens the
database registers the same modules"): everything but `record` and `store` works from the start,
and `record` and `store` work once the runtime is configured and migrated and one of that host's
factories has returned, and never while one runs. A doctor check can use them only when doctor
successfully opened the store. Standalone extension commands do not open the store. Each
member below exists because the loop's inventory needs it (`wiki/extension-api.md`), and api 1
has no other.

```ts
type Host = {
	/** The API this host gives. Additions within a major are optional members to feature-detect. */
	readonly api: 1;
	readonly kabane: {
		readonly version: string;
		/** A path that runs this kabane with nothing in front of it, for a detached runner or a session's MCP server. */
		readonly executable: string;
		/**
		 * `executable` asked again at each spawn by a process that outlives an update (a loop runner,
		 * the board): that path while it is still there, else `kabane` on PATH, else null.
		 */
		readonly current?: () => string | null;
	};
	readonly record: Host.Record;
	readonly harnessMode: "auto" | "default";
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
	readonly result: { ok: typeof ok; err: typeof err; tryCatch: typeof tryCatch; trySync: typeof trySync };
	readonly args: { flagBool: typeof flagBool; flagString: typeof flagString; flagList: typeof flagList; flagCsv: typeof flagCsv };
	readonly outcome: { success: typeof success; conciseSuccess: typeof conciseSuccess; failure: typeof failure; usage: typeof usage };
	readonly settings: Pick<typeof Settings, "fields" | "groupsOf" | "lookOf" | "options">;
	/** Types a tool's handler against its input shape, for the tools `Extension.mcp` returns. */
	readonly defineTool: typeof defineTool;
};
```

The compiled contract uses `typeof` for helper
signatures and an explicit `harnessMode` member (Mode only, JCAB-316:8).
`types/extension.d.ts` is generated from the types-only entry in `packages/extension`: it is
self-contained, includes the reachable core and zod types, and exports types only. The
published `./extension` export has a `types` condition only. Build tests compile named type
imports and reject value imports.

An extension with module-level leaf functions can keep a local `result.ts` whose four typed
live bindings (`ok`, `err`, `tryCatch`, `trySync`) are assigned from `host.result` by
`Kabane.bind(host)`, the first call in its factory. Imports of that module do not call the
helpers before the factory binds them. Tests bind the real result helpers before exercising
leaf functions (`extensions/loop/src/result.test.ts` pins the live binding, and both lint
passes accept the pattern). Review checks that module initialization calls none before binding.
Only these stateless functions are shared: the record, scope, settings and
other per-host values remain explicit dependencies. The loop uses this pattern; it does not
retain a global host or a global record.

The helpers on `result`, `args`, `outcome` and `settings` keep their signatures in
`packages/core/result.ts` and `packages/extension/index.ts`, and `defineTool` is `define` in
`packages/core/mcp/tools.ts`, which the loop's `kabane_loop_advise` uses
(`extensions/loop/src/mcp.ts`). `Extension.Ctx` (`packages/extension/contract.ts`) has `home`,
`store`, `cwd`, `actor`, `harnessMode` and the `settings` port. `ctx.store` is the path of the
database's directory; `host.store` is the storage kit bound to it.

`harnessMode` is the only harness configuration `host` carries in api 1. JCAB-316:2 also names
"which command runs claude or codex", but the device config holds a launch command only for the
board's copilot (`copilot.command` and `copilot.args` in `CopilotConfigSchema`), so there is none
to pass. An extension that needs a launch override declares it in its own settings, as the loop
does with `loop.harnesses`. A device setting for it would reach `host` as an optional api-1
member.

`z` is on `host` because the host introspects the schemas an extension hands it:
`Settings.fields` walks the schema of a settings namespace (`packages/extension/settings.ts`), and the MCP
server validates a tool's input with `z.object(shape).safeParse`. The loader refuses a schema built with another copy
of zod and directs the extension to `host.z`.

### The record half of `host` is the MCP tools' operations, as typed wrappers

`host.record` offers the operations the MCP tools expose, called in the host's process under
`ctx.actor`. `host.record` runs under the context's actor (the one `--as` sets) and the device's human
actor, as an agent's call over local stdio does, so an extension can record a relayed answer;
it cannot name another actor.
Each named method is a wrapper over one tool, and says so: it takes the tool's input
without the presentation fields (`responseFormat`, `cursor`, and `kabane_comment`'s `text` and
`content` aliases of `body`), always runs the tool's full format, and returns the value the tool
returns in that format before the MCP server serializes it. The types below are those values,
read from the handlers in `packages/core/mcp/tools.ts` and the `Planner` functions they return:

```ts
namespace Host {
	export type Record = {
		get(input: { id: string }): Promise<Result<Task | null>>; // kabane_get
		list(input: ListInput): Promise<Result<Task[]>>; // kabane_list
		edit(input: EditInput): Promise<Result<Task>>; // kabane_edit
		done(input: { id: string }): Promise<Result<Task>>; // kabane_done
		comment(input: { id: string; body: string; kind?: string }): Promise<Result<TaskEntry>>; // kabane_comment
		log(input: { id: string; refs?: { uri: string; label?: string }[]; commit?: string; note?: string }): Promise<Result<TaskWorkLog>>; // kabane_log
		context(input: ContextInput): Promise<Result<{ id: string; markdown: string }>>; // kabane_context
		upstreamLink(input: UpstreamLinkInput): Promise<Result<UpstreamLink>>; // kabane_upstream_link
		// Wrappers over kabane_linkList, kabane_upstreamList and kabane_logList.
		links(input: { id: string }): Promise<Result<TaskLink[]>>;
		upstreamLinks(input: { id: string }): Promise<Result<UpstreamLink[]>>;
		workLogs(input: { id: string; limit?: number }): Promise<Result<TaskWorkLog[]>>;
		/** Any registered tool by name, input unchanged; a data module's included. An unregistered name is an err. */
		call(tool: string, input: unknown): Promise<Result<unknown>>;
	};
}
```

`ListInput`, `EditInput`, `ContextInput` and `UpstreamLinkInput` are the tools' zod shapes less
the presentation fields. `ListInput` includes optional `limit` and `offset` for full-format paging;
concise tool calls page with `cursor` and refuse `offset`. A data module's tools, `kabane_checklist` among them, are
reached through `call`, whose result is `unknown` until the caller parses it; core's tools get
typed wrappers. `call` passes input unchanged, including cursors and response format.
`get` accepts case-insensitive short ids, full ULIDs and unique ULID prefixes. It returns `null`
for an absent task and an `err` for a failed read or an ambiguous prefix (with its candidates).
`log` takes `refs` or `commit` or both, as `kabane_log` does. `context` always returns the full
context. Inputs are spelled out in `Host`; compile-time assertions compare each mirror to
the tool’s typed input shape, and real database tests pin the wrappers to the handlers’ full
results. Default scope is resolved lazily on the first record call and reused.

The rule that keeps this surface honest: **`host.record` has no operation an agent cannot perform
through a tool.** An extension that needs an operation no tool offers gets a new tool or a new
tool input, so agents gain it too. The loop's needs added `parentTaskId` and `includeDeferred` to
`kabane_list`, `needsReview` to `kabane_edit`, and the tools `kabane_linkList`,
`kabane_upstreamList`, `kabane_logList` and `kabane_checklist`, whose live items the loop
computes a task's progress from. The loop writes its work-log refs under `ctx.actor` and names
the run in its `loop:<runId>` ref, so no tool stamps another actor. Core keeps no session, so
there is no session tool.

Why the tools and not `Planner`: opencode made its plugin context "essentially an OpenCode server
client", and that keeps a host API from growing shortcuts only internal code can take. `Planner`
is storage internals: it takes a `basePath`, and its module-facing calls take a `Db` inside a
transaction. The tools already validate input at the boundary and return `Result`, and their tests
cover what an extension would call. The cost is that renaming a tool or changing its input breaks
extensions, so a tool's input shape is part of api 1.

### An extension's data modules get a storage kit on `host.store`, and the host owns commit and notification

A module's storage has to capture its writes through the oplog and change a task's state through
the one path that runs every module's `onTaskStateChange` (`packages/core/AGENTS.md`, "Data
modules"). Two rules come with that path and live only in comments: `atomic` rolls back on a
throw and commits whatever `fn` returns, an `err` included (`atomic` in
`packages/core/runtime.ts`); and a caller of `Planner.updateTaskIn` must roll back on its `err`
and emit `TASK_UPDATED` after the commit (`packages/core/storage/tasks.ts`). The kit makes both true by construction
instead of handing an extension `atomic` and `updateTaskIn` to get right:

```ts
namespace Host {
	export type Store = {
		/** Reads, on a connection that refuses writes (`PRAGMA query_only`). */
		read<T>(fn: (db: Db) => Result<T> | Promise<Result<T>>): Promise<Result<T>>;
		/**
		 * One transaction. An `err` returned from `fn`, a throw, or an `err` from any `tx` call
		 * rolls everything back. After the commit, and only then, the host emits `TASK_UPDATED`
		 * for every task `tx.updateTask` changed.
		 */
		write<T>(fn: (tx: Tx) => Result<T> | Promise<Result<T>>): Promise<Result<T>>;
	};
	export type Tx = {
		readonly db: Db;
		afterWrite(table: string, op: "insert" | "update", id: string): Result<void>;
		snapshot(table: string, id: string): Result<Row | undefined>;
		afterDelete(rows: readonly { tbl: string; row: Row }[]): Result<void>;
		updateTask(id: string, updates: TaskUpdate): Result<Task | null>;
	};
}
```

`fn` runs inside the database's write lock, held on its own connection until it returns, and
SQLite waits for a lock by blocking the one thread that could release it. So `fn` must not await
I/O, a timer or another write. The kit refuses what would wait on it: a `store.write` nested in
another (from any host in the process, found through an `AsyncLocalStorage` the kit sets around
`fn`) and a `host.record` call to a write tool made inside `fn` return an `err` at once that says
to use `tx.db` and `tx.updateTask` or to call after the write returns. The context carries the
write itself, marked closed when it ends, so a callback `fn` scheduled may write once the outer
write is over. A `host.record` read inside `fn` works and sees what was committed before the
write began, not the write's own rows. `tx.db` is a raw handle: only the kit's capture calls are
checked against the extension's declared tables.

**What takes turns, and what does not.** Every `store.write` and every `host.record` write in the
process takes one write turn (`HostWrites.take` in `packages/extension/host-store.ts`). A waiter
waits at most 5000 ms, the busy timeout `@kabane/sqlite` sets, then returns an `err` naming the
write that holds the turn (`extension notes's store.write has held it for 5004 ms`) and saying the
holder must not await inside `fn`; a waiter that gave up is removed from the queue and never runs.
So an `fn` that awaits a callback which writes, or never settles, costs the other writes of
the process 5 s each and a loud error, not a silent stall. Kabane's own writes (CLI commands, the
MCP tools through `callTool`, the board's `Planner` calls) do not take turns: they open their
own connection and wait in SQLite's busy handler, which blocks the thread the awaiting `fn` would
resume on, so they stall for the busy timeout and then go through (10.3 s, measured).
Awaiting inside `fn` is the misuse behind both. Putting first-party writes in the queue is
JCAB-386.

This is `packages/extension/host.ts` as compiled. `Db`, `Row` (core's
`Record<string, unknown>`) and `TaskUpdate` are core types the published declaration carries,
with `KabaneModule` and `ModuleSyncTable` for the modules entry. An `err` from a `tx` call
poisons the transaction even when `fn` ignores it and returns `ok`, so a refused capture or a
refused state change never commits half a write. `read` gets a connection that refuses writes,
and capture is reachable only through `tx`. `Oplog.afterDelete` takes a readonly row list for
the kit.

The kit (`packages/extension/host-store.ts`) is built from `withDb` and `atomic`
(`packages/core/runtime.ts`), `Oplog.afterWrite`, `Oplog.snapshot` and `Oplog.afterDelete`
(`packages/core/storage/oplog.ts`), `Planner.updateTaskIn` (`packages/core/storage/tasks.ts`) and
`Events.emit`, so an extension's module tests run the same kit over a real database
(`host-store.test.ts`). `afterWrite` and `afterDelete` refuse a table the calling extension's
modules do not declare, so an extension writes only its own tables and changes tasks only through
`updateTask`. Raw SQL on `tx.db` against another package's table is not stopped by the kit;
review holds that.

## An extension contributes through six optional fields on `Extension`, a modules entry, skills and copilot files

```ts
type Extension = {
	/** What `extensions` in config.json enables it by; prefixes its board ids and MCP tool names. */
	name: string;
	settings?: z.ZodTypeAny; // built with host.z
	looks?: Settings.Looks;
	commands?: readonly Extension.Command[];
	board?: (ctx: Extension.Ctx) => Promise<Extension.BoardPorts>;
	doctor?: (ctx: Extension.Ctx) => Promise<Result<Doctor.Finding[]>>;
	mcp?: (ctx: Extension.Ctx) => Promise<{ instructions?: string; tools?: readonly ToolDef[] }>;
};
```

- **`commands`, `settings`, `looks`** are defined in `packages/extension/contract.ts`. Command
  names follow the collision rule beside shortcuts below.
- **`board`** keeps `activity` and `dispatcher` and takes headers as data (above). `jobs` is a
  `JobSource`: for the job ids the board lists from the tracker, every scope's, it gives each
  one's schedule, next fire, recipe, inputs, harness, session mode, folder and recent runs as data, which the
  board's Jobs tab draws; handing one keeps the tab in the bar before the first job. Without one
  the tab shows only while there is a job, and lists the jobs with their title, scope and state
  only. Running a job now is a trigger its `dispatcher` offers on the job, not part of this port.
- **`doctor`** uses `Doctor.Source["doctor"]` from `packages/extension/doctor.ts`: findings
  with a stable `id`, a severity of `auto`, `mention`,
  `suggest` or `route`, and an optional `fix` returning `Result<string>`. A check returns
  `Promise<Result<Doctor.Finding[]>>`; one that throws, returns an `err` or returns a malformed
  report becomes that extension's `check-failed` finding instead of failing the run.
- **`mcp`** returns tools named `kabane_<extension>_<verb>` and one instructions paragraph,
  served by `kabane mcp` after the device's config tools. The hub never serves them: it cannot
  load an extension.
- **Data modules** are `KabaneModule`s the extension builds with `host.store`, from an entry of
  their own that the manifest names (below). Their ops replicate and park like a first-party
  module's (the header of `packages/core/module.ts`), and the hub, which cannot register them,
  parks them.
- **Skills, copilot `/` shortcuts and templates** are files in the extension's directory
  (below). Skills are how-to that `kabane mcp` serves to any session; nothing an extension ships
  is appended to the copilot's instructions.

### Every process that opens the database registers the same modules

The CLI imports an extension's main entry only when a command, the board or `kabane mcp` needs
it, so `kabane list` loads none of it (`resolveCommand` in `packages/cli/src/main.ts`). An
extension's modules cannot wait like that.
`Oplog.cascadeOf` finds the module tables a task delete cascades into through the registered
modules, so a process without the module would delete a task without capturing those rows'
deletes; it would also change a task's state without the module's `onTaskStateChange`, and park
on a pull the ops it could apply. So every process that opens the database, `kabane list`
included, registers every enabled extension's modules with `Runtime.configure`.

To keep the rest of the extension off that path, the manifest names the modules as an entry of
their own, `"kabane": { "modules": "./modules.ts" }`, whose default export is
`(host) => KabaneModule[]`. `openContext` and `doctor` run these stages through
`registerModules` (`packages/cli/src/context.ts`) and then `Planner.init`:

1. Read the device config and, for each enabled extension, its manifest; check `api`
   (`Extensions.modules` in `packages/cli/src/extensions.ts`, kept apart from the main entry's
   loader because its failures stop instead of refusing).
2. Build `host`, one per extension per process (`hostFor` in `packages/cli/src/host.ts`). Every
   member but `record` and `store` works now; those two return an `err` ("the runtime is not
   configured yet") if called, and keep doing so while any factory of that host runs.
3. Import each modules entry and call its factory with `host`. The factory only builds module
   objects; the `host.store` calls inside them run later. The tables they declare are the only
   ones that host's `store` captures.
4. `Runtime.configure` with the first-party modules, then the extensions' in `extensions` order,
   one extension at a time so a refused set names the extension that brought it.
5. `Planner.init`, which migrates core and every module and records each module's declaration.
6. `record` and `store` start working. The main entry is imported later, when a command, the
   board, `kabane mcp` or the copilot needs it, and its factory receives the same `host` its
   modules entry received. An extension's own command resolves its main entry before
   `openContext`; the host is the same object either way.

That an entry imports only what its module objects need is a convention: nothing at runtime stops
`modules.ts` from importing the extension's board. `scripts/modules-entry.test.ts` walks the
import graph of a modules entry (syntax only, with the parser `scripts/layers.ts` uses) and fails
when it reaches the extension's main entry, a `.tsx`, a `commands`/`board*` file, or a board or
harness-client package. It runs on the fixture extension (`packages/cli/src/extension-fixture.ts`)
and on every `extensions/*` manifest that names `modules`: today `extensions/jobs`, whose
`modules.ts` registers its run and job tables. Neither the loop nor dispatch names one. The extensions' builds carry a
`modules` entry into the built manifest at its built path (`scripts/build.ts` in each).

**What it costs.** With the fixture extension enabled, whose modules entry imports one small
file and declares one table, `openContext` takes a median 5.4 ms against 4.2 ms with no extension
enabled, and `kabane list` a median 119.8 ms of process wall time against 118.8 ms (30 runs per
case on an M4 Pro, 2026-11-15). `openContext` is timed inside the process around the call: the
manifest read, the modules entry's import and its transitive imports, the factory, the
registration and the migration check, which on a boot that changes nothing only reads. An entry
that imports more costs more; the import-graph test is what keeps that small.

### A module that fails to load stops writes; anything else that fails is skipped

A failing command, board port, MCP tool, doctor check or copilot file costs only that
contribution: it is skipped with one line naming the extension, and everything else runs. A data
module is different, because its tables are already in the database and the host keeps them
consistent only while the module is registered. The rule has two parts:

- **What capture needs from a module is persisted.** When a module first registers, and whenever
  its migrations move, the host records its declaration (name, schema version, each `syncTables`
  entry with `family`, `clock` and `childOfTasks`) in a device-local table. `Oplog.cascadeOf`
  and capture read the registered modules and then the recorded declarations of modules that are
  not registered, so a task delete captures the deletes of every module row the cascade removes,
  whether that module's code is loaded, broken or disabled. What capture needs is data, so it does
  not depend on code being present.
- **An enabled extension whose modules entry fails stops every process that opens the database.**
  A manifest that names a modules entry the host cannot import, a factory that throws or returns
  no module list, a module set `Runtime.configure` refuses, or an `api` the host does not support
  on a manifest that names `modules` ends `openContext` with one line: the extension, why, and
  the two ways out, repair it or remove it from `extensions` in `config.json`, by hand or with
  `kabane config set extensions <the others> --layer global` (`Extensions.stopLine`). Every
  command that opens the database stops, `kabane mcp` and the board included. Commands that do
  not open the database (`kabane --help`, and the commands marked `standalone`: `config`,
  `init`, `scope`, `update`) still run, so the human can do either. `doctor` runs too: it goes
  through the same stages, reports the stop as its `kabane/extension-modules` finding instead of
  opening the store, and runs every check that needs no store. Writing on in that state would
  change task states without the module's `onTaskStateChange`, and the human never chose that.
  An enabled extension whose directory exists but whose `package.json` is missing, unreadable,
  not JSON or not a valid manifest stops the same way, naming the file: nothing proves it has no
  modules. An enabled name with no directory is not a stop: it is as
  good as disabled (below), and where commands load extensions it stays the "not installed"
  refusal.

**Disabling an extension** (removing it from `extensions`) is the human choosing that state. Its
tables stay, with their rows. Task deletes still capture their cascaded rows through the recorded
declaration. Its `onTaskStateChange` no longer runs, its tools leave `kabane mcp`, and the ops
other devices push for its tables park on this device, as for any device that lacks a module
(the header of `packages/core/module.ts`). Enabling it again registers the module, and the next pull
replays what parked. Removing its tables is a separate, explicit step, designed below and not
built.

**Removing a disabled extension's tables (designed, not built).** A new command,
`kabane modules forget <module>`, takes a module name as `module_declarations` records it,
because a disabled or broken extension's code is not loaded and the declarations know modules,
not extensions; `kabane modules` with no argument lists the recorded modules that are not
registered, with their tables and row counts. It opens the database through the same stages as
every other command, so it runs only when every enabled extension's modules load. It refuses:

- a module that is registered, which means its extension is enabled: disable it first;
- a module with ops parked in `sync_parked`: other devices' writes are waiting for it, so enable
  it and sync, or accept losing them with `--discard-parked`, which deletes them in the same
  transaction;
- a module whose tables have ops in this device's own oplog past `last_pushed_seq`: sync first,
  so the deletes and writes this device already captured reach the other devices.

Then, in one transaction, it drops each table the declaration names, the module's version table
(`schema_migrations_<name>`), its `module_declarations` rows and its tables' `sync_parked_deletes`
rows. It captures nothing: the rows are this device's copy, the other devices keep theirs, and a
delete op would erase them there. Afterwards the device is one that never had the module: its
ops park on pull. Enabling it again migrates from version 0 and replays only what parked since,
so rows nobody wrote after the forget stay absent here; rebuilding them needs the module's ops
from the start of the log, which no device reads today, and the command says so before it runs.

The alternatives, a read-only mode and refusing writes command by command, are in
`wiki/extension-api.md`.

### How-to is a skill `kabane mcp` serves; the copilot's instructions carry only state, identity and boundaries

An extension's how-to, such as setting up dispatch or a loop run, ships as skills in the Agent
Skills format, in the extension's own directory. Why, and what was rejected, is
[ADR 0004](wiki/adr/0004-extension-how-to-ships-as-skills-served-by-kabane-mcp.md). Like the
copilot files below, this is a file convention the CLI host implements, not a field of the
extension contract:

- `skills/<name>/SKILL.md`, with frontmatter `name` equal to the directory name and a required
  `description`, plus any files under `skills/<name>/` such as `references/<option>.md`.
- `kabane mcp` serves every enabled extension's skills through two tools: `kabane_skillList`
  returns each skill's name, description and extension, and `kabane_skillGet { name, file? }`
  returns `SKILL.md` or one file under the skill's directory, with the manifest of its other
  files. A file outside the skill's directory is refused, and two enabled extensions shipping one
  name are both refused. The tools are device-only: the hub loads no extensions.
- On a get the host fills `{{extension}}`, the extension's directory, and `{{kabane}}`, the
  executable and `KABANE_HOME` this server runs. Nothing else is substituted: a skill file
  computes nothing. A value the host cannot know comes from a command the extension contributes,
  which the skill tells the agent to run with `{{kabane}}`; the dispatch template's stamp is the
  first (`kabane dispatch stamp`).
- A skill states its own write boundary in its text, because it may run in a session that is not
  the board's copilot.

Skills do not trigger on their own by description: the server instructions name the tools, and
the board's `/` shortcuts name the skill to fetch. The copilot's instructions
(`packages/board/src/copilot-instructions.ts`) keep only what code alone knows: the per-prompt
`kabane-board` block, `setup()`'s machine context, the copilot's identity and its write
boundaries in `BLOCK`. Base kabane's own how-to (linking external issues, config and help,
doctor) is the `kabane` skill, `packages/cli/skills/kabane/`, which names no extension. `kabane
mcp` serves it first, always, with an extension's skill of that name refused; the CLI imports
its files as text so a compiled kabane, which has no source tree, serves it too.

### Copilot shortcuts are markdown files

`packages/cli/src/copilot-files.ts` reads an extension's copilot shortcuts, as opencode ships
commands (`.opencode/commands/<name>.md`):

- `copilot/shortcuts/<name>.md`: frontmatter `hint`; the body, one line, is the template dropped
  into the prompt line as `/name`. A built-in name wins; two extensions with one name are both
  refused with a diagnostic, because a human types it. A shortcut stays a file: it is how a human
  on the board reaches a skill.
- `copilot/procedures/` is retired (ADR 0004): the host does not read it, so one left in a
  third-party extension is ignored.
- `templates/<name>/`: skill templates a skill tells the agent to copy into a
  project.

Extension commands use the same name rule: a command named like a built-in is refused with
one line, while the rest of that extension loads. If two enabled extensions contribute the
same command name, both contributions are refused with one line each. Help lists neither
refused command.

A copilot file names a file of its own extension by `{{extension}}`, filled with the absolute path
of the extension's directory before the text reaches the copilot, as in
`{{extension}}/templates/dispatch`. The copilot learns how this machine runs kabane from the
host's own block (`KABANE ON THIS MACHINE` in `copilot-instructions.ts`). A file has no field for
harness mode, allow lists or MCP entries, so neither a skill nor a copilot file can carry a
permission policy in its type, though its text can still ask for anything.

## An extension loads from `$KABANE_HOME/extensions/<name>/` when `extensions` names it

1. **Where.** Only `$KABANE_HOME/extensions/<name>/`, a directory with a `package.json` carrying
   the `kabane` field. Nothing loads from a repository or a working directory, so opening a board
   in a clone runs none of the clone's code. A project's `.kabane/<name>.json` holds settings
   only.
2. **Enabled.** `config.json`'s existing `extensions` list names it. A directory alone loads
   nothing.
3. **The `api` check.** The host reads the manifest before importing anything, and the check
   gates both entries. A major it does not support refuses that extension with one line naming
   both versions, and its code never runs. An enabled extension refused this way whose manifest
   names a modules entry counts as a failed module (rule above).
4. **Import and factory.** The entry is imported with `import()` and its own `node_modules`
   resolve normally. Before import, the entry's real path must be inside the extension's real
   directory; a symlinked extension directory is allowed. The host validates the factory result
   against the extension contract, and its `name` must equal the directory's.
5. **A load failure of the main entry** (a missing or invalid manifest, an unsupported `api` on
   an extension with no modules entry, an
   import or factory that throws, a name mismatch) refuses that one extension with one line naming
   it and why: on stderr for the CLI and `kabane mcp`; the board announces a short reason for
   one refusal or a count and names for several, followed by any update notice. The others load,
   and the board, `kabane --help` and `kabane mcp` open. A failure of its modules entry stops
   database access instead, as "A module that fails to load stops writes" says.
   `Extensions.loadAll(names, home)` returns `{ loaded, refused }`; callers keep the loaded
   contributions and report each refusal. A manifest's modules entry is not the main entry's
   concern: `Extensions.modules` loads it on the database path, and its failure is the stop.
6. **A call failure** (a command's `run`, a board port, an MCP handler, a doctor check, a module
   hook) becomes a one-line error naming the extension. A module's `onTaskStateChange` that returns
   `err` rolls back the state change, as a first-party module's does.

Long work runs in a detached process the board only observes, as the loop's runner does
(`extensions/loop/index.ts`), because a host cannot interrupt a synchronous loop in its own
process.

This follows the 2026-11-04 research note except in three places:

- **`api` sits in the manifest**, read before the import, where the note put it on the exported
  object. An incompatible extension then runs no code at all.
- **There are no official extensions inside the bundle.** The note kept official extensions on
  internals because they ship in lockstep with the CLI. JCAB-316:3 builds the loop as an
  external extension against API v1 alone, so the CLI keeps no list of official names, and an
  official name has no precedence to defend.
- **A single `<name>.ts` file is not an extension.** The note accepted one; a directory is the one
  shape, as opencode requires for configured local paths, so a later install command has a single
  thing to put in place.

## The code breaks these rules in named places

A break that lands gets a row here: the rule, where the code breaks it, and the issue that
removes it.

| Rule | Where the code breaks it | Removed by |
|---|---|---|
| An extension writes only its own tables | `extensions/jobs/src/from-recipes.ts`: the migration that moved a device from the `recipes` names renames its version tables and rewrites `sync_oplog`, `sync_parked`, `sync_parked_deletes`, `sync_quarantine` and `module_declarations` with raw SQL, because core cannot rename a module | JCAB-648 |

Each rule in this file and what holds it. "Review" means nothing fails a build; a reviewer has to
notice. The architecture lens is `.agents/skills/dispatch/references/lenses/architecture.md`.

| Rule | Held by |
|---|---|
| The layer table | `scripts/layers.ts` in `bun run check`, which fails an edge its entries do not list; the ordering and the narrowings in prose are review |
| No package depends on one of its own layer; only a host uses the storage adapter at runtime | the entries of `scripts/layers.ts`, which list no such edge; an entry that adds one is review |
| A package imports another by its package name | `scripts/layers.ts`, which fails a relative import into another package that it does not name as an exception |
| Core's test support stays out of production code | `scripts/layers.ts`, which fails a production import of `@kabane/core/testing` or `@kabane/core/git-fixture` |
| A first-party package with a layer moves its code in the change that creates it | review, with the architecture lens |
| Core keeps only what passes the four questions | review, with the architecture lens and each package's `AGENTS.md` |
| Core needs no Bun types | the hub's typecheck, with no `bun` in `types`, which fails a Bun global on the production barrel; `bun run typecheck` and the Worker test script run it |
| A client uses only what another client could | review, with the architecture lens |
| An extension imports types only, apart from the harness client it bundles | `scripts/layers.ts`, which permits production type-only imports from an extension's development dependencies and refuses value imports |
| A modules entry imports only what its module objects need | `scripts/modules-entry.test.ts` on the fixture extension and every in-repo manifest naming `modules`; an extension outside the repo, review |
| An extension writes only its own tables and changes tasks only through `tx.updateTask` | partly the kit (`host-store.ts`): capture refuses an undeclared table, and any `err` from a `tx` call rolls the write back; raw SQL on `tx.db` is review |
| A failed module stops database access; a disabled one's deletes are captured | `registerModules` and `Extensions.modules` (`extension-modules.test.ts`); `module_declarations` read by `Oplog.cascadeOf` and capture (`packages/core/sync/modules.test.ts`) |
| Manifest, `api` check before import, per-extension refusal | `packages/cli/src/extensions.ts` and its tests |
| `host` and its typed record wrappers | `host-record.test.ts`, the CLI host and directory-extension tests, and the isolated declaration typecheck |
| Headers are data, laid out and clipped by the board | `card-header.tsx`, `card-header.test.tsx` |
| Skills are served by `kabane_skillList` and `kabane_skillGet` on devices only; `{{extension}}` and `{{kabane}}` are the only placeholders, a file outside the skill is refused, and a computed value comes from a command | `packages/cli/src/skills.ts` (the reader and the two tools) with `skills.test.ts`, and `packages/cli/src/commands/mcp.ts`, which serves them; `kabane dispatch stamp` (`extensions/dispatch`) |
| Shortcuts are files; `{{extension}}` is their only placeholder | `packages/cli/src/copilot-files.ts` and its test |
| Core reaches files through a port | `RuntimeConfig.fileReader`, defaulting to a pointer; the CLI reader and core assembly tests |
