# @kabane/board

A client: the terminal kanban, in React over OpenTUI. It reads the record through core and the
data modules and learns everything else from ports a host hands to `startBoard(deps)`. Each port
has a no-op default, so the board runs with none. `README.md` describes every port and view; read
the section for the one you change. `DESIGN.md` at the root holds the visual rules and the theme's
ramps.

It never opens a database or runs SQL against a table: it reads through the exports of core and
the data modules, as a second client would have to (`ARCHITECTURE.md`, "A client uses only what
another client could"). Base kabane's copilot text and setup screen name no extension: an
extension's how-to is a skill `kabane mcp` serves, never text in `systemPrompt`.

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
- Adding to `src/ports.ts` a type an extension produces. That type belongs in
  `@kabane/extension/ports.ts`; the board imports it from the contract.
