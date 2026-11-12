# Benchmark Kabane across Codex and Claude

This local runner compares the same small application brief with and without Kabane. Both
conditions build in round 1 and continue in a fresh harness session in round 2. The initial
recipe is deliberately editable: review the app, give it a different theme, and change the
round prompts before freezing an experiment. No scored application run is part of installing
or checking the runner.

The question is whether adding Kabane to an otherwise competent workflow earns back its
cost in verified outcomes, inference usage, delivery time, and human attention. Initial
build overhead and continuation benefits remain visible separately. One pair is a case
study, not statistical proof that Kabane improves every task.

## Start here

Prerequisites are Bun, this checkout's dependencies (`bun install`), subscription-authenticated
Codex and Claude Code CLIs, and a local browser. The optional browser tool uses the maintained
mise backend:

```sh
mise install aqua:vercel-labs/agent-browser@0.42.0
```

`init` discovers that pinned installation without changing mise's global activation. On macOS
it uses an installed Google Chrome executable. Other machines can set `recipe.json`'s
`browser.command` and `browser.executable` to their installed paths; agent-browser's own
browser setup is an alternative. The browser command and the explicit browser executable's
reported versions are frozen. A missing binary fails before model execution.

Run these commands from the Kabane checkout:

```sh
bun run benchmark init ~/kabane-bench/recipe
# Edit ~/kabane-bench/recipe/common.md, round-1.md, round-2.md and rubric.md.
# Verify automatic paid usage/purchase controls in both accounts before setting
# billingControlsVerified=true in recipe.json. It defaults to false.
bun run benchmark freeze ~/kabane-bench/recipe ~/kabane-bench/experiment-1
bun run benchmark doctor ~/kabane-bench/experiment-1 --browser
bun run benchmark run ~/kabane-bench/experiment-1
bun run benchmark report ~/kabane-bench/experiment-1
```

`run` starts real subscribed coding sessions only after the frozen recipe records
`billingControlsVerified=true`. This is an explicit human verification gate, not an inferred
claim based on a healthy included allowance. Until the account controls are checked, doctor
and reports work but model runs remain blocked. It produces `report.md`, `report.json`, and
`results.csv`, including after a failed attempt. To inspect each stage before proceeding:

```sh
bun run benchmark run ~/kabane-bench/experiment-1 --next
```

A later `run` continues at the first uncompleted stage; it never silently retries a failed
attempt. An explicit `retry` starts a **new session** on that condition's existing workspace,
retaining the earlier attempt and counting both. It is not native conversational resume.

```sh
bun run benchmark retry ~/kabane-bench/experiment-1 --next
```

The frozen `maxAttempts` allowance defaults to two per condition/round. The harness-process wall-clock cap
applies to each attempt (browser startup and evidence processing have separate bounds); a timed-out or quota-failed attempt remains an outcome. Do not
exclude it from the efficiency totals. `retry` can recover a dead runner's lock after checking
that its recorded process no longer exists. A still-running experiment refuses a second runner.

The default recipe has Codex build and Claude continue. To study the reverse direction, edit
the harness names in a separate recipe and freeze a new experiment. Analyze directions
separately. The runner randomly chooses condition order once at freeze, runs sequentially,
and completes both conditions' first round before advancing to the second.

## What can be edited

- `common.md`: engineering, browser verification, and handoff expectations shared by every stage.
- `round-1.md`, `round-2.md`: the task briefs. Additional rounds are listed in `recipe.json`.
- `rubric.md`: the human acceptance criteria, frozen outside agent workspaces.
- `starter/`: the common starting files. The default is a minimal README so the app's stack
  can follow the brief; use a prepared scaffold when setup is not part of what you want to measure.
- `recipe.json`: exact model IDs, harness sequence, effort, per-attempt timeout, retry allowance,
  browser paths, and an optional evaluator script path.

The supplied booking brief exercises persistence, overlap rules, cancellation and a later
maintenance/rescheduling change. It is a provisional original adaptation of a booking-task
family, not an unmodified published benchmark task. A funny reskin can preserve these behaviors;
a change to the functional requirements should also change the rubric.

Freeze copies the starter, prompt content, rubric and optional evaluator, records their digest,
and creates separate repositories, harness profiles and a local Kabane device. Changing an
input means creating a new experiment directory. The runner refuses manifest tampering,
changed configuration, changed initial workspaces, later unrecorded workspace edits, changed
harness/browser versions, and changed Kabane/runner source or dependency lock content.

Use an experiment directory outside this checkout and other project trees. Ancestor
`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, or `CLAUDE.local.md` files cause preflight to
refuse the experiment. Existing directories are never overwritten by `init` or `freeze`.

## Configuration parity

Within each harness, both conditions use the same model, effort, common instructions, tools,
permissions, network policy, browser capability, starting files, round briefs, and stopping
rules. Codex and Claude have different native implementations; the comparison is each
harness against itself in the same role, not a claim that the two harnesses are identical.

The baseline has native plans, Git and repository notes, with a request to preserve a useful
handoff. Treatment adds the local Kabane MCP registration and minimal instructions to use
its work records. Native planning and repository notes remain available in treatment. The
extra instructions, tool schemas, calls and record maintenance are part of Kabane's cost;
the baseline is not padded with meaningless tokens.

Profiles use an allowlisted environment, isolated `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
and XDG directories. Ambient API keys, provider overrides, normal skills, account configuration,
and project settings are not forwarded. Claude receives an explicit tool list, disabled
skill discovery, strict MCP configuration and disabled automatic memory. Codex uses an explicit
local configuration with unrelated integrations, memories and delegation disabled. Both get
the same short browser usage guidance. The runner prelaunches an isolated browser companion
before injecting model credentials; the sandboxed agent controls it through the same local
session/socket. This lets Chrome retain its own sandbox while Codex keeps its native sandbox.
The companion is closed after each attempt. Additional agent delegation is out of scope for this
first protocol.

Doctor checks native subscription authentication and Codex's native MCP inventory. Every
Claude run also captures and checks its startup model, API-key source, tools, MCP connection,
skills and plugins. Builtin Claude plugins remain and are compared across conditions; external
plugins/skills fail the check. Treatment must make an observed Kabane tool call. Same-harness
Claude inventories must match after removing the intended Kabane tool difference. Codex's
JSON stream does not provide the same startup inventory/model evidence; its record consists
of requested settings, native MCP inventory and observed execution/tool calls. Do not label
that as equivalent introspection.

This is configuration isolation, **not an OS-level security boundary**. Agents are instructed
to stay in their workspace and supplied tools, but ordinary shell/filesystem capabilities
and administrator-managed policies still exist. It is not suitable for adversarial agents
or for claims that another experiment is physically inaccessible.

## Subscription and credential handling

The runner invokes installed CLIs through their subscription authentication paths. It does
not invoke paid model APIs, purchase credits, switch providers or deploy anything. Existing
account-level automatic credit/extra-usage settings are outside its control. The owner
requires those controls to be checked before model execution, so recipes default to a blocked
`billingControlsVerified=false`. Set it true only after the actual check and freeze a new
experiment; do not infer this from unused included quota. Disable paid fallback and automatic
credit purchase in account settings for the requested no-overage policy. Native subscription authentication
and a short execution cap do not by themselves guarantee zero monetary spend.

Codex requires a ChatGPT `auth.json`. A private temporary profile receives access credentials
and `last_refresh`, with the refresh credential removed. Tokens near expiry are refused; refresh
the normal login before retrying. The runner does not rotate or overwrite the user's original
credentials. Temporary credentials are removed on normal exit. A process forcibly killed
outside the runner can leave its private copied access-token file; remove the experiment's
`home/.codex/auth.json` after verifying no process is running.

Claude credentials come from its native credentials file or macOS keychain. Only a recognized
subscription is accepted. The access token is passed in memory as `CLAUDE_CODE_OAUTH_TOKEN`,
never as an argument or manifest field. Authentication probes use separate disposable homes
so they cannot remove an active attempt's credentials. The runner does not change user-level
harness configuration. Claude's API-only `--bare` mode is deliberately not used.

Keep experiment directories private. Raw traces may contain application data and shell
output. Do not publish the entire directory or harness homes. Model usage is recorded in
native categories; API-equivalent dollar figures are deliberately omitted. Codex cached
input is a subset of its reported input; Claude reports cache reads and writes separately.
Missing usage stays missing, including on interrupted runs.

## Evaluation and evidence

A successful harness exit is **not** a passing app. Without an evaluator, outcomes remain
`ungraded` until actual verification is recorded:

```sh
bun run benchmark grade ~/kabane-bench/experiment-1 baseline 1 pass \
  'Browser: create/edit/search, adjacency, overlap rejection, cancel and restart persistence passed; screenshots in round-1 review folder.'
bun run benchmark grade ~/kabane-bench/experiment-1 kabane 1 fail \
  'Restart lost reservations; screenshot and reproduction saved in review notes.'
bun run benchmark report ~/kabane-bench/experiment-1
```

Grades are append-only; the latest judgment for an attempt is shown, with all judgments kept
in the report. Grade the saved attempt's artifacts, not a later improved app. Review the real
UI at desktop/mobile widths, and retain screenshots and exact reproduction steps. Prefer a
blinded reviewer when practical; work records and app details may reveal the condition.

For executable acceptance checks, set `evaluator` to a relative TypeScript file in the recipe.
Freeze copies its source outside the agent workspace. After each attempt, the runner verifies
the frozen evaluator and snapshot digests, makes a disposable copy of that attempt's saved
workspace, and runs the evaluator with Bun from that copy. Exit zero means pass; another exit,
a timeout or interruption means fail. Output is retained beside the attempt. The evaluator gets:

- `BENCHMARK_WORKSPACE`: its disposable copy of the saved application.
- `BENCHMARK_ROUND`: the one-based round number.
- `BENCHMARK_EVIDENCE`: the attempt directory for screenshots and other lasting evidence.

The evaluator may start the actual app, drive a browser, and prepare dependencies from the
saved lockfile. It must clean up its own detached servers. A custom evaluator is trusted code;
review it before running. Re-run one saved attempt with:

```sh
bun run benchmark evaluate ~/kabane-bench/experiment-1 baseline 1
```

Snapshots preserve executable files and include application records and the treatment's local
Kabane state. They exclude `.git`, dependency directories, `.env`, `.env.local`, `.dev.vars`
and platform debris. They are source/data evidence, not a self-contained environment image.
Credentials and complete harness homes are not snapshotted. Round 2 sees the live state produced
by its own round 1; snapshots retain the before/after evidence independently.

Per-attempt artifacts include launch arguments, exact prompt, raw stdout/stderr, native observed
inventory, status, elapsed time, native usage, tool-call counts, workspace digest and snapshots.
Failure details are retained rather than erased. The process runner caps a dedicated process
group with TERM then KILL and flushes trace output before parsing. A deliberately detached
process can escape that group; app/evaluator instructions require cleanup.

Record human effort in a separate review note with active minutes, exact intervention text,
condition, round and attempt. Do the same for quota-reset waiting, repeated discovery, excessive
context reads, bookkeeping, failed tools and implementation/verification rework. Cite trace
locations for those diagnoses. Neither removed lines nor large token counts alone establish
waste. The runner does not fabricate human-time or causal-rework measurements.

## Interpreting a pilot

Report first-round, continuation and combined outcomes. Round 2 inherits the quality of round 1;
a worse initial implementation can make continuation expensive regardless of handoff quality.
Compare resource use at a comparable verified quality bar, include all failed attempts, and keep
per-provider token categories separate. Show quality/effort tradeoffs rather than hiding them
behind an arbitrary weighted score. The runner excludes between-attempt quota/reset waits from
active duration; record those waits separately for a delivery-time interpretation.

The first experiment has one pair and two rounds: four sessions. Reverse harness order in a
second experiment if the pilot is useful. Further independent repetitions and different tasks
are needed before making a general claim. Freeze changes before rerunning; keep at least one
unused task for checking whether an optimization generalizes. Diagnose one source of waste,
change one mechanism, then run another paired comparison.

## Research and Claude design review

Sources consulted for this protocol:

- [App-Bench tasks and evaluation material](https://huggingface.co/datasets/AfterQuery/App-Bench/blob/main/AppBench%20vExternal.csv)
  supplied functional app-task ideas. Its [methodology](https://appbench.ai/) uses the best of
  three attempts; this runner retains every attempt instead.
- [UI-Bench prompts](https://huggingface.co/datasets/AfterQuery/ui-bench) and its
  [paper](https://arxiv.org/abs/2508.20410) inform optional blinded visual comparison, not
  functional correctness or work-record efficiency.
- [WebCoderBench](https://arxiv.org/abs/2601.02430) offers a larger set of real requirements and
  separates quality dimensions; running the entire suite is unnecessary for a subscription pilot.
- [Anthropic's agent-evaluation guidance](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)
  motivates checking actual outcomes, retaining traces and treating repetitions explicitly.
- [Claude authentication](https://code.claude.com/docs/en/authentication),
  [Claude usage](https://code.claude.com/docs/en/costs), and
  [OpenAI subscription pricing guidance](https://learn.chatgpt.com/docs/pricing) distinguish
  native subscription authentication and usage from API billing estimates.

Claude Code was consulted through a real subscription session, followed by an adversarial
review of auth/isolation and measurement choices. Agreed changes include separate round scores,
source/version/config freezing, baseline notes as a competent alternative, real startup inventory,
no-refresh Codex credential copies, frozen evaluator source outside agent workspaces, preserved
per-attempt snapshots, process-group caps and explicit fresh-session retry semantics. We did not
adopt equal-length prompt padding or count deleted lines as rework: both would distort the
measurement. We also kept the initial case study small rather than requiring a large evaluation
platform or dozens of subscription sessions before learning anything.

## Infrastructure smoke

```sh
bun run benchmark init ~/kabane-bench/smoke-recipe --smoke
# Model execution remains blocked by default. Check account billing controls before
# setting billingControlsVerified=true in smoke-recipe/recipe.json, then freeze.
bun run benchmark freeze ~/kabane-bench/smoke-recipe ~/kabane-bench/smoke-1
bun run benchmark doctor ~/kabane-bench/smoke-1
bun run benchmark run ~/kabane-bench/smoke-1
```

This uses the real harnesses, local Kabane MCP, durable decisions and a fresh-session handoff.
Each model round must also open a local page, click its button, read the changed text and
save a screenshot using the shared browser companion. The evaluator executes the actual
generated TypeScript exports and checks the decision and browser evidence files. Inspect the
trace/screenshots to establish browser correctness; file presence alone does not establish it.
This is a plumbing check, not evidence of app-building superiority. `doctor --browser` also
validates browser launch and interaction independently without any model calls. The scored app runs remain
separate and should use the reviewed app prompts and acceptance criteria.

## Verification status (2026-11-12)

The final CLI's `init → freeze → doctor --browser` path was exercised against actual installed
Codex/Claude clients and Chrome. Both condition profiles passed native subscription-auth
checks, native MCP inventory checks, and real browser open/snapshot/click/read through the
Codex sandbox client. The browser click changed the page to `42`. This preflight makes no model
requests and leaves the billing gate blocked.

The generated local Kabane stdio configuration was also exercised with two actual MCP clients:
the first created an issue and handoff containing a decision, disconnected, and a fresh second
client retrieved that decision with `kabane_context`. This verifies local transport and durable
shared state; it does not prove that either model chooses the right tools during an app task.

An earlier baseline Codex smoke stage completed and passed the real export/decision evaluator.
That stage preceded final browser-companion and configuration fixes, so it is not evidence that
the final paired model workflow has passed. No scored app trial has run. The final model-driven
Kabane condition, Claude continuation, both-direction handoffs and in-model browser use remain
unverified because the owner explicitly requested no more model runs until billing controls
are checked. Running the final CLI with the default false gate was verified to refuse before
creating an attempt. This is the remaining live verification step, not a simulated passing path.
