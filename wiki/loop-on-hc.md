# The loop on herdr core: brainstorm prep

Status: prep for a brainstorm, 2026-11-07. Nothing is decided here. Baseline: kabane `2209dfb`,
hc 0.1.18, Claude Code 2.1.319, Codex 0.166.0, pi 1.5.0.

Inputs: JCAB-154 (practice vs engine), JCAB-19 (herdr session provider, someday), JCAB-144
(worktree per claim), JCAB-29 (harness auto mode), JCAB-160 (decomposition),
`wiki/loop-extension-plan.md`, `wiki/herdr-integration.md`, `extensions/loop/src`, `hc --skill`,
`hc schema`, the research note `projects/kabane/research/herdr-core-and-app.md` (icitte), and
`kabane-herdr/mods/kabane/main.js` (▶ start).

Evidence tags: **src** (read in source or a binary), **live** (seen in the `loopprep` herdr
sandbox, below), **doc** (hc's own manual or schema), **inf** (inferred, unverified).

## Headline

- **What hc covers well:** starting a harness on a first message, a session that outlives the board
  and the runner, status from the harness itself (7501), waiting, interrupting, killing, steering
  by typing, and labels to join claims to issues. All three harnesses checked report 7501 on their own.
- **What hc does not cover:** structured permission and form asks (it gives a state word plus a
  `msg`, and the human answers in the terminal), usage and cost, context occupancy, tool-call
  activity for the board's lanes, and the agent's last message as a summary.
- **A new gap, found live:** a fresh folder opens Claude's and Codex's trust dialog *before* they
  report anything. Loop worktrees are a fresh folder per run (per claim, after JCAB-144), so each
  claim would start blocked on a prompt that herdr can't see.

## 1. What the loop needs from an engine

These are JCAB-154's engine modules, with line counts as of today.

| Module | Lines | What it does for the practice layer |
|---|---|---|
| `dispatch.ts` | 922 | Spawns the harness over ACP in the claim's folder with `kabane mcp --scope`, sends the brief, runs turns until the tracker says the claim is over, nudges, steers (`inject`), cancels, and reports usage and the last message. |
| `runner.ts` | 606 | The detached `kabane loop run <id>` process. On each tick it reads the inbox, checks spend, re-reads the plan, checks the stop predicate and fills slots, then waits for a session to end or for the next tick. |
| `lock.ts` | 123 | Makes sure only one process per device drives a run (a file lock that a dead owner's successor can take over). |
| `state.ts` | 143 | The runner's in-process state, and the two writes that go with every step: an event on the trace and a save of `run.json`. |
| `store.ts` | 604 | `$KABANE_HOME/loops/<id>/{run.json, events.jsonl, inbox.jsonl, runner.log}`. A run whose runner is gone reads as `failed`. |
| `elicitation.ts` | 465 | Turns a harness form into numbered tracker questions, validates the answers, and returns the filled form or a decline. |
| `permission.ts` | 148 | Turns a harness permission request into a tracker question carrying the harness's options verbatim, and maps the answer back to an option id. |

The practice layer reaches these through `Dispatch.Hooks` (`event`, `opened`, `usage`, `continueTurn`,
`permission`, `elicitation`) and `Dispatch.Handle` (`done`, `cancel`, `close`, `inject`). That
pair is already most of JCAB-154's seam.

## 2. Mapping: each engine responsibility to hc

| Responsibility | hc | Coverage | Evidence |
|---|---|---|---|
| **Start a harness on a brief in a folder** | `hc run --bg --no-parent --name <claim> --cwd <worktree> --label kabane.issue=<id> --label kabane.run=<run> <harness argv> "<first message>"`. The `env` param can carry `KABANE_LOOP=1`. The first message is the CLI's own prompt argument (`claude "…"`, `codex [PROMPT]`, `pi [messages…]`) or a template body. | **Full**, with the trust-dialog caveat below | doc (`hc --skill`, `terminal.run` params); ▶ start already does this through `tab.new` (src) |
| …the brief itself | ACP sends `assembleContext` plus run instructions as the prompt. A CLI argv can carry it, but a long brief pasted into a TUI is clumsy. The ▶ start pattern sends a pointer instead: "Work kabane issue X: read its brief with kabane_context". | **Partial**. The loop's run instructions (gates, retry output, concurrency) have no `kabane_context` equivalent today | src (`main.js:84`, `brief.ts`) |
| …kabane MCP attached | ACP attaches `kabane mcp --scope` to each session. A CLI harness uses whatever MCP the user installed (`kabane mcp install`), and that server resolves the scope from the folder. `.kabane/scope` is committed, so a worktree has it. | **Partial**. It depends on the user's setup. Whether the MCP server inherits `KABANE_LOOP*` from the harness's env is unverified | src (`dispatch.ts:145-175`, `git ls-files .kabane`); inf |
| …ready to receive the task | A template launch waits up to 60 s for readiness and records `first_message.sent`. A plain argv prompt is held by the harness itself. | **Partial**. A trust dialog blocks it unseen (below) | doc; live |
| **Know it's working / blocked / done** | The harness's own 7501 root record: `status {state, kind?, msg, app}`, `turn` increments each time it leaves `working`; `hc wait <t>` returns when it stops working; `hc events --label kabane.run=<id>` streams `status`, `turn` and `finished` changes. All of this works from a process outside hc: `wait <t>` and `events` need no caller terminal. | **Full** for the state word; **none** for what it's doing (no tool calls) | doc (schema `terminal.wait`, `events.subscribe`); live (idle reports, table below) |
| …claim over (outcome) | It stays in the tracker, as today: the subtask is closed or parked, or the nudges run out. hc's `done` only marks the end of a turn. | **N/A**: practice | src (`dispatch.ts` header) |
| …usage, cost, context occupancy | Nothing. hc never reads the program's output. | **None** | doc ("does not guess from screen text") |
| …last message / summary | `hc read --lines N` returns screen text only. | **None** (structured) | doc |
| **Permission asks** | `blocked` with `kind=permission` (where the harness sets it) and `msg`. The human answers in the terminal (herdr-app's "Needs you", a toast, or `hc attach`). `send` refuses a blocked program without `--force`. | **Surfaced, not relayed** | doc; src (pi reports `blocked` with the dialog title as `msg`; Claude's and Codex's emitters write `kind=`, but which kinds their root record sends wasn't traced) |
| **Form asks** (AskUserQuestion, `request_user_input`, MCP forms) | The same `blocked` state, with the form drawn in the harness's TUI. | **Surfaced, not relayed** | inf |
| **Steering (`inject`)** | `hc send <t> "…"` pastes once the keyboard has been quiet for about 3 s. What a harness does with input mid-turn is up to the harness. | **Full** (harness-defined) | doc |
| **Nudge / continuation** | On a `turn` event with the issue still active and owned: `hc send`. | **Full** | doc |
| **Cancel / close** | `hc interrupt` (Esc for a program that reports status, never escalates), then `hc kill`; `hc rm` once it has finished. | **Full** | doc |
| **Retry in the same session** (JCAB-48) | The terminal is still alive, so `hc send` the gate's output into it, with no ACP `session/resume`. `Retry`'s rule ("only while under half the context window") loses its input. | **Partial** | src (`retry.ts`); doc |
| **Resume after the runner dies** (JCAB-40) | Mostly unnecessary: sessions keep running without the runner (holders plus launchd). A new runner finds them again with `hc ls --label kabane.run=<id>`. | **Better than ACP** | doc |
| **Session alive after the board exits** | It already is with ACP (detached runner). With hc it also survives the runner, a core restart, and `hc update`. `--keep` swaps a lost program for a shell and never reruns it. | **Full** | doc |
| **Stall detection** | The progress mark (closed subtasks, tree hash, gates, checklist ticks) is practice. Only "an automatic attempt ended" needs the engine, and the `turn` / `wait` return gives that. | **Full** | src (`stall.ts`) |
| **Budget** | Concurrency is practice and works the same. The spend limit needs `usage_update.cost`, which hc doesn't provide. | **Concurrency full, spend none** | src (`budget.ts`) |
| **Parallel claims in worktrees** | One terminal per claim, `--cwd` the claim's worktree (JCAB-144), joined by labels. hc keeps a terminal for each, and herdr-app shows them as agents or sub-agents. | **Full**, plus the trust caveat | doc |
| **Runner process** | The runner stays a kabane process, or becomes one more hc terminal (`hc run --bg --no-parent kabane loop run <id>`) whose claims are its children. Then `hc wait --children any` replaces its tick wait, and herdr shows the run as an agent. | **Optional** | doc |
| **Lock / state / store** | `doc.get`/`doc.set` is a compare-and-set store hc could offer, but putting run state there breaks "nothing of herdr's in kabane" and "depend on none". | **Keep kabane's** | doc; `kabane-herdr/AGENTS.md` rule |
| **Auto mode** (JCAB-29) | ACP moves the session into the harness's auto mode. Under hc, the launch argv would carry the mode flag, for example Codex's `-a`. | **Full**, as argv | src (`harnesses.ts`); inf for flags |

### Status from the harness itself (7501), per harness

| Harness | Emits 7501 | Gate | In hc, at its ready prompt | Before ready |
|---|---|---|---|---|
| Claude Code 2.1.319 | yes: `PROGRAM_STATUS:7501`, `state/kind/progress/title/msg`, child records for background tasks (src, binary strings) | probes `OSC 7501;?` and reports only on a reply (src) | `{app: claude-code, state: idle}` (live) | trust dialog on an untrusted folder: **no status at all** (live) |
| Codex 0.166.0 | yes: `]7501;state=…:app=codex:kind=` (src, binary strings) | not traced | `{app: codex, state: idle}` (live, `--no-daemon`) | update prompt, then the trust dialog on an untrusted folder: **no status** (live) |
| pi 1.5.0 | yes: `ProgramStatusReporter`. `working` during a run, `blocked` while an extension dialog or login waits (msg = dialog title), `done`, `error`, and `idle` at start or after a cancel (src, `docs/terminal-setup.md`) | reports only after the terminal confirms support; `PI_PROGRAM_STATUS=1/0` overrides (src) | `{app: pi, state: idle}` (live) | none seen |
| Gemini CLI | not installed here; unknown | | | |
| kabane board | yes: `blocked kind=question app=kabane` (JCAB-154 comment, live) | | | |

So status works with kabane out of the loop for all three. Pi has no ACP adapter in kabane's
registry (`claude`, `codex`, `gemini`), so hc would be the only way the loop could run pi at all.

**Live check, for the record.** In the `loopprep` sandbox core, each harness was started with
no task (so no model calls), and `hc get` and `hc read` were read back. In a scratch git folder,
Claude and Codex both sat in their trust dialog with `status: null`. In `~/Projects/kabane`, which
is already trusted, both reported `idle`. Pi reported `idle` in both.

### What the asks do to the board's relay and to North Star #6

- **Today, over ACP:** each ask becomes a core `question` on the claim's session, which feeds
  `getNeedsInput`, `!`, the banner and `kabane loop answer`. The answer is a `decision` activity,
  credited to the human and kept in the record (North Star #5).
- **Over hc:** the ask stays inside the harness's own UI. The human answers there: through herdr-app's
  Needs you, a toast and a jump to the pane, or `hc attach` without the app.
  - **Kept:** the human still decides every ask, in the harness's native and lossless form, with
    no translation layer. That suits "thin wrapper" and North Star #6's "ability to steer does not shift".
  - **Lost:** answering from the board or the CLI, from wherever the human is (the board in another pane,
    `kabane loop answer`). Also lost: the decision in kabane's history, who approved what and when
    (#5), and the `!` attention on the board unless something maps `blocked` into it (and
    `herdr-integration.md` rejects an ActivitySource of herdr agents for now). Elicitation's
    validation and "i of n" grouping become the harness's own.
  - **The trust dialog is the sharpest case.** It's a real ask, it gets no 7501 report, so herdr
    can't show it, and kabane answering it would be a trust decision taken for the human.

## 3. What "hit start and monitor" could mean

| | **(a) Loop drives hc** | **(b) Conductor agent** | **(c) Hybrid: the run is an hc agent** |
|---|---|---|---|
| Start | The board's or the panel's start runs `kabane loop start --engine hc`. The runner claims, and each claim is `hc run --bg <harness> "<pointer to brief>"`, labelled `kabane.run` and `kabane.issue`. | Start one agent, `hc run --bg --name conduct-<id> claude "<conductor brief for parent X>"` (or an hc template `kabane-conductor`). It reads the plan through kabane MCP, claims with `kabane_edit`, delegates with `hc run --bg`, collects with `hc wait --children any`, and runs the gates with `hc run --bg --rm`. | Start puts the runner itself in hc (`hc run --bg --no-parent --label kabane.run=<id> kabane loop run <id>`). Implementers are its hc children, while lenses and rechecks stay on ACP (short, read-only, never ask). |
| Monitor | `hc events --label kabane.run=<id>` in the runner; herdr's Agents list; the board's loop tab from `events.jsonl` as today | herdr's Agents list (conductor plus sub-agents); the tracker | The runner emits 7501 (blocked if any claim is blocked, done at the end), so the run is one agent row with its claims as sub-agents. The board's loop tab stays. |
| Kabane keeps | The whole practice layer, run state, lock, gates, land, prune | Only the record, plus the practice delivered as text (a brief or skill: plan rules, gates, lenses, stop) | Everything (a) keeps, and ACP for verifiers |
| hc does | Sessions, status, steering, cancel, persistence | Sessions, status, delegation, waiting, *and the scheduling itself* (the LLM following the brief) | (a), plus the run's own visibility and `wait --children` |
| Lost vs ACP | Structured asks, cost and spend limit, context occupancy, tool-call lanes, the last-message summary, answers in the record | All of (a), plus deterministic scheduling, the stop predicate, checkpoints and resume. The conductor can drift from the practice, and the board's loop tab goes dark unless the conductor logs | (a)'s losses for implementers only. Verifiers keep their structure. |
| Without herdr | The ACP engine stays the default, chosen per run, so one machine stays complete (#4) | No delegation, so it falls back to one agent (or the harness's own subagents). The ACP loop has to stay alongside. | Implementers fall back to ACP. Same as (a). |
| North Stars | #1 keeps kabane's practice and recommends hc's sessions; #6 asks move to the terminal | #1 "recommend theirs" in its purest form, #3 the smallest core. It gives up #5: the practice record is whatever the conductor wrote. | Like (a), with fewer of the losses that matter |
| Where code lives | An hc engine behind the JCAB-154 seam, in `extensions/herdr` (`herdr-integration.md` slice 5 names it as that engine's home) | A brief or template; almost no code | The same as (a), plus a 7501 emitter in the runner (the board's `program-status.ts` is the model) |

All three hit the trust dialog unless loop worktrees live under a path the human has trusted once.

## 4. Questions for David

1. **Which shape to try first?** (a) the smallest change behind the seam; (b) the least kabane
   code and the most delegation to hc; (c) (a) plus the run visible in herdr.
2. **Is "answer in the terminal" acceptable for loop claims?**
   - (i) Yes for every hc claim; the board shows "blocked in <claim>" with a way to jump there.
   - (ii) Yes, but kabane records that a claim blocked and when, without hc ids (this pulls against
     `kabane-herdr`'s rule that nothing of herdr's goes into kabane).
   - (iii) Keep ACP for any claim expected to ask, and use hc only for implementers in auto mode.
3. **Engine choice, at what granularity?** Per device config, per run (the run form), or per claim
   kind (implementers on hc, verifiers on ACP).
4. **Trust dialogs for worktrees.**
   - (i) Put loop worktrees under one folder the human trusts once in each harness (does trusting a
     parent cover its children? unverified for both).
   - (ii) The human answers each one, which means making the pre-ready dialog visible to herdr
     somehow.
   - (iii) ACP for worktree claims.

   Kabane pressing "yes" itself is off the table (thin wrapper).
5. **How the brief reaches an hc claim.**
   - (i) The full brief as the first message.
   - (ii) A pointer line, plus a way for the agent to pull the claim's brief, gates and retry output
     (`kabane loop brief <claim>` or an MCP tool).
   - (iii) A file beside the terminal (`hc put`).
6. **Spend limit under hc.** Drop it for hc claims; keep it as ACP-only; or say "no budget" in the
   run form when the engine can't report cost. Reading harness transcripts for cost is out (it
   would mirror their files).
7. **Does the runner stay a kabane process, or become an hc terminal** (shape c)? The trade is
   `wait --children` and visibility against a second way to start a run.
8. **Does JCAB-154's scope change?** It says "ACP stays the only implementation; an hc backend is
   not in scope". This brainstorm asks whether hc is the seam's second implementation now
   (JCAB-19 promoted from someday) or after the seam lands.

## 5. What not to decide yet

- **Retiring the ACP engine.** North Star #4 and "depend on none" make it the floor. Revisit only
  if hc becomes something every user has.
- **Cost capture under hc.** Wait for harnesses to report cost through 7501 or another open channel.
- **Herdr 1 TUI, remote machines (`--on`), Gemini under hc.** Nothing here needs them.
- **Board lanes fed from hc** (an ActivitySource of hc terminals). `herdr-integration.md` already
  defers this.
- **Whether to ship a conductor template.** It depends on Q1. A template is cheap to try by hand
  first: write `~/.config/herdr-core/templates/` locally, outside the repo. None exists on this
  machine (`hc templates` → `[]`).

**How this relates to JCAB-160 (decomposition).**
- The engine seam is a decomposition seam. The practice layer should load without `@cabane/acp`,
  and an hc engine should load only with `extensions/herdr`, off by default. That is #3's "the
  core stays small", applied to the loop.
- Shape (b) is the far end of decomposition: the practice ships as text, and no loop code runs at all.
- If the seam lands first, JCAB-160 can treat "loop practice", "ACP engine" and "hc engine" as
  three separately loadable pieces, next to "board without the copilot".
