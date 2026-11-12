# Loop settings that fit the task

Research, 2026-11-12. How the loop could recommend a run's settings from the work in front of it,
instead of starting every run from the same defaults.

## What happens today

- The run form (`extensions/loop/src/dispatcher.ts:87`) defaults each input to the resolved config:
  schema defaults, then global, shared `.kabane/loop.json`, then local. Nothing about the plan
  reaches those defaults.
- The plan is already analysed before the form opens. `Lint.run` (`packages/core/lint/risks.ts`)
  finds file overlap between subtasks, missing tests, large scope, past thrash (reopens), thin
  descriptions and descriptions that name no files. `Briefing.preview` adds the critical path. All
  of it lands in the preview as **risks**: text only. It never changes a setting.
- So the form can say "`a.ts` referenced by JCAB-1, JCAB-2: potential merge conflict if run in
  parallel" and still default to `budget.concurrency` 2 (`LoopConfig.concurrency`,
  `config.ts`). Likewise a single issue gets the subtask-oriented defaults, and a project with
  `check`/`test` scripts gets no gates unless the human already wrote them.
- One `implementer` and one `model` cover every subtask in a run. Nothing can say "this subtask is
  docs, that one is a migration".
- The run record (`RunStore.ClaimSchema`) already holds per-claim harness, outcome, continuations,
  reopen history and gate results: the raw material for learning, unused for advice.

## Settings and the signal that could set each

| Setting | Signal | Kind |
| --- | --- | --- |
| `budget.concurrency` | width of the ready set (max antichain of the blocker DAG), capped; lint's file overlap among subtasks that could run together | deterministic |
| `isolation` | file overlap → `worktree`; single issue → irrelevant | deterministic |
| `gates` | the project's own scripts (`package.json` `check`/`test`/`typecheck`, `Makefile`, `cargo`, `justfile`) | deterministic |
| `setup` | lockfile present and `isolation: worktree` → its installer (`bun install`, `pnpm install`…) | deterministic |
| `reuse`, `maxWorktrees` | follow concurrency and setup cost | deterministic |
| `lenses` | lenses the project offers; plan size and kind of change | rule or AI |
| `stallAfter`, `budget.continuations` | past thrash on these subtasks (lint already reads reopens) | deterministic, history |
| `implementer`, `verifier`, `model` | harnesses installed; nature of each subtask; past outcomes per harness in this project | AI or history |
| `land` | `gh` signed in and a remote → `pr` is possible; otherwise not offered | deterministic |

## Options

### A. A deterministic advisor (recommended first)

A pure function `Advice.of(plan, lint, project) → Recommendation[]`. Each recommendation is
`{ path, value, reason, evidence }`, for example
`budget.concurrency = 1 because JCAB-3 and JCAB-4 both touch packages/core/lint/risks.ts`.

- **Where it applies.** It fills in only settings that no layer sets explicitly; it never overrides
  a value a human set. Where it disagrees with an explicit value, the preview shows the suggestion
  and its reason next to the value. The form marks an advised default with its origin
  ("advised: …") the way the settings view marks a layer.
- **Stars.** Instant (2): no I/O beyond what `triggers` already reads. Explains itself (5): every
  value carries its reason. Human in charge (6): advice, never a lock. Helps you work well (1):
  "recommends theirs instead of redoing it". Gates come from the project's own scripts, not from
  kabane's idea of a gate.
- **Limits.** Rules only see structure (files, DAG, scripts), not meaning. Rules accrete; keep
  each one a small named function with a test, like the lint's `check*`.
- **Seam.** The lint is in core and the advisor is loop-specific, so the advisor lives in the
  extension and takes the lint's risks as input. Turning risks into typed findings (code plus
  data, not only a message) lets rules match on them without parsing text.

### B. Learn from the project's history

Read past `run.json` claims in this project. Outcomes per harness and model, gate reopens under
`isolation: shared`, stalls per `stallAfter`, findings per lens, lenses that never find anything.
Advice cites runs: "the last 3 runs at concurrency 3 reopened 4 subtasks on merge conflicts".

- **Stars.** This is exactly what (1) means by "learns from what happened to the work, never
  from how much of it got done": the inputs are reopens, stalls and findings, never throughput.
  "Proposes a better practice when one isn't working; the human decides."
- **Limits.** Cold start: this machine has 2 runs under `~/.kabane/loops`. Runs are
  machine-local and not synced (4): history on one device only. Small n, so it should speak in
  counts and cases, never in rates.
- **Shape.** The same `Recommendation` type as A, with history as one more input, which makes B an
  add-on to A rather than a rival. Worth recording now whatever B will need that `run.json`
  lacks, such as why a claim reopened.

### C. Ask an agent

Two flavours, neither on the form's open path (2):

- **C1, the copilot sets it up (Yours, by asking, 3).** "Set up a loop for JCAB-x": the copilot
  reads the brief, the advisor's output and the project, then proposes overrides or writes them
  with `kabane_configSet`, explaining each. It needs a copilot skill or instructions and no new
  machinery, and it reuses A's output as grounding.
- **C2, an advisor session on demand.** A short ACP session that returns typed overrides for the
  form ("suggest" on the trigger), shown as a diff the human accepts. It costs a session per
  plan, and the cost and latency must be visible.
- **Stars.** The AI is what sees meaning: a subtask that is docs, one that is a risky migration,
  which lens matters. Agent-driven practice changes fast (1), and a model keeps up where rules go
  stale. Risk: unexplained choices, which is why the output must carry reasons like A's.

### D. The plan declares it

Whoever writes the plan (usually an agent under the dispatch skill) knows the work best. Let it
state per-subtask hints the loop reads:

- a **territory** (globs) per subtask, so overlap is computed rather than regexed out of prose
  (the lint's `FILE_PATTERN` guesses paths from the description today);
- a **weight** or kind (`docs`, `refactor`, `migration`) that routes the implementer and model.

- **Stars.** Issues are the spec. It composes with the dispatch skill, which already assigns
  territories but only in prose. The planner's judgment is explained in the issue (5).
- **Limits.** It needs a place on the issue: tags (`territory:` is awkward), a context ref, or a
  small first-party data module like `@cabane/checklist` (not a core column). Plans not written
  by an agent will lack it, so A must degrade without it.

### E. Per-subtask routing

"Match the task" can mean per subtask, not per run: a cheaper model for docs, Codex for one
territory, Claude for another. The schema has one `implementer` and one `model` per run, so this
is a schema change (an `implementer` per subtask, taken from D's kind or from an assignee already
on the subtask). It belongs after A to D have shown which signals predict anything.

## Recommendation

A, then C1 and D, then B, with E deferred.

1. **A, the advisor**, with a `Recommendation` type carrying reasons, applied only below explicit
   settings and shown in the form and the preview. It closes the gap where the lint sees the risk
   and the defaults ignore it.
2. **C1**: the copilot uses A's output when asked to set up a run. It is cheap and is the "by
   asking" path.
3. **D**: territories on subtasks make A's overlap rule exact, not a guess.
4. **B** once runs accumulate: history feeds the same `Recommendation`s. Record what it will need
   from now on.
5. **E** only if A to D show that routing by kind pays.

## Decided (2026-11-12, JCAB-243)

- **First wave: A and C1**, plus E in its tier form below. D and B come later.
- **What advice may change.** Preferences are never overridden: which harness implements and
  which verifies. Task-shaped settings (lenses, concurrency, isolation and the like) may be
  overridden by advice even when a layer sets them, and the reason is shown.
- **Model tiers instead of models on issues.** An issue states how demanding its work is, never
  a model, because the right model for a tier changes with releases, quotas, the week and the
  project.
  - On the issue: a tag, `tier:balanced`, or `tier:codex/fast` to pin the harness too (a harness
    id, not a vendor).
  - In settings: the mapping from tier to model per harness, in the usual layers, so a change is
    one config write or one request to the copilot. Its keys are the vocabulary. The defaults
    are `frontier`, `balanced` and `fast`, the generic terms routing write-ups converge on, with
    no models pinned.
  - Fallback: a subtask with no tier gets the run's `model`, or the harness default when that is
    unset. A tier wins over `model` for its subtask.
  - The model reaches the session through ACP's model config option, which both pinned adapters
    expose (`dispatch.ts`), not through harness-specific agent definitions.
  - The loop ignores a subtask's assignee on purpose (`claims.ts`: agents assign what they file
    to themselves), so the tier is its own signal.
