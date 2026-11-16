# @cabane/outcome

A data module with no table: it declares the four session outcome kinds and their templates.
Core stores them as timeline entries and renders all four in Discussion. `README.md` lists
the kinds and their templates; keep it aligned with `module.ts`.

## It depends on core alone and both hosts register it

Its layer is `data module`; its entry in `scripts/layers.ts` says what it may list. The CLI
(`MODULES` in `packages/cli/src/context.ts`) and hub (`packages/worker/src/hub.ts`) register
`outcomeModule` immediately after `handoffModule`. Handoff remains that module's kind.

Read before writing: `module.ts`, `module.test.ts`, and core's AGENTS.md, "Timeline entries".
No session stream or question storage belongs here: the loop keeps its sessions and questions
in its own run directory, and core keeps no session table.

## Verify

```bash
bun test packages/outcome
bun run layers
bun run --cwd packages/worker test
```

Tests use real SQLite through core's test runtime. A new kind needs its declaration, template,
README row and a test that writes it through `Planner.addEntry` and reads it in the brief.
