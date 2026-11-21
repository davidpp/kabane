# @kabane/board

A client: the terminal kanban, in React over OpenTUI. It reads the record through core and the
data modules (`src/data.ts`, `BoardData`) and learns everything else from ports a host hands to
`startBoard(deps)` (`src/start.tsx`): `ActivitySource`, `Dispatcher`, `JobSource`, `Copilot`,
`SettingsSource`, `Announcer`, `OpenRequests`, card headers and `resolveScope`. Each port has a
no-op default, so the board runs with none. `README.md` describes every port and view; read the
section for the one you change. `DESIGN.md` at the root holds the visual rules and the theme's
ramps.

## It reads through exports only, as a second client would have to

Its layer is `client`; its entry in `scripts/layers.ts` (`"@kabane/board"`) says what it may
list. It never imports the CLI or an extension, never opens a database (the host calls
`Runtime.configure` before `startBoard`), and never runs SQL against a table: it calls `Planner`
and the data modules' exports (`ARCHITECTURE.md`, "A client uses only what another client
could"). `@kabane/sqlite` and `@kabane/handoff` are `devDependencies` for tests and stories.

The CLI imports the board (`startBoard`, `startSetup`, `BoardCopilot`, the `Activity`,
`Dispatchers` and `Headers` merges, `Launcher`). Nothing below this client imports it.

`@kabane/extension` owns the activity, dispatch, header, panel, settings field and shortcut
port types; `@kabane/acp/form-field` owns form types and validation. `src/ports.ts` keeps the
board-only ports and no-op defaults. `src/copilot.ts` implements `BoardCopilot` over ACP;
`src/mailbox.ts` and `src/copilot-instructions.ts` support it. The host supplies `kabaneBin`.
`ActivitySource.questions` supplies agent questions and `answer` records their answers; the board
does not read or answer them through core, which keeps no session: a session is a `session:` ref
in the work log and its outcomes are timeline entries.
`Header` returns data: `src/card-header.tsx` polls it and lays out its rows, sharing tone mapping
with trigger previews. Base kabane's copilot text and setup screen name no extension: an
extension's shortcuts arrive in `CopilotInstructions.Setup`, read by the host from its files, and
its how-to is a skill `kabane mcp` serves, never text in `systemPrompt`.

Where things are drawn: `src/app.tsx` holds the state and wires the ports; `src/board.tsx` is
the board view, one row per card; `src/detail.tsx` an issue's detail; `src/tab-bar.tsx` and
`src/event-view.tsx` a card's tab and its events; `src/jobs.ts` and `src/jobs-view.tsx` the
Jobs tab, whose rows live in `tabs.jobs` and whose detail is the tracker's with `JobPanel` in it;
`src/footer.tsx` the footer.

Read before writing: `src/ports.ts`, a small component with its test and story
(`src/plan-block.tsx`, `src/plan-block.test.ts`, the `plan` story in `src/stories/index.tsx`),
and `src/theme.ts` before choosing a color.

## Verify

```bash
bun test packages/board                      # headless renders through src/testing.ts
bun run gallery --print plan --width 40 --theme light --ansi
```

Then drive the flow in the real board under tmux, as the root `AGENTS.md` shows under
"Validating a UI change". Check the tracker, the detail and the jobs tab at 40 columns first:
`DESIGN.md` makes forty their design target. A run's card tab is designed at 200×50 and splits
from 160 columns (`src/cockpit.ts`): check it at 200×50, at 160 and 159, and at 40 as the
fallback, with a short pane (100×22) to see the footer stay.
Mouse, the host's pasteboard, OSC 52 over ssh and a real light/dark switch are manual checks.

## Mistakes that are easy to make here

- A key bound in one place only. Reducers in `src/nav.ts` bind keys; `src/keymap.ts` is the one
  place hints are written, and `keymap.test.ts` fails a hint that no reducer acts on.
- A hex color outside `src/theme.ts`. Every color comes from the theme's tokens (`useTheme`),
  which follow the terminal's palette and its light/dark switch, and a test fails on a hex
  literal elsewhere (`DESIGN.md`).
- Adding to `src/ports.ts` a type an extension produces. That type belongs in
  `@kabane/extension/ports.ts`; the board imports it from the contract.
