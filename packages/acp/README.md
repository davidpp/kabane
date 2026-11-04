# @cabane/acp

Agent Client Protocol client for the board copilot. It launches one coding harness
(Claude Code, Codex, or Gemini) as a subprocess, speaks ACP to it over stdio, and turns a
prompt into a stream of kabane's own updates. The board consumes that stream and never
imports the SDK.

`BoardCopilot` is the piece the board actually holds: the `Copilot` port from
`@cabane/board`, implemented over one lazily started session whose only tool server is
`kabane mcp`.

## Pieces

- `Harnesses` — registry of launch commands with pinned adapter versions
  (`claude` → `npx -y @agentclientprotocol/claude-agent-acp@0.99.1`,
  `codex` → `npx -y @agentclientprotocol/codex-acp@2.5.0`, `gemini` → `gemini --acp`).
  `resolve(id, overrides?)` returns `{ command, args, env }`; the env always carries
  `KABANE_SESSION=1` so user hooks can tell a board session from an interactive one,
  and for Claude `ANTHROPIC_MODEL=sonnet` — a board turn is triage against a planner,
  not what the frontier models are for, and the adapter reads that variable ahead of
  the human's own `settings.json`. `overrides.model` replaces it with any name the
  harness takes (`opus`, a full id) and rides through a `command` override, the model
  being a property of the harness rather than of how it is launched. The other two
  get none: Gemini reads `GEMINI_MODEL` but nothing pins it yet, and codex-acp reads no
  model variable. `acceptsSystemPrompt(id)` is true only for Claude, the one
  adapter that reads `_meta.systemPrompt` on `session/new`. All of that is the
  copilot's profile, `COPILOT`, and the default: `resolve`'s third argument is a
  `Profile` (`pinModel`, `env`) for another launcher, such as the loop, which runs the
  user's own default model under its own env marker. A profile has no allow list or
  settings file, and `onPermission` hands every request to the caller, which never answers
  one for the human. `modes(id)` names the adapter's manual and auto session modes (see
  Session modes). `installedCli(id)` is the env
  that points an adapter at the CLI on PATH instead of the copy it bundles
  (`CLAUDE_CODE_EXECUTABLE` for claude-agent-acp, `CODEX_PATH` for codex-acp), nothing
  when the user's environment already sets that variable or the harness has no adapter
  (Gemini, whose launch command is the CLI), and an error when that CLI is not installed. `AcpClient.spawn` takes the profile as
  `profile`.
- `Stdio` — the two adapters between `Bun.spawn` and the SDK's `ndJsonStream`:
  `stdinSink(FileSink)` wraps Bun's piped stdin as a `WritableStream`, and `jsonLines()` drops
  the log lines harnesses interleave with JSON-RPC on stdout.
- `AcpClient` — `spawn(harness, cwd, { onPermission })` starts the process and runs
  `initialize` (30 s cap, stderr attached on failure); `newSession(conn, { cwd, mcpServers,
  systemPromptAppend?, mode? })` opens a session with stdio MCP servers in the mode
  `session.mode` reports; `prompt(session, blocks)` is a
  lazy `AsyncIterable<Update>`; `cancel(session)`; `close(conn)` kills the process.
  `steer(session, blocks)` puts text into the turn the session is running through the
  `_session/steering` extension method, for a harness whose `initialize` advertised
  `_meta.steering.supported` (`conn.steering`; both pinned adapters do, Gemini does not). It
  asks an idle session to hand the text back (`idleBehavior: promptRequired`), so the result
  says where the text went: `injected`, `prompt_required` (the caller sends it as a prompt),
  or `new_turn` from an adapter that ignores the hint and starts a turn of its own (both
  pinned adapters honour it).
  `connect(harness, transport, options)` takes an SDK `Stream` or an in-process `AgentApp`,
  which is how the tests run without a subprocess.
- `CopilotInstructions` — the instruction block, the `/` shortcut templates, and
  `actorUri(harness)`, the `cabane://actor/agent/<harness>` every write of a session is
  stamped with. `DISPATCH_TEMPLATE` is the absolute path of `templates/dispatch/`, the generic
  dispatch skill `/setup-dispatch` fills from a project's own instructions and writes under its
  `.claude/skills/dispatch/` — the copilot's one allowed file write. `PLACEHOLDERS.md` there
  says what fills each `{{NAME}}` and is never copied.
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
  scopeDir: "/repos/myapp",         // the session cwd, so the harness reads the project's own rules
  scopeUri: "jake://scope/myapp",   // omit on an all-scopes board
  kabaneBin: "/usr/local/bin/kabane", // defaults to this process's entry script
});
```

Nothing is spawned until the first `run`. The session opens with one stdio MCP server,
`kabane mcp --scope <uri> --as cabane://actor/agent/<harness>`, so every write goes through
the same tools and database the board reads and arrives stamped as an agent's.

What the harness is told:

- The instruction block goes out twice on Claude and once everywhere else — as
  `_meta.systemPrompt.append` on `session/new` where the adapter reads it, and as the first
  text block of the session's first prompt, which is the channel every harness has. An
  adapter that ignores `_meta` would otherwise run with no instructions at all.
- The tool loop is not restated: the kabane MCP server sends `SERVER_INSTRUCTIONS` on
  initialize, and the block points at it.
- Every prompt is preceded by `BoardContext.render(context)` — the board's scope, view,
  section, filters, selected row, marked set, and the assembled briefs. It is refreshed each
  turn, so "these", "here" and "the selection" always mean what is on screen now.

What comes back, as the port's `CopilotUpdate`:

| Harness update | Port update |
|---|---|
| `text`, `thought` | one `text` / `thought` per MESSAGE: ACP streams these as deltas, and a run of them is joined until something else happens |
| `tool_call` | `tool_call` (plus `tool_result` when it already completed a write) |
| `tool_call_update`, completed, on a `kabane_*` write tool | `tool_result` → the board reloads |
| `plan` | `plan` → the pane and the transcript show the agent's todo, the footer counts it |
| `session/request_permission` | `permission` → the board asks, and `answerPermission` unblocks the turn |
| `usage` (from `usage_update`) | nothing: the copilot shows no meter; the loop extension reads it for its budget |
| `stop`, `error` | `done`, `error` |

A write is recognised by the tool call's **title**, never by its result: the two adapters
disagree on where MCP results land, so the title is scanned for a `kabane_*` write tool name
(`add`, `edit`, `done`, `link`, `comment`, `log`, `contextAdd`, `contextRemove`), which also
survives a namespaced `mcp__kabane__kabane_edit`. Reads trigger no reload.

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

## Session modes

A session starts in the harness's own auto mode, where the harness decides which tool calls
need a human, instead of asking before every read and edit. It is selected through ACP. The
spec has Session Config Options supersede Session Modes, so `newSession` (and `resumeSession`)
looks first for a `category: "mode"` select option on `session/new` and switches it with
`session/set_config_option`; only a harness that sends `modes` alone gets `session/set_mode`.
Both pinned adapters send the option (claude-agent-acp mirrors its modes into one with id
`mode`); Gemini sends modes only. `session.mode.via` says which path the session took
(`config_option` or `set_mode`). The ids, as the pinned adapters advertise them:

| Harness | Manual | Auto | Others |
| --- | --- | --- | --- |
| claude-agent-acp 0.99.1 | `default` ("Manual") | `auto` ("Claude handles permission decisions") | `acceptEdits`, `plan`, `bypassPermissions` |
| codex-acp 2.5.0 | `read-only` (a read-only sandbox) | `agent` ("Auto review"), where a session opens | `workspace-write`, `agent-full-access` |
| gemini | not named | not named | |

The switch happens only from the manual mode: a session that opens in any other mode got it
from the user's own harness settings or from the harness itself, and keeps it. The note does
not guess which: Claude opens in `acceptEdits` when the settings ask for `auto` on a model
without it, and says so in a notice. Gemini has no auto id here, so it stays on whatever it
starts in. A harness that does not advertise the id, or refuses the switch, stays where it
opened; none of these fails the session, and `session.mode.note` says which happened. A
config option answers with where the session landed, which is not always auto: Claude on a
model without auto lands on `acceptEdits`, the note says so, and the harness's own notice
gives the reason in the first turn. `mode: "default"` selects nothing. A mode is the
harness's own policy, not kabane's: whatever it still asks reaches `onPermission` as before.

A `current_mode_update`, or a `config_option_update` whose mode option holds a mode the session
is not in, is a `mode` update; the echo of the switch `newSession` made and an update that
repeats the current mode are not.

## Notices

`initialize` advertises `clientCapabilities.session.notices`, so a harness sends what it wants
the human to know outside the agent's reply (a mode it fell back from, a model it swapped) as
a `notice` session update rather than as a bold line in the agent's text. It reaches the caller
as `{ type: "notice"; severity; text }`, with `text` the notice's title and description as one
line. The copilot shows it as a step of the turn; the loop records it as a `notice` run event.

## Updates

```ts
type Update =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; id; title; kind?; status? }
  | { type: "tool_call_update"; id; title?; status? }
  | { type: "plan"; entries: { content; status }[] }
  | { type: "usage"; used: number; size: number; cost?: { amount; currency } }
  | { type: "mode"; id: string }
  | { type: "notice"; severity: string; text: string }
  | { type: "stop"; reason: string }
  | { type: "error"; message: string };
```

Every turn ends with exactly one `stop` or one `error`.

## Rules

- Harness defaults are inherited whole, apart from the move from manual to the harness's own
  auto mode: no `fs` or `terminal` capability is advertised, no permission policy is applied. A `session/request_permission` goes to the caller's
  `onPermission`; a failed callback answers `cancelled`. Nothing is ever auto-answered — kabane
  has no permission policy of its own and does not want one.
- Cancel before the agent has seen the turn (the iterator was not started yet) never sends
  `session/cancel`; the turn stops as `cancelled` locally.
- Every SDK call that can reject comes back as a `Result` or an `error` update.

## Verify

```bash
bun test packages/acp                       # in-process agent; client.harness.test.ts opens a
                                            # real session (no prompt) per installed CLI
bun run packages/acp/scripts/smoke.ts claude  # real adapter; needs a logged-in claude
```
