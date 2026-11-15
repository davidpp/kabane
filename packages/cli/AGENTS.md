# kabane (packages/cli)

The host on a device: the `kabane` command, `kabane mcp` over stdio, the board's runtime and
everything that reads this machine (config, settings layers, scope, harness configs, updates).
Every command is a thin parser over core and the data modules. `README.md` describes the
commands, the config and the settings layers.

| Where | What it holds |
|---|---|
| `src/main.ts` | `COMMANDS`, the built-in command table; help; exit codes (0 ok, 1 error, 2 usage); `run(argv, env, cwd)` |
| `src/commands/*.ts` | one file per command, each a `Command` |
| `src/context.ts` | `MODULES`, `configureRuntime`, `openContext` (the `Ctx` every command gets), scope selection |
| `src/config*.ts` | `config.json`, the settings layers, `kabane config`, and the device config tools only `kabane mcp` serves (`config-tools.ts`) |
| `src/extensions.ts` | the official extensions (`OFFICIAL`), loaded only when a command or the board needs one |
| `src/commands/board-runtime.ts` | builds the board's ports and the copilot, then calls `startBoard` |
| `src/first-run.ts`, `src/mcp-clients.ts`, `src/update-*.ts` | the setup screen, MCP registration in harness configs, self-update |

## It is the host, so it may depend on everything below it and nothing beside it

Its layer is `host`; its entry in `scripts/layers.ts` (`kabane`) says what it may list. It is
the only package that depends on `@cabane/sqlite` at runtime. Its dependency on
`@cabane/loop` is a named exception that JCAB-326 removes; never add a new import from
`extensions/`. The `relativeImports` exceptions in that entry are test fixtures and
`src/update-process.ts` reaching into core by path; JCAB-331 and JCAB-334 remove them, and
`bun run layers` fails any new one.

A data module is registered in `MODULES` and in `packages/worker/src/hub.ts`, in the same
order. Something core needs from the device (a file read, the process's own path) reaches it
through a port wired in `configureRuntime`, never by core reading the environment
(`CODING_PRINCIPLE.md`, "Explicit dependencies").

This package is where most of the extension API lands, so expect these files to move under you
and check main first:

- In flight now: JCAB-275 (`kabane mcp` serves extension tools, `src/commands/mcp.ts`), JCAB-263
  (a `doctor` command, on its own branch), JCAB-331 (test fixtures).
- JCAB-321 rewrites `src/extensions.ts` and the board's refusal in `board-runtime.ts`: kabane
  loads extensions from `$KABANE_HOME/extensions`, and a broken one is skipped.
- JCAB-322 builds the `host` object; JCAB-323 splits `openContext` into the stages
  `ARCHITECTURE.md` lists under "Every process that opens the database registers the same
  modules".
- JCAB-328 moves scope detection, `Self` and `serveStdio` from core into this package.
- JCAB-326 removes `OFFICIAL` and the loop dependency.

Read before writing: `src/main.ts`, `src/context.ts`, and one command with its test
(`src/commands/checklist.ts`, `src/commands/checklist.test.ts`).

## Verify

```bash
bun test packages/cli                 # cli.test.ts runs every command against the real entry
bun run sandbox <command> [args]      # the real command on a throwaway KABANE_HOME and repo
bun run sandbox mcp                   # kabane mcp over stdio: initialize, then tools/call
bun run sandbox --scripted board      # under tmux, as the root AGENTS.md shows
```

A change to setup, MCP registration or anything that writes a harness's config is checked with
`bun run sandbox --harnesses`, which points the harnesses' HOME into the sandbox.

## Mistakes that are easy to make here

- A test or a check that runs with the real `KABANE_HOME` or the real harness configs. Tests
  give each run a temp `KABANE_HOME` and `KABANE_HARNESSES: ""` (see `checklist.test.ts`).
- A command added to `src/commands/` and not to `COMMANDS`, or to both and not to the README's
  command list and `--help` text.
- Logic a second host would need written into a command. Record operations belong in core or a
  data module, where the hub and the MCP tools reach them too.
- A device config tool registered where the hub would serve it. Config tools are stdio only.
