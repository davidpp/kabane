# @kabane/acp

Agent Client Protocol client used by the board’s copilot and the loop. It launches one coding harness
(Claude Code, Codex, or Gemini) as a subprocess, speaks ACP to it over stdio, and turns a
prompt into a stream of kabane's own updates. The board consumes that stream and never
imports the SDK.

The board's `BoardCopilot` uses this package as a library; its implementation and
instructions live in `@kabane/board` (see [the board README](../board/README.md#the-acp-copilot)).

## Pieces

- `Harnesses` — registry of launch commands with pinned adapter versions
  (`claude` → `npx -y @agentclientprotocol/claude-agent-acp@0.100.0`,
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
  `Profile` (`pinModel`, `env`) for another launcher, such as the loop, which pins no model
  in the env and runs under its own env marker. A profile has no allow list or
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
  `initialize` (30 s cap, stderr attached on failure; a `signal` aborted before the harness
  answers kills it and fails the start once it has exited); `newSession(conn, { cwd, mcpServers,
  systemPromptAppend?, mode? })` opens a session with stdio MCP servers in the mode
  `session.mode` reports; `prompt(session, blocks)` is a
  lazy `AsyncIterable<Update>`; `cancel(session)`; `close(conn)` closes the harness's stdin,
  gives it 2 s to exit, then sends SIGTERM and SIGKILL to its process group (the harness runs in
  its own, so an npx wrapper's adapter goes with it), and settles once it has exited.
  `steer(session, blocks)` puts text into the turn the session is running through the
  `_session/steering` extension method, for a harness whose `initialize` advertised
  `_meta.steering.supported` (`conn.steering`; both pinned adapters do, Gemini does not). It
  asks an idle session to hand the text back (`idleBehavior: promptRequired`), so the result
  says where the text went: `injected`, `prompt_required` (the caller sends it as a prompt),
  or `new_turn` from an adapter that ignores the hint and starts a turn of its own (both
  pinned adapters honour it).
  `connect(harness, transport, options)` takes an SDK `Stream` or an in-process `AgentApp`,
  which is how the tests run without a subprocess. `options.onElicitation`, passed only by a
  launcher with a human to ask, is what makes the client advertise form elicitation (see
  Rules); `toElicitationRequest` is the form-to-fields mapping it applies.
- `CopilotInstructions` — `actorUri` and `SERVER_NAME`.
- `FormField` and the form types — typed answer validation shared by the board and the loop.
  `@kabane/acp/form-field` is a light entry point with no ACP SDK on its import path.

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
| claude-agent-acp 0.100.0 | `default` ("Manual") | `auto` ("Claude handles permission decisions") | `acceptEdits`, `plan`, `bypassPermissions` |
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

## Session models

Both pinned adapters advertise their model as a `category: "model"` select option on
`session/new`, with the values the user's own CLI lists (claude-agent-acp: `default`, `opus`,
`sonnet`, `haiku` and full ids; codex-acp: the Codex model ids). A `model` in `newSession`'s or
`resumeSession`'s options is selected through `session/set_config_option`, on every harness,
before the mode is negotiated, since the model decides which modes the harness offers (Claude
has no auto mode on some models); this is how the loop applies its `model` setting.
`session.model` says what came of it. A harness with no model option, a value it does not
list, or a switch it refuses leaves the session on the model it opened with, and an answer
that names no model leaves it unconfirmed: `applied` is false and `note` says why. It never
fails the session.

## Named agents

An `agent` in `newSession`'s or `resumeSession`'s options runs the session's main thread as one
of the harness's own named agents, where the harness can select one; this is how the loop
applies a subtask's `agent:` tag. Only Claude can: the pinned adapter takes it as
`_meta.claudeCode.options.agent` (the Agent SDK's `agent`, the CLI's `--agent`) and reports
the agent it runs on its `agent` config option, which it lists only when the user has agents of
their own. `session.agent` says what came of it: an agent the harness does not have runs its
default agent, and a harness with no way to select one (codex-acp 2.5.0 takes no agent or
profile per session) runs without it; `applied` is false and `note` says why.

`Harnesses.agentDefinition(id, name, cwd)` finds the agent's definition as a session in `cwd`
would (Claude: `.claude/agents/*.md` from `cwd` up, then `~/.claude/agents`), and the model its
frontmatter pins (`inherit` is no pin). It is read from the file because the session's model
option goes on naming the session's own model while a pinned agent's turns run on its pin.

## Notices

`initialize` advertises `clientCapabilities.session.notices`, so a harness sends what it wants
the human to know outside the agent's reply (a mode it fell back from, a model it swapped) as
a `notice` session update rather than as a bold line in the agent's text. It reaches the caller
as `{ type: "notice"; severity; text }`, with `text` the notice's title and description as one
line and `severity` ACP's open-ended value read as `info`, `warning` or `error`. The loop records it as a `notice` run event; the copilot's mapping is in the board README.

## Updates

```ts
type Update =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; id; title; kind?; status?; content?; input?; output? }
  | { type: "tool_call_update"; id; title?; kind?; status?; content?; input?; output? }
  | { type: "plan"; entries: { content; status }[] }
  | { type: "usage"; used: number; size: number; cost?: { amount; currency } }
  | { type: "mode"; id: string }
  | { type: "notice"; severity: "info" | "warning" | "error"; text: string }
  | { type: "commands"; commands: { name; description; hint? }[] }
  | { type: "stop"; reason: string }
  | { type: "error"; message: string };
```

A `tool_call_update` carries only the fields that moved, and one it carries replaces the old
value whole; `ToolCalls.apply` folds them back into the call. `content` is what the call shows:
`{ type: "text"; text }` or `{ type: "diff"; path; oldText?; newText }` (`oldText` absent for a
created file), with terminals and images left out. `input` and `output` are the harness's raw
arguments and result, in whatever shape it chose.

Every turn ends with exactly one `stop` or one `error`.

## Rules

- Harness defaults are inherited whole, apart from the move from manual to the harness's own
  auto mode: no `fs` or `terminal` capability is advertised, no permission policy is applied. A `session/request_permission` goes to the caller's
  `onPermission`; a failed callback answers `cancelled`. Nothing is ever auto-answered — kabane
  has no permission policy of its own and does not want one.
- A harness form (`elicitation/create`, form mode) goes to `onElicitation` as an
  `ElicitationRequest`: the message, then each field with its title and description verbatim,
  as `text`, `number`, `boolean`, `choice` (one option) or `choices` (several). The answer is
  `accept` with the fields the human answered, `decline` or `cancel`; a failed callback answers
  `cancel`. `elicitation: { form: {} }` is advertised only when a handler is passed: without
  it claude-agent-acp turns AskUserQuestion off and codex-acp its `request_user_input` forms,
  which is right for a launcher nobody watches. URL elicitation is never advertised, and a
  form that requires a field of a type kabane cannot ask is answered `cancel` unasked; the
  reason, naming the form and the field, goes to `onElicitationRefused`, which the board
  copilot shows as an error notice and the loop records as a `notice` event.
- Both callbacks get an `AbortSignal` that aborts when the harness withdraws the request
  (`$/cancel_request`) or the connection closes. The request is then answered `cancelled` /
  `cancel` at once, whatever the callback does after, so the caller can close what it asked.
- Cancel before the agent has seen the turn (the iterator was not started yet) never sends
  `session/cancel`; the turn stops as `cancelled` locally.
- Every SDK call that can reject comes back as a `Result` or an `error` update.

## Verify

```bash
bun test packages/acp                       # in-process agent; client.harness.test.ts opens a
                                            # real session (no prompt) per installed CLI
bun run packages/acp/scripts/smoke.ts claude  # real adapter; needs a logged-in claude
```
