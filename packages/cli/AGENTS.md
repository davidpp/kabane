# kabane (packages/cli)

The host on a device: the `kabane` command, `kabane mcp` over stdio, the board's runtime and
everything that reads this machine (config, settings layers, scope, harness configs, updates).
The record commands (`add`, `edit`, `list`, `checklist`, ...) are thin parsers over core and the
data modules; setup, configuration, updates and the board's runtime are the host's own code.
`README.md` describes the commands, the config and the settings layers.

| Where | What it holds |
|---|---|
| `src/main.ts` | `COMMANDS`, the built-in command table; help; exit codes (0 ok, 1 error, 2 usage); `run(argv, env, cwd)` |
| `src/commands/*.ts` | one file per command, each a `Command` |
| `src/context.ts` | `MODULES`, `configureRuntime`, `openContext` (the `Ctx` a command gets), scope selection |
| `src/config*.ts` | `config.json`, the settings layers, `kabane config`, and the device config tools only `kabane mcp` serves (`config-tools.ts`) |
| `src/extensions.ts` | directory extensions: a main entry is imported when a command, the board or `kabane mcp` needs it, a modules entry by every process that opens the database |
| `src/copilot-files.ts` | a directory extension's `copilot/shortcuts` files, `{{extension}}` filled, unusable files refused |
| `src/skills.ts` | a directory extension's `skills/<name>/`, served by `kabane mcp` as `kabane_skillList` and `kabane_skillGet`, `{{extension}}` and `{{kabane}}` filled, unusable skills refused |
| `src/commands/board-runtime.ts` | builds the board's ports and `BoardCopilot` from `@cabane/board`, passing `Self.executable()`, then calls `startBoard` |
| `src/first-run.ts`, `src/mcp-clients.ts`, `src/update-*.ts` | the setup screen, MCP registration in harness configs, self-update |

## It is the host, so it may depend on everything below it and nothing beside it

Its layer is `host`; its entry in `scripts/layers.ts` (`kabane`) says what it may list. It is
the only package that depends on `@cabane/sqlite` at runtime. It imports every other package by
its package name, `src/update-process.ts` included (`@cabane/core/result`), and its entry lists
no relative-import exception. Never add an import from `extensions/`.

A first-party data module is registered in `MODULES` and in `packages/worker/src/hub.ts`. What
core needs from the device reaches it through a port wired in `configureRuntime`, never by core
reading the environment (`CODING_PRINCIPLE.md`, "Explicit dependencies").

The extension API is implemented here:

- The extension contract includes `mcp` and `doctor`; the `doctor` runner is in
  `packages/extension/doctor.ts`. `src/commands/doctor.ts` runs kabane's own checks
  (`src/doctor/`; a project skill's template stamp is checked by the extension named like the
  template, and `project/skill-unchecked` only says when none is loaded) and each loaded
  extension's through `Extensions.doctors`, which turns a
  malformed report into that extension's `check-failed` finding; a refused extension is an
  `extension-refused` finding.
- `src/extensions.ts` loads enabled directories from `$KABANE_HOME/extensions`. `loadAll(names, home)` returns `loaded`, `refused` and `directories` (each
  extension loaded from a directory, with that directory); callers must consume `loaded` and
  `refused`. Help, commands and MCP report refusals on stderr; the board uses its announcer.
  `src/copilot-files.ts` reads the copilot files of `directories` for the board; a refused file
  is a line in the board's announcer and a `copilot-file-*` finding of `kabane doctor`
  (`src/doctor/copilot-files.ts`). `src/skills.ts` reads their `skills/` for `kabane mcp`; a
  refused skill goes to stderr there, the board's announcer and a `skill-*` finding. A disabled
  directory is discovered without importing it, including during command lookup and config.
  The manifest API and the resolved entry path are checked before import, and the factory
  result is validated before its contributions are accepted.
- Data modules are the other path, kept apart in `src/extensions.ts`: `Extensions.modules`
  imports each enabled extension's modules entry and calls its factory, and a failure there is
  no refusal but the stop (`Extensions.stopLine`): `registerModules` in `src/context.ts` runs
  those stages and `Runtime.configure`, one extension at a time so a refused set names its
  extension, before `Planner.init`. Every process that opens the database goes through it:
  `openContext` (so every non-standalone command, `kabane mcp` and the board) and `doctor`,
  which reports the stop as its `kabane/extension-modules` finding and runs its other checks.
  `init` writes a fresh config with no extensions and registers the first-party list.
- `src/host.ts` builds API 1 hosts, one per extension per process (`hostFor`), so the modules
  entry and the main entry receive the same object; `store` is scoped to the tables its
  modules declare. `openContext` activates `record` and `store` after migration with the MCP
  actor context and lazy, cached scope resolution; each host refuses both while one of its
  factories runs and until one has returned. Doctor activates them only after it opens the
  store.
- `src/scope/` owns scope detection, `src/self.ts` owns executable discovery, and
  `src/mcp-stdio.ts` owns `serveStdio`. `configureRuntime` wires core's bounded file reader.

Read before writing: `src/main.ts`, `src/context.ts`, and one command with its test
(`src/commands/checklist.ts`, `src/commands/checklist.test.ts`).

## Verify

```bash
bun test packages/cli                 # cli.test.ts spawns the real entry; command tests call run()
bun run sandbox init                  # once per fresh sandbox
bun run sandbox <command> [args]      # the real command
bun run sandbox mcp                   # kabane mcp over stdio: initialize, then tools/call
```

The board goes through tmux as the root `AGENTS.md` shows. A change to setup or MCP
registration is checked with `bun run sandbox --harnesses`, which points the harnesses' HOME
into the sandbox. A test that runs a command passes `KABANE_HARNESSES: ""` so setup finds no harness to
register in (`src/commands/checklist.test.ts`).

## Mistakes that are easy to make here

- A `standalone` command that reads the record. It gets `bareCtx`, with no runtime configured
  and no database opened (`src/main.ts`); `mcp` is standalone and calls `openContext`
  itself.
- A command added to `src/commands/` and not to `COMMANDS`, or to both and not to the README's
  command list.
- Record logic written into a command. It belongs in core or a data module, where the hub and
  the MCP tools reach it too.
- A device config tool registered where the hub would serve it. Config tools are stdio only.
