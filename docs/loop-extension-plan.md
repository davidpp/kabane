# Extensions and the loop: implementation plan

Status: proposed 2026-10-10. Baseline: `babde56`, Kabane 0.3.0.
Prototype: branch `worktree-agent-a51c0219f3321b329` (scripted run, real tracker writes). It is
the UX reference and a source to port from, not a branch to merge.

## Outcome

Kabane stays a tracker. An extension mechanism lets official extensions add CLI commands and board
contributions without the core or the board learning what they do. The first official extension,
`loop`, drives a parent issue's subtasks to verified completion through ACP harnesses. The board
shows each run as a tab, surfaces every question waiting on a human, and answers it with the
issue's brief on screen.

Ship when a real loop has run end to end in a sandbox home: real harness, real gates, a question
answered from the board, a finding filed. Mocked transcripts do not count.

## Decisions

1. **Official extensions live in `extensions/<name>`**, are workspace members, and are bundled into
   the one `kabane` npm package (`scripts/build.ts` already bundles what `packages/cli/index.ts`
   imports). One version, so an extension never runs other migrations against `kabane.db`. It may
   import `@cabane/core` and `@cabane/acp` directly.
2. **Extensions are opt-in.** `config.json` gains `extensions: string[]`. A disabled extension's
   commands print how to enable it, and it contributes nothing to the board. Enabled extensions are
   imported lazily, so a plain `kabane list` loads no extension code. It still loads the board and
   ACP modules, as it already did. To print that hint, the CLI imports the disabled extensions
   too, but only when a command name is not found. Unknown names in `extensions` are ignored, so a
   config written by a newer kabane still opens.
3. **The contract is a plain object, in `@cabane/extension`.** `Extension = { name, commands?,
   board?(ctx) → { activity?, dispatcher?, headers? } }`.
   - **Where it lives:** `packages/extension`, which also holds the args parser and the `Outcome`
     constructors. An extension cannot import from `packages/cli` without a cycle.
   - **Context:** `Extension.Ctx` is `{ home, store, cwd, actor }`; the CLI's `Ctx` adds `config`.
   - **The official list** is `OFFICIAL` in `packages/cli/src/extensions.ts`, and the build fails
     if a directory under `extensions/` is missing from the bundle.
   - **The board** receives the merged ports through the existing `BoardDeps` and never imports an
     extension. Merged trigger ids and card ids are both prefixed `<name>:`, so dispatch, `card()`
     and `events()` route back to their extension.
4. **Long-running work runs in its own process.** `kabane loop start` writes the run and spawns the
   detached `kabane loop run <runId>` from the same binary. Closing the board never stops a loop,
   and the board only observes it.
5. **The board is loop-agnostic.** Everything it gains is generic and optional, with no-op
   defaults:
   - tabs for cards that ask for one
   - lanes in the event view
   - card actions
   - a per-kind card header component
   - a trigger form with a preview
   - attention over waiting questions

   `CardHeader` is the one seam that takes a component, so only in-package extensions can supply
   rich headers. That is acceptable.
6. **One question mechanism: core session questions.**
   - Every loop agent session is a core `agent_session` on the subtask it works.
   - An agent's question, and an ACP permission request, become a `question` activity.
   - The answer is `Planner.answerQuestion`, which writes the `decision` activity. The core
     CLAUDE.md already describes it, but it is not implemented, so package C1 adds it.
   - Badges, `!`, the pinned banner and clear-on-answer all read `getNeedsInput`.
   - The prototype's `CardQuestion` and `ActivitySource.answer` are dropped. Instead a card lists
     the `sessionIds` it owns, which is how its tab counts its questions.
7. **Engine shape follows the outer-loop research.** Composable steps, not four fixed phases:
   - **Plan source:** the parent issue, its children and their `blocks` links, re-read every tick.
     Agents may add and link subtasks mid-run, and that is a normal event.
   - **Dispatch:** `@cabane/acp`, one session per claim. Ready work is claimed continuously up to
     a concurrency cap, with no lockstep waves. The harness is the subtask's assignee when it names
     a known harness, else the run's configured implementer. The brief is `assembleContext` plus
     short run instructions, with `kabane mcp --scope` attached.
   - **Launch profile:** the loop runs the user's full harness, never the copilot's profile. The
     copilot pins `ANTHROPIC_MODEL=sonnet`, appends its own system prompt, sets `KABANE_SESSION`
     and lets the claude adapter fall back to the Agent SDK's bundled binary. The loop instead:
     - pins no model, unless the run config names one
     - sets `CLAUDE_CODE_EXECUTABLE` to the installed `claude`, and fails if there is none
     - adds no copilot prompt
     - sets `KABANE_LOOP=1`

     This goes through a generic profile argument to `Harnesses.resolve`.
   - **Folder:** `run.json` records `projectDir`, the directory the loop was started from.
     `start` refuses when that directory's detected scope is not the issue's `scopeUri`, unless
     `--dir` is given. Sessions run in the run's worktree, else in `projectDir`.
   - **Gates:** named shell commands from config, run when an implementing session ends. The
     result goes to the work log. A failure reopens the subtask with the output in the next brief.
   - **Verifiers:** lenses, each a prompt file plus a harness, run once the plan is done. Findings
     are child issues of the parent, tagged `finding` and `p1`/`p2`/`p3`. That keeps them
     trackable and fixable with existing tools; `kabane_comment` has no severity field.
   - **Stop condition:** all subtasks done, gates green, no open `p1` finding.
   - **Continuations:** at most N nudges when a turn ends with the plan still open.
   - **Budgets:** wall time, concurrency and continuations are always enforced. Spend is enforced
     when the harness reports `usage_update.cost`. ACP reports context occupancy, not cumulative
     tokens, so the meter shows context use and does not enforce a token budget.
   - **Health:** one stall detector (no gate or diff progress across N session ends) plus
     dependency-graph deadlock detection.
   - **Steering inbox:** `inject` goes to the target session as a new prompt; `pause`, `skip` and
     `next` change what is claimed. On a loop tab, `i` opens the copilot's own textarea, which
     supports paste, multi-line input and history, aimed at the session in the selected lane.
     How a prompt sent mid-turn behaves (queued, rejected or interrupting) is to be checked
     against ACP.
   - **Checkpoints:** a commit per passing gate, in the run's worktree. Rollback is a reset to a
     checkpoint.

   Removed from Jake's loop:
   - specialist routing by path
   - the question regex
   - the uncertainty score
   - "same task completed twice"
   - the iteration cap
   - memory injection
   - tRPC
   - the fixed research and docs phases (expressible as a step or a lens)
8. **Run state is device-local files**, alongside the device-local sessions:
   `$KABANE_HOME/loops/<runId>/{run.json, events.jsonl, inbox.jsonl}`.
   - `run.json`: config, status, runner pid.
   - `events.jsonl`: the trace and the board's event source.
   - `inbox.jsonl`: steering, append-only.

   Readers treat a dead pid as `failed`. No migration and no sync.
9. **Config** comes from the trigger form or flags, layered over a repo file `.kabane/loop.json`
   (gates, lenses, harnesses, budgets). Lens prompts ship with the extension and can be overridden
   by `.kabane/loop/lenses/<name>.md`.
10. **The prototype's UX carries over:**
    - tabs `{`/`}`, `w` closes a finished tab
    - `!` jumps to the next question, oldest first, including non-loop questions
    - `o` opens the question's issue with a pinned banner; the banner clears once answered
    - `b` goes back
    - a 3-row header with `e` to expand
    - the `all agents · live` lane with a stable tag color per session
    - the grouped briefing with the plan at the center
    - the debrief on the finished tab

    Q1 (whether starting a loop focuses its tab) is decided after real use.

## Work packages

The packages depend on each other like this:

```
A ──► B1 ──► B2 ──► B3 ──┐
│                        ├──► D ──► E
└──► C1 ──► C2, C3, C4 ──┘
```

Each package merges on its own: `bun run check`, `typecheck` and `test` pass, the board works
without the loop, and there is one concern per commit.

### A. Extension mechanism (CLI)
Done on branch `worktree-agent-a02640e27e5096832` (`4a190e2..ae7d894`).
- Add `"extensions/*"` to the root workspaces.
- Add the `@cabane/extension` contract package, and the official list in
  `packages/cli/src/extensions.ts`.
- Add `extensions` to the config schema.
- Command lookup falls through to enabled extensions' commands, and `helpText` lists them.
- `boardDeps` merges the enabled extensions' ports. The board gains generic `Activity.merge` and
  `Dispatchers.merge` helpers; trigger and card ids get a `<extension>:` prefix so they route back.
- The build check confirms the bundle carries `extensions/*` and still names no `@cabane/*`
  dependency.
- **Evidence:** in a sandbox, an empty `extensions/hello` with one command runs from the built
  tarball, and `kabane board` opens unchanged. Delete `hello` before merging, or keep it as the
  smoke fixture if the release smoke can use it.

### B1. Board: tabs and attention (replaces the sidebar)
- Port from the prototype:
  - `ActivityCard.tab` and `sessionIds`
  - the tab bar and the tab state in `nav`
  - `{`/`}` and `w`
  - `!` over `getNeedsInput`
  - the pinned question banner in the detail view
  - clear-on-answer
- Mouse: tabs, lane chips and question options are clickable, routed through the reducer like the
  board's rows and the detail view's tab cells.
- Delete `sidebar.tsx` and every `sidebarWidth` prop; the prototype left them threaded at 0.
- Split the `nav.ts` growth into per-context reducers instead of growing the one file past its
  current 1770 lines, and clear the prototype's new complexity warnings.
- Update the board README's port and key sections and the keymap drift fixtures.
- **Evidence:** headless frames, plus a real terminal run in the sandbox with a non-loop session
  question answered through `!` → `o` → digit.

### B2. Board: event view lanes, card actions, card header
- Port `lanes`, `laneNoun`, `ActivityEvent.lane`, sticky-bottom scrolling on card tabs, and the
  stable session tag palette in `theme.ts`.
- Port `actions` with `ActivitySource.act` and the one-line input prompt.
- Port `CardHeader` by kind, with the board theme exported for it.
- Reserve `x` as the stop key on a card tab, and keep it consistent with the copilot transcript.

Done on branch `worktree-agent-a830dce27b8802384` (on top of `4682f30`), with B1's follow-ups. Found on the
way:
- The input is not a one-line prompt: an action with `input`, and a question that offers no
  answers, open the copilot's own textarea (`PromptField`), so paste, multi-line and `up` history
  work.
- Lanes, actions and the header live on a card's tab only; a card opened with `o` as a plain event
  view keeps the one-line title.
- `inject` needs a live session to aim at, so it waits for a lane; a run that has claimed nothing
  has no one to inject into. The runner reads `inject` inbox entries and drops them until C4.
- `stop` is the command's own (`Loop.stop` with no wait).

### B3. Board: trigger form
- Port `TriggerInput.label`, `group` and `options`, `TriggerDescriptor.preview`, the third
  `inputs` argument to `dispatch`, and the two-column grouped form with dimmed defaults and `•`
  marks for changed values.
- Fix the truncated blocker list (`← JREP-2,JRE…`) the prototype left.

### C1. Loop engine: run, dispatch, plan, stop
- In `extensions/loop`:
  - the run store (Decision 8)
  - the ready frontier over core links
  - continuous claiming under the concurrency cap
  - ACP dispatch with one core session per ACP session
  - the stop condition, budgets, stall detection and deadlock detection, as pure modules
  - commands: `start`, `run`, `status`, `stop`
- In core: add `Planner.answerQuestion`, which writes a `decision` that answers a question
  activity and unblocks the session once every question is answered. The question/answer path in
  core CLAUDE.md becomes true.
- Unit tests cover the business logic only: the frontier, stall detection, the stop predicate and
  budget accounting.
- Wiring, after A: add `loop` to `OFFICIAL`. Add `extensions` to the root `test`, `test:bun` and
  `duplicates` scripts (jscpd errors on a missing directory, so A could not), and to knip if it
  needs an entry.

### C2. Gates, worktree and checkpoints
- Gate commands from config run when an implementing session ends; results go to the work log,
  and a failure reopens the subtask.
- Optional git worktree per run.
- A checkpoint commit per passing gate, and `kabane loop rollback <runId> <sha>`.

### C3. Verifier lenses and findings
- Lens prompt files, the shipped `functional` and `quality` lenses, and repo overrides.
- Findings filed as tagged child issues.
- A `p1` keeps the run open and reopens work.

### C4. Questions, permissions and steering
- ACP `onPermission` and agent questions become core `question` activities, and the session waits
  for `answerQuestion`.
- The `inbox.jsonl` consumer handles `inject`, `pause`, `skip` and `next`, plus the matching CLI
  commands.

### D. Loop on the board
- `board(ctx)` receives the extension context, not the board's resolved scope. Add the scope to
  that context if the loop's ports need it.
- The loop's `ActivitySource` reads `run.json`, `events.jsonl` and the run's sessions; each run is
  a card with `tab: true`.
- The `Dispatcher` offers the "start loop" trigger, with the form inputs from Decision 9 and the
  plan, critical path and risks as `preview`. The risks come from core `lint`.
- The loop `CardHeader` is ported from the prototype's `header.tsx`; actions are written to the
  inbox.
- The prototype's `scripted-timeline.ts`, `seed.ts` and frame script do not come over.

### E. Real end-to-end
- In a `bun run sandbox` home, against a small throwaway git repo with an issue of 3–5 subtasks
  and links, run a real loop from the board with the `claude` harness. Paid harness calls need
  your go-ahead first.
- Expected along the way:
  - a forced gate failure reopens a subtask
  - an agent question is answered via `!` → `o`
  - a lens files a finding
  - the run completes and the debrief shows commits
- Record what was observed, and anything not exercised, in the merge description.

## Deferred
- Third-party extensions as `kabane-<name>` executables on `PATH`, with a manifest.
- A herdr backend for dispatch.
- A stream across all loops.
- Jake re-hosted as an extension.
- A switch for starting a loop on a whole subtree in one session.

## Open questions
1. Opt-in (Decision 2) or the loop on by default?
2. Findings as tagged child issues (Decision 7) or comments?
3. One PR per package, or one branch with a commit per package?
