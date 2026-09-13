# @cabane/acp

Agent Client Protocol client for the board copilot. It launches one coding harness
(Claude Code, Codex, or Gemini) as a subprocess, speaks ACP to it over stdio, and turns a
prompt into a stream of cabane's own updates. The board consumes that stream and never
imports the SDK.

`BoardCopilot` is the piece the board actually holds: the `Copilot` port from
`@cabane/board`, implemented over one lazily started session whose only tool server is
`cabane mcp`.

## Pieces

- `Harnesses` — registry of launch commands with pinned adapter versions
  (`claude` → `npx -y @agentclientprotocol/claude-agent-acp@0.76.0`,
  `codex` → `npx -y @agentclientprotocol/codex-acp@1.11.0`, `gemini` → `gemini --acp`).
  `resolve(id, overrides?)` returns `{ command, args, env }`; the env always carries
  `CABANE_SESSION=1` so user hooks can tell a board session from an interactive one,
  and for Claude `ANTHROPIC_MODEL=sonnet` — a board turn is triage against a planner,
  not what the frontier models are for, and the adapter reads that variable ahead of
  the human's own `settings.json`. `overrides.model` replaces it with any name the
  harness takes (`opus`, a full id) and rides through a `command` override, the model
  being a property of the harness rather than of how it is launched. The other two
  adapters get none: their variables are not documented here, and a guess would pin a
  model silently wrong. `acceptsSystemPrompt(id)` is true only for Claude, the one
  adapter that reads `_meta.systemPrompt` on `session/new`.
- `Stdio` — the two adapters between `Bun.spawn` and the SDK's `ndJsonStream`:
  `stdinSink(FileSink)` wraps Bun's piped stdin as a `WritableStream`, and `jsonLines()` drops
  the log lines harnesses interleave with JSON-RPC on stdout.
- `AcpClient` — `spawn(harness, cwd, { onPermission })` starts the process and runs
  `initialize` (30 s cap, stderr attached on failure); `newSession(conn, { cwd, mcpServers,
  systemPromptAppend? })` opens a session with stdio MCP servers; `prompt(session, blocks)` is a
  lazy `AsyncIterable<Update>`; `cancel(session)`; `close(conn)` kills the process.
  `connect(harness, transport, options)` takes an SDK `Stream` or an in-process `AgentApp`,
  which is how the tests run without a subprocess.
- `CopilotInstructions` — the instruction block, the `/` shortcut templates, and
  `actorUri(harness)`, the `cabane://actor/agent/<harness>` every write of a session is
  stamped with.
- `Mailbox` — a one-consumer queue whose `filled()` is already settled when something is
  waiting. `BoardCopilot` drains it alongside the harness's stream, which is the only way a
  permission request can reach the board while the agent is blocked on the answer.
- `BoardCopilot` — `create(options)` returns the board's `Copilot` plus a `close()` for the
  board's teardown to kill the harness with. It carries that same actor uri as the port's
  `actor`, which is how the board glyphs the rows this session wrote.

## The copilot

```ts
const copilot = BoardCopilot.create({
  harness: "claude",
  scopeDir: "/repos/cabane",        // the session cwd, so the harness reads the project's own rules
  scopeUri: "jake://scope/cabane",  // omit on an all-scopes board
  cabaneBin: "/usr/local/bin/cabane", // defaults to this process's entry script
});
```

Nothing is spawned until the first `run`. The session opens with one stdio MCP server,
`cabane mcp --scope <uri> --as cabane://actor/agent/<harness>`, so every write goes through
the same tools and database the board reads and arrives stamped as an agent's.

What the harness is told:

- The instruction block goes out twice on Claude and once everywhere else — as
  `_meta.systemPrompt.append` on `session/new` where the adapter reads it, and as the first
  text block of the session's first prompt, which is the channel every harness has. An
  adapter that ignores `_meta` would otherwise run with no instructions at all.
- The tool loop is not restated: the cabane MCP server sends `SERVER_INSTRUCTIONS` on
  initialize, and the block points at it.
- Every prompt is preceded by `BoardContext.render(context)` — the board's scope, view,
  section, filters, selected row, marked set, and the assembled briefs. It is refreshed each
  turn, so "these", "here" and "the selection" always mean what is on screen now.

What comes back, as the port's `CopilotUpdate`:

| Harness update | Port update |
|---|---|
| `text`, `thought` | one `text` / `thought` per MESSAGE: ACP streams these as deltas, and a run of them is joined until something else happens |
| `tool_call` | `tool_call` (plus `tool_result` when it already completed a write) |
| `tool_call_update`, completed, on a `cabane_*` write tool | `tool_result` → the board reloads |
| `plan` | `plan` → the pane and the transcript show the agent's todo, the footer counts it |
| `session/request_permission` | `permission` → the board asks, and `answerPermission` unblocks the turn |
| `stop`, `error` | `done`, `error` |

A write is recognised by the tool call's **title**, never by its result: the two adapters
disagree on where MCP results land, so the title is scanned for a `cabane_*` write tool name
(`add`, `edit`, `done`, `link`, `comment`, `log`, `contextAdd`, `contextRemove`), which also
survives a namespaced `mcp__cabane__cabane_edit`. Reads trigger no reload.

A permission request is carried to the human, never answered here. `session/request_permission`
becomes a `permission` update on the port and the ACP callback's promise is held open until the
board calls `answerPermission(id, optionId | null)` — an option id selects it, `null` answers
`cancelled`. Nothing is ever auto-allowed and there is no timeout; `cancel` and `close` let go of
whatever is outstanding with a decline, so a turn nobody answered is still cancellable and the
harness is never left holding a promise that cannot settle.

That update cannot ride the harness's own stream, which is why `Mailbox` exists: the request
arrives on its own JSON-RPC call and the agent is blocked on the answer, so no further session
update can come until it has one. `run` drains the mailbox and the stream together, taking
whichever settles first.

In practice the harness runs under the human's own permission mode, so a permissive one
(`--permission-mode auto`) never asks at all.

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
  `onPermission`; a failed callback answers `cancelled`. Nothing is ever auto-answered — cabane
  has no permission policy of its own and does not want one.
- Cancel before the agent has seen the turn (the iterator was not started yet) never sends
  `session/cancel`; the turn stops as `cancelled` locally.
- Every SDK call that can reject comes back as a `Result` or an `error` update.

## Verify

```bash
bun test packages/acp                       # in-process agent, no npx
bun run packages/acp/scripts/smoke.ts claude  # real adapter; needs a logged-in claude
```
