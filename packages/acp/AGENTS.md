# @cabane/acp

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
| `BoardCopilot` (`src/copilot.ts`), with its internal `Mailbox` (`src/mailbox.ts`) | the CLI's board runtime (`packages/cli/src/commands/board-runtime.ts`) |
| `CopilotInstructions` (`src/instructions.ts`) | the copilot; the loop reads `actorUri`, `SERVER_NAME` and `DISPATCH_TEMPLATE` |
| `templates/dispatch`, `templates/grill` | the copilot's `/setup-dispatch` and grill procedures |
| `scripts/scripted-agent.ts` | `bun run sandbox --scripted`, and tests that need a harness subprocess |

## It depends on core alone, and today it also imports the board

Its layer is `harness client`; its entry in `scripts/layers.ts` (`"@cabane/acp"`) says what it
may list. The entry carries an exception, `@cabane/board`, for the imports in
`src/client.ts`, `copilot.ts`, `tool-calls.ts` and `instructions.ts`. Never add another. The
loop's dependency on this package is allowed and stays: an extension bundles its own harness
client (`ARCHITECTURE.md`, the fourth narrowing under the layer table).

This package is about to change shape; check main before you edit the files these name:

- JCAB-320 moves `copilot.ts`, `instructions.ts` and `mailbox.ts` into the board and brings the
  form field types here (`ARCHITECTURE.md`, "Ports").
- JCAB-324 takes the loop's procedure and shortcut out of `instructions.ts`.
- JCAB-327 moves `templates/` out of base kabane.
- JCAB-328 moves `Self` (`@cabane/core/self`, read by `copilot.ts` and `instructions.ts`) into
  the host, which then passes the path as an argument.

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
