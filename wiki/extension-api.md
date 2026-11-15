# Extension API v1: the inventory and the choices behind ARCHITECTURE.md

Design record for JCAB-317, under JCAB-316. Baseline: `main` at `7d1a6b1`, 2026-11-15. It holds
what `ARCHITECTURE.md` was built from: every value and type the loop imports from kabane and where
each one goes, the alternatives weighed for the record half of `host` and for the contribution
slots, and the research it rests on. The rules themselves are in `ARCHITECTURE.md`; where this
note and that file disagree, that file is current.

## The loop imports 61 names from nine `@cabane/*` entry points in 32 of its 40 source files

Counted over `extensions/loop/src`, test files excluded, by reading each `import { ... } from
"@cabane/..."` statement and splitting type-only names from values; a name imported from two entry
points counts twice. 32 of the 40 non-test files import from kabane, and 30 of them import at
least one value. Import statements per entry point: `@cabane/core` 28, `@cabane/acp` 12,
`@cabane/board/ports` 5, `@cabane/extension` 3, and one each from `@cabane/board`,
`@cabane/board/form-field`, `@cabane/checklist`, `@cabane/core/scope` and `@cabane/core/self`.

Each value goes in one of four columns:

- **on host**: the extension reads it from the `host` object it receives;
- **own dependency**: it comes from a package the extension bundles into its own build, which
  JCAB-316:2 allows for the harness client alone;
- **moves into the extension**: the code goes with the extension;
- **dropped**: the port to API v1 removes the need.

A type-only import needs none of these: it comes from the contract's published types and the
compiler erases it. The types are listed after the values.

### Values

| Import | Files | Used as | Column | Where it lands |
|---|---|---|---|---|
| `@cabane/core` `Planner` | 8 | see the next table | on host | `host.record`, operation by operation |
| `@cabane/core` `ok`, `err` | 22, 19 | building `Result`s | on host | `host.result` |
| `@cabane/core` `tryCatch`, `trySync` | 4, 7 | wrapping throwing calls | on host | `host.result` |
| `@cabane/core` `Runtime` | 2 | `Runtime.actor()` (`parent.ts:226`, `:316`) | dropped | `ctx.actor`, already on `Extension.Ctx` |
| | | `Runtime.modules()`, to ask whether the checklist module is registered (`checklists.ts:16-17`) | dropped | `host.record.call` returns `err` for a tool no registered module provides |
| `@cabane/core` `Lint` | 1 | `Lint.run` (`commands.ts:568`) | moves into the extension | with `lint/` (JCAB-326) |
| `@cabane/core` `RiskAnalyzer` | 1 | `checkFileOverlap` (`advice.ts:113`) | moves into the extension | with `lint/` |
| `@cabane/core` `defineTool` | 1 | typing `kabane_loop_advise`'s handler against its input (`mcp.ts:10`); added by JCAB-275 after the baseline, so not in the counts above | on host | `host.defineTool` |
| `@cabane/core` `ScopeUri` | 1 | `getScopeId` (`commands.ts:343`) | on host | `host.scope.idOf`; parsing a stored URI, both schemes, stays with core |
| `@cabane/core` `authorTypeOf` | 1 | stamping a comment's author type (`parent.ts`) | dropped | `host.record.comment` stamps it, as `kabane_comment` does (`mcp/tools.ts`, `authorType: authorTypeOf(ctx.actor)`) |
| `@cabane/core` `answersContext`, `isAnswerTo` | 1, 2 | matching an answer activity to its question | open | JCAB-316:7 |
| `@cabane/core` `formatQuestionBody`, `parseQuestionBody` | 2, 1 | a session question's body | open | JCAB-316:7 |
| `@cabane/core/scope` `detectScope` | 1 | a run's project scope (`commands.ts:310`, `:338`) | on host | `host.scope.detect` |
| `@cabane/core/self` `Self` | 1 | `Self.executable` (`extension.ts:47`) | on host | `host.kabane.executable` |
| `@cabane/acp` `AcpClient` | 3 | sessions, prompts, permission and elicitation requests | own dependency | `@cabane/acp` |
| `@cabane/acp` `Harnesses` | 7 | ids, modes, launch resolution, agent definitions | own dependency | `@cabane/acp` |
| `@cabane/acp` `ToolCalls` | 1 | folding tool calls into a detail (`dispatch.ts`) | own dependency | `@cabane/acp` |
| `@cabane/acp` `CopilotInstructions` | 4 | `actorUri(harness)` (`checklists.ts:85`, `dispatch.ts:226`) | moves into the extension | the `cabane://actor/agent/<harness>` form is stored in rows, so a copy cannot drift |
| | | `SERVER_NAME` (`brief.ts:153`, `dispatch.ts:220`) | moves into the extension | the name the loop gives its sessions' MCP server |
| | | `DISPATCH_TEMPLATE` (`lenses.ts:24`), the directory the shipped lenses are read from | moves into the extension | with the templates (JCAB-327); see "Open points" |
| `@cabane/board` `Theme`, `useTheme` | 1 | drawing the run header (`header.tsx:12-18`) | dropped | the header becomes `PanelLine`s |
| `@cabane/board/form-field` `FormField` | 1 | judging an answer to a harness form (`elicitation.ts:20`) | own dependency | `@cabane/acp`, where JCAB-320 moves it |
| `@cabane/board/ports` `STOP_ACTION` | 1 | the stop action's id (`activity.ts:41`, `:134`) | dropped | the string literal `"stop"`, typed by the contract |
| `@cabane/checklist` `Checklist` | 1 | `list`, `progress` (`checklists.ts:27`, `:39`) | on host | through `kabane_checklist` (JCAB-336) |
| `@cabane/checklist` `checklistModule` | 1 | its `name`, for the registration check | dropped | as `Runtime.modules()` above |
| `@cabane/extension` `Settings` | 3 | `fields`, `groupsOf`, `lookOf`, `options` | on host | `host.settings` |
| `@cabane/extension` `success`, `failure`, `usage` | 1 | a command's outcome | on host | `host.outcome` |
| `@cabane/extension` `flagBool`, `flagString`, `flagList` | 1 | reading parsed flags | on host | `host.args` |

### What the loop asks of `Planner`

| Call | Uses | Tool | Where it lands |
|---|---|---|---|
| `getTask` | 13 | `kabane_get` | `host.record.get` |
| `updateTask` | 7: `state` alone in 4 (`checklists.ts:92`, `checks.ts:414`, `claims.ts:56`, `parent.ts:69`), with `assignee` once (`claims.ts:327`), with `needsReview` twice (`parent.ts:273`, `:324`) | `kabane_edit`, `kabane_done` | `host.record.edit`, `done` |
| `resolveTaskId` | 2 | `kabane_get` (returns the ULID) | `host.record.get` |
| `queryTasks` | 1 (`plan.ts:98`: `parentTaskId`, `includeClosed`, `includeDeferred`, `limit`) | `kabane_list`, full format | `host.record.list` |
| `addComment` | 2 | `kabane_comment` | `host.record.comment` |
| `addWorkLog` | 3, each with `addedBy: "loop:<runId>"` and `addedByType: "ai"` (`checks.ts:377`, `claims.ts:342`, `parent.ts:76`) | `kabane_log`, which stamps the connected actor | `host.record.log` under `ctx.actor`; the run stays named by its `loop:<runId>` ref |
| `assembleContext` | 1 | `kabane_context` | `host.record.context` |
| `upsertUpstreamLink` | 1 | `kabane_upstream_link` | `host.record.upstreamLink` |
| `getLinksForTask` | 2 | `kabane_linkList` | `host.record.links` |
| `getUpstreamLinksForTask` | 1 | `kabane_upstreamList` | `host.record.upstreamLinks` |
| `getWorkLogs` | 1 | `kabane_logList` | `host.record.workLogs` |
| `startSession`, `getSession`, `endSession` | 1, 1, 2 | none | JCAB-316:7 |
| `addActivity`, `getActivities` | 3, 3 | none | JCAB-316:7 |
| `getNeedsInput`, `answerQuestion` | 2, 3 | none | JCAB-316:7 |

### Types

From the published contract types: `Task`, `TaskLink`, `TaskPriority`, `TaskState`, `Result`,
`ChecklistItemView`, `Extension`, `Outcome`, `ParsedArgs`, `Settings.Port`, `Settings.Looks`,
`Settings.Look`, and the port types `ActivityCard`, `ActivitySource`, `ActivityStatus`,
`ActivityToolDetail`, `CardAction`, `Dispatcher`, `NoticeSeverity`, `PanelLine`, `PanelPart`,
`SettingField`, `TriggerDescriptor`, `TriggerInput`. `CardHeader` and `CardHeaderProps` go with
the component header. `Risk` moves with `lint/`. `AgentActivity`, `ParsedQuestion` and
`PermissionRequestMeta` wait on JCAB-316:7.

## The record half of `host` follows the MCP tools

Three shapes were weighed for how an extension reads and writes the record.

**`Planner` calls, a curated subset with the store path bound.** The port is mechanical: the
loop's 18 distinct calls keep their names and types. It lost because `Planner` is storage
internals. Its functions take a `basePath`, the module-facing ones a `Db` inside a transaction,
and a subset frozen as API would need its own validation, its own tests and its own rule for what
joins it, beside the tool layer that already has all three. Two surfaces over one record drift.

**The MCP tools, called by name, returning what the agent gets.** This is opencode's choice: its
plugin context "is essentially an OpenCode server client" and "Its read and action methods use
the same inputs and responses as the client" (`opencode-architecture.md`). It lost on output: a
tool's concise format is text sized for a context window, which a program then parses back.

**The tools' operations, typed, returning the value before it is serialized** (chosen). Each method is a declared wrapper over one tool: the tool's input less `responseFormat`, `cursor`
and `kabane_comment`'s two aliases of `body`, run in the full format, returning what the handler
returns there. That is the `Task` for `kabane_get`, `kabane_edit` and `kabane_done`, a
`TaskWorkLog` for `kabane_log` (`Planner.addWorkLog`), a `TaskEntry` for `kabane_comment`
(`Planner.addEntry`), `{ id, markdown }` for `kabane_context`, and `Task[]` for `kabane_list`.
Exposing the presentation fields was rejected: the concise format changes the envelope, so one
method would return two shapes. Its reasons:

- one rule decides what an extension can do: what an agent can do through a tool;
- an operation an extension needs and no tool offers becomes a tool or a tool input, so agents
  gain it too (the loop's inventory finds four reads, two `kabane_list` inputs and one
  `kabane_edit` input);
- input is validated where every other caller's is, and returns `Result`;
- a data module's tools reach extensions with no host change, through `call`.

The cost, from opencode's record: its v2.1.0 changed plugin contracts and the HTTP API together,
"Integrations must adopt the new fields". A tool's input shape is part of api 1, so renaming a
tool or changing an input is a major change for extensions as well as for agents.

Sessions and activities have no tool, and the loop uses seven session calls. JCAB-316:7 decides
whether they become timeline entries (no host operation needed), a data module's tools (reached
through `call`), or stay in core (session operations on `host.record` that no tool mirrors, an
exception to the rule above).

## Smaller choices on `host`

- **`ok`, `err`, `tryCatch`, `trySync` on `host`, over a copy in each extension.** The four
  helpers fill most of the 78 lines of `packages/core/result.ts`, and `Result` is structural, so
  either works. `host` won because the parent's
  draft already carried them and a copy in a monorepo extension would trip `jscpd` against
  `packages/core/result.ts`.
- **The host's zod on `host.z`, over JSON Schema.** The host introspects settings schemas
  (`Settings.fields`, `packages/extension/settings.ts:290`) and validates tool input with
  `z.object(shape).safeParse`. JSON Schema would mean a second introspection path for settings
  and a converter for tools. Whether a user's own zod copy mixes with the host's was never run
  (H3 in `kabane-extension-model.md`); passing one zod removes the question.
- **`harnessMode` on `ctx`, and no harness launch on `host`.** This narrows JCAB-316:2 and is
  listed first under "Where this document departs from a decision" in `ARCHITECTURE.md`. The
  device's `harness.mode` is the one harness setting the device config holds for every session
  (`packages/cli/src/config.ts:114-116`). The only launch command it holds is the board copilot's
  (`copilot.command`, `copilot.args`, `config.ts:34-43`). The loop has a seam for per-harness
  launch overrides, `RunDeps.overrides` (`extensions/loop/src/commands.ts:903`), and nothing sets
  it outside the loop's tests. Exposing "which command runs claude or codex" on `host` would mean
  inventing that device setting first.

## Slots

### Card header: data, over a component kept official-only

The 2026-11-04 note kept component-taking ports for official extensions only, in the spirit of
VS Code's proposed APIs. With JCAB-316:3 there is no official extension inside the bundle to keep
it for, and a component ties an extension to the board's React and OpenTUI. opencode's record
shows the price: "TUI plugins require OpenTUI 0.8" in its v2.2.3. The loop's header (658 lines,
`extensions/loop/src/header.tsx`) draws text, meters as cells of characters, and colors. What
`PanelLine` lacks is more than two tones: the header also sets its own layout, a raised
background, one column of padding, `flexShrink: 0` and rows that never wrap (`header.tsx:613-621`,
`:428`), where `PanelLine` wraps. A per-extension layout would be copied by every extension, so
the board owns it, and the data carries only lines, tones (with `faint` and `secondary` added)
and series indices.

### Copilot procedures and shortcuts: files, over a `copilot(ctx)` code slot

opencode ships commands, agents and skills as markdown, and those survived its V2 rewrite
unchanged while code plugins broke ("should continue to work without changes",
`opencode-architecture.md`). Base kabane's `CopilotShortcut` is already plain data,
`{ name, hint, template }` (`packages/board/src/ports.ts:448`). The procedures in
`packages/acp/src/instructions.ts` are prose with two kinds of computed text: the host's block on
how this machine runs kabane (`instructions.ts:107`), which stays the host's, and the paths of the
dispatch and grill templates (`:68`, `:80`), which `Self.templates` resolves where the package or
the binary is installed (`:40`, `:44`). One placeholder, `{{extension}}` for the extension's
directory, covers the second kind. A value that has to be computed, such as the dispatch
template's stamp the doctor branch puts in `setup()`, comes from a command the extension
contributes and the procedure tells the copilot to run (`kabane dispatch stamp`, JCAB-327).
Alternatives weighed: a relative path the copilot resolves
itself (it does not know where the extension is installed), and a general template language (no
procedure needs more than a path). Files with that one placeholder meet every need the loop and
the dispatch skill have; a code slot would be API to keep stable for no current user.

### Data modules: a manifest entry, over a field on `Extension` or lazy registration

- **A field on `Extension`** would put the modules in the main entry, so `kabane list` would
  import every enabled extension's commands and board to register them.
- **Registering only in processes that load the extension** breaks three things in the others:
  a task delete that does not capture the module rows the cascade removes, a state change that
  skips the module's `onTaskStateChange`, and a pull that parks ops the device could apply
  (`packages/core/AGENTS.md`, "Data modules" and "Multi-device sync").
- **A separate modules entry** (chosen) is imported by every process and holds only the module
  objects. Its factory needs `host` before `Runtime.configure`, so `host` is built in two stages:
  `record` and `store` start working only after migration. Its cost is the whole `openContext`
  path of `kabane list` (manifest reads, the entry's transitive imports, the factory,
  registration, the migration check), which JCAB-323 measures. That the entry imports nothing
  else of the extension is a convention, checked by a test JCAB-323 adds, on a fixture
  extension until the loop has a modules entry.

### A module that fails to load: stop database access, and persist what capture needs

`Oplog.cascadeOf` finds the module tables a task delete cascades into through the registered set
(`packages/core/storage/oplog.ts:225-231`), and `onTaskStateChange` runs only for registered
modules (`packages/core/module.ts`, `Modules.taskStateChanged`). A device whose module tables
exist but whose module is not registered therefore loses deletes from the log and skips the
module's reaction to state changes. Four rules were weighed for an enabled extension whose
modules fail to load:

- **Skip it, as any other contribution** (the 2026-11-04 note, the parent's draft). Rejected:
  every task delete in that state loses the module rows' deletes from the log, and the devices
  diverge.
- **Open read-only.** Reads are safe, but every write path (the CLI's commands, every MCP write
  tool, the board, the copilot through `kabane mcp`, the loop's runner) would need a gate, and a
  read-only `kabane mcp` fails its agent on every write anyway. Rejected for now as cost without
  a user; it can come later as a refinement of the stop.
- **Refuse writes command by command.** The same gates, spread across every write.
- **Stop every process that opens the database, with one line naming the extension and the two
  ways out** (chosen). The commands that open no database stay usable, so the human can repair
  or disable.

Separately, capture must not depend on code at all, because a disabled extension is a state the
human chooses and keeps. So the host persists, per module, what capture reads (name, schema
version, `syncTables` with `family`, `clock`, `childOfTasks`) and `cascadeOf` reads those
declarations for unregistered modules. Persisting them is the alternative to forbidding
disabling an extension that has tables, which would make every experiment permanent. What
disabling still costs: the module's `onTaskStateChange` stops running, which is the trade the
human made.

### Writes through the kit: one `write` that rolls back on `err` and notifies after commit

`atomic` commits whatever its function returns and rolls back only on a throw
(`packages/core/runtime.ts:167-191`), and `Planner.updateTaskIn`'s comment asks its caller to roll
back on `err` and emit `TASK_UPDATED` after commit (`packages/core/storage/tasks.ts:401-405`). Handing
`atomic` and `updateTaskIn` to extension authors leaves both rules to each author. The chosen
`write(fn)` turns a returned `err` into a rollback and emits the notifications itself after
commit, and capture calls exist only on the transaction object, so they cannot run outside one.

### Loading: where this departs from the 2026-11-04 note

The note is the source for the location, the enable list, per-extension refusal and call-time
wrapping. `ARCHITECTURE.md` departs from it in three places: `api` is read from the manifest
before any import, there is no bundled official list once the loop builds against API v1
(JCAB-316:3), and a single `<name>.ts` file is not accepted. The note's deadline rule for board
ports and MCP handlers (a missed `activity.load` shows stale cards; a missed handler returns
`isError`) is left to JCAB-321.

## Open points

- **The loop's shipped lenses live in the dispatch template.** `Lenses` reads `functional` and
  `quality` from `<dispatch template>/references/lenses` (`extensions/loop/src/lenses.ts:23-28`).
  If the dispatch skill ships as an extension other than the loop's (JCAB-327), the loop needs
  its own copy of the two lens files, since API v1 has no dependency between extensions.
- **`@cabane/acp` imports `@cabane/core` for `Result`** (`packages/acp/src/client.ts:33`). An
  extension that bundles the harness client bundles that import too. Whether the harness client
  keeps a dependency on core, or the bundle's tree shaking keeps it to `result.ts`, is for
  JCAB-326 to measure.
- **What kabane keeps of a session** (JCAB-316:7) decides seven rows of the `Planner` table and
  four question helpers.

## Research

Read in full from `~/Vaults/icitte-third-brain/projects/kabane/research/`:

- `kabane-extension-model.md` (2026-11-04): loading from `$KABANE_HOME`, `api: 1` passed to a
  factory, failure isolation, files and slots compared with pi, VS Code and Claude Code.
- `jake-package-layers.md` (2026-11-15): two layer tables that disagreed, facade packages,
  nothing checking the rules; the core verdicts for `lint/`, `commit-linker/`, `scope/detect.ts`,
  `mcp/server.ts`, `self.ts` and `storage/sessions.ts` start from its table.
- `opencode-architecture.md` (2026-11-15): the client rule, the plugin context as a server
  client, files in place of code, and a compiled Bun binary importing user TypeScript with its
  own `node_modules` (a probe on toy code; kabane's loader is unproven until JCAB-321).
- `herdr-principles.md` (2026-11-15): the three-question gate on what enters herdr's core, which
  the four questions for kabane's core follow.
- Background: `vercel-workflow-sdk-principles.md` and `vercel-durable-harness.md`, on durable
  runs and where a loop's state could live.
