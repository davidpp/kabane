# @cabane/acp

Agent Client Protocol client for the board copilot. It launches one coding harness
(Claude Code, Codex, or Gemini) as a subprocess, speaks ACP to it over stdio, and turns a
prompt into a stream of cabane's own updates. The board consumes that stream and never
imports the SDK.

## Pieces

- `Harnesses` — registry of launch commands with pinned adapter versions
  (`claude` → `npx -y @agentclientprotocol/claude-agent-acp@0.76.0`,
  `codex` → `npx -y @agentclientprotocol/codex-acp@1.11.0`, `gemini` → `gemini --acp`).
  `resolve(id, overrides?)` returns `{ command, args, env }`; the env always carries
  `CABANE_SESSION=1` so user hooks can tell a board session from an interactive one.
  `acceptsSystemPrompt(id)` is true only for Claude, the one adapter that reads
  `_meta.systemPrompt` on `session/new`.
- `Stdio` — the two adapters between `Bun.spawn` and the SDK's `ndJsonStream`:
  `stdinSink(FileSink)` wraps Bun's piped stdin as a `WritableStream`, and `jsonLines()` drops
  the log lines harnesses interleave with JSON-RPC on stdout.
- `AcpClient` — `spawn(harness, cwd, { onPermission })` starts the process and runs
  `initialize` (30 s cap, stderr attached on failure); `newSession(conn, { cwd, mcpServers,
  systemPromptAppend? })` opens a session with stdio MCP servers; `prompt(session, blocks)` is a
  lazy `AsyncIterable<Update>`; `cancel(session)`; `close(conn)` kills the process.
  `connect(harness, transport, options)` takes an SDK `Stream` or an in-process `AgentApp`,
  which is how the tests run without a subprocess.

## Updates

```ts
type Update =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; id; title; kind?; status? }
  | { type: "tool_call_update"; id; title?; status? }
  | { type: "plan"; entries: { content; status }[] }
  | { type: "stop"; reason: string }
  | { type: "error"; message: string };
```

Every turn ends with exactly one `stop` or one `error`.

## Rules

- Harness defaults are inherited whole: no `fs` or `terminal` capability is advertised, no
  permission policy is applied. A `session/request_permission` goes to the caller's
  `onPermission`; a failed callback answers `cancelled`. Nothing is ever auto-answered.
- Cancel before the agent has seen the turn (the iterator was not started yet) never sends
  `session/cancel`; the turn stops as `cancelled` locally.
- Every SDK call that can reject comes back as a `Result` or an `error` update.

## Verify

```bash
bun test packages/acp                       # in-process agent, no npx
bun run packages/acp/scripts/smoke.ts claude  # real adapter; needs a logged-in claude
```
