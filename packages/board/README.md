# @cabane/board

Terminal kanban for the Cabane tracker, built on OpenTUI. It reads the tracker through
`@cabane/core` and learns about the host's running work, its dispatch targets and its copilot
through three ports, so the same board runs standalone or inside a host like Jake.

## Start it

```ts
import { Runtime } from "@cabane/core";
import { SqliteDb } from "@cabane/sqlite";
import { startBoard } from "@cabane/board";

Runtime.configure({ provider: SqliteDb.provider() });
await startBoard({ cwd: process.cwd(), basePath: "~/.cabane" });
```

`startBoard(deps)` takes:

| Field | Required | Default behaviour when absent |
|---|---|---|
| `cwd` | yes | — |
| `basePath` | yes | — (the handle the configured `DbProvider` reads) |
| `activity: ActivitySource` | no | sidebar shows `no activity`, no badges, no header strip |
| `dispatcher: Dispatcher` | no | `a` flashes `no dispatcher configured` in the footer |
| `copilot: Copilot` | no | `A` flashes `no copilot configured` in the footer |
| `resolveScope(cwd)` | no | the board opens on all scopes (the CLI passes `@cabane/core/scope` detection) |

The host calls `Runtime.configure` before `startBoard`; the board never opens a database itself.

## Ports

### `ActivitySource`

```ts
interface ActivitySource {
  load(): Promise<Result<ActivityCard[]>>;
  card?(id: string): Promise<Result<ActivityCard | null>>;
  events?(id: string, afterSeq: number): Promise<Result<ActivityEvent[]>>;
}
```

`load()` returns flat cards, newest first, already capped. A card carries `kind` (the sidebar
section it groups under — the host picks the word, `"loops"`, `"runs"`), `label`, `status`
(`pending | running | paused | completed | failed`), an optional `taskId` or `taskShortId`, and
`detail` lines joined with ` · ` after the label. The board renders:

- a row badge for the first in-flight card of a task: `· ⠹ loop · implement 3`, plus `· ⠹ +n` for more
- a header strip counting in-flight cards per kind: `· ⠹ 2 loops · 1 run · 1 input`
- a status line under the detail header for the first in-flight card, and an `activity` block listing all
- the sidebar, grouped by kind, then `input needed` (questions come from the tracker, not the host)

`card` and `events` are optional. When a card has `hasEvents: true` and the source implements
`events`, `enter` on it in the sidebar (or `o` in the detail view) opens the event log, polled every
second until the card leaves the in-flight states.

### `Dispatcher`

```ts
interface Dispatcher {
  triggers(taskId: string): Promise<Result<TriggerDescriptor[]>>;
  dispatch(triggerId: string, target: DispatchTarget): Promise<Result<string>>;
}
```

`a` opens a picker over `triggers(taskId)`: `j/k` or a digit select, `enter` fires a satisfiable
trigger, an unsatisfiable one flashes its `hint`. `dispatch` receives the task id, shortId, title
and the assembled brief (what `y` copies) and resolves to the footer notice.

### `Copilot`

```ts
interface Copilot {
  run(prompt: string, context: BoardContext.Context): AsyncIterable<CopilotUpdate>;
  cancel(): Promise<void>;
  shortcuts(): CopilotShortcut[];
  answerPermission(id: string, optionId: string | null): void;
  readonly actor?: string;
}
```

The copilot is a PANE above the footer, always mounted, never a modal: one status row when it is
not focused, a bordered panel when it is. `tab` and `⇧tab` cycle focus board → copilot → sidebar,
skipping panes that are not visible; `A` (or `:`) jumps straight to it. Its title carries a chip
saying what the prompt carries (`JCAB-31 · 3 marked · inbox`), and because the buffer outlives a
focus change you can type half a prompt, tab to the board, mark three more rows, and tab back to
find the chip updated under you.

The input is an OpenTUI `<textarea>`, so paste, word motions, `ctrl+w` and undo all work; `enter`
sends, `⇧enter` and `ctrl+j` make a newline. The textarea owns the buffer and `copilot.text`
mirrors it — `BoardNav.copilotConsumes` names the keys the reducer takes back from it, and app.tsx
`preventDefault`s exactly those. `esc` leaves the pane, stopping a running turn on the way out;
`tab` is the exit that leaves it running. Typing `/` lists `shortcuts()` (`/triage`, `/refine`, …)
as a palette; `tab`, or `enter` on the exact name, expands the `template` so what will be sent is
read before it goes. `↑` on an empty buffer walks back through this session's prompts.

The turn runs in the background and the board stays fully interactive. Submitting hands the
keyboard back to the board, because the next thing after sending a command is watching it. The
pane's row shows `⠹ copilot · 2/5 · <last tool call>` while it runs — the count is the agent's own
plan — `✓ copilot · <the agent's last line>` when it ends, `✗ copilot · <reason>` on an error or a
cancel; the finished indicator stays until the next keypress, which also clears the `✦ ai` glyphs.

Exactly one surface animates per fact: the pane owns the copilot, the sidebar owns host cards, and
every echo of a running thing renders `●` rather than a frozen spinner frame (see `spinner.ts`). `run` yields `CopilotUpdate`s (`text`, `thought`, `tool_call`, `tool_result`,
`error`, `done`); each `tool_result` reloads the board so the copilot's writes appear as they
land. One turn at a time: a second `A` while one runs shows `a turn is running · esc to cancel it
first`, and that `esc` calls `cancel`.

The turn also appears as an in-memory activity card (`kind: "copilot"`) at the top of the
sidebar. `o` (from the board or the detail view, while the indicator is up) or `enter` on the
card opens the event view on its live transcript: prose as text lines, thoughts dimmed, tool
calls with the usual glyphs; `x` there cancels a running turn, `esc` returns. Nothing about the
turn is persisted; the next turn replaces the card.

A harness that stops mid-turn to ask before doing something yields a `permission` update, and the
turn is blocked until it is answered. The choice is shown on exactly one surface: the transcript
when it is open on the copilot's card, the copilot pane's one row everywhere else — the pane being
the only copilot surface present in every view, so a board with no transcript open still sees that
something is waiting. A digit picks the option it numbers, `esc` declines, and both go straight to
`answerPermission` ahead of whatever view is on screen. The board never answers by itself and there
is no timeout: a question left alone keeps the turn waiting, and `x` on the transcript still
cancels it.

Rows the copilot changed during the turn carry `✦ ai` before the title: the reload after each of
its writes brings the fresh `updatedBy`/`updatedAt`, and `BoardNav.copilotTouched` keeps the ones
stamped with `actor` since the turn opened. The glyphs go the way the finished-turn indicator
does — on the next keypress — so one press acknowledges the whole turn. A copilot that names no
`actor` never glyphs anything.

The port is protocol-free on purpose: `@cabane/acp` implements it over an ACP harness, and a
test can implement it with a scripted async generator. `noCopilot` is an explicit no-op whose
every turn ends with `no copilot configured`.

## Marks and the copilot context

`m` toggles the row under the cursor (or the open task in the detail view) in and out of a
working set. Marked rows carry a `●` before the title and the header counts them (`· 3 marked`).
Marks survive every reload; `esc` on the board clears them first, then a committed search, then
widens the scope, one level per press.

`BoardContext` (`src/context.ts`) turns what the human is looking at into one value for a
copilot: scope, view, the selected task's section, the kind and status filters and any query,
the selected task, the marks oldest first, and the assembled briefs (what `y` copies) for the
selection and the marks. Each brief is capped at 6000 characters and the whole set at 24000;
the oldest marks are dropped first and `truncated` says when anything was cut. `project` and
`render` are pure; `load(basePath, state, scope)` fetches the briefs. `render` produces a fenced
`cabane-board` field block followed by the briefs under `### <shortId>` headings.

## Testing

`bun test` in this package. Rendering tests go through `src/testing.ts`, a headless OpenTUI test
renderer that captures character frames; nothing needs a real TTY. Storage tests use
`src/test-db.ts`, which configures the bun:sqlite provider with plain table names on a temp
directory. Key-driven flows (the `A` prompt against a scripted copilot) go through the test renderer's
`mockInput`; a lone escape must be rendered through before the next key, or the parser reads the
pair as Alt+key. Not covered here and left to a manual run: a real terminal's keyboard, mouse,
the clipboard writers, and OSC 52 through a terminal multiplexer.
