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
   config written by a newer kabane still opens, with a warning on stderr since one may be a typo.
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
     Human tasks remain required work and dependency blockers, but only agent issues are dispatched.
     A human-only plan waits for named tasks rather than completing early.
     Agents may add and link subtasks mid-run, and that is a normal event.
   - **Dispatch:** `@cabane/acp`, one session per claim. Ready work is claimed continuously up to
     a concurrency cap, with no lockstep waves. The harness is the run's implementer for every
     subtask, and a claim sets the subtask's assignee to it: agents assign the issues they file to
     themselves, so an assignee says who wrote the issue, not who the human chose to work it.
     Splitting a run's subtasks across harnesses is deferred. The brief is `assembleContext` plus
     short run instructions, with `kabane mcp --scope` attached.
   - **Launch profile:** the loop runs the user's full harness, never the copilot's profile. The
     copilot pins `ANTHROPIC_MODEL=sonnet`, appends its own system prompt, sets `KABANE_SESSION`
     and lets the claude adapter fall back to the Agent SDK's bundled binary. The loop instead:
     - pins no model, unless the run config names one
     - sets `CLAUDE_CODE_EXECUTABLE` to the installed `claude`, and fails if there is none
     - adds no copilot prompt
     - sets `KABANE_LOOP=1`

     This goes through a generic profile argument to `Harnesses.resolve`.
   - **Thin wrapper:** Kabane adds no security and no policy the user did not configure, and
     it overrides none of their settings. The loop forces no permission mode (`acceptEdits`,
     bypass, …), injects no allow rules or settings file, and pins no model. A session that
     opens in the harness's manual mode is moved to the harness's own auto mode (JCAB-29;
     `harness.mode` in the device config turns it off). The harness decides what gets asked.
   - **Permissions:** whatever the harness would prompt in an interactive session reaches the
     human through the tracker, unchanged. The loop never approves or declines a request
     itself.
     - Each request becomes a `question` on the asking session, carrying the harness's options
       verbatim.
     - The human answers from the board or with `kabane loop answer`, and the harness gets
       the option id they picked.
     - A run that stops while a request waits, or a harness that withdraws it, sends it back
       to ACP as `cancelled`, unanswered, and closes its question as withdrawn.
     - Other claims keep running meanwhile.
     - Waiting never counts toward the stall count, which counts automatic attempts, not time
       or intentional parking.
   - **Folder:** `run.json` records `projectDir`, the directory the loop was started from.
     `start` refuses when that directory's detected scope is not the issue's `scopeUri`, unless
     `--dir` is given. Sessions run in the run's worktree, else in `projectDir`.
   - **Gates:** named shell commands from config, run when an implementing session ends. The
     result goes to the work log. A failure reopens the subtask with the output in the next brief.
   - **Verifiers:** lenses, each a prompt file plus a harness, run once the plan is done. Findings
     are child issues of the parent, tagged `finding` and `p1`/`p2`/`p3`. That keeps them
     trackable and fixable with existing tools; `kabane_comment` has no severity field.
   - **Stop condition:** all subtasks done, every lens has reviewed, the fixer has had its pass
     at the open findings, and the gates are green on the result (JCAB-47, C3).
   - **Continuations:** at most N automatic nudges across the run, only for still-active issues
     owned by their implementing claim. Blocked agents set their issue to `waiting` with
     `kabane_edit`, comment the blocker with `kabane_comment`, and end their turn. Waiting,
     someday, human work and live ownership handoffs end the claim without automatic nudges
     or counting against stall detection; earlier failed attempts are neither incremented nor
     reset by parking. Explicitly set `next` to resume; closing a dependency does not unpark it.
     Exhausting nudges alone does not establish a blocker or complete the issue. Normal automatic
     retries (including red gates) remain separate from the nudge budget.
   - **Limits:** concurrency and continuations are enforced. Concurrency defaults to 1: every
     implementing claim works in the run's one tree, so a subtask's gates and checkpoint would
     see a sibling's half-done edits (JCAB-113). More is for subtasks that touch disjoint files.
     An optional spend limit is enforced
     when the harness reports `usage_update.cost`. There is no wall-time deadline; runs continue
     until completion, an explicit stop, or a health/limit stop. Legacy repo `budget.wallMinutes`
     settings are ignored; the CLI flag and board control are removed. ACP reports context
     occupancy, not cumulative tokens, so the meter shows context use, not a token budget.
   - **Health:** one stall detector (no gate or diff progress across N automatic attempts) plus
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

   `kabane loop resume <runId>` restarts a run whose runner died. The claims it left open close
   as `interrupted`, and the claim that takes the same work over (a subtask, a lens, the fixer)
   continues it: the harness session the claim recorded (`acpSessionId`) is reopened through
   ACP `session/resume`, which both pinned adapters advertise, and told only that its last turn
   was cut. When the harness cannot resume it, a new session's brief says what the interrupted
   attempt left: its work-log entries, its commits and `git status`.
9. **Config** comes from the trigger form or flags, layered over a repo file `.kabane/loop.json`
   (gates, lenses, harnesses, budgets). Lens prompts ship in kabane's dispatch template and can be
   overridden by the project's dispatch skill, `.claude/skills/dispatch/references/lenses/<name>.md`
   (JCAB-174).
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
- `inject` (labelled `message` on the tab) needs a live session to aim at: the lane on screen, else
  the card's `liveLanes`, the only one or the newest with `tab` in the prompt walking the rest. A
  run with no session running has no one to message.
- `stop` is the command's own (`Loop.stop` with no wait).

### B3. Board: trigger form
- Port `TriggerInput.label`, `group` and `options`, `TriggerDescriptor.preview`, the third
  `inputs` argument to `dispatch`, and the two-column grouped form with dimmed defaults and `•`
  marks for changed values.
- Fix the truncated blocker list (`← JREP-2,JRE…`) the prototype left.

Done on branch `worktree-agent-ae0c8bf171811033c` (on top of `9e8facc`). Found on the way:
- The form is its own module (`trigger-form.ts` for keys and clicks, `trigger-form-view.tsx` to
  draw it); nav only routes to it. `esc` goes back to the picker, one level per press, rather than
  closing everything.
- The fix is generic: a preview line too long for its room wraps (`Segments.wrap`), the
  overflowing part breaking at a space or a comma under the column it started at. The settings
  stack under the preview below a hundred columns, and the overlay's hint row is dropped when it
  does not fit one row (the footer under it names the same keys).
- An option input's value crosses the port as the option's text; the host converts it back.

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

Done on branch `worktree-agent-aec5e4f6bb339d036`. Found on the way:
- **Config:** `gates: {name: command}` (one-word names, run in key order) and `worktree: bool`,
  from `.kabane/loop.json` or `--gate name=command` (repeatable) and `--worktree`/`--no-worktree`; gates merge
  key by key like budgets. No gates: nothing runs, the run behaves as before.
- **When gates run:** after an implementing session ends with its subtask `done`, while the
  claim still holds the subtask, so nothing re-claims it mid-gate. They stop at the first red
  gate. Stdout and stderr are read together; the last 40 lines are kept.
- **A final pass the plan did not have:** a run whose work is done runs the gates once more
  unless the last pass was green on the same tree fingerprint. Without it a subtask a human
  closes, or a plan already done at `start`, would complete unchecked. A red final pass has
  no subtask to reopen, so the run stops as `gates-red` for a human. `start` therefore accepts
  a plan whose work is done when gates are configured: the run is then a check.
- **On the tracker:** each pass is a work log entry with `gate:<name>` refs (label: `passed in
  2s`, `failed (exit 1) in 300ms`) and `commit:<sha>` for a checkpoint; a red pass's note is
  the failing tail. A red pass reopens the subtask to `next`, and the next claim's brief opens
  with the gate, its exit and the tail. The final pass logs on the parent.
- **Worktree:** `git worktree add -b <branch> $KABANE_HOME/loops/<runId>/worktree HEAD` at
  `start`, so uncommitted work in the checkout is not in it, and a project's untracked
  settings (say, `.claude/settings.local.json`) are not either. The branch is named for the
  parent (`jcab-91-` and the first words of its title, numbered when taken; JCAB-91), and
  `run.json` records it and the base the worktree came from (`base: {branch, sha}`).
  `kabane loop status <runId>` prints it and its checkpoints. Removed with its branch once
  its work is merged, at the parent's next `start` or by `kabane loop prune`; only a worktree
  under `$KABANE_HOME/loops` is ever removed.
  - **On by default (JCAB-52):** a run with the worktree off once ran its fixer's `git switch -c`
    in the maintainer's own checkout, the one their global `kabane` runs from. `worktree`
    now defaults to `true`; `--no-worktree`, `"worktree": false` in `.kabane/loop.json` or the
    board form's toggle turn it off, and `--worktree` turns it back on over the file. A
    project that is not a git repository (no `.git` in it or above it) is worked in place,
    and the start output and a `workspace` event say so.
  - **Reused while unmerged:** when the parent's last run has a worktree that is still one of
    the repository's worktrees, no live run works in it, and its work is not merged, the new
    run goes on in it, on that branch, so follow-up work such as the fixer's builds on what is
    not merged yet. A last run with a pull request asks `gh pr view` (JCAB-91): open, the run
    goes on in it and takes the pull request over; merged, with the branch at its head, the
    worktree is removed; closed unmerged, the run starts afresh and the worktree is left.
    Otherwise git decides (`git for-each-ref --merged HEAD`), which calls a squash-merged
    branch unmerged.
    `run.json` records `worktreeReused: {runId, branch}`, and the `workspace` event carries
    both. A merged branch (one with no commit past HEAD counts), a removed worktree, or a
    last run without one gets a fresh worktree. A last run whose runner died is still refused
    at `start`: it is restarted, not taken over.
  - **Ignored files do not come with it:** no `node_modules`, no build output. A gate that
    needs them installs them itself (`"test": "bun install && bun test"`), or the first pass
    fails in a fresh worktree. The loop adds no setup step of its own; `loop start` prints a
    one-line reminder when it makes a new worktree.
  - **Started in a folder of the repository:** the worktree is still the whole repository, and
    `run.json` records the folder's place in it (`worktreePrefix`, from `git rev-parse
    --show-prefix`). Sessions and gates run in that folder of the worktree, the folder the loop
    was started from. A folder HEAD does not have is refused at `start`.
- **Checkpoints:** `git add -A` and a commit in the worktree after each green pass, with the
  user's own git config and hooks (no `--no-verify`). Nothing to commit makes no checkpoint.
  `Worktree.checkpoint` and `reset` refuse a directory that is not a linked worktree, so the
  user's checkout cannot be committed to or reset even by mistake.
- **Rollback:** a full sha or a unique prefix of one of the run's checkpoints, else refused.
  Also refused while a claim is live (pause and let it finish, or stop). `reset --hard` plus
  `clean -fd` (ignored files stay). The tracker is not rolled back. The `rollback` event is
  written by the CLI for a finished run and through the inbox (`rolled_back`) for a live one,
  so the runner stays the trace's one writer.
- **Stall mark:** closed work, the tree fingerprint and the last pass's gate results.
- **Landing (JCAB-91):** `land: none|pr` (`--land`, the form's Workspace group). With `pr`, a
  run whose final checks are done fetches its base in the worktree and rebases onto it,
  gating again when that moved the branch (a conflict is aborted, a red gate resets the
  branch), pushes with `--force-with-lease` and runs `gh pr create --base <base>`, or pushes
  to the pull request already open for the branch. The outcome is `run.json`'s `landing` and
  `pr`. A failure completes the run anyway, and `kabane loop land <runId>` tries again, or
  lands a `none` run by hand. With a pull request open the parent moves to `waiting` and the
  pull request is its upstream twin.

### C3. Verifier lenses and findings
- Lens prompt files, the shipped `functional` and `quality` lenses, and repo overrides.
- Findings filed as tagged child issues.
- One fixer session takes every open finding after the lenses (JCAB-47, below).

Done on branch `worktree-agent-aec5e4f6bb339d036`. Found on the way:
- **Config:** `lenses: string[]` (none by default, so a run with no lenses completes on its
  gates) and `verifier` (a harness, else the implementer); `--lens <name>` repeatable and
  `--verifier`. `start` refuses a lens with no prompt before writing the run.
- **Prompts:** `packages/acp/templates/dispatch/references/lenses/{functional,quality}.md`,
  inside the copilot's dispatch template since JCAB-174 (they began as the loop's own
  `templates/lenses`). A project's dispatch skill, `.claude/skills/dispatch/references/lenses/<name>.md`,
  adds a lens or replaces a shipped one, and the skill's close review reads the same files. The
  old `.kabane/loop/lenses/<name>.md` is still read after the skill.
  The loop's own part of every lens prompt (how to file, the tags, no edits) is prepended in
  `Brief.lens`, so a repository's lens cannot drop the structured channel.
- **When:** the work is done, nothing is running, and the gates are green on the tree as it
  is. Lenses take free slots like claims, none while paused. Each is a claim on the parent
  (`lens` on the claim, lane `<harness>:<name>-lens`) that leaves the parent's state alone,
  runs no gates, and counts toward no stall. One turn: its end is the review's end.
- **One round:** a lens runs once per run, which the plan did not say. Once every lens has
  reviewed, the fixer has one pass at what they filed and the run completes on green gates
  without a second review. Repeating lenses after every fix has no natural bound short of the
  budgets.
- **Failure:** a lens that ends without finishing (error, cancelled, a stop reason other than
  `end_turn`) stops the run as `lens-failed`, rather than completing unreviewed; one
  interrupted by a runner that died runs again on resume.
- **Stop:** `Stop.evaluate(plan, {gatesGreen, lensesDone, fixerDone})`. Header: a lens step
  after the gates, with the findings count and how many are open, then a fixer step.
- **Fixer (JCAB-47):** findings are never claimed one by one. Once every lens has finished, one
  session on the implementer (`fixer` on the claim, lane `fixer`) gets every claimable open
  finding under the parent, p1 → p2 → p3, read structurally (children tagged `finding`). It
  closes each one it fixes and comments and parks (`waiting`) one it judges wrong or out of
  scope. Its session is over when none of its findings is still claimable or its own; a turn
  that ends with some left spends a continuation like any claim. It does not wait for the
  gates (a resumed one picks up a half-fixed tree); the gates, and a worktree's checkpoint,
  run once it has ended. One interrupted by a dead runner runs again on what is still open;
  one that errors stops the run as `fixer-failed`. Findings it left do not keep the run open:
  the run completes saying how many are left for a human. A run started on a parent whose
  subtasks are all closed goes straight to the fixer when no lens is configured, so
  `kabane loop start <parent>` is how a human has an earlier run's findings fixed.
- **Recheck (JCAB-114):** once the fixer has ended and the gates are green on its result, each
  lens with a finding the fixer closed runs once more on the verifier (`recheck` on the claim,
  lane `<name>-recheck`), with the fixer's diff (`git diff` from the HEAD the first fixer claim
  recorded) and those findings. It edits nothing: it confirms each fix, or reopens the finding
  with a comment, and files only what the diff broke. No second fixer follows; what it reopens
  or files is counted in the exit detail and left for a human. The `recheck` setting (on by
  default, `--no-recheck`, the run form's "recheck the fixes") turns it off; a fixer that closed
  nothing or a session directory outside git skips it.

### C4. Questions, permissions and steering
- **Permissions:** done on branch `worktree-agent-a74b0c0ae0b7397eb`. Every request goes to the
  human; the loop never answers one itself (Decision 7).
  - **The question:** `extensions/loop/src/permission.ts` turns an ACP `onPermission` request
    into a `question` activity on the claim's core session. The session moves to
    `awaiting_input`, so the request shows on `getNeedsInput`. The question body carries
    `permission` (`schemas/question-body.ts`): the tool call's title and the harness's
    options verbatim (id, label, kind). The labels are its `choices`, and free text is off.
  - **The wait:** the relay polls the session for the `decision` that `answerQuestion`
    writes, maps its body to an option (id, then label in any case, then 1-based position)
    and answers the harness with that option's id. An answer that names no option is asked
    again, never guessed.
  - **Stop:** `Dispatch` aborts every waiting relay on `cancel`, on `close` and when the claim
    ends. The ACP client then answers `cancelled`. The claim settles as `cancelled`, and its
    core session ends as `error`, which takes it off `getNeedsInput`.
  - **Withdrawn (JCAB-59):** a harness that takes its request back (`$/cancel_request`, as
    Claude does when its turn is cancelled) aborts the request's own signal; the ACP client
    answers `cancelled` at once. On a stop or a withdrawal the relay closes its question with a
    `withdrawn` activity (`extensions/loop/src/questions.ts`): it carries `answers
    <questionId>`, so the badge and `getNeedsInput` clear even while the session runs on, its
    body says why (`withdrawn by the harness (claude)`, `withdrawn: the loop stopped this
    claim`), and it is no answer and no decision, so the brief stays clean. A question the
    human answered just before is left with its answer.
  - **Events:** `permission_asked`, then `permission_answered` (option id, kind, who, wait),
    `permission_cancelled` (the claim stopped) or `permission_withdrawn` (the harness withdrew).
    Each carries the details in `data`.
  - **CLI:** `kabane loop answer <questionId> <option>` calls `answerQuestion` with the
    option's label. `kabane loop status <runId>` lists the run's open questions.
  - **Who answered:** core records no author on an activity, and adding one is a migration,
    which would stop older devices from pulling. Instead the answering surface appends
    `{kind: "answered", questionId, by}` to the run's inbox. The board does too, since D: it
    calls `ActivitySource.answering(questionId)` before it writes an answer, and the loop notes
    the board's actor when one of its sessions asked.
- Agent questions become core `question` activities the same way, and the session waits for
  `answerQuestion`.
- **Forms (JCAB-59):** the loop passes `onElicitation`, so the ACP client advertises form
  elicitation and the harness can ask (claude-agent-acp turns AskUserQuestion off without it,
  codex-acp its `request_user_input`). `extensions/loop/src/elicitation.ts` relays a form the
  way `permission.ts` relays a request, and fills nothing itself.
  - **Questions:** one per field, all asked at once on the claim's session and numbered "i of
    n" (`questionIndex`/`totalQuestions` too), so the board lists them together. Each carries
    the harness's message, then the field's title and description verbatim. A choice field's
    options are its `choices`, a multi-select is `multiSelect`, a boolean is Yes / No, text and
    numbers are free text. An optional field also offers `skip`, which leaves it out of the
    answer; every field offers `decline`. On a free-text field those are the bare words.
  - **The wait:** the form resolves once every question has an answer: `accept` with the
    fields answered (option values, numbers as numbers, booleans as booleans), or `decline`
    the moment any field is declined, the others then closed as withdrawn. An answer that
    does not fit its field (not a number, out of range, not an option, failing its pattern)
    is asked again, saying why. Answers are `decision`s, the human's choice on the record.
  - **Stop and withdrawal:** as for permissions: the ACP client answers `cancel`, and the
    open questions close as withdrawn.
  - **Events:** `elicitation_asked`, then `elicitation_answered` (`action`, the fields
    answered, who, wait), `elicitation_cancelled` or `elicitation_withdrawn`.
  - **CLI:** `kabane loop answer <questionId> <answer>` takes a multi-select as
    comma-separated options (`1, 3` or labels).
  - AskUserQuestion's companion "Other" box (`question_<n>_custom`) is its own optional
    free-text question: kabane cannot tell it from any other text field without the AIR-only
    markers, so it is relayed as the adapter describes it.
- **Steering:** done on branch `worktree-agent-aec5e4f6bb339d036`.
  - **Inject:** the runner hands an `inject` entry to the live claim behind its session
    (`Dispatch.Handle.inject`); one for a session that has ended is dropped with a warning.
    While a turn runs and the harness advertised steering, the text goes through
    `AcpClient.steer` (`_session/steering`) into that turn. Otherwise, or when the harness
    reports the turn had ended, it is queued and sent as the session's next prompt once the
    turn ends, ahead of any continuation, and spends none. Events: `inject_delivered`
    (`data.via`: `steering`, `new_turn`, `prompt`) and `inject_queued` (`data.why`).
  - **Checked against the adapters:** claude-agent-acp 0.99.1 and codex-acp 2.5.0 both
    advertise `_meta.steering.supported` on `initialize` and honour `idleBehavior:
    promptRequired`: an idle steer on a real session of each returned `prompt_required` and
    started nothing. `new_turn` remains for an adapter that ignores the hint. A steer into a
    running turn has not been watched on either harness yet (paid; package E).
  - **Pause, skip, next:** inbox kinds folded into `run.json`'s `steering` by
    `Steering.apply`. Pause claims nothing and lets running sessions finish. A skipped
    subtask leaves the frontier and stays open, so its dependents stay blocked and the run
    reports `waiting on X (skipped)`. `next` puts a subtask ahead of priority order once it
    is ready, and un-skips it. CLI: `kabane loop pause|resume <runId>`,
    `kabane loop skip|next <subtask>` (the run is the live one on the subtask's parent). Card
    actions: `p` pause/resume, `s` skip, `n` next (the latter two take a short id), next to
    `x` and `i`.

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

The trigger and who-answered are done on branch `worktree-agent-ae0c8bf171811033c`. Found on the
way:
- `board(ctx)` needed nothing new: `Extension.Ctx` already carries `home`, `store`, `cwd` and
  `actor`, and `Loop.start`'s folder check runs on `cwd` as the CLI's does. `--scope` on the board
  does not move it.
- `Loop.prepare` is `start` without the write: the trigger shows the same refusal `start` would
  give (wrong folder, a live run, nothing open) as its hint, and the same resolved config as its
  defaults.
- The form is read off `LoopConfig.Schema` (`settings.ts`): a field the schema gains that is an
  enum, a number or a boolean shows up under its path. Lists and free text (gates, lenses) do not:
  each needs a look in `LOOKS` (toggles, say) before the form can carry it. Config overrides are
  now any object, validated with the repo file, so the form can unset what the file sets.
- Who answered has to be noted before the answer, not after: the permission relay reads the inbox
  the moment it sees the decision. And the question is core's, not a card's: a card only lists the
  sessions its claims recorded, so the seam takes the question id alone and the loop finds the run
  from the session's `externalRef`, as `kabane loop answer` does.
- Q1 stays open: starting a loop leaves the tracker on screen, and the run's tab appears.

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
