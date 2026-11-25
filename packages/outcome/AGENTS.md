# @kabane/outcome

A data module with no table: it declares the four session outcome kinds and their templates.
Core stores them as timeline entries and renders all four in Discussion. `README.md` lists
the kinds and their templates; keep it aligned with `module.ts`.

## Verify

```bash
bun test packages/outcome
bun run layers
bun run --cwd packages/worker test
```

A new kind needs its declaration, template,
README row and a test that writes it through `Planner.addEntry` and reads it in the brief.
