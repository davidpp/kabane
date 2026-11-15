# @cabane/board

A client: the terminal kanban, in React over OpenTUI. It reads the record through core and the
data modules (`src/data.ts`, `BoardData`) and learns everything else from ports a host hands to
`startBoard(deps)` (`src/start.tsx`): `ActivitySource`, `Dispatcher`, `Copilot`,
`SettingsSource`, `Announcer`, `OpenRequests`, card headers and `resolveScope`. Each port has a
no-op default, so the board runs with none. `README.md` describes every port and view; read the
section for the one you change. `DESIGN.md` at the root holds the visual rules and the theme's
ramps.

## It reads through exports only, as a second client would have to

Its layer is `client`; its entry in `scripts/layers.ts` (`"@cabane/board"`) says what it may
list. It never imports the CLI or an extension, never opens a database (the host calls
`Runtime.configure` before `startBoard`), and never runs SQL against a table: it calls `Planner`
and the data modules' exports (`ARCHITECTURE.md`, "A client uses only what another client
could"). `@cabane/sqlite` and `@cabane/handoff` are `devDependencies` for tests and stories.

Who imports the board today: the CLI (`startBoard`, `startSetup`, the `Activity`, `Dispatchers`
and `Headers` merges, `Launcher`), the loop (`@cabane/board/ports`, `/form-field`, `Theme` for
its card header), and, through named exceptions, `@cabane/extension` and `@cabane/acp`
(`/ports`, `/context`).

JCAB-320 changes this package's shape: port types leave `src/ports.ts` and `src/form-field.ts`,
the copilot arrives from `@cabane/acp`, and `CardHeader` becomes data the board lays out.
`ARCHITECTURE.md`, "Ports", says what moves where; check main before editing those files or a
card header. JCAB-324 removes the text in `src/setup.tsx` that offers to turn on the loop.

Where things are drawn: `src/app.tsx` holds the state and wires the ports; `src/board.tsx` is
the board view, one row per card; `src/detail.tsx` an issue's detail; `src/tab-bar.tsx` and
`src/event-view.tsx` a card's tab and its events; `src/footer.tsx` the footer.

Read before writing: `src/ports.ts`, a small component with its test and story
(`src/plan-block.tsx`, `src/plan-block.test.ts`, the `plan` story in `src/stories/index.tsx`),
and `src/theme.ts` before choosing a color.

## Verify

```bash
bun test packages/board                      # headless renders through src/testing.ts
bun run gallery --print plan --width 40 --theme light --ansi
```

Then drive the flow in the real board under tmux, as the root `AGENTS.md` shows under
"Validating a UI change". Check at 40 columns first: `DESIGN.md` makes forty the design target.
Mouse, the host's pasteboard, OSC 52 over ssh and a real light/dark switch are manual checks.

## Mistakes that are easy to make here

- A key bound in one place only. Reducers in `src/nav.ts` bind keys; `src/keymap.ts` is the one
  place hints are written, and `keymap.test.ts` fails a hint that no reducer acts on.
- A hex color outside `src/theme.ts`. Every color comes from the theme's tokens (`useTheme`),
  which follow the terminal's palette and its light/dark switch, and a test fails on a hex
  literal elsewhere (`DESIGN.md`).
- Adding to `src/ports.ts` a type an extension produces. Under JCAB-320 that type belongs in
  the contract; add it there or say in the handoff why it waits.
