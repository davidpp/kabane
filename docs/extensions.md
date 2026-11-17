# Extensions

Kabane on its own is the tracker, the board and its copilot, the MCP server your coding agents
use, and sync. It bundles no extension. An extension is a directory under
`$KABANE_HOME/extensions/<name>/` (default `~/.kabane/extensions/<name>/`), and it runs only once
its name is in the `extensions` setting.

This repository has three:

| Extension | What it adds |
|---|---|
| `loop` | `kabane loop`, which drives an issue or a parent issue's subtasks through coding harnesses on your machine; `a` on the board to start a run, with a tab per run; the copilot's procedures to start and advise a run; the `kabane_loop_advise` MCP tool; `loop.*` settings; doctor checks under `loop`. See [loop.md](loop.md). |
| `dispatch` | The dispatch and grill skills for your projects; `/setup-dispatch` in the copilot, which writes a project's dispatch skill; `kabane dispatch stamp`; doctor checks under `dispatch`. See [its README](../extensions/dispatch/README.md). |
| `recipes` | `kabane run`, which starts a prompt recipe from a project's `.kabane/recipes/` in a background `hc` (herdr core) terminal, and `kabane runs` to list, read, send to, attach to and stop those runs; on the board, a card for each run that works on an issue, with its state and the command that attaches to it, and `a` on an issue to start a recipe; the `recipes.harness` setting; a doctor check under `recipes`. See [recipes.md](recipes.md). |

`a` on the board lists what the enabled extensions can start on an issue: a loop run, the
project's recipes that target an issue, or both. Without the loop and recipes it does nothing.
Without dispatch, the copilot neither offers `/setup-dispatch` nor knows the grill skill. Without
recipes, kabane has no `run` or `runs`, and the board shows no run cards.

## Build them from a kabane checkout

There is no install command or registry for extensions yet. You build each one from a clone of
this repository, which needs git and [Bun](https://bun.sh) 1.4 or later, the standalone binary
included. Build from the same kabane version you run: the extensions are tested against the kabane
built beside them.

```bash
git clone https://github.com/davidpp/kabane.git
cd kabane && bun install
bun run --cwd extensions/loop build
bun run --cwd extensions/dispatch build
bun run --cwd extensions/recipes build
```

Each build prints where it wrote, such as `build: /…/kabane/extensions/loop/dist`. The `dist/`
directory is the whole extension: a bundled `index.js` with its dependencies inlined, its
`package.json`, and the files it reads at run time (the copilot's files, the loop's verifier
lenses, the dispatch skill templates).

## Install and enable them

These steps are the same for the npm install and the standalone binary: both load a copied
`dist/`. From the checkout, copy each build into your kabane home:

```bash
mkdir -p "${KABANE_HOME:-$HOME/.kabane}/extensions/loop"
cp -R extensions/loop/dist/. "${KABANE_HOME:-$HOME/.kabane}/extensions/loop/"
mkdir -p "${KABANE_HOME:-$HOME/.kabane}/extensions/dispatch"
cp -R extensions/dispatch/dist/. "${KABANE_HOME:-$HOME/.kabane}/extensions/dispatch/"
mkdir -p "${KABANE_HOME:-$HOME/.kabane}/extensions/recipes"
cp -R extensions/recipes/dist/. "${KABANE_HOME:-$HOME/.kabane}/extensions/recipes/"
```

Then enable them by name. `extensions` is a list, and a `set` replaces the whole list, so read it
first and name every extension you want on:

```bash
kabane config get extensions
kabane config set extensions loop,dispatch,recipes --layer global
```

```text
extensions = ["loop","dispatch","recipes"] (global)
```

In the board, the copilot's `/setup` shortcut, for its harness, model and extensions, can enable
an installed extension for you.

Restart a running board, and the coding sessions whose `kabane mcp` should see the change: a
process reads the list when it starts. Then check that kabane loaded them. Their commands are at
the end of `kabane --help`:

```text
  loop      Drive an issue, or a parent issue's subtasks, to completion through coding harnesses
  dispatch  Print the dispatch template's stamp
  run       Start a project recipe in a background terminal
  runs      List recipe runs; attach to, read, send to or stop one
```

and `kabane doctor`, run in a project, reports their checks under their names. On a project with
no loop settings and no dispatch skill yet:

```text
suggest:
  loop/model-unpinned: loop.model is unset, so every loop session runs on claude's own default model, which for Claude Code is whichever model was last picked interactively. → propose loop.model (a tier is best) and the loop.tiers mapping it needs; the human picks the models; write it with kabane_configSet in the global layer unless they say this project only
  dispatch/dispatch-skill-missing: No dispatch skill in .agents/skills/dispatch or .claude/skills/dispatch. → /setup-dispatch writes one
```

The loop needs a coding harness installed and logged in before it starts a run;
[loop.md](loop.md) goes on from here. For dispatch, type `/setup-dispatch` in the copilot
([its README](../extensions/dispatch/README.md#setting-up-the-dispatch-skill)).

## Run an extension from the checkout instead

When kabane runs through Bun (the npm install, or `bun link` from a clone), the extension
directory can be a symlink to the source in the checkout, so a change there needs no build.
From the clone, link every extension of the checkout, or only the ones you name:

```bash
bun run link-extensions            # loop, dispatch, recipes
bun run link-extensions recipes
```

It links `${KABANE_HOME:-$HOME/.kabane}/extensions/<name>` to `extensions/<name>` and prints
one line per extension: `linked`, `already linked here`, or `skipped` with what is already
there. It never replaces an installed directory or a link to another place, and replaces a
link whose target is gone. A name with no `extensions/<name>` in the checkout makes it exit 1.

It installs only. `extensions` is a list and a `set` replaces it whole, so read it first and
name every extension you want on:

```bash
kabane config get extensions
kabane config set extensions loop,dispatch,recipes --layer global
```

The standalone binary cannot load the loop's source through that link. It resolves no package
from disk, and the loop's source imports kabane's workspace packages, so it refuses the
extension and keeps the others:

```text
Extension loop: the entry could not be imported: Cannot find package '@cabane/acp' imported from /…/kabane/extensions/loop/src/commands.ts; repair the entry and its dependencies; or remove it from extensions with `kabane config set extensions <names> --layer global`.
```

## Try them in the sandbox

`bun run sandbox`, from a checkout, links `extensions/loop`, `extensions/dispatch` and
`extensions/recipes` into its throwaway `KABANE_HOME`. They are installed there but not enabled:

```bash
bun run sandbox config set extensions loop,dispatch,recipes --layer global
bun run sandbox loop --help
bun run sandbox --scripted board
```

With `--scripted`, the copilot and every loop session run on a scripted agent, so nothing spends
a harness's quota ([README](../README.md#try-a-change-without-touching-your-own-device)).

## Update an extension

Pull the checkout (`git pull`), build again, and replace the installed directory:

```bash
bun run --cwd extensions/loop build
rm -rf "${KABANE_HOME:-$HOME/.kabane}/extensions/loop"
mkdir -p "${KABANE_HOME:-$HOME/.kabane}/extensions/loop"
cp -R extensions/loop/dist/. "${KABANE_HOME:-$HOME/.kabane}/extensions/loop/"
```

Removing the directory first drops files the new build no longer has. The loop's runs and
settings are elsewhere (`$KABANE_HOME/loops`, `config.json`, the project's `.kabane/loop.json`)
and stay. Restart the board and the coding sessions afterwards.

## Turn an extension off

Set `extensions` to the ones you keep, or to `""` for none:

```bash
kabane config set extensions dispatch --layer global
```

The directory stays and loads nothing. Its settings stay in their files and are read again when
you enable it. An extension still enabled whose directory you removed stops nothing either: each
command that loads extensions prints `Extension loop: not installed; put it in
<home>/extensions/loop/`, then how to take it off the list.

To write your own, see [writing an extension](writing-an-extension.md).
