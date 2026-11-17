# Recipes

A recipe is a prompt you run again and again, kept as a file in your project. `kabane run`
fills it in, starts your coding harness on it in a background terminal and returns at once;
`kabane runs` shows what each run is doing and lets you read it, send to it, take it over or
stop it.

Recipes are the `recipes` extension. Without it, kabane has no `run` or `runs` command, and the
board shows no run and offers no recipe.

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
| `target` | `issue`: the run works on an issue given with `--target`; `none` (the default): it takes none |
| `inputs` | by name: `type` (`string`, the default, `number` or `boolean`), `required`, `default`, `options` (strings only), `label`, `hint` |

The body can use `{{inputs.<name>}}` and, with `target: issue`, `{{target.id}}`,
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

`<id>` is the run's id or its last few characters, as long as one run ends with them; the
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
| `target` | `{ kind, id }`: what the run works on, absent when the recipe takes none. `kabane run` writes kind `issue` and the issue's full id |
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
it.

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

## Settings

One setting, `recipes.harness`: the command a run starts, as a list; the prompt is added as
its last argument. The default is `["claude"]`.

```bash
kabane config set recipes.harness codex --layer global
kabane config set recipes.harness claude,--model,opus            # for this project only
```

`config set` splits a list on commas. For an argument that contains one, write the list in
`config.json` or in the project's `.kabane/recipes.json` by hand.
