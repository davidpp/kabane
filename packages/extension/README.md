# @cabane/extension

The shared contract for extension commands, board ports, settings and doctor checks.

## Doctor checks

An extension can provide `doctor(ctx)`, returning
`Result<Doctor.Finding[]>`. Call `Doctor.run(sources, ctx, options)` with the enabled
sources in display order. Checks finish before any fixes run. A thrown or returned
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

`Settings.drift(schema, raw)` returns unknown or retired keys as structured path
segments, plus an inferred replacement path when preprocessing introduces a declared
sibling with the same JSON value. It never changes the raw layer. This inference is
a heuristic, not a migration guarantee. The storage owner constructs findings and
chooses severity and any repair; inferred renames alone are informational.
