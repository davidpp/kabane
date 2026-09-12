# AI in the cabane TUI: light integration

Research note, 2026-09-11 (revised the same day after scoping with David). Question: people
will not code inside cabane, but the board should let a human use AI for issue management
(planning confirmation, spring cleaning, triage, refining, splitting, linking). What is worth
building in the TUI, and how do we bring harness support in without rebuilding an orchestrator?

Inputs: the cabane board and core as they stand today, Jake's harness history
(`~/Projects/jake`), desk-copilot's ACP integration (`~/Projects/botpress/desk-copilot`), and
prior art (Linear, beads / Gas Town / bv, GitHub Copilot coding agent, Vibe Kanban, ACP).

## TL;DR

1. **Phase 1 is a board copilot, not dispatch.** An ACP (Agent Client Protocol) session runs
   inside the board so the agent knows what David is looking at: scope, section, filter,
   selected row, a marked set. That context is what a native harness cannot have and what
   makes a better-than-chat UX possible. Coding stays in the native harness on the left; `y`
   copies the brief. ACP lags native harnesses, which does not matter for a copilot that only
   needs prompt, streaming text, MCP injection and cancel.
2. **Cabane's core is already Linear-shaped.** Sessions, typed activities, `needsReview`,
   actor URIs, `assignee` as the claim. What is missing is TUI write paths and the client.
3. **Inherit harness defaults; add only a prompt.** No sandboxing, no capability games, no
   permission policy of our own. The user's harness settings apply (auto mode stays auto).
   Cabane contributes a copilot instruction block: Claude via `_meta.systemPrompt.append`,
   every harness via the first prompt of the session and `cabane mcp` injected as a tool
   server.
4. **The TUI is the recorder, later the dispatcher, never the orchestrator.** Dispatch,
   session recording and question answering stay behind the existing `Dispatcher` and
   `ActivitySource` ports for a later phase. Jake's own research and Gas Town's critics agree
   that orchestration is commodity.
5. **MCP-side improvements are logged separately** (section 8): agent-actor attribution,
   `needsReview` policy on agent writes, deterministic triage tools, a focus handshake, hooks.

## 1. What exists today (cabane)

Seams already in place, all currently at no-op defaults:

| Seam | Where | State |
|---|---|---|
| `Dispatcher` port (`triggers`, `dispatch`) | `packages/board/src/ports.ts:80` | `a` flashes "no dispatcher configured" |
| `ActivitySource` port (`load`, `card?`, `events?`) | `packages/board/src/ports.ts:44` | sidebar shows "no activity" |
| Question merge into activity map | `packages/board/src/activity.ts:59` | reads `Planner.getNeedsInput`, read-only |
| Event view with glyphs per event type | `packages/board/src/event-view.tsx:31` | polls `source.events` at 1s |
| Sessions storage (`startSession`, `addActivity`, `getNeedsInput`, `sweepStale`) | `packages/core/storage/sessions.ts` | no writer other than tests |
| Question body convention (`choices`, `multiSelect`, `answers <id>`) | `packages/core/schemas/question-body.ts` | no `answerQuestion` fn |
| `assembleContext` = the brief | `packages/core/storage/assemble-context.ts:334` | `y` copies it |
| `needsReview` + `v` mark reviewed | `packages/board/src/data.ts` | human-only today |
| Actor URIs `cabane://actor/agent/<runtime>` | worker + MCP `authorTypeOf` | deployed |

Gaps the TUI currently has: it cannot create, edit, comment, assign, link, or **answer a
question**. `detail.tsx` tells the user to run `cabane needs-input`, a command that does not
exist. Sessions have no MCP tools by design (they do not replicate), so a runtime that picks up
work on its own has no way to file a question today.

## 2. Lessons from Jake

Jake ran three LLM paths. The one described as "raw API" (`orchestrator/providers/claude-api.ts`)
never shipped a tool loop: tools were collected but not sent (JJAK-714), tool-input JSON was
hand-reassembled, pricing was hardcoded, and it only worked with an API key. ADR-006 records the
decisive constraint: Pro/Max OAuth credentials are refused by the Messages API, so the Agent
SDK won. The multi-provider orchestrator cost 1159 lines for OpenCode alone and had no
production caller outside Claude.

What Jake concluded in `docs/research/loop-gates-review-contracts.md` is the governing lesson:
dispatch, fan-out, worktrees and monitoring are shipped by the harnesses themselves; the
durable value is the **plan as ground truth, the verification contract, and the question /
answer channel**. "Bespoke dispatch plumbing mostly doesn't survive."

Smaller lessons worth carrying:

- Questions: headless agents write a `question` activity and exit `awaiting_input`; they do not
  poll. Answers are revisable decisions, matched by `answers <id>`, never queue-clearing.
- Sessions are optional forever and never gate task writes.
- Programmatic sessions must be distinguishable from interactive ones (Jake used an env
  marker) or user hooks misfire.
- The TUI dispatch that worked was ~300 lines of pure argv plans plus an injected runner. The
  TUI never answered a question; that gap is inherited.
- Tier discipline: deterministic → one structured call → full agent session. Defaulting to a
  full session "because it sounds like something Claude does" is the common mistake.

## 3. Lessons from desk-copilot (ACP)

Desk-copilot is an ACP client: `@agentclientprotocol/sdk` 0.22.1 plus `@acp-components/core`
0.1.0, harnesses launched as subprocesses (`npx -y @agentclientprotocol/claude-agent-acp`,
`npx -y @agentclientprotocol/codex-acp`, `hermes acp`), one MCP server injected at
`session/new`, everything else (skills, instructions, other MCP servers) coming from the cwd.

Transferable pieces, in order of value:

1. **Harness registry** as a three-entry const map, harness pinned per thread. Copy verbatim.
2. **`mcpServers` injection at `session/new`** with identity carried as a header (HTTP) or env
   (stdio). Beware: the library's `loadSession` sends empty `mcpServers`, so resumes lose tools
   unless you re-pass them.
3. **Lazy sessions**: a thread exists before its ACP session; the session is created on the
   first prompt. Failed resume keeps the old id until a replacement is sent.
4. **Turn state machine** with a `dispatched` flag so cancel-before-dispatch never sends
   `session/cancel` for a turn the agent never saw.
5. **Harness divergence is real**: Claude and Codex adapters put MCP results in different
   places and neither passes `resource` blocks through. Test both from day one.
6. **Elicitation** had to be shimmed at the wire in 0.22; in SDK 1.4.0 it is a first-class
   client capability (`clientCapabilities.elicitation`).

Not transferable: the Tauri IPC transport (a Bun TUI spawns directly), the React kit, and
`@acp-components/core` (still 0.1.0, pinned to SDK 0.22, zustand). The board already has its
own reducer + effect pattern; a second store would be a foreign body.

## 4. Prior art

### Linear: Agent Interaction Guidelines and agent sessions

Six principles: **disclosure** (always show it is an agent), **native integration** (agents
use the platform's existing UI, not a separate interface), **instant feedback** (acknowledge
within ~10 s), **internal transparency** (thinking / waiting for input / executing / finished),
**respect disengagement** (stop means stop), **human accountability**. The structural
consequence: issues are *assigned* to humans and *delegated* to agents, because "an agent
cannot be held accountable". Sessions carry state derived from emitted activities (`thought`,
`action`, `response`, `elicitation`, `error`, `prompt`). They rejected sub-issues as the
delegation model and resisted codifying structure before observing real usage.

Triage Intelligence: search + ranking + LLM reasoning over the backlog; suggestions are visually
distinct from human metadata, hover shows reasoning and alternatives, everything is
human-reviewed by default with opt-in auto-apply. "If you are going to act on AI-generated
suggestions, you need to see where they came from."

Fit for cabane: `SESSION_STATES` and `ACTIVITY_TYPES` already match this vocabulary.
`needsReview` + `v` is the review queue. `assignee` (freeform, "agent name, 'me', email") is the
delegate; the human accountability half has no field yet.

### beads / Gas Town / bv

Beads: git-backed issues as the agents' shared memory; `bd ready` yields the unblocked
frontier of the dependency graph; a bead closes only on merge so any worker can resume it.
Gas Town layers roles on top (Mayor files and slings, Polecats are one-per-task ephemeral
workers, Convoys bundle work for tracking). Praised: throughput and "psychological distance from
babysitting terminals". Criticised: "most work gets done; some work gets lost", 141 orphaned
Claude processes, observability gaps about what is finished or stalled, tmux fluency and
constant prodding, `--dangerously-skip-permissions` as a prerequisite, cost spirals. Not suited
to iterative human-in-the-loop work.

bv (beads_viewer) is the interesting UX split: the TUI gives humans list / kanban / graph views;
`--robot-triage`, `--robot-plan`, `--robot-next` give agents deterministic, pre-computed JSON
(ready work, unblock counts, PageRank, critical path, staleness) so the LLM does not do graph
traversal. Deterministic first, LLM second.

Fit for cabane: ADR-032 already rejected beads' git-backed single-runtime model in favour of the
hub, but the *ready frontier* and *deterministic triage before LLM* ideas port directly; core
has the link DAG (`blocks` / `blocked_by`) and `assembleContext` already computes position.

### GitHub Copilot coding agent

Assign an issue → session appears under the assignee with live status (queued / working /
waiting for review / completed); sessions surface on project boards; logs expose every tool
call; commits carry an `Agent-Logs-Url` trailer back to the session. The recurring loop across
Copilot, Linear, Jules, Devin and Codex cloud tasks is **assign → watch status → answer a
question → review a diff/PR**, with the issue as the anchor and the log one hop away.

### Vibe Kanban, Conductor, Claude Squad

Card = one worktree + one agent + one reviewable outcome. Vibe Kanban is now sunsetting to
community maintenance, which reads as confirmation of Jake's conclusion: the standalone
agent-kanban layer is being absorbed by the harnesses. What survives is the tracker.

### ACP in 2026

SDK `@agentclientprotocol/sdk` 1.4.0 (Aug 2026; desk-copilot is on 0.22.1). Agents: Claude
Code via `claude-agent-acp` 0.76.0, Codex via `codex-acp` 1.11.0, Gemini CLI, Cursor, Copilot
(preview), Goose, Hermes, OpenCode, Kiro, Junie and ~25 more; a registry launched Jan 2026.
Protocol: `initialize`, `session/new` (with `mcpServers`: stdio / http / sse), `session/load`,
`session/prompt`, `session/cancel`, `session/update` notifications (`agent_message_chunk`,
`agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`, …),
client-side `session/request_permission` and `elicitation/create`. The SDK now ships a fluent
`client().onRequest(...).connectWith(stream, ctx => ctx.buildSession(cwd).withMcpServer(...)
.withSession(s => s.prompt(...); s.nextUpdate()))` builder; the bundled client example is
131 lines including a CLI permission prompt.

Alternative: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). Richer control (hooks,
`canUseTool`, in-process MCP tools) but Claude-only. Cabane's thesis is several runtimes on one
board, so ACP is the better default; the Agent SDK remains a fallback if the Claude adapter
lacks something specific.

## 5. Phase 1: the board copilot

### Why in the board

The board holds state a harness cannot see: which scope is open, which section and filter,
which row is under the cursor, which rows are marked. Passing that as structured context turns
"triage the inbox", "merge these three", "re-parent these under JCAB-31", "is this plan still
coherent" into one keystroke instead of pasted ids. Coding work is a different job and stays in
the native harness: David reads the issue on the right, works on the left, `y` copies the brief.

### Principles

- **Board-native, not chat-native.** Actions on the selection first; a prompt line second;
  streamed prose in a pane while a turn runs. The pane is the only chat-shaped surface.
- **Selection is the prompt.** Every action carries scope, section, filter, and the selected or
  marked issues with their briefs (`assembleContext`, capped).
- **Inherit the harness.** Permission mode, model, hooks, skills, `CLAUDE.md` / `AGENTS.md` all
  come from the user's harness config and the scope cwd. Cabane adds one instruction block.
- **Writes go through `cabane mcp`.** Same DB the board reads; the board reloads on each
  completed tool call instead of waiting for the 5 s poll. Review is the existing `v` where
  `needsReview` is set (policy is a separate item, section 8).
- **Keep it simple until the flow is known.** One long-lived session per board run, lazy
  started; no persistence of the copilot transcript beyond the event log.

### Interaction

| Key | Action |
|---|---|
| `m` | mark / unmark the row; marked rows form the working set |
| `A` (or `:`) | copilot palette on the selection: refine · split · find duplicates · re-parent · triage section · check plan · custom prompt |
| typed prompt | freeform, always with the selection context attached |
| `esc` | cancel the running turn (`session/cancel`); second `esc` closes the pane |
| `o` | event log of the copilot session (existing event view) |
| `v` | mark reviewed, as today |

Streamed agent text shows in a bottom pane; tool calls appear as event-view lines and as a
"working…" badge in the header strip (Linear's instant-feedback rule: a pending card the moment
a turn starts, before `npx` finishes cold-starting).

### What the copilot receives

First prompt of the session (all harnesses) and, for Claude, `_meta.systemPrompt.append`:

- the role: issue-management copilot for this board, write through the cabane tools, never
  the filesystem for tracker state, prefer proposing over sweeping changes, keep ids stable;
- the tool loop already spelled out in `SERVER_INSTRUCTIONS` (`cabane_context` before editing,
  `cabane_edit` / `cabane_link` / `cabane_comment` as you go);
- the board context block, refreshed on every prompt: scope uri, section, filter, selected
  id, marked ids, and the assembled briefs.

Verified against the adapters: `claude-agent-acp` 0.76.0 reads `_meta.systemPrompt` on
`session/new` (string replaces; `{ append }` extends the Claude Code preset) and applies the
user's settings for `permissions.defaultMode`. `codex-acp` 1.11.0 has no client-side instruction
hook; it reads `AGENTS.md` from cwd and gets the first prompt. So the first prompt is the
portable channel and the Claude append is a bonus.

### Out of scope for phase 1

Dispatching to a coding harness, session recording into `agent_sessions`, answering agent
questions in the TUI, worktree or merge machinery, capability sandboxing, a permission policy
of our own, multi-provider abstraction, raw Messages API calls.

## 6. Technical design

### Shape

```
packages/
├── acp/    # @cabane/acp — Harnesses registry, AcpClient over Bun.spawn + ndJsonStream,
│           #   Copilot (session lifecycle, context block, prompt templates)
├── board/  # marks, palette overlay, prompt line, stream pane, header badge,
│           #   copilot events into the existing event view
└── cli/    # wires the copilot into boardDeps; `cabane mcp --actor` (section 8)
```

One new dependency: `@agentclientprotocol/sdk` 1.4.0 (zod peer matches). Not
`@acp-components/core` (0.1.0, pinned to SDK 0.22, zustand). The board keeps its reducer +
`Effect` pattern; the copilot adds effects (`copilotPrompt`, `copilotCancel`, `mark`).

### Client

`Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: scopeDir })` then
`ndJsonStream(writable, proc.stdout)`. Bun's piped stdin is a `FileSink`, not a
`WritableStream` (checked on Bun 1.3.14), so a ~10-line adapter wraps it. Non-JSON stdout lines
are dropped, as desk-copilot does. The SDK's fluent builder covers the rest:

```ts
client({ name: "cabane" })
  .onRequest(methods.client.session.requestPermission, askInBoard)
  .connectWith(stream, async (ctx) => {
    await ctx.request(methods.agent.initialize, { protocolVersion, clientCapabilities: {} });
    const session = await ctx.buildSession(scopeDir)
      .withMcpServer({ name: "cabane", command: cabaneBin, args: ["mcp", "--scope", uri, "--actor", actor], env: [] })
      .start();               // _meta.systemPrompt.append set via toRequest() for Claude
    …session.prompt(blocks); for (;;) { const u = await session.nextUpdate(); … }
  });
```

Permission requests are shown in the board and answered by the human; the copilot does not
auto-answer anything. If the user's harness is in auto mode, no requests arrive. That is the
"inherit the defaults" rule in one place.

Harness registry, copied from desk-copilot and reduced: `claude` →
`npx -y @agentclientprotocol/claude-agent-acp`, `codex` → `npx -y @agentclientprotocol/codex-acp`,
`gemini` → `gemini --acp`, overridable in `~/.cabane/config`. Pin adapter versions; test Claude
and Codex both (they diverge on where MCP results land).

### Session lifecycle

- Lazy: the harness process and the session start on the first palette action.
- One session per board run; each action is a `session/prompt` with the context block
  prepended as a text block. Turn state with a `dispatched` flag so cancel-before-dispatch
  never sends `session/cancel` for a turn the agent never saw (desk-copilot `threadRuntime`).
- `startBoard`'s `finally` kills the process. No resume in phase 1; `session/load` can come
  later behind the same client.
- Set `CABANE_SESSION=1` in the harness env so user hooks can tell a board session from an
  interactive one (Jake's `JAKE_AGENT_SDK_SESSION` lesson).

### Reflecting writes

`tool_call_update` with status completed for a `cabane_*` write triggers a board `reload`.
Rows changed by the copilot's actor since the turn started get a transient highlight; the
review glyph and `v` need the `needsReview` policy from section 8 to be meaningful, so phase 1
ships the highlight and the policy is the first follow-up.

### Size

Registry + client + copilot ≈ 250–350 lines plus tests (the SDK's in-process `AgentApp` lets
tests run without a subprocess); board ≈ 300 (marks, palette, prompt line, pane, badge); cli ≈
30. Against Jake's 1159-line OpenCode provider, this is the point.

## 7. Proposed issues (under JCAB-1)

1. **`@cabane/acp` client**: registry, Bun stdin adapter, connect / initialize / session /
   prompt / cancel, permission requests surfaced as a `Result`-returning callback; tests over
   the in-process `AgentApp`.
2. **Board marks and context block**: `m` marks, `BoardContext` projection (scope, section,
   filter, selected, marked, briefs), pure and unit-tested.
3. **Copilot palette, prompt line, stream pane**: overlay reusing the dispatch overlay
   pattern, effects `copilotPrompt` / `copilotCancel`, header badge, events into the event view.
4. **Copilot instructions**: the instruction block, prompt templates per action, Claude
   `_meta.systemPrompt.append`, reload-on-write and transient highlight.
5. **Wire into `cabane board`** with config for the harness choice.

Open decisions: `A` vs `:` for the palette; whether marks survive a reload; whether the pane
sits at the bottom or replaces the sidebar while a turn runs.

## 8. Logged separately: MCP-side improvements

Good ideas from this research that are independent of the copilot and worth their own issues.
They make agent writes visible and reviewable whichever harness made them.

- **Agent-actor attribution**: `cabane mcp --actor cabane://actor/agent/<harness>` so writes
  from a harness (board copilot or native) are distinguishable from the human's. One flag;
  `authorTypeOf` already keys on the prefix.
- **`needsReview` policy**: writes by agent actors to title, description, state, priority,
  parent set `needsReview: true` in the MCP write handlers. Comments and work logs exempt.
  Board: review glyph, needs-review filter or section, `v` clears (exists).
- **Change summary in the detail view**: what changed, by whom, when, from the local
  `task_activity` timeline; verify whether it records before/after values (needed for a
  revert key).
- **Deterministic triage tool** (`cabane_triage`), borrowing bv's robot mode: stale issues,
  ready frontier (no open `blocked_by`), orphans, duplicate candidates by FTS. Same
  computation powers a board "ready" filter and stale dimming.
- **Focus handshake** for the side-by-side workflow with a native harness: the board writes
  the selected id to a focus file; `cabane_context` / `cabane_edit` default to it when no id
  is given.
- **Board card for external claims**: a task in `in_progress` with an agent `assignee` and no
  write from that actor for 30 min renders as a stale card, with nothing installed on the
  harness side.
- **Harness hooks plugin** (Claude Code first): `cabane hook` reads the hook JSON on stdin;
  the post-tool-use event on the cabane edit tool joins harness session id to task id, later
  file and shell events append ephemeral `action` activities. Only if the coarse view feels
  thin. Not herdr-style pane observation, and not session tools on the replicated MCP surface.

## 9. Later phases, kept ready

The `Dispatcher` and `ActivitySource` ports stay at no-op. When dispatch or loops come back,
the same `@cabane/acp` client serves them, and a Recorder projects ACP `session/update` into
core sessions with this mapping:

| ACP | Core |
|---|---|
| `session/new` ok | `startSession({taskId, agent, externalRef: sessionId})` |
| `agent_thought_chunk` | `progress`, ephemeral |
| `tool_call` / `tool_call_update` | `action`, or `error` on failure |
| `agent_message_chunk`, buffered per turn | `response` at stop |
| `elicitation/create` | `question` with `QuestionMeta` → `awaiting_input` |
| human answer | `decision` with `answersContext(id)` |
| stop / cancel / error | `endSession(complete \| error, summary)` |

Then: answer picker for questions (`cabane answer`, `cabane needs-input`), "run with …" over
ACP with the brief as first prompt, resume via `session/load` (re-passing `mcpServers`).

## Sources

- Linear AIG: https://linear.app/developers/aig · SDK rationale:
  https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk · Triage
  Intelligence: https://linear.app/now/how-we-built-triage-intelligence · Agents dev docs:
  https://linear.app/developers/agents
- Gas Town: https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04 · critique:
  https://tenzinwangdhen.com/posts/gastown-good-bad-ugly/ · bv:
  https://github.com/Dicklesworthstone/beads_viewer
- GitHub agent sessions in Issues/Projects:
  https://github.blog/changelog/2026-03-26-agent-activity-in-github-issues-and-projects/ ·
  commit → logs: https://github.blog/changelog/2026-03-20-trace-any-copilot-coding-agent-commit-to-its-session-logs/
- Vibe Kanban: https://github.com/BloopAI/vibe-kanban · orchestrator list:
  https://github.com/andyrewlee/awesome-agent-orchestrators
- ACP: https://agentclientprotocol.com/protocol/overview · agents:
  https://agentclientprotocol.com/get-started/agents · Zed external agents:
  https://zed.dev/docs/ai/external-agents
- Claude Agent SDK TS: https://platform.claude.com/docs/en/agent-sdk/typescript
- Jake: `docs/ADR/006`, `012`, `016`, `030`, `032`; `docs/research/loop-gates-review-contracts.md`;
  `packages/planner/CLAUDE.md` (question routing); `packages/tui/src/dispatch.ts`
- desk-copilot: `apps/desktop/src/{harnesses,deskSession,threadRuntime,elicitation,reconnect}.ts`, `README.md`
