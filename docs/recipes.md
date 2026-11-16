# Recipes

A recipe is a prompt you run again and again, kept as a file in your project. `kabane run`
fills it in, starts your coding harness on it in a background terminal and returns at once;
`kabane runs` shows what each run is doing and lets you read it, answer it, take it over or
stop it.

Recipes are the `recipes` extension. Without it, kabane has no `run` or `runs` command.

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

A recipe is `.kabane/recipes/<name>.md` in your project; the file name is the recipe's name
(lowercase letters, digits, `-` and `_`). The frontmatter says what it works on and what it
asks for; the body is the prompt.

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
kabane run preliminary-research --target JCAB-12 --json '{"depth": "thorough"}'
```

Inputs come from `--input name=value` (repeat it), a JSON object, and then their defaults.
`--input` wins over the JSON object. At a terminal, kabane asks for each required input still
missing, numbering the options; anywhere else a missing required input is an error that
names it. Each value is checked against its type and options. With `--json`, kabane also
prints its own output as JSON.

`kabane run` puts a short preamble above the recipe's prompt: the run's id, that nobody is
watching the terminal, that a decision for you is filed with `kabane_ask` on the target issue
before the agent stops, and that the result goes on the issue as a comment. It records the
run, starts the harness in a new terminal in the current folder, logs a `run:<id>` reference
on the target issue, prints the run's id and terminal, and returns.

The harness reads its own configuration from that folder (its MCP servers, permissions and
instructions); kabane adds nothing to it.

## Follow your runs

```bash
kabane runs                 # this project's live runs, newest first
kabane runs --all           # ended ones too
kabane runs read <id>       # print the terminal's screen
kabane runs send <id> yes   # type an answer into it and press enter
kabane runs attach <id>     # take the terminal over; ctrl+\ gives it back
kabane runs stop <id>       # end its program
```

`<id>` is the run's id or its last few characters, as long as one run ends with them; the
terminal's name ends with the id's last six. A run's state is read from its terminal each
time runs are listed:

| State | The terminal |
|---|---|
| `running` | the agent is working, or its program never reports a status |
| `waiting` | the agent is blocked on you: a permission or a question in the terminal |
| `idle` | the agent's turn ended and the program is still open |
| `ended` | the program exited, or the terminal is gone |

Kabane never says a run succeeded. `idle` means the agent stopped; what it did is what it
wrote on the issue. A run started on another machine shows the state last recorded there and
that machine's name, and `read`, `send`, `attach` and `stop` refuse it.

## Settings

One setting, `recipes.harness`: the command a run starts, as a list; the prompt is added as
its last argument. The default is `["claude"]`.

```bash
kabane config set recipes.harness codex --layer global
kabane config set recipes.harness claude,--model,opus            # for this project only
```

`config set` splits a list on commas. For an argument that contains one, write the list in
`config.json` or in the project's `.kabane/recipes.json` by hand.
