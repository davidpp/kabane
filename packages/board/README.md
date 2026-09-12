# @cabane/board

Terminal kanban for the Cabane tracker, built on OpenTUI. It reads the tracker through
`@cabane/core` and learns about the host's running work and dispatch targets through two ports,
so the same board runs standalone or inside a host like Jake.

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
directory. Not covered here and left to a manual run: real keyboard input, mouse, the clipboard
writers, and OSC 52 through a terminal multiplexer.
