# @cabane/extension

The shared contract for extension commands, board ports, settings and doctor checks.

## Factory host

Import `Extension` and `Host` with `import type` from `kabane/extension`. The published
package exports types only, including named record, command, settings, board and doctor
types and the reachable core and zod types; no `@cabane/*` package or additional type dependency is required.

The factory receives API 1 with `kabane.version`, `kabane.executable`, `record`, `scope`,
`harnessMode`, `z`, `defineTool`, and the `result`, `args`, `outcome` and `settings` helpers.
Build settings and tool schemas with `host.z`, even when the extension installs its own zod.

`host.record` wraps MCP operations with validated inputs and full, unserialized results.
Its named methods document their corresponding tools; `call(name, input)` also reaches
registered data-module tools, passes its input unchanged (including pagination cursors),
and returns `Result<unknown>`. Calls use the invocation’s actor and the device’s human actor.
Record methods return a stage error until the database is configured and migrated and the
host’s factory has returned. Use them from regular commands, board ports, tool handlers,
or doctor checks when doctor opened the store. Standalone extension commands do not open
the store. Scope detection and helpers are ready in the factory. Harness configuration
exposes only the mode, never sessions.

## Doctor checks

An extension can provide `doctor(ctx)`, returning `Doctor.Finding[]` or a
`Result<Doctor.Finding[]>`. The host runs enabled sources in display order. Checks finish before any fixes run. A thrown or returned
check error becomes a `mention` finding named `check-failed` for that source.

Each finding has a stable kebab-case `id`, unique within its `source`, a `summary`,
and a severity:

- `auto`: a mechanical repair, eligible for `fix: true`.
- `mention`: something the human should know.
- `suggest`: an available improvement, applied only when explicitly named.
- `route`: a judgement call, with copilot instructions in `route`.

A finding may attach `fix: () => Promise<Result<string>>`. Without `fix` options,
the runner only reports. `fix: ["source/id"]` selects exactly those findings,
regardless of severity; a finding without a fix remains informational. The report
contains `findings` and `fixes`, each attempted fix carrying its source, id and
result. Failed fixes do not stop later fixes. `Doctor.toJson(report)` removes
closures, adds `fixable`, and turns fix errors into message strings.

The host’s settings diagnostics report unknown and retired keys
without changing the raw layer. Its IDs include category, layer and full setting
path, escaping characters that would otherwise collide. It follows the same Zod
preprocessing as settings validation. A dropped key is a `mention`; when a newly
added, declared sibling has the same JSON value, it infers a rename and reports
`auto`. That inference is a heuristic, not a migration guarantee. The caller owns
storage and attaches any repair closures; drift detection does not write files.

`ports.ts` exports the activity, dispatch, header, panel, settings field and copilot shortcut
types through `@cabane/extension`. `StopAction` is the literal type `"stop"`; consumers use
their own constant. The contract has no dependency on the board.
