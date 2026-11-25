# @kabane/acp

The harness client: it launches a coding harness (Claude Code, Codex, Gemini) as a subprocess,
speaks the Agent Client Protocol to it over stdio, and turns a turn into kabane's own `Update`
union so nothing downstream imports the ACP SDK. `README.md` describes every piece, the session
modes, models, named agents, notices, the update union and the rules; read the parts your
change touches.

## Verify

```bash
bun test packages/acp                          # in-process agent; client.harness.test.ts opens a real
                                               # session on claude and codex when installed, no prompt
bun run packages/acp/scripts/smoke.ts claude   # a real adapter and one turn; needs a logged-in claude
```

For the copilot, drive the board under tmux with `bun run sandbox --scripted board`, as the root
`AGENTS.md` shows. A change to how a harness's asks, forms or permissions arrive also needs one
run against a real harness, which an agent here cannot log in to: put it on the manual list.

## Mistakes that are easy to make here

- Answering a permission request or a form for the human, adding a timeout that does, or
  advertising `fs` or `terminal`. Kabane has no permission policy; every request goes to the
  caller's callback (README, "Rules").
- Recognising a write from a tool call's result. The two adapters put MCP results in different
  places; a write is recognised from the title.
- Bumping a pinned adapter version without reading its mode and model ids again: the tables in
  the README name the ids each pinned version advertises.
