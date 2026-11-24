# kabane (packages/cli)

The host on a device: the `kabane` command, `kabane mcp` over stdio, the board's runtime and
everything that reads this machine (config, settings layers, scope, harness configs, updates).
The record commands (`add`, `edit`, `list`, `checklist`, ...) are thin parsers over core and the
data modules; setup, configuration, updates and the board's runtime are the host's own code.
`README.md` describes the commands, the config and the settings layers.

The extension loader, the modules stages and `host` implement `ARCHITECTURE.md`, "Extension API
v1" and the sections after it; read the one your change touches.

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
