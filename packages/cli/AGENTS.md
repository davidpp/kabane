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
| `src/extensions.ts` | directory extensions and the bundled fallback (`OFFICIAL`), loaded only when a command or the board needs one |
| `src/commands/board-runtime.ts` | builds the board's ports and `BoardCopilot` from `@cabane/board`, passing `Self.executable()`, then calls `startBoard` |
| `src/first-run.ts`, `src/mcp-clients.ts`, `src/update-*.ts` | the setup screen, MCP registration in harness configs, self-update |

## It is the host, so it may depend on everything below it and nothing beside it

Its layer is `host`; its entry in `scripts/layers.ts` (`kabane`) says what it may list. It is
the only package that depends on `@cabane/sqlite` at runtime. Two named exceptions remain: the
dependency on `@cabane/loop`, which JCAB-326 removes (never add an import from `extensions/`),
and `src/update-process.ts` importing `../../core/result` by relative path, which JCAB-334
removes.

A first-party data module is registered in `MODULES` and in `packages/worker/src/hub.ts`. What
core needs from the device reaches it through a port wired in `configureRuntime`, never by core
reading the environment (`CODING_PRINCIPLE.md`, "Explicit dependencies").

Most of the extension API lands here; check main before editing these files:

- The extension contract includes `mcp` and `doctor`; the `doctor` runner is in
  `packages/extension/doctor.ts`. The CLI `doctor` command remains separate work.
- `src/extensions.ts` loads enabled directories from `$KABANE_HOME/extensions` before the bundled
  fallback. `loadAll(names, home)` returns `loaded` and `refused`; callers must consume both.
  Help, commands and MCP report refusals on stderr; the board uses its announcer. A disabled
  directory is discovered without importing it, including during command lookup and config.
  The manifest API and the resolved entry path are checked before import, and the factory
  result is validated before its contributions are accepted. A directory named `loop` overrides
  the bundled fallback. Manifests naming data modules are refused until JCAB-323 adds
  registration and its database gate.
- JCAB-322 builds the `host` object; JCAB-323 splits `openContext` into the stages
  `ARCHITECTURE.md` lists under "Every process that opens the database registers the same
  modules".
- JCAB-328 moves scope detection, `Self` and `serveStdio` from core into this package.
- JCAB-326 removes `OFFICIAL` and the loop dependency.

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
  and no database opened (`src/main.ts:183`); `mcp` is standalone and calls `openContext`
  itself.
- A command added to `src/commands/` and not to `COMMANDS`, or to both and not to the README's
  command list.
- Record logic written into a command. It belongs in core or a data module, where the hub and
  the MCP tools reach it too.
- A device config tool registered where the hub would serve it. Config tools are stdio only.
