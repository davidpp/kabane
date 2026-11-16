# @cabane/recipes (extensions/recipes)

The recipes extension: prompt recipes from a project's `.kabane/recipes/`, `kabane run` to start
one in an `hc` (herdr core) terminal, and `kabane runs` to list, read, answer, attach to and stop
those runs. `docs/recipes.md` is what a user reads.

| Where | What it holds |
|---|---|
| `src/extension.ts` | the `(host) => Extension` factory: the `recipes.harness` setting, both commands, the `hc-missing` doctor finding, the board ports |
| `src/recipe.ts` | `Recipe.parse`, `load`, `all`, `render`: frontmatter, placeholders, and the errors that name the file |
| `src/inputs.ts` | `Inputs.resolve`: `--input` pairs, the JSON object, defaults, the terminal prompts, validation with `host.z` |
| `src/run-command.ts` | `startRun`, which starts a recipe from explicit inputs (scope, root, dir, recipe, target, inputs, harness, actor) and reads no cwd, TTY or setting; `kabane run`, which resolves those and calls it; the dispatcher calls it too |
| `src/runs-command.ts` | `kabane runs`: the listing and `reconcile`, which the board shares, `attach`, `read`, `send`, `stop` |
| `src/activity.ts` | `RecipeActivity`: the board's cards, one per run with a target, and the stop action |
| `src/dispatcher.ts` | `RecipeDispatcher`: `a`'s triggers, one per recipe with `target: issue`, and `dispatch` through `startRun` |
| `src/runs.ts` | the run row and its table, `recipes_runs`; the only file that knows where a run is stored |
| `src/runtime.ts` | the `Runtime` interface: `start`, `get`, `stop`, the optional `find` that recovers an interrupted start's session, and the optional terminal operations `read`, `send`, `attach` |
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
run id. What a user reads calls `session` the run's terminal (the `TERMINAL` column of `kabane
runs`, "in hc terminal …" from `kabane run`), because hc is the only runtime; `--json` and
`docs/recipes.md`'s field table say `session`. A run is recorded before its runtime starts it, with `session` empty (`Runs.STARTING`)
until `start` returns, so a start that fails still leaves an ended run. A start interrupted between the two
writes leaves a `live` row with no session (JCAB-467:1): reconcile asks the runtime's optional
`find(run)` for it (hc: `hc ls --all --label kabane.run=<id>`, the terminal whose name ends with
the id's last six), records the session it finds, and ends the run when there is none.
`Runs.endStarting` ends it only while its session is still `STARTING`, and `Runs.setSession` on a
run still `STARTING` sets it `live` again, so a listing that runs during a start that is still
on its way never ends it for good; on a run whose session a reconcile already recovered it keeps
the state that reconcile read. `read`, `send`, `attach` and `stop` reconcile such a run first, and refuse it
before any terminal call while its session is still `STARTING`; a runtime without `find` leaves
it as recorded. The hc adapter also refuses an empty or blank terminal in every method before it spawns hc,
because hc reads `""` as no terminal given and picks one from the caller's scope. `kabane runs` leaves a run
in a runtime it does not have as recorded, and `read`, `send` and `attach` on a run whose runtime
has no terminal fail with one line naming the runtime.

`machine` is `os.hostname()`. Only this machine's unfinished runs are reconciled; the others
show their last recorded state.

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
`hc send` to a blocked terminal (exit 9, "is blocked (waiting)") unless `--force`.

## On the board

`Extension.board` gives the board's project (`host.scope.detect(ctx.cwd)`, read on each call) an
`ActivitySource` and a `Dispatcher`; a device without the extension has neither. Only runs with
a target are cards: a run without one belongs to a jobs view, not the issue board (JCAB-426).

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
session. `Runtime.read` stays for `kabane runs read`. The only action is `stop`, which the board
reaches only from a card's tab, so until it runs a card's actions from the issue's detail
(JCAB-496) a run is stopped with `kabane runs stop`; answering stays in a terminal.

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
