# @cabane/board

Terminal kanban for the Kabane tracker, built on OpenTUI. It reads the tracker through
`@cabane/core` and learns about the host's running work, its dispatch targets and its copilot
through three ports, so the same board runs standalone or inside another host.

## Start it

```ts
import { Runtime } from "@cabane/core";
import { SqliteDb } from "@cabane/sqlite";
import { startBoard } from "@cabane/board";

Runtime.configure({ provider: SqliteDb.provider() });
await startBoard({ cwd: process.cwd(), basePath: "~/.kabane" });
```

`startBoard(deps)` takes:

| Field | Required | Default behaviour when absent |
|---|---|---|
| `cwd` | yes | — |
| `basePath` | yes | — (the handle the configured `DbProvider` reads) |
| `activity: ActivitySource` | no | no badges, no header strip, no tabs beside the tracker |
| `dispatcher: Dispatcher` | no | `a` flashes `no dispatcher configured` in the footer |
| `copilot: Copilot` | no | `A` flashes `no copilot configured` in the footer |
| `resolveScope(cwd)` | no | the board opens on all scopes (the CLI passes `@cabane/core/scope` detection) |
| `headers: Record<kind, CardHeader>` | no | every card tab heads with the board's one-line title |
| `announcer: Announcer` | no | nothing is announced over the footer |
| `settings: SettingsSource` | no | `,` opens the settings view, which says settings are not available here |
| `open: { taskId }` | no | the board opens on the board view. Given, it opens on that task's detail, as `enter` on its row: the filter that holds it, its parent expanded, `esc` back to its row. `resolveScope` should answer the task's scope, as `kabane board --issue <id>` does. |

The host calls `Runtime.configure` before `startBoard`; the board never opens a database itself.

The board takes its colours from the terminal: before the first frame it asks for the foreground,
background and ANSI palette, and derives its surfaces and grays from them (`src/theme.ts`; a
terminal that does not answer gets DESIGN.md's dark or light ramp). It keeps following the
terminal while open. When the terminal reports a light/dark switch (DEC 2031) or a new palette,
`ThemeProvider` re-derives the tokens and every surface recolours, markdown included, without a
restart.

## Ports

### `ActivitySource`

```ts
interface ActivitySource {
  load(): Promise<Result<ActivityCard[]>>;
  card?(id: string): Promise<Result<ActivityCard | null>>;
  events?(id: string, afterSeq: number): Promise<Result<ActivityEvent[]>>;
  act?(id: string, actionId: string, input: { text?: string; lane?: string }): Promise<Result<string>>;
  dismiss?(id: string): Promise<Result<void>>;
  answering?(questionId: string): Promise<Result<void>>;
}
```

`load()` returns flat cards, newest first, already capped. A card carries `kind` (what the
header strip counts it as — the host picks the word, `"loops"`, `"runs"`), `label`, `status`
(`pending | running | paused | completed | stopped | failed`; `stopped` is over but not failed,
halted on purpose with why in `error`), an optional `taskId` or `taskShortId`, and `detail` lines
joined with ` · ` after the label. The board renders:

- a row badge for the first in-flight card of a task: `· ● loop · implement 3`, plus `· ● +n` for more
- a header strip counting in-flight cards per kind and the questions waiting: `· ⠹ 2 loops · 1 run · 1 input`
- a status line under the detail header for the first in-flight card, and an `activity` block listing all
- a tab of its own for a card with `tab: true` (below)

`card` and `events` are optional. When a card has `hasEvents: true` and the source implements
`events`, `o` in the detail view opens the event log, polled every second until the card leaves
the in-flight states. An event with a `callId` is a tool call's: a call and its end are one row,
closed until clicked, that opens on its `detail` (input, output, diffs). `t` in the event log, a
card's tab included, opens every tool row at once, the ones still to come too, and `t` again
closes them all; a click still opens or closes one row against it.

#### Tabs and the questions waiting on you

The top row is the tab bar. Tab 1 is the tracker (the board and every view pushed over it); then
one tab per card with `tab: true`, a new one opening at the end, several at once oldest first by
`startedAt`, labelled with the card's state glyph
and its `taskShortId` (else its `label`). The tab is the card's event log. A finished card keeps its
tab until `w` closes it, and a closed one does not come back: `w` also calls the source's optional
`dismiss(id)`, so a host that remembers it stops listing the card across a relaunch (without
`dismiss`, it stays closed for this session only). `{` and `}` walk the
tabs, wrapping; a click on a tab switches to it. Starting work does not switch tabs. Only the tab on
screen animates its spinner; a running card on another tab is the still `●`. A bar wider than the
pane keeps the tracker, the tab on screen and every tab with a `?n`, then what fits of the rest, and
counts the others in a `+n` cell.

Questions are core's, never the host's: every unanswered `question` activity `Planner.getNeedsInput`
returns, whoever asked it. A card says which are its own by listing the core `agent_session` ids
its work runs as in `sessionIds`. The tracker tab's `?n` counts every question; a card's tab counts
its sessions' questions.

`!` walks them all, oldest first, from any view; on the only question, already on screen, it says
nothing else is waiting. A question one of a tabbed card's sessions asked lands on that card's tab,
pinned under its header and answered there: a digit (or a click on an answer) answers it through
`Planner.answerQuestion`, which writes the answer and unblocks the session: a `decision`, naming
the question, the choice and who made it, or an `answer` for a tool permission request, which is
no decision and stays out of the brief. The tab shows its
sessions' oldest question first, with `+n more` for the rest, and says what was answered until the
next poll drops it and moves on to the next. `o` there opens the question's task for context, with
the question pinned over it. Any other question lands straight on its task's detail view, pinned
over it as a banner that answers the same way. While a question is pinned the digits are its alone:
one past its answers does nothing (`h/l` still walk the sections or lanes), and a shifted digit is
never one (a terminal that reports shift+1 by its base key means `!`). `b` on the banner goes back
to the card's tab when the question came from one. An answered banner says what was answered and
clears when you leave the view; an unanswered one stays pinned until it is answered. A question
that offers no answers (freeform), or whose asker allows a typed answer besides its answers
(`allowFreeform` in the question body), takes a typed one: `enter`, on its banner or on the card's
tab that shows it, opens the board's prompt (below), and what is sent goes to
`Planner.answerQuestion` as the answer. On a multi-select question (`multiSelect`) the digits, or a
click, toggle answers rather than sending one, and `enter` sends the toggled labels
comma-separated in the order picked (`Gamma, Alpha`), the form `kabane loop answer` takes. A
banner whose question left the queue without an answer from this board (answered elsewhere, or
withdrawn by its asker) reads `closed`. Every surface answers through the one `answerQuestion`
effect: marked answered on the keypress, so a second digit answers nothing, and taken back if the
write fails.

Core records who answered on the answer itself (`author`). Before it writes any answer, the board
also calls the source's optional `answering(questionId)`, so a host that keeps who answered of its
own (the loop notes the board's actor in its run's inbox) has it on record by the time its work sees
the answer. The id is core's, so a
merged source hands it to every contributor, and a host whose sessions did not ask it does nothing. A
failed note does not hold the answer back.

#### A card's header

```ts
type CardHeader = (props: { card: ActivityCard; width: number; expanded: boolean }) => ReactNode;
```

`headers`, by card kind, is the one seam that takes a component rather than data: a host's status
is its own design. A card tab whose card's kind has one draws it above the lane chips in place of
the board's one-line title (`loop · JREP-1 · running · 2m`). It is compact by default, and `e`
expands it (per card, kept across tab switches; the footer offers `e more` only where there is a
header). It renders inside the board's tree, so it reads the board's colors through the exported
`useTheme` and picks a session's color with `Theme.seriesOf`, the same one its lane chip and its
lines carry. `Headers.merge` keys several contributors' headers by kind and hands each its card under
the id its own source minted.

#### Card actions and the prompt

```ts
act?(id: string, actionId: string, input: { text?: string; lane?: string }): Promise<Result<string>>;
```

A card may list `actions` (`{ id, key, label, input?, lane? }`) the human can press on its tab; the
source's `act` runs them and resolves to the footer notice. The footer leads with them, and the `?`
sheet lists them as `this card`. The board's own keys on a card's tab come first and cannot be taken
(`h/l`, `j/k`, `g/G`, `e`, `o`, `w`, `q`, `t`, the digits, the everywhere keys), and `x` is reserved for the
action whose id is `STOP_ACTION` (`stop`), as it stops the copilot's turn on its transcript: `x` runs
it while the card is in flight, and does nothing on a card that offers none. An action passes the
lane on screen. One with `lane: true` is aimed at a single lane: the one on screen, else, on the
all-lanes view, one of the card's `liveLanes` (every lane when the host lists none). With one, it goes
there; with several, its prompt opens aimed at the first and `tab`/`⇧tab` walk the others; with none
the footer leaves it out. One with no prompt and several to choose from asks for a lane (`h/l`).

An action with `input` opens the prompt: the copilot's own input (`PromptField`, the same textarea,
bindings and `up` history as the copilot pane), in a raised panel above the copilot's row that says
what it is for (`message → JREP-2`), with `input` as its placeholder. While it is open it has
the keyboard: `enter` sends to `act` with the text, `⇧enter`/`ctrl+j` make a newline, paste works,
`up` on an empty buffer recalls what was sent from it before, `tab` aims it at another lane when it
has several, `esc` drops it, and a click on the board closes it.

#### Lanes on a card's tab

A card may split its stream into `lanes` (one per agent session, say), naming them with `laneNoun`
(`agents`), and tag each event with the `lane` it belongs to. Its tab then shows the lanes as chips
under the header: the first, `all agents · live`, is every lane at once and where the tab opens;
`h`/`l` walk them, wrapping, and a click on a chip picks it. On the all-lanes stream every line
carries its lane's tag in the lane's color, a categorical series from the theme that no status hue
or the accent is part of, chosen by the lane's place in `lanes` (so a host appends lanes and never
reorders them). A picked lane shows its own events and the ones on no lane. The lane on screen is
kept by name, per card, across tab switches. A card's tab follows its newest line until the human
scrolls up, and again once they scroll back down. Thoughts are dimmed under the agent's words.

### `Dispatcher`

```ts
interface Dispatcher {
  triggers(taskId: string): Promise<Result<TriggerDescriptor[]>>;
  dispatch(
    triggerId: string,
    target: DispatchTarget,
    inputs?: Readonly<Record<string, unknown>>,
  ): Promise<Result<string>>;
}
```

`a` opens a picker over `triggers(taskId)`: `j/k` or a digit select, `enter` fires a satisfiable
trigger, an unsatisfiable one flashes its `hint`. `dispatch` receives the task id, shortId, title
and the assembled brief (what `y` copies) and resolves to the footer notice.

#### The trigger form

A trigger whose every input has a `default` and either `options` or a `number` or `boolean` type
is filled in on the board before it fires: `enter` on it opens its form instead. Each input is a
row, called by its `label` (else its name) and filed under its `group`, a titled section, in the
host's order. `j/k` move between rows, `h/l` change the one in hand (the next or previous option,
wrapping; a number up or down, never below zero; a boolean on and off), a click focuses a row and
a second click changes it, `enter` fires with every value, and `esc` goes back to the picker. A
value still at its default is dimmed, and a changed one is bright with a `•` after it. `dispatch`
gets the values as its third argument, by input name; an option input's value is the option, as
written, so the host converts it back.

The trigger's `preview`, lines of toned parts (`{ text, tone?, bold? }`, the tone a role such as
`muted`, `working` or `accent`), sits at the centre with the settings in a column beside it, or
above them when the pane is under a hundred columns. A preview line too long for its room wraps:
the part that overflows breaks at a space or a comma and carries on under the column it started
at, so a list at the end of a line is read whole rather than cut. On a pane too short for both, the
preview keeps up to half the rows, its last line saying how many it leaves out, and the settings
scroll to keep the row in hand on screen.

### `SettingsSource`

```ts
interface SettingsSource {
  list(): Promise<Result<SettingRow[]>>;
  set(
    key: string,
    value: string | number | boolean | { unset: true },
    layer: SettingLayer,
  ): Promise<Result<SettingChange>>;
}
```

`,` opens the settings view over whichever view is on screen, and `,` or `esc` closes it. It
calls `list()` each time it opens, never at board start. A `SettingRow` is a row of
`kabane config list --json`: its `key`, the extension `namespace` that declares it (absent for
the device's own keys), its `value` (a secret already `<set>`), the `layer` it comes from
(`default`, `global`, `shared` or `local`) and the file it is in (`from`), what the layers
under it set there (`hides`), its schema `field`, how it reads (`label`, `group`, `none`), and
its `readOnly` and `protected` flags. The view is generated from the rows, so a namespace an
extension declares appears with no board code for it.

Rows sit under their namespace, then their group, in the order the rows first name them. A
group of settings is no row of its own, and a record with entries is listed by its entries
(`loop.gates.test`). Each row shows its label, its value (an unset one as its `none`), a mark
when it is read-only or protected, and the one word for its layer, `default` dimmed. In a pane
too narrow for both, the value keeps its room and the mark gives way. `j/k` move, and a click on
the row in hand opens or closes its detail under it: the key with its whole value, its
description, what its layer means and the file it is in, each value it hides with that layer
and file, and when a change applies. `enter` does the same on a row with no editor.

The view edits the row in hand. `h/l` step an enum, a boolean, or a single value with looked-up
steps (`options`), through `TriggerForm.step` like the run form. `enter` starts editing: on a
string or a number it types the value, read with `FormField.read` against the field's bounds, and
a value it refuses shows its reason under the field and is not saved; on a list of strings,
numbers or enum values it types the whole list, items apart by commas as `kabane config set`
reads them, each checked against the list's `options` when it has any, and an empty text saves an
empty list; on a boolean, an enum, or another value with steps it opens the editor on the current
value, for `h/l`. On a row with no editor,
such as a `readOnly` one, `enter` opens or closes its detail. `x` removes the
key from a layer; a record's entries are added and removed with `kabane config set`. The editor
opens on the row's `target`, the layer a write that names none goes to, and `tab`/`⇧tab` walk
the row's `layers`, each said with what it means. A secret is typed masked and never prefilled.
A save to `shared`, or to a `protected` key, asks `y/n` first; a `readOnly` key has no editor.
`enter` saves through `set()`. The rows are then listed again, and the saved row says the layer
and value written (`SettingChange`), the layer that `shadowedBy` says still decides, the layer an
unset `fallsBackTo`, and, for `restart: "start"`, that the change applies at the next start. A
refused save keeps the editor open with the host's reason.

### `Copilot`

```ts
interface Copilot {
  run(prompt: string, context: BoardContext.Context): AsyncIterable<CopilotUpdate>;
  cancel(): Promise<void>;
  shortcuts(): CopilotShortcut[];
  answerPermission(id: string, optionId: string | null): void;
  answerElicitation(id: string, answer: CopilotElicitationAnswer): void;
  readonly actor?: string;
}
```

The copilot is a PANE above the footer, always mounted, never a modal: one status row when it is
not focused, a bordered panel when it is. `tab` and `⇧tab` move focus between the view and the
copilot; `A` (or `:`) jumps straight to it. Its title carries a chip
saying what the prompt carries (`JCAB-31 · 3 marked · inbox`), and because the buffer outlives a
focus change you can type half a prompt, tab to the board, mark three more rows, and tab back to
find the chip updated under you.

The input is an OpenTUI `<textarea>`, so paste, word motions, `ctrl+w` and undo all work; `enter`
sends, `⇧enter` and `ctrl+j` make a newline. The textarea owns the buffer and `copilot.text`
mirrors it — `BoardNav.copilotConsumes` names the keys the reducer takes back from it, and app.tsx
`preventDefault`s exactly those. `esc` and `tab` are both plain exits — `esc` to the board, `tab`
to the next pane — and neither touches a running turn: `esc` is the back key in every other view
and destroys nothing anywhere on the board. Typing `/` lists `shortcuts()` (`/triage`, `/refine`, …)
as a palette; `tab`, or `enter` on the exact name, expands the `template` so what will be sent is
read before it goes. Once the session is open the harness's own commands follow them, from its
latest `commands` update (`{ type: "commands", source, commands }`, each `{ name, description,
hint? }`), each hint led by the harness's name (`/compact  claude · …`). Picking one puts `/name `
in the input, and the prompt goes to the harness as written, with no board context ahead of it,
since the command is the harness's to run. The palette shows eight rows around the pick and says
where it is in a longer list. `↑` on an empty buffer walks back through this session's prompts.

The turn runs in the background and the board stays fully interactive. Submitting hands the
keyboard back to the board, because the next thing after sending a command is watching it. The
pane's row shows `⠹ copilot · 2/5 · <last tool call>` while it runs — the count is the agent's own
plan — `✓ copilot · <the agent's last line>` when it ends, `✗ copilot · <reason>` on an error or a
cancel; the finished indicator stays until the next keypress, which also clears the `✦ ai` glyphs.

A `usage` update (`used` of the window's `size` tokens, and the session's `cost` where the harness
reports one) is the session's reading of its context window, kept across turns. Every footer ends
on it, muted and right-aligned, as `ctx 42%` or `ctx 42% · $0.31` (`CopilotLog.usageLabel`,
provided once through `FooterTrail`). It shows only where it fits whole beside the hints or the
notice, so at forty columns it is the first thing to go, and before the first reading it is absent.

Exactly one surface animates per fact: the pane owns the copilot, the tab on screen owns its card,
and every echo of a running thing renders `●` rather than a frozen spinner frame (see `spinner.ts`). `run` yields `CopilotUpdate`s (`text`, `thought`, `tool_call`, `tool_result`,
`mode`, `error`, `done`, `notice` with a `severity` of `info`, `warning` or `error`, the `commands`
list above, and `usage`). A tool call is a `tool_call` and then its end, `tool_result` or
`tool_failed`, both carrying the call's `callId` and its `detail` (ACP's raw input, output and
diffs, capped by `ToolCalls.detail`), so the transcript folds them into one row that opens on the
real tool, its input and its diff, the way the loop's do. An end marked `wrote` (a call to one of
kabane's write tools) reloads the board, so the copilot's writes appear as they land. A notice is a line of the turn's
transcript and changes nothing else: a `notice` event carrying its `severity`, which the event view
draws as `!` in the accent for a warning, in the failed hue for an error, and muted for information.
The loop's notices carry theirs as a `<severity>: ` prefix and its own warnings as the event type
`warning`, which read the same way. One turn at a time: while one runs the input reads `a turn is running · send when it ends`
rather than inviting a prompt, and `enter` flashes `a turn is running · o for its transcript, x
there stops it` instead of dropping what was typed — the draft keeps until the turn ends.

The turn also appears as an in-memory activity card (`kind: "copilot"`). The header strip neither
counts nor animates it: the pane owns the turn. `o` — from the board once the session has a transcript at all, from the detail
view while the indicator is up, the task's own events otherwise — opens the event view on it: prose as text lines, thoughts dimmed, tool calls with the usual glyphs, the last few turns
oldest-first each under the prompt that started it. `x` there is the ONE key that stops a running
turn; `esc` returns. The pane's row names `o` wherever there is a transcript to open, because the
board's footer is trimmed to the board's own keys. Nothing is persisted: the log is a session
buffer capped at the last few turns and gone when the board closes.

A harness that stops mid-turn to ask before doing something yields a `permission` update, and the
turn is blocked until it is answered. The choice is shown on exactly one surface: the transcript
when it is open on the copilot's card, the copilot pane's one row everywhere else — the pane being
the only copilot surface present in every view, so a board with no transcript open still sees that
something is waiting. A digit picks the option it numbers, `esc` declines, and both go straight to
`answerPermission` ahead of whatever view is on screen. The board never answers by itself and there
is no timeout: a question left alone keeps the turn waiting, and `x` on the transcript still
cancels it.

A harness that asks the human to fill in a form (Claude's AskUserQuestion, codex's
`request_user_input`) yields an `elicitation` update: the harness's `message` verbatim and its
`fields`, each `text`, `number`, `boolean`, `choice` or `choices` (a multi-select), with a title,
an optional description and whether it is required. It opens the copilot panel, focused or not
and over the transcript too, in place of the input, and is filled in one field at a time
(`elicitation-form.ts`): a digit picks a choice, digits toggle a multi-select and `enter` confirms
it, `y`/`n` answer a boolean, and text or a number is typed into a one-line input and sent with
`enter`. `enter` leaves an optional field empty, and an empty field is absent from the answer,
never filled in. An answer the field does not take (a number out of its bounds, too long a text) is
refused with why, and the field asked again. `esc` declines the whole form from any field. Once the
last field is answered the board calls `answerElicitation(id, { action: "accept", content })`, or
`{ action: "decline" }`. Permissions and forms share one queue, answered in the order the harness
asked; while a session question on the view outranks the copilot, the pane's row names the form and
`tab` to reach it. A form's typed field keeps every key but `esc` from the board while its input is
in hand, so typing never moves the board under it; each field arms the digits afresh, so a key
already on its way when one field moves on does not answer the next.

A harness can take a permission or a form back before anyone answers it (ACP's
`$/cancel_request`). The copilot yields `{ type: "withdrawn", id, summary }`: the request leaves
the queue wherever it was in it, its block goes, the transcript keeps `withdrawn by the harness:
…` where the question was, and the footer says so when it was the one on screen. A key pressed in
the instant before the redraw answers nothing, because the copilot no longer holds the request.

The board also tells the terminal when it is waiting on you, through OSC 7501
(`renderer.setProgramStatus`, `src/program-status.ts`). One root record for the board: `blocked`
(kind `permission` or `question`, none when they differ, message `N need input`) while a copilot
permission or form, or any session question the board lists, waits on the human; else `working`
while a copilot turn or a host card runs; else cleared. Under it, one record per card with
something pending (the copilot's turn, a host card running or waiting on one of its sessions'
questions), by the card's id, hashed when the protocol would not take it. Everything is derived
from board state in one pure function and written only when it changes, and the root is cleared,
taking every record under it, once the renderer has let go of the terminal on exit. A terminal that
does not implement the protocol ignores all of it.

Rows the copilot changed during the turn carry `✦ ai` before the title: the reload after each of
its writes brings the fresh `updatedBy`/`updatedAt`, and `BoardNav.copilotTouched` keeps the ones
stamped with `actor` since the turn opened. The glyphs go the way the finished-turn indicator
does — on the next keypress — so one press acknowledges the whole turn. A copilot that names no
`actor` never glyphs anything.

The port is protocol-free on purpose: `@cabane/acp` implements it over an ACP harness, and a
test can implement it with a scripted async generator. `noCopilot` is an explicit no-op whose
every turn ends with `no copilot configured`.

Ask the ACP copilot to triage issues, refine briefs, split work, find duplicates or check a plan.
It reads the project's code, docs and history to ground briefs in real files and commands.
It can also:

- Pull a Linear or GitHub issue into a local brief, or file a team issue from one and link it back
  (`/linear`, `/github`). The harness needs a Linear MCP server or `gh` access, respectively; a
  missing one is reported rather than worked around. Kabane holds no provider credentials and
  makes no network call of its own.
- Explain commands and board keys, change Kabane settings, or enable an official extension
  (`/setup`). A device setting, enabling an extension included, applies once the board restarts;
  an extension's own setting (`loop.*`) applies the next time it is read, with no restart.
  Enabling loop does not start a run.
- Create a dispatch skill tailored to the project's conventions (`/setup-dispatch`), showing
  what it wrote and asking before replacing an existing skill.
- Start a loop run when asked, such as “run this issue with codex”, with the loop extension
  enabled. A run handles a single issue or a parent's subtasks; follow it in its board tab.

The copilot manages the tracker and setup; the loop's coding sessions make the code changes.

## An issue's detail

The detail pins the issue at a glance above four sections, `1`-`4` or `h`/`l` to switch:

- `now`: what is in force while the work runs, the part a glance between edits wants. The
  checklist, the newest entry of each kind the brief lifts as a digest (below), the decisions
  made and the subtasks, in that order. A part with nothing in it takes no room.
- `description`: the ask, read when the issue is picked up. The description and the curated
  context.
- `comments`: the whole timeline, newest first.
- `log`: the host's cards, then the work logged and what agent sessions said.

The detail opens on `now` when it has anything in it, otherwise on `description`; a section with
nothing in it is faint in the bar. The section it opened on, or the one you picked, stays when a
change lands while it is open: a checklist added to an issue you are reading the description of
does not move you.

What lands while the detail is open is marked where it landed instead. Within one poll of a new
handoff, a tick, a decision made or a subtask moving, that part's header on `now` reads
`✦ checklist · 2/3`, `✦ handoff · claude · just now`, and while you are on another section the
bar reads `✦ now`. A mark goes once its header has stayed on screen with `now` showing for
three seconds, or when the detail closes. A tick or an answer you make from this board is not
marked, nor is anything on the issue's first load. A new comment marks nothing: the comments
count already moves.

The section scrolls with the keys every scrolling view shares, the `?` sheet and the transcript
included: `j/k` (or the arrows) two rows, `ctrl+d`/`ctrl+u` half the viewport, `g`/`G` the top
and the end.

## Decisions agents file

An agent that needs a human's call on an issue files it with `kabane_ask` (`@cabane/questions`):
the question, its choices, the one it recommends and why, and the issue goes to `waiting`. The
board reads these through `Questions.list` when the host registered the questions module (the CLI
does; a host that did not shows none). They are not the `!` queue, which stays the live sessions'
own questions: a decision waits for whenever the human gets to it.

Each row with open decisions counts them in the accent, `· ?2`. `u` narrows the board to those
issues (a subtask's parent stays as its heading), the header says `· decisions`, and `u` again or
`esc` (above) takes it off. The footer offers `u decisions` while any loaded issue has one.

An issue's detail asks its open decisions under the header, one at a time and oldest first, with
`n more waiting` while others queue behind. It is the copilot's form (above), not a second one: a
decision is a single choice or a multi-select over its choices, the recommended one marked `★`,
then an `Other` box when the agent takes a typed answer (the whole answer when it offered no
choices), then an optional reasoning line, with `why` under the question. The keys are the
form's: a digit or `enter` picks, `space` toggles and `enter` sends a multi-select, `s` leaves
the choices for the Other box, and `enter` in a text field sends it, empty to skip. On a single
choice a typed Other is the answer; on a multi-select it joins the picks. The answer goes to
`Questions.answer`, judged by `validateAnswer` as `kabane_answer` judges it; one that cannot be
read (nothing picked, nothing typed) is refused with why and asked again from its first field.

While a decision is on screen it has the keys it names, ahead of the view's: the digits answer it
rather than switching sections, and `↑↓` move its cursor. Every other key works as before (`h/l`,
`j/k`, `v`, `q`). A decision that opens on a text field waits for `enter` before its input takes
the keys, so opening such an issue does not type into it; once a decision is under way, its text
fields take every key but `tab`. `esc` starts a decision under way over, and on an untouched one
goes back to the board. It outranks the copilot's own ask the way a pinned session question does:
the copilot's row says `tab to answer`, and while the copilot has the keys the decision says `esc
to answer · the copilot has the keys`. A session question pinned over the view comes first, with
one row saying how many decisions wait behind it.

Once answered, the footer says `JREP-7:1 answered`, and `· JREP-7 → next` when it was the last
and moved the issue on. The `now` section lists the decisions made, like the brief:
`question → answer (who, reasoning)`. Withdrawn ones are not shown. A click on an answer or a
key hint does what its key does.

## Checklists

An agent or a shell breaks one change into steps with a checklist (`@cabane/checklist`:
`kabane_checklistAdd`, `kabane checklist add`). The board reads it through `Checklist.progress`
and `Checklist.list` when the host registered the checklist module (the CLI does; a host that did
not shows none). It adds no items: agents and the CLI do.

Each row with items says how far they have got, `· 2/5`, muted beside the `· ?N` badge, and in
the done hue once every item is ticked (`· 3/3`). The counts come from one query on every poll.

The `now` section lists the items first, headed `checklist · 2/5`: `✓` for a ticked
one, `○` for an open one, one line each. A cursor sits on the first open item, where a loop
resumes. Opening `now` scrolls the cursor's row into view; a scroll after that leaves the cursor
where it is. `J/K` move it and `space` ticks or unticks the item under it, as `kabane_checklistTick`
does, bringing it into view in the same press when it is off screen; the item shows the press at once, the footer says `JREP-8.3 ticked · 3/5`, and a write that
fails puts the item back to the state the store last acknowledged, with why. An item's writes go one
at a time: presses while one is in flight leave only the latest queued behind it, and a poll's
records never take back a press still being written. A click on an item toggles it the same way. These keys work
only on `now` with the board holding the keys, and a decision on screen keeps
`space` for its own multi-select.

A tick leaves the task row alone, so nothing on the row says it changed. The poll reads the
progress beside the rows, and the open detail's stamp (`BoardData.detailStamp`) counts the items
and their newest change, so a tick made in a shell or by an agent shows on an open board within
one poll.

## Timeline entries

An issue's timeline holds entries of a kind: a plain comment, a handoff (`@cabane/handoff`), or
any kind a writer names (`kabane comment <id> "…" --kind review`). The board reads them all with
`Planner.getEntries` and writes none.

The comments tab is the whole timeline, newest first. An entry that is not a plain comment names
its kind in its band, between the author and the time: `claude · handoff · 2h ago`. A kind no
registered module declares is named the same way; a plain comment's band reads `ada · 2h ago`.
A band is one row and never wraps: when it is too long for the pane, the author's name is cut with
`…` first, so the kind and the age stay whole (`claude-sonnet-4… · handoff · just now`).

The `now` section shows what the brief lifts. For each kind a registered module projects as
`latest` (the handoff), the issue's newest entry of that kind sits under the checklist as a
digest: one line with the kind's title, its author and its age (`handoff · claude · 2h ago`), the
kind's framing line muted, then the body read as markdown sections. The text before the first
heading and the first section show rendered, the first heading behind `▾`, held to about eight
rows at forty columns (more of it fits a wider pane) with `… 6 more lines` for what that leaves
out. Every further heading at the body's top level is one line with its size, never its content:

```
▾ Summary
The wave is merged on local main at
1519458, not pushed. …
… 6 more lines
▸ Evidence · 7 lines
▸ Not verified · 8 lines
▸ Risk · 1 line
```

Headings are read from the text, `##` or `###` alike, never checked against the kind's template;
a `#` line inside a code block is code. A body with no headings shows its first paragraph and how
many lines follow. `1 earlier in comments` says when there are older entries of the kind; the
comments section has every entry whole. The kinds come from the host's registered modules, so a
host that registered none lifts nothing, and an issue with no such entry shows nothing for it. A
new entry moves the open detail's stamp, so a handoff recorded in a shell shows within one poll.

`r` on the detail, from any section, opens the reader: each lifted kind's newest entry in full,
in the same order, over the detail. The footer names it after the kind (`r read handoff`), or
says `r read` when an issue has entries of several lifted kinds, and leaves it out when there is
nothing to read. In the reader, `j/k` scroll, `[` and `]` move to the previous and next heading
across the entries (headings read as the digest reads them), `?` lists these keys, and `esc` or
`q` close it onto the detail at the section and scroll you left. A newer entry that lands while
the reader is open replaces the one on screen, and the heading you were at stays where it was;
when the newer entry has no heading of that name, the reader goes back to the top.

## Linked issues

A task can point at one issue in an external tracker. The row says only that it does, with a gray
`◆` in the gutter beside the mark: which issue it is belongs to the detail view, whose brief
carries the line `assembleContext` writes. Sixteen columns of ` · linear ENG-123` on every linked
row is not a trade this board makes — it is read in a narrow split beside an editor.

`O` opens it (`o` is the event log: lowercase looks inward at this task, uppercase outward at the
team's). The chain is the desktop app's scheme, then the web URL, then the clipboard — the last
leg is what keeps the key useful over ssh, where there is no opener. With several links the first
opens; the detail brief lists them all. The footer offers `O` only while the row under the cursor
has somewhere to go.

Every copy (`y`, and that last leg) goes through OpenTUI's clipboard (`src/clipboard.ts`). On a
local session it writes the machine's own pasteboard, and sends OSC 52 only when there is none. On
a remote one (ssh) it sends only OSC 52, so the text lands in the human's own terminal and the
remote machine's pasteboard is never written. The footer flashes what happened, or
`copy not supported by this terminal`. `kabane open` has no renderer, so its copy is the host's
pasteboard or nothing.

Nothing here creates a link: that is `kabane upstream link`, or the copilot, which can read the
external issue and write what matters into the task's own description. `Launcher` (`src/launcher.ts`)
is exported so the CLI's `kabane open` walks the same chain.

## Marks and the copilot context

`m` toggles the row under the cursor (or the open task in the detail view) in and out of a
working set. Marked rows carry a `●` before the title and the header counts them (`· 3 marked`).
Marks survive every reload; `esc` on the board clears them first, then a committed search, then
the decisions filter (`u`), then dismisses the host's announcement, then widens the scope, one
level per press. A click on the announcement dismisses it too, and leaves the keys where
they were.

`BoardContext` (`src/context.ts`) turns what the human is looking at into one value for a
copilot: scope, view, the selected task's section, the kind and status filters and any query,
the selected task, the marks oldest first, and the assembled briefs (what `y` copies) for the
selection and the marks. Each brief is capped at 6000 characters and the whole set at 24000;
the oldest marks are dropped first and `truncated` says when anything was cut. `project` and
`render` are pure; `load(basePath, state, scope)` fetches the briefs. `render` produces a fenced
`kabane-board` field block followed by the briefs under `### <shortId>` headings.

## Testing

`bun test` in this package. Rendering tests go through `src/testing.ts`, a headless OpenTUI test
renderer that captures character frames; nothing needs a real TTY. Storage tests use
`src/test-db.ts`, which configures the bun:sqlite provider on a temp
directory. Key-driven flows (the `A` prompt against a scripted copilot) go through the test renderer's
`mockInput`; a lone escape must be rendered through before the next key, or the parser reads the
pair as Alt+key. Not covered here and left to a manual run: a real terminal's keyboard, mouse,
the host's pasteboard, OSC 52 reaching a real terminal (over ssh or through a multiplexer), and a
real light/dark switch.
