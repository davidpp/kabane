# @cabane/recipes (extensions/recipes)

The recipes extension: prompt recipes from a project's `.kabane/recipes/`, `kabane run` to start
one in an `hc` (herdr core) terminal, and `kabane runs` to list, read, answer, attach to and stop
those runs. `docs/recipes.md` is what a user reads.

| Where | What it holds |
|---|---|
| `src/extension.ts` | the `(host) => Extension` factory: the `recipes.harness` setting, both commands, the `hc-missing` doctor finding |
| `src/recipe.ts` | `Recipe.parse`, `load`, `all`, `render`: frontmatter, placeholders, and the errors that name the file |
| `src/inputs.ts` | `Inputs.resolve`: `--input` pairs, the JSON object, defaults, the terminal prompts, validation with `host.z` |
| `src/run-command.ts` | `startRun`, which starts a recipe from explicit inputs (scope, root, dir, recipe, target, inputs, harness, actor) and reads no cwd, TTY or setting; `kabane run`, which resolves those and calls it. Export it when a second caller needs it |
| `src/runs-command.ts` | `kabane runs`: the listing and its reconcile, `attach`, `read`, `send`, `stop` |
| `src/runs.ts` | the run row and its table, `recipes_runs`; the only file that knows where a run is stored |
| `src/runtime.ts` | the `Runtime` interface: `start`, `get`, `stop`, and the optional terminal operations `read`, `send`, `attach` |
| `src/runtime-hc.ts` | the hc runtime; the only file that runs `hc` |
| `modules.ts` | the modules entry: registers the run table, imports only `src/runs.ts` |

## It takes types from kabane and no value

Its layer is `extension`; its entry in `scripts/layers.ts` (`"@cabane/recipes"`) allows no runtime
dependency. Scope detection, records, storage, zod, outcomes and the result helpers arrive on
`host`; the factory binds the result helpers through `src/result.ts`. Core, the contract and zod
are development dependencies for types and for the tests' own result helpers.

## The run row is this extension's data module

JCAB-444:1 put the run table in the extension's own module: it ships with `recipes`, is absent
when the extension is disabled, and a device without it, the hub included, parks its ops. It is
`row-lww` on `updated_at` and not `childOfTasks`: a run names what it works on in `target_kind` and
`target_id` without belonging to it, and a target is optional. Both columns are null or both are
set; a read gives them as one `target: { kind, id }`, and `kabane run` writes kind `issue`. Moving
the row to a first-party package changes `src/runs.ts` and `modules.ts` only.

`runtime` is the runtime's name and `session` its own handle for what it started, which only that
runtime reads: for hc, the terminal's name, which the adapter builds from the recipe name and the
run id. A run is recorded before its runtime starts it, with `session` empty (`Runs.STARTING`)
until `start` returns, so a start that fails still leaves an ended run. `kabane runs` leaves a run
in a runtime it does not have as recorded, and `read`, `send` and `attach` on a run whose runtime
has no terminal fail with one line naming the runtime.

`machine` is `os.hostname()`. Only this machine's unfinished runs are reconciled; the others
show their last recorded state.

## State is read from hc

`HcRuntime.stateOf` maps `hc get --json`. `state` is `live` or `finished`; `status` is the
program's own OSC 7501 record, `null` when it never reported one; `turn` goes up each time the
status leaves `working`; `hc get` on a removed terminal exits 3 with
`{"error":{"kind":"not_found",…}}`.

| hc | run state |
|---|---|
| `state: "live"`, `status.state: "working"` | `running` |
| `state: "live"`, `status.state: "blocked"` (`status.kind` permission, question or auth) | `waiting` |
| `state: "live"`, `status.state` `idle`, `done` or `error` | `idle` |
| `state: "live"`, `status: null`, `turn: 0` | `running` (a program that never reports, such as a shell) |
| `state: "live"`, `status: null`, `turn` above 0 | `idle` |
| `state: "finished"` (any `reason`: `exited`, `killed`, …), or not found | `ended` |

Captured with hc 0.1.21 on 2026-11-16 and kept in `src/runtime-hc.test.ts`: a shell one-liner
started by `kabane run` (`"state":"live","status":null,"turn":0`, then after `hc kill`
`"state":"finished","reason":"killed"`) and a Claude Code terminal mid-turn
(`"status":{"app":"claude-code","state":"working"},"turn":13`). `blocked`, `idle`, `done` and
`error` come from `hc schema` (`Status.state`: "idle, working, done, blocked or error"); no real
Claude Code terminal was captured in those states, nor any Codex terminal.

## Verify

```bash
bun test extensions/recipes                 # parsing, inputs, the hc mapping, and the real kabane entry
bun run --cwd extensions/recipes build      # dist/ is installed as a directory extension
bun run sandbox config set extensions recipes --layer global
bun run sandbox config set recipes.harness 'sh,-c,printf "%s\n" "$0"; read line; echo "got: $line"; sleep 600' --layer global
# write a recipe into <repo>/.kabane/recipes/; the sandbox prints <repo> on its first line
bun run sandbox add "Probe" --kind issue
bun run sandbox run <recipe> --target <id> --input name=value
hc label <terminal> kabane.sandbox=1        # at once: mark it yours
bun run sandbox runs
bun run sandbox runs read <id>
bun run sandbox runs send <id> some text
bun run sandbox runs stop <id>
bun run sandbox runs --all                  # ended
hc rm <terminal>                            # each terminal you started
```

The tests never start a terminal: hc has one core per user, and it holds the human's own
sessions. In a check by hand, label every terminal you start, remove each one when done, and
never kill, remove, send to or attach to one you did not start; never `hc server stop` or
`restart`. A real harness (`claude`) started this way uses the folder's own kabane MCP, which in
a real checkout is the real tracker: only the maintainer runs that.

## Mistakes that are easy to make here

- Calling `hc` from anywhere but `src/runtime-hc.ts`, or reading the run table anywhere but
  `src/runs.ts`.
- Writing a run state kabane decided. A state comes from `HcRuntime.stateOf`; there is no
  `succeeded`.
- Adding flags, MCP entries or a system prompt to the harness command. The harness reads the
  folder's own configuration.
- `--json` as an input flag: the CLI takes every `--json` as its output flag, so the inputs
  object arrives as the positional after the recipe name.
