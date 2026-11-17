# @cabane/recipes (extensions/recipes)

The recipes extension: prompt recipes from a project's `.kabane/recipes/`, `kabane run` to start
one in an `hc` (herdr core) terminal, `kabane runs` to list, read, send to, attach to and stop
those runs, and `kabane job` to start one on a schedule. `docs/recipes.md` is what a user reads.

| Where | What it holds |
|---|---|
| `src/extension.ts` | the `(host) => Extension` factory: the `recipes` settings (`harness`, `onAttention`), both commands, the `hc-missing` doctor finding, the board ports |
| `src/recipe.ts` | `Recipe.parse`, `load`, `all`, `render`: frontmatter, placeholders, and the errors that name the file |
| `src/inputs.ts` | `Inputs.resolve`: `--input` pairs, the JSON object, defaults, the terminal prompts, validation with `host.z` |
| `src/run-command.ts` | `startRun`, which starts a recipe from explicit inputs (scope, root, dir, recipe, target, inputs, harness, actor) and reads no cwd, TTY or setting; `promptOf`, the text it passes, which a kept job's wake sends; `kabane run`, which resolves those and calls it; the dispatcher calls it too; `shortIdOf`, which `kabane runs` and the board share |
| `src/runs-command.ts` | `kabane runs`: the listing, `attach`, `read`, `send`, `stop` |
| `src/job-command.ts` | `kabane job`: `add`, `list`, `show`, `pause`, `resume`, `run`, and `tick`, which runs the attention hook, then fires the due jobs through `startRun`, or wakes a kept job's idle terminal |
| `src/jobs.ts` | the job row and its table, `recipes_jobs`, and this machine's folder per scope, `recipes_roots`, and what its tick last saw of each run, `recipes_attention`; the due rule, the fire decision and the attention rule |
| `src/activity.ts` | `RecipeActivity`: the board's cards, one per run with a target, and the stop action |
| `src/dispatcher.ts` | `RecipeDispatcher`: `a`'s triggers, one per recipe with `target: issue`, and `dispatch` through `startRun`; on a job, `job:run`, which fires it as `kabane job run` does |
| `src/job-source.ts` | `RecipeJobs`: the board's `JobSource`, each job's schedule, next fire, recipe, inputs, harness, session mode, folder and newest runs |
| `src/runs.ts` | the run row and its table, `recipes_runs`; the only file that knows where a run is stored; `reconcile` and `stop`, which `kabane runs` and the board share |
| `src/runtime.ts` | the `Runtime` interface: `start`, `get`, `stop`, and the optional terminal operations `read`, `send`, `attach` |
| `src/runtime-hc.ts` | the hc runtime; the only file that runs `hc` |
| `modules.ts` | the modules entry: registers the run and job tables, imports only `src/runs.ts` and `src/jobs.ts` |

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
run id. What a user reads calls `session` the run's terminal (the `TERMINAL` column of `kabane
runs`, "in hc terminal …" from `kabane run`), because hc is the only runtime; `--json` and
`docs/recipes.md`'s field table say `session`. A run is recorded before its runtime starts it, with `session` empty (`Runs.STARTING`)
until `start` returns, so a start that fails still leaves an ended run. A run whose start was interrupted
stays `live` with no terminal: reconcile skips a run whose session is still `STARTING`, and a
verb on it goes to the runtime. The hc adapter also refuses an empty or blank terminal in every method before it spawns hc,
because hc reads `""` as no terminal given and picks one from the caller's scope. `kabane runs` leaves a run
in a runtime it does not have as recorded, and `read`, `send` and `attach` on a run whose runtime
has no terminal fail with one line naming the runtime.

`machine` is `os.hostname()`. Only this machine's unfinished runs are reconciled; the others
show their last recorded state.

## A job is an item plus a row

A job is an item of kind `job` (title, description as the standing request, scope, state:
`next` active, `someday` paused) created through `kabane_add`, plus its `recipes_jobs` row
(`childOfTasks`, keyed by the item's id): schedule, recipe, inputs, harness, `session`
(`fresh` or `keep`; an appended migration added it, so a row from before reads `fresh`),
`last_fired_at`.
Due is the schedule's first time after `last_fired_at`, or after the row's creation, so missed
fires fold into one. A fire skips while one of the job's runs on this machine is `live`,
`running` or `waiting`. A `fresh` job then stops the `idle` ones and calls `startRun` at the root
with a `job` target. A `keep` job sends `promptOf` (the text `startRun` passes, with the woken
run's own id in the preamble) to its newest `idle` run through `Runtime.send`, and starts one
only when none is idle (`Jobs.decide`). A wake writes no run row: one row per terminal, so
`kabane runs` lists the session once, and `last_fired_at` records the fire. `tick` has no cwd:
it reads the root from `recipes_roots`, which every `kabane job` command run inside a project
writes and which is left out of `syncTables`, since a path belongs to one machine.

Before it fires anything, `tick` reads each open job's newest run on this machine and runs
`recipes.onAttention`, when set, once when that run enters `waiting` and once when it finishes
(`idle` or `ended`): `Jobs.attention` is the rule, and `recipes_attention`, machine-local like
`recipes_roots`, holds the state the tick last saw each run in. It is written whether or not the
hook is set, so setting it later does not replay old finishes. The hook runs with `sh -c` in the
run's folder with `KABANE_JOB`, `KABANE_JOB_TITLE`, `KABANE_RUN`, `KABANE_RUN_STATE`,
`KABANE_ATTENTION`, `KABANE_FOLDER` and `KABANE_ATTACH`; a nonzero exit is one line of the tick's
output and is not retried. A run has one id, so there is no separate run short id.

## State is read from hc

`HcRuntime.stateOf` maps `hc get --json`. `state` is `live` or `finished`; `status` is the
program's own OSC 7501 record, `null` when it never reported one; `hc get` on a removed terminal
exits 3 with `{"error":{"kind":"not_found",…}}`. A run's state is only what its program reported
(JCAB-484): one that reported nothing is `live`, never a guessed `running` or `idle`, and
`startRun` records a new run as `live` until reconcile reads otherwise. `turn` is not read.

| hc | run state |
|---|---|
| `state: "live"`, `status.state: "working"` | `running` |
| `state: "live"`, `status.state: "blocked"` (`status.kind` permission, question or auth) | `waiting` |
| `state: "live"`, `status.state` `idle`, `done` or `error` | `idle` |
| `state: "live"`, `status: null` (any `turn`) | `live` (a program that never reports, such as a shell) |
| `state: "finished"` (any `reason`: `exited`, `killed`, …), or not found | `ended` |

Captured with hc 0.1.21 on 2026-11-16 and kept in `src/runtime-hc.test.ts`: a shell one-liner
started by `kabane run` (`"state":"live","status":null,"turn":0`, then after `hc kill`
`"state":"finished","reason":"killed"`) and a Claude Code terminal mid-turn
(`"status":{"app":"claude-code","state":"working"},"turn":13`). The words are `hc schema`'s
(`Status.state`: "idle, working, done, blocked or error"). A shell harness reports any of them
itself: `printf '\033]7501;state=blocked:app=my-agent\033\\'` gives
`"status":{"app":"my-agent","state":"blocked"}` (fields split on `:`; with `;` between fields
hc kept no record). That drove `live`, `running`, `waiting` and `idle` in the sandbox. No real
Claude Code terminal was captured blocked or idle, nor any Codex terminal. hc refuses
`hc send` to a blocked terminal (exit 9, "is blocked (waiting)") unless `--force`; `HcRuntime`
always passes it, so `kabane runs send` types into a waiting run like any other (JCAB-512).

## On the board

`Extension.board` gives the board's project (`host.scope.detect(ctx.cwd)`, read on each call) an
`ActivitySource` and a `Dispatcher`, and a `JobSource` over every scope's jobs; a device without the
extension has none of them. Only runs whose target is an issue are cards: a run without one, or a
job's run, is not on the issue board (JCAB-426). A job's runs are on the board's Jobs tab instead,
through `RecipeJobs`: what `kabane job show` prints, as data, and for each of the newest five runs
its state and `kabane runs attach <id>`. Its runs are reconciled on each call, as `kabane job list`
does. `a` on a job offers `job:run`, which fires it now in its scope's folder from
`recipes_roots`, whatever the board's project; pause and resume are the item's state, which the
board writes itself.

| Run state | `ActivityStatus` | Why |
|---|---|---|
| `live` | `paused` | in flight without a spinner and without claiming work; `detail[0]` is `live`, so the row reads `⏸ <label> · paused · live` |
| `running` | `running` | in flight, animated |
| `waiting` | `paused` | in flight without a spinner: the harness waits on the human. The row reads `⏸ <label> · paused · waiting` |
| `idle`, `ended` | `completed` | finished; `detail[0]` is the run state, though the board draws no badge or header line for a finished card, so only `kabane runs` tells the two apart |

Listing and `card` run `reconcile` first, as `kabane runs` does; retention follows the loop's
source (every run in flight, the newest finished up to ten, where `idle` counts as finished as
the board draws it). A card has no tab and no events (JCAB-483): kabane does not render a
harness's terminal. The card carries the state and `kabane runs attach <id>`; hc shows the
session. `Runtime.read` stays for `kabane runs read`. The only action is `stop`, which `X` on the
issue's detail runs (JCAB-496), as `kabane runs stop` does; answering stays in a terminal.

Triggers are `recipe:<name>`. Inputs pass as declared; the board's form opens only when every
input has a default and is a choice, number or boolean, and otherwise `dispatch` gets no
inputs and the defaults apply through `Inputs.resolve`. A required input with no default makes
the trigger unsatisfiable, with the `kabane run` command as its hint, as does a missing `hc`.

## Verify

```bash
bun test extensions/recipes                 # parsing, inputs, the hc mapping, the board ports, the real kabane entry
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

Jobs, with the same shell harness and a recipe that says `target: job` or none:

```bash
bun run sandbox job add <recipe> --title Probe --schedule "* * * * *"
bun run sandbox job list
bun run sandbox job tick                   # after the minute turns: starts a run
hc label <terminal> kabane.sandbox=1        # at once
bun run sandbox job tick                   # skips it while it is live
```

The board in the sandbox, on your own tmux socket: start a run as above, then
`tmux -L <yours> new-session -d -s board -x 100 -y 30 'bun run sandbox board'`; `enter` on the
issue shows the card with its attach command, `a` on the issue starts a recipe. A recipe the
board starts gets a new terminal: label it at once.

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
- `--json` as an input flag: the CLI takes every `--json` as its output flag. The inputs
  object comes with `--inputs` or as the positional after the recipe name.
