# Recipes

A recipe is a prompt you run again and again, kept as a file in your project. `kabane run`
fills it in, starts your coding harness on it in a background terminal and returns at once;
`kabane runs` shows what each run is doing and lets you read it, send to it, take it over or
stop it. `kabane job` runs a recipe on a schedule.

Recipes are the `recipes` extension. Without it, kabane has no `run`, `runs` or `job` command,
and the board shows no run and offers no recipe.

## Install

Build it from a kabane checkout and install it as [Extensions](extensions.md) shows for the
loop and dispatch:

```bash
bun run --cwd extensions/recipes build
mkdir -p "${KABANE_HOME:-$HOME/.kabane}/extensions/recipes"
cp -R extensions/recipes/dist/. "${KABANE_HOME:-$HOME/.kabane}/extensions/recipes/"
kabane config set extensions loop,dispatch,recipes --layer global   # the ones you use
```

Runs start in terminals of `hc` (herdr core), which must be on your `PATH`. Without it,
`kabane run` stops with one line naming it and `kabane doctor` reports
`recipes/hc-missing`.

## Write a recipe

A recipe is `.kabane/recipes/<name>.md` at your project's root: the folder that already holds
`.kabane/`, or the repository's root when there is none yet. The file name is the recipe's
name (lowercase letters, digits, `-` and `_`). The frontmatter says what it works on and what
it asks for; the body is the prompt.

Keep it there, even for a recipe about one package. A `.kabane/` folder marks a project's
root, so creating one in a subfolder makes that subfolder a separate project: every command
run inside it, `kabane run` included, files into its own scope, and a scope you pinned with
`kabane init --scope` stops applying there. When `kabane run` finds no recipes, it names the
root it looked in.

```markdown
---
description: Gather what an implementer needs before work starts on an issue
target: issue
inputs:
  depth:
    options: [quick, medium, thorough]
    default: medium
    hint: how far to follow prior issues
---

Do preliminary research on {{target.shortId}} ("{{target.title}}") at {{inputs.depth}} depth.
Write the result as one comment on {{target.shortId}}.
```

| Field | Meaning |
|---|---|
| `description` | one line, shown when `kabane run` lists the recipes |
| `target` | `issue`: the run works on an issue given with `--target`; `job`: it runs for a scheduled job (see [Jobs](#jobs)); `none` (the default): it takes none |
| `inputs` | by name: `type` (`string`, the default, `number` or `boolean`), `required`, `default`, `options` (strings only), `label`, `hint` |

The body can use `{{inputs.<name>}}` and, with `target: issue` or `target: job`, `{{target.id}}`,
`{{target.shortId}}` and `{{target.title}}`. An optional input left out with no default
reads as nothing. A placeholder the recipe cannot fill, an input or field the frontmatter does
not allow, or a file with no body is an error naming the file: kabane never skips a broken
recipe.

## Run one

From your project's folder, or any folder inside it:

```bash
kabane run                                        # the recipes here, with their inputs
kabane run preliminary-research --target JCAB-12 --input depth=quick
kabane run preliminary-research --target JCAB-12 --inputs '{"depth": "thorough"}'
```

Inputs come from `--input name=value` (repeat it), a JSON object given with `--inputs` or
bare after the recipe name, and then their defaults. `--input` wins over the JSON object. At
a terminal, kabane asks for each required input still missing, numbering the options;
anywhere else a missing required input is an error that names it. Each value is checked
against its type and options. `--json` is the output flag every kabane command takes: it
prints the command's own output as JSON and supplies no inputs.

`kabane run` puts a short preamble above the recipe's prompt: the run's id, that nobody is
watching the terminal, that a decision for you is filed with `kabane_ask` on the target issue
before the agent stops, and that the result goes on the issue as a comment. With `target: none`
there is no issue to file on, so the preamble asks the agent to write its question or its
result as its last message, which `kabane runs read` shows. It records the
run, starts the harness in a new terminal in the current folder, logs a `run:<id>` reference
on the target issue, prints the run's id and terminal, and returns.

The harness reads its own configuration from that folder (its MCP servers, permissions and
instructions); kabane adds nothing to it.

## Follow your runs

```bash
kabane runs                 # this project's runs that have not ended, newest first
kabane runs --all           # ended ones too
kabane runs read <id>       # print the terminal's screen
kabane runs send <id> yes   # type an answer into it and press enter
kabane runs attach <id>     # take the terminal over; ctrl+\ gives it back
kabane runs stop <id>       # end its program
```

`<id>` is the run's whole id, which works from any folder whatever project the run is in, or
its last few characters within this project, as long as one run ends with them; the
terminal's name ends with the id's last six. A run's state is what its program last reported
to its terminal, read each time runs are listed. Programs report through OSC 7501, herdr's
Program Status Protocol; kabane never guesses a state from the screen:

| State | The terminal |
|---|---|
| `live` | the program is open and has reported no status: a shell, or a harness that does not speak OSC 7501 |
| `running` | the agent is working |
| `waiting` | the agent is blocked on you: a permission or a question in the terminal. Answer it with `runs send <id> <text>`, or `runs attach <id>` to see it first |
| `idle` | the agent's turn ended and the program is still open |
| `ended` | the program exited, or the terminal is gone |

Any program can report its own state, a script set as `recipes.harness` included: it runs
`printf '\033]7501;state=working:app=my-agent\033\\'`, with `state` one of `working`, `blocked`,
`idle`, `done` or `error`. `blocked` shows `waiting`; `idle`, `done` and `error` show `idle`.

Kabane never says a run succeeded. `idle` means the agent stopped; what it did is what it
wrote on the issue. A run started on another machine shows the state last recorded there and
that machine's name, and `read`, `send`, `attach` and `stop` refuse it. A run in a runtime
this kabane does not have is treated the same way, and `read`, `send` and `attach` on a runtime
with no terminal fail with one line naming it. A run whose start was interrupted
stays `live` with no terminal (an empty TERMINAL column), and every verb on it fails with
"This run has no terminal: its start never recorded one".

With `--json`, `kabane run` prints `run` (the id), `session` and `attach` (the command that
attaches to it), plus `warnings` when there are any. `kabane runs --json` prints `runs`, a list
of runs with these fields:

| Field | Meaning |
|---|---|
| `id` | the run's id |
| `recipe` | `{ name, hash }`: the recipe and a hash of the file it started from |
| `target` | `{ kind, id }`: what the run works on, absent when the recipe takes none: kind `issue` or `job`, and the item's full id |
| `scope`, `dir`, `cwd` | the scope's URI, the folder relative to its root (`""` at the root), and that folder's full path |
| `machine` | the host name of the machine the run started on |
| `runtime` | what started the run: `hc` |
| `session` | the runtime's own handle for it: for `hc`, the terminal's name |
| `inputs` | the input values the run started with |
| `state` | `live`, `running`, `waiting`, `idle` or `ended` |
| `startedAt`, `endedAt` | ISO timestamps; `endedAt` once the run has ended |

## On the board

A run that works on an issue is a card on that issue, for the board's project. The board reads
each state from the terminal, as `kabane runs` does, and draws it this way:

| State | On the board |
|---|---|
| `running` | in flight, with a spinner: the issue's row shows the recipe's name and the state, and its header also shows the run's inputs, its machine and `kabane runs attach <id>` to copy |
| `live` | paused, with no spinner, since nothing says the program is working: the issue's row shows `⏸ <recipe> · paused · live`, and its header also shows the run's inputs, its machine and `kabane runs attach <id>` to copy |
| `waiting` | paused, with no spinner: the issue's row shows `⏸ <recipe> · paused` and the state, and its header also shows the run's inputs, its machine and `kabane runs attach <id>` to copy. The agent waits on you: answer it with `kabane runs attach <id>` |
| `idle`, `ended` | finished: no badge on the row or line in the header. `kabane runs --all` says which of the two it is |

Every run in flight (`live`, `running` or `waiting`) is listed, and the newest finished ones (`idle` or
`ended`) up to ten runs in all. A run with no target is not on the board: `kabane runs` lists
it. A job's run is on the board's Jobs tab, under its job (below).

A run's card has no tab: the board does not show the terminal. To see or answer the session,
run `kabane runs attach <id>`, which opens it in hc; `kabane runs read <id>` prints its screen
and `kabane runs stop <id>` stops it. `X` on the issue's detail stops it too (the footer says
`X stop <recipe>`). Nothing is answered from the board.

`a` on an issue offers every recipe of the project whose frontmatter says `target: issue`,
with its description. A recipe whose inputs all have a default and are choices, numbers or
booleans opens a form first; `enter` starts it with those values, and the footer names the
new run. A recipe with any free-text input opens no form: `enter` starts it at once with every
input's default, and the card's header shows the values it got. To give other values, start it
with `kabane run <recipe> --target <id> --input name=value`. A recipe with a required input that has no default cannot start from the board: the
footer gives the `kabane run` command that does. A recipe file that does not parse is listed
with its error and does not start.

## Jobs

A job runs a recipe, or its own request, on a schedule, in its project's folder. It is an item of kind `job`: its
title names it, its description is the standing request the agent reads each time, and its
comments are what each run reported. Lists that name no kind leave jobs out; `kabane list
--kind job` shows them.

```bash
kabane job add wiki-maintenance --title "Keep the wiki current" --schedule "0 7 * * *" \
  --request "Fold this week's notes into the wiki pages they belong to"
kabane job add --title "Check the nightly build" --schedule "0 8 * * *" \
  --request "Check last night's build and comment what broke"   # no recipe
kabane job list                 # this project's jobs; --all for every project's
kabane job show JCAB-600        # the request, the inputs and the last runs
kabane job pause JCAB-600       # resume JCAB-600 starts it again
kabane job run JCAB-600         # fire it now
kabane job tick                 # fire every job that is due; what launchd or cron calls
```

`job add` runs in the project. The recipe must say `target: job` or take no target. Its inputs
come from `--input name=value` and `--inputs '{…}'` as with `kabane run`, are checked now, and
are never asked for: a required input that is missing is an error. `--schedule` is a cron
expression (`minute hour day month weekday`, or `@daily` and the other nicknames), read in this
machine's time zone. `--harness claude,--model,opus` gives this job its own command instead of
`recipes.harness`. `--session keep` makes the job keep one session between fires (below); the
default, `--session fresh`, starts a new one on each fire. To change it, close the job and add
it again.

With no recipe name, `--request` is required and is the prompt: each fire gives the agent the
job preamble (below), then the request as the job's description reads at that moment, so an
edit to the description takes effect at the next fire. It is not a template: `{{…}}` in it
stays as written, and such a job takes no `--input`. Its runs are listed with `request` as their
recipe.

`job list` shows each job's id, whether it is active or paused, its schedule, the next time it
fires, its recipe (`-` for none), its harness, its session mode, the state of its latest run and its title. `pause` sets the job
`someday` and `resume` sets it `next`. A job ends when you close it with `kabane done`; there is
no delete.

`job tick` fires every active job whose schedule has come round since it last fired, or since
it was added. A tick that comes late fires a job once, however many times it was missed. A fire,
like `job run`:

1. reads the job's runs on this machine from their terminals;
2. skips the job when one is `live`, `running` or `waiting`, and says so; the job stays due for
   the next tick;
3. on a `fresh` job, stops each `idle` one, because a harness stays at its prompt after its
   turn, then starts the recipe at the project's root, as `kabane run` would, with the job as
   its target;
4. on a `keep` job, types the recipe's prompt into the newest `idle` run's terminal, as `kabane
   runs send` would, and stops and starts nothing. The harness answers it in the same
   conversation, so it remembers the earlier fires and keeps its prompt cache. When no terminal
   is left (its run `ended`, or hc no longer has it), it starts one as a `fresh` job does.

A woken run stays one row in `kabane runs`, with the time it first started; `job show` and
`job list` say when the job last fired and the state its session is in. Kabane adds no harness
flag to resume a session: a kept session lasts as long as its terminal, so a reboot or `kabane
runs stop` ends it and the next fire starts a new one.

The run's preamble tells the agent it is a scheduled background run of the job, to read the job
with `kabane_context` for the request and what earlier runs reported, to write its result as one
comment on the job and to file a decision for you with `kabane_ask` on the job. `tick` prints one
line for each job it fired or skipped and exits 0 unless kabane itself failed.

`tick` runs with no project, so it needs each project's folder on this machine: every `kabane
job` command run inside a project records it. A job whose project has no folder recorded is
skipped with a line that says to run `kabane job list` inside it. Jobs sync with your other
items; the folders do not, so each machine that ticks needs one `kabane job` command in each
project.

### Hear when a run needs you

`recipes.onAttention` is a shell command that `job tick` runs when a job's run needs you: once
when it starts waiting on you (a permission, a question, a trust dialog), and once when it
finishes (`idle` or `ended`). A run still waiting at the next tick does not run it again; one
that waits again after it went back to work does. Only the newest run of each job on this
machine counts, paused jobs included. Unset, the default, nothing runs.

The command runs with `sh -c` in the run's folder, with these environment variables:

| Variable | Holds |
|---|---|
| `KABANE_JOB` | the job's short id (`JCAB-600`) |
| `KABANE_JOB_TITLE` | the job's title |
| `KABANE_RUN` | the run's id |
| `KABANE_RUN_STATE` | `waiting`, `idle` or `ended` |
| `KABANE_ATTENTION` | `waiting`, or `finished` for `idle` and `ended` |
| `KABANE_FOLDER` | the folder the run started in |
| `KABANE_ATTACH` | the command that opens its session: `kabane runs attach <run id>` |

```bash
kabane config set recipes.onAttention \
  'terminal-notifier -title "$KABANE_JOB $KABANE_ATTENTION" -message "$KABANE_JOB_TITLE: $KABANE_ATTACH"' \
  --layer global
```

A hook that exits nonzero is reported on the tick's output with its last line of stderr, and
changes nothing else: it is not retried. Under launchd, the command must be on the plist's
`PATH`.

### Jobs on the board

While this device has a job, the board has a Jobs tab after the tracker (tab 2; `2`, `{` and `}`
reach it, or click it). It lists the jobs of every project on this device, not only the
board's, one section per project named after its folder. Each row shows the state of the
job's latest run, its id and title, then as much as fits of: `? waiting` when that run waits on
you, `paused`, when it fires next, its schedule, its recipe and its harness. A waiting run is
in the accent color, and the tab counts them (`jobs ?1`), so you see from any tab that a job
needs you.

| Key | On the Jobs tab |
|---|---|
| `enter` | the job's detail: its request and comments as an issue's, with its schedule, next fire, recipe, inputs, harness, session mode, folder and latest runs under the header |
| `a` | `run now`, which fires it as `kabane job run` does, in its own project's folder |
| `s`, `n` | pause it (`someday`) and resume it (`next`) |
| `esc` | back to the tracker |

Each run in the detail shows its state, when it started and `kabane runs attach <id>`, which
opens its session in hc; the board does not show the session. A board without the recipes
extension still lists the jobs, with only their id, title, project and whether they are paused.

### Tick on a schedule

On macOS, `docs/schedule/com.kabane.job-tick.plist` runs `kabane job tick` every minute with
launchd; the comment at its top says how to install and remove it. On Linux,
`docs/schedule/kabane-job-tick.cron` is the same as a crontab line. A tick with nothing due does
nothing, so ticking every minute is cheap.

## Settings

`recipes.harness` is the command a run starts, as a list; the prompt is added as its last
argument. The default is `["claude"]`. `recipes.onAttention` is the command a tick runs when a
job's run needs you ("Hear when a run needs you", above); unset by default.

```bash
kabane config set recipes.harness codex --layer global
kabane config set recipes.harness claude,--model,opus            # for this project only
```

`config set` splits a list on commas. For an argument that contains one, write the list in
`config.json` or in the project's `.kabane/recipes.json` by hand.
