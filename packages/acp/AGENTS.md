# @kabane/acp

The harness client: it launches a coding harness (Claude Code, Codex, Gemini) as a subprocess,
speaks the Agent Client Protocol to it over stdio, and turns a turn into kabane's own `Update`
union so nothing downstream imports the ACP SDK. `README.md` describes every piece, the session
modes, models, named agents, notices, the update union and the rules; read the parts your
change touches.

| Piece | Who calls it |
|---|---|
| `Harnesses` (`src/harnesses.ts`): launch commands, pinned adapter versions, profiles, mode ids | the loop, the CLI's config and MCP registration, the copilot |
| `AcpClient` (`src/client.ts`): spawn, sessions, prompt, steer, cancel, permissions and forms | the loop, the copilot |
| `ToolCalls` (`src/tool-calls.ts`): folds tool call updates | the loop, the copilot |
| `Stdio` (`src/stdio.ts`): `Bun.spawn` pipes to the SDK's stream | `AcpClient` |
| `FormField` (`src/form-field.ts`) and form types | the board and the loop, also through the SDK-free `/form-field` export |
| `CopilotInstructions` (`src/instructions.ts`): `actorUri`, `SERVER_NAME` | the board's copilot |
| `scripts/scripted-agent.ts` | `bun run sandbox --scripted`, and tests that need a harness subprocess |

## It depends on core alone

Its layer is `harness client`; its entry in `scripts/layers.ts` (`"@kabane/acp"`) says what it
may list. The board and loop both use it as a library; it imports neither of them.
`BoardCopilot`, `Mailbox` and the copilot's prose live in `packages/board/src`. It ships no
template: the dispatch and grill skills are `extensions/dispatch`'s.

Read before writing: `src/client.ts`, `src/harnesses.ts`, `src/client.test.ts` (an in-process
`AgentApp`, no subprocess).

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
- Sending in `prompt()` before the caller iterates. It is lazy on purpose, so a cancel before
  the first iteration never reaches the harness (`src/client.ts:983`).
- Recognising a write from a tool call's result. The two adapters put MCP results in different
  places; a write is recognised from the title.
- Bumping a pinned adapter version without reading its mode and model ids again: the tables in
  the README name the ids each pinned version advertises.
