# Agent work in kabane needs seven contracts and no workflow engine

Status: proposal for JCAB-426 (parent JCAB-420), 2026-11-16. Two slices are built; "What is
built" below says how they differ from the sections after it. David answered the decisions on
JCAB-426 the same day; they are summarized below and override any section that disagrees with
them. Research behind it is attached to that issue:
the Jake recipe study (icitte `projects/kabane/research/recipe-primitive.md`), the always-on and
code-mode notes in Second Brain, and the Codex reports on Coral, OpenMausBot, durable
runtimes and cloud runtimes.

## David's decisions, 2026-11-16

Answered on JCAB-426 (:21, :27 to :36). Where a section below still shows an alternative, these
win.

| Topic | Decision |
|---|---|
| Packaging | Packages, no layer-rule change yet: the runtime port and ask relay go into `@cabane/acp` until a second adapter exists; data modules for jobs and runs; extensions stay leaves. |
| Job | A job kind. Not necessarily shown on the board: a separate app, the way the loop is, that can sit in the TUI as a tab. |
| Run | A small synced run row (state, runtime, machine, sessions, outcome, cost) plus a local journal file. |
| Code mode | Later. The Coral-style `kabane_agent_exec` flow is not part of v1. |
| Script recipes | No sandbox decision until the first script recipe exists. Code recipes run locally, as Jake's did. |
| Folder | A scope URI plus a relative dir. A scope with no local path offers to configure one. A run may override the working directory. |
| Schedules | The OS scheduler, through one tick entry running `kabane job tick`. Schedules live on job rows, so `kabane job list` filters them by scope and tag. A daemon can come later if needed. |
| Agent profile | Yes, a kabane profile: the pattern recurred in Jake and in ZACT. Applied both ways: launch flags where the harness supports them, project files where it doesn't. Distribution of skills, profiles and recipes to harnesses is its own primitive (JCAB-436), generalizing what the dispatch skill does today. |
| Machines | Profiles and recipes by chezmoi now. The hub revamp is the next step (JCAB-434, blocked by JCAB-426). |
| First runtime after ACP | A dots trial. Keep the shape open to other allowances (Claude Code's monthly allocation was mentioned); which ones pay off is not known yet. |
| Sessions | Kabane keeps session references. The store for performance, analytics and evals is a separate someday epic (JCAB-437): an existing tool with kabane's philosophy, adopted gradually and configured per user. |
| Scope | Custom agents and jobs are always tied to a scope and a working folder. No user-level jobs in v1. |
| MCP exposure | `kabane mcp` serves a small default set and turns the rest on per project through the existing settings layers (JCAB-438). A Cloudflare-style code-mode tool for the hidden tools comes later (JCAB-439). |

## What is built, and where it differs from the proposal

Slice 1 (JCAB-444, JCAB-445, JCAB-460, JCAB-515) and slice 2 (JCAB-521) live in the `recipes`
extension. `docs/recipes.md` is the user's description; this table is the difference from the
sections below.

| Proposal below | Built |
|---|---|
| The first runtime is ACP, behind a port in `@cabane/acp` | The runtime is hc (herdr core), behind one adapter file in the extension. No port in `@cabane/acp`, no relay move. |
| Asks are relayed to tracker questions | No relay. hc reports the terminal blocked, the run reads `waiting`, and the human attaches or sends text. |
| A recipe is a prompt or a script: `body` is `{ kind: "prompt"; text }` or `{ kind: "script"; … }` | A recipe is a definition over a project skill (JCAB-537): frontmatter only (`description`, `target`, `inputs`, `harness`, and `skill`, which defaults to the file name), and a body is an error. The procedure is the skill, in `.agents/skills/<name>/SKILL.md` with `.claude/skills/<name>` a symlink to it, which the harness loads itself. Kabane sends its preamble, then "Use the <skill> skill.", the target and one line per input. No `{{…}}` substitution. |
| Run states `queued`, `claimed`, `succeeded`, a lease | A run's state is what its program reported through OSC 7501: `live`, `running`, `waiting`, `idle`, `ended`. Kabane never claims success. |
| Run rows in a first-party `@cabane/runs` | `recipes_runs`, in the extension's own module (JCAB-444:1). JCAB-461 decides whether it moves. |
| A job is a module table, or a core kind | `job` is a third core item kind, left out of listings that name no kind (JCAB-522). Its schedule row, `kabane job` and `kabane job tick` are in the `recipes` extension, next to `startRun` (JCAB-523). |
| A job may have no recipe; `schedule` is cron or RRULE; `watch`, `deliver`, `agent` | A job runs a recipe with `target: job` or none, or has no recipe and its prompt is the job preamble then its request, read at each fire (JCAB-527). The schedule is a 5-field cron expression. No watch, delivery or profile field yet. |
| A job's states `active`, `paused`, `done` | The item's own states: `next` is active, `someday` is paused, and a human marks it done. |
| The router resolves a scope to a checkout | A machine-local table records each project's folder when a `kabane job` command runs in it; `tick` reads it and needs no cwd. No router. |
| Continuing after a wait resumes a session or starts fresh | Both, per job (JCAB-526). A fire is skipped while the job's last run is live, running or waiting. A `fresh` job stops its idle terminal and starts a new one; its comments are the memory between runs. A `keep` job types the prompt into its idle terminal with `hc send`, so the harness keeps its conversation, and starts one only when the terminal is gone. No resume by harness session id. |
| The board shows an attention feed | The board shows a run's card on its issue, with its state and attach command, and renders no terminal. A job's runs are on the board's Jobs tab (JCAB-525). No attention feed. |
| Notification is a shell hook | `recipes.onAttention`, a shell command `kabane job tick` runs once when a job's newest run on the machine enters `waiting` and once when it finishes (`idle` or `ended`), with the facts in `KABANE_*` variables (JCAB-527). What the tick last saw of each run is a machine-local table. Only jobs' runs; no built-in notifier, no retry. |

## David's questions, answered in one place

| Question | Answer here | Section |
|---|---|---|
| Can a recipe exist without a durable workflow? | Yes. A recipe is a file and a run is a row. Neither needs an engine. | "Durable replay is a capability of one runtime" |
| Is durability a separate primitive, on top, or equal? | On top. It is the `replay` capability a runtime may report, under the same run record. It is not an eighth primitive. | same |
| Extension chains, packages, or hooks only? | Packages below the extensions, or the record alone with execution outside. Both avoid a chain. The recommended start puts the runtime port and relay in `@cabane/acp`, which needs no layer-rule change; a separate `@cabane/runtime` waits for a second adapter. | "Packaging" |
| Personal work or backend jobs? | Personal. Backend replay stays possible through the runtime port. | "The target" |
| More than one runtime, and free tokens? | A runtime port with push and pull adapters, and a router that filters by needs and then by cost order. The dots path is untested. | "Runtime port", "Routing" |
| Agent prompts as opposed to skills? | An agent profile is a file with standing instructions and runtime preferences. Skills stay as they are. | "Agent profile" |
| Sessions visible and searchable on both machines? | Session references with a short summary are synced rows. Transcripts stay where the harness wrote them. | "Session reference" |
| Where do agents surface things? | One attention feed read by the board's copilot and a small dashboard. | "Attention" |
| Can a run be tied to a folder? | Yes. A job and a run name a kabane scope, each machine resolves it to its own checkout, and the harness starts there and reads the folder's own `AGENTS.md`. | "A run starts in a folder" |

## The target is personal-agent work

Personal-agent work is a request David makes once that runs in a harness he already uses, with
his MCP servers, settings and subscription. Claude Duet's own example of one is "Check Stripe
for unpaid invoices and draft reminder emails for me to approve." Backend jobs are unattended
pipelines that must survive any crash and repeat no side effect. The contracts below serve
personal work and leave a port for backend jobs.

Four requirements come from that choice:

1. Runs happen in the user's harness by default: Claude Code, Codex or any ACP agent, with
   its own settings, tools and permission prompts. Kabane never owns the model loop. Coral
   makes the same cut. The Coral report found no generative-model call in its execution and MCP
   code, and the connected harness writes the programs Coral runs
   (`crates/coral-mcp/src/instructions.rs`).
2. A run starts in a folder, and the folder supplies the project context.
3. Every run and session is visible and searchable afterwards, whether or not kabane started
   it, on whichever machine it ran.
4. More than one runtime exists, and they spend different allowances. A local Claude Code
   session spends the Claude subscription. A dot's own conversations do not count against
   ChatGPT limits on Pro and Business Premium (OpenAI docs read 2026-11-16), while the Work and
   Codex tasks it starts do.

## A run starts in a folder, and the folder supplies the context

David's rule: a well-made folder with an `AGENTS.md` as its index gives an agent started there
the context it needs. The contracts follow it in four ways.

Kabane already has the name for a folder that survives a move to another machine: the scope.
`host.scope.detect(dir)` walks up from a directory to a `.kabane/` marker, then falls back to
git, and returns `{ root, scopeId, scopeUri }`. The scope id comes from the marker or the
normalized git remote, so it is the same on both machines. `root` is a path on one machine.

- A job and a run name a scope URI and an optional directory relative to the scope root. A
  synced row never holds an absolute path as its address. The run also records the `cwd` it
  resolved to, next to its `machine`, as a fact about that execution.
- Each machine resolves the scope to its own checkout. A machine with no checkout of the scope
  cannot take the run, and the router drops it. Kabane stores checkouts by path today
  (`ProjectDirs` in `packages/cli/src/scope/projects.ts`, `DetectedScopes`); the reverse lookup
  from scope to local root was not checked and may need writing.
- A folder that is not a git repository becomes a scope with a `.kabane/` marker, which is how
  a personal folder gets one.
- Kabane starts the harness in that directory and adds no project context. The harness reads
  `AGENTS.md`, `CLAUDE.md` and its own agent and skill directories from there, as it does for a
  session David starts by hand. What kabane sends is the request, the recipe's prompt and the
  human's answers. A run on an issue still gets the issue's brief, which is the record of the
  work and has no other home.

Project recipes follow from the same rule. A recipe in `<scope root>/.kabane/recipes/` belongs
to the folder, travels with the repository through git, and is found by walking up from the
run's directory. Home recipes in `$KABANE_HOME/recipes/` are the fallback and travel through
chezmoi. Agent profiles resolve the same way (`<scope root>/.kabane/agents/`, then home), which
matches how the loop already finds a harness's named agent by walking up from `cwd`
(`Harnesses.agentDefinition` in `packages/acp/src/harnesses.ts`).

## Durable replay is a capability of one runtime, on top of the run record

A recipe does not need a durable workflow engine. "Durable" covers three separate things:

| Need | Mechanism | Who provides it |
|---|---|---|
| A record of what ran, searchable later | Run rows and session references in the tracker | Kabane, always |
| Waiting on a human and continuing | A question, then resume the harness session or start a fresh one from the request and the answer | Kabane plus the harness's own resume |
| Replaying a half-finished script after a crash without repeating effects | An append-only journal and deterministic replay | A runtime that reports `replay`, later |

Quarterdeck, the Anthropic always-on article and OpenMausBot all continue work by rebuilding a
brief from stored state. None restores a suspended stack. The durable-runtime report reaches the
same split: kabane owns the outer run record, the harness owns its session, and deterministic
replay is a capability one executor may report.

One case falls between rows two and three. A script recipe that calls `run.ask()` holds a live
JavaScript stack while it waits. If its process dies, the run ends `interrupted`, and without
replay the only way on is to run the script again from the top, which the human decides. Prompt
recipes do not have this problem, because the harness resumes its own session.

## Seven primitives, each with one owner

| Primitive | What it is | Lives in |
|---|---|---|
| Agent profile | Who does the work: instructions, skills, runtime preferences, needs | Files under `<scope root>/.kabane/agents/` or `$KABANE_HOME/agents/` |
| Recipe | What to run: a prompt or a script, typed inputs and output, no trigger | Files under `<scope root>/.kabane/recipes/` or `$KABANE_HOME/recipes/` |
| Job | A standing personal request: plain-words ask, scope, optional recurrence or watch, human closes it | Rows in a data module |
| Run | One execution on a task, issue or job, or of a recipe alone: scope, state, runtime, sessions, outcome, cost | A row (summary) plus a local journal file |
| Session reference | One harness session: runtime, id, machine, cwd, transcript pointer | A row, attached to a run or on its own |
| Runtime | Something that can execute a run, pushed to or pulling from kabane | A port with adapters, in a harness-layer package |
| Attention item | Something that should reach the human, with why and a link | Rows for results, failures and digests; open questions read from `@cabane/questions` |

Skills stay what they are: instructions any agent can load. OpenMausBot draws the same line. Its
bot identity ("soul") is always in the assembled prompt, skills are an index the agent reads
when one applies, and its `ParsedSkill` defines no bot id, wake schedule or result destination.

All shapes below are sketches in TypeScript. Field names reuse existing kabane vocabulary
(`TriggerInput`, `tier:`, `agent:`, scope URIs) where one exists.

### An agent profile says who does the work and leaves authority in the harness

```ts
// <scope root>/.kabane/agents/<id>.md or $KABANE_HOME/agents/<id>.md
// frontmatter + the standing instructions as the body
type AgentProfile = {
	id: string;                     // file stem
	name: string;
	description: string;
	instructions: string;           // the body; its hash is recorded on every run
	skills?: string[];              // skill names the runtime should make available
	runtime?: {
		prefer?: string[];          // runtime ids in order
		tier?: string;              // same meaning as the loop's tier: tag
	};
	needs?: {
		scope?: string;             // kabane://scope/...: must start in a checkout of this scope
		mcp?: string[];             // MCP servers the work needs, by the name the harness uses
		machine?: string;           // must run on this machine (local apps, files outside any scope)
	};
};
```

Authority is not part of the profile. Approval mode, allowed tools and permission prompts stay
in the harness the profile runs in. ZACT's ADR-0013 gives its recipes no permissions of their own
either; a recipe there references an agent.

A runtime adapter passes the profile to the harness in the harness's own form: the named agent
when the harness already has one of that id, else an appended system prompt. It writes nothing
into the user's harness configuration. The run records the hash of the profile it used.

### A recipe is a definition with no trigger

```ts
// <scope root>/.kabane/recipes/<name>.(md|ts) or $KABANE_HOME/recipes/<name>.(md|ts)
type Recipe = {
	name: string;
	description: string;
	inputs?: Record<string, TriggerInput>;   // renders as a form, CLI flags, MCP tool input
	output?: JSONSchema;                     // what a successful run returns
	agent?: string;                          // default profile for prompt bodies and agent() calls
	target?: "task" | "issue" | "job" | "none"; // what it can run on, as Jake's triggers did
	body:
		| { kind: "prompt"; text: string }            // a .md recipe: run by an agent end to end
		| { kind: "script"; source: string; api: 1 }; // a .ts recipe: run by kabane's script runner
	status: "candidate" | "promoted";          // a saved script starts as a candidate
	provenance?: { fromRun: string; savedBy: string; reviewedBy?: string };
};
```

A recipe has no schedule, event or watch. Those belong to a job. Only 2 of Jake's 26 recipes set
its declarative `workflow:` field, and one was an example. ZACT's proposed recipe did carry a
schedule; this design moves it to the job so one recipe can serve a manual run and a recurring
one.

A script recipe is an async function body against the run API below. It imports nothing: the
runtime injects `run`, so the runtime `@jake/*` import that made discovery silently skip a Jake
recipe has no equivalent.

A recipe written by hand has no `provenance` and is `promoted`. `candidate` applies to scripts an
agent saved.

### A script sees one injected API, and `run.agent()` is where the model comes back

```ts
type RunApi = {
	inputs: Record<string, unknown>;
	target?: { id: string; kind: "task" | "issue" | "job" };
	scope?: { uri: string; root: string; cwd: string };   // the folder this run started in
	record: KabaneTools;            // typed kabane_* tools: list, get, add, edit, comment, ask, handoff
	sh?: (cmd: string) => Promise<{ code: number; stdout: string }>; // home recipes only; runs in cwd
	agent: (prompt: string, opts?: { as?: string; output?: JSONSchema; runtime?: string }) =>
		Promise<{ result: unknown; session: SessionRef }>;   // one harness session, started in cwd
	ask: (question: Question) => Promise<Answer>;            // kabane_ask; the run waits
	emit: (item: AttentionItem | { log: string }) => Promise<void>;
};
```

Everything except `run.agent()` is deterministic code. Each system in the code-mode report has
some place where the model comes back: LLMz's typed exits, Skyvern's `ai="fallback"` on generated
calls, Stagehand's fall back to inference when a cached action fails. A saved recipe should show
where that place is.

### Code mode runs on demand in the harness the user is in, and a save makes a candidate

Kabane exposes two MCP tools to the harness the user is already in:

```ts
kabane_exec({ program: string; intent: string; target?: string }) // run a script now, return its result
kabane_recipe_save({ name: string; source: string; inputs?; output?; description }) // save as candidate
```

The agent explores with `kabane_exec` (calling `record.*`, `sh`, `ask`), and when a function is
worth keeping it saves it. That is Coral's shipped flow. Its instruction to the agent reads: "If
other values can reuse the work (many calls, paging, joins, filters), write a function, call it,
then pass it as `source` to `coral.addCustomTool` in that run". A saved script starts as
`candidate`. It becomes `promoted` when the human (or a review run they started) accepts it.
In Coral a test call before saving is encouraged and not required, and a save stays if the rest
of its run fails, so promotion is a separate decision here. Coral's ADR-0031 also reports that
unprompted Claude Code never saved a function after answering, so the save needs an explicit
instruction.

The run that produced a candidate is linked from it. Its journal lets the review see the calls
and results the script was distilled from, on the machine that ran it.

Three limits follow from kabane's own rules:

- The names above are short forms. An extension's MCP tools are served as
  `kabane_<extension>_<verb>` (ARCHITECTURE.md), so from `extensions/agent` they are
  `kabane_agent_exec` and `kabane_agent_recipe_save`.
- The hub never serves an extension's tools. A dot that reaches kabane through the hub can claim
  and report runs, which are data-module tools, and cannot use code mode.
- An MCP tool call cannot stay open for the hours a human may take to answer. A `kabane_exec`
  program that calls `ask` has to return the run id with state `waiting` and continue under a
  detached runner, as loop runs do, or `ask` is unavailable inside `kabane_exec`. Undecided.

### A job is a standing request in a folder, and only the human closes it

```ts
// A row in @cabane/jobs
type Job = {
	id: string;
	title: string;
	request: string;                    // the ask in plain words
	scope?: string;                     // kabane://scope/...; absent: the job needs no folder
	dir?: string;                       // relative to the scope root; absent: the root
	recipe?: string;                    // a recipe name; absent: the agent works from the request
	agent?: string;                     // profile id
	inputs?: Record<string, unknown>;
	schedule?: string;                  // cron or RRULE
	watch?: { recipe: string; fires: "new" | "change" }; // a script recipe run as a check, no model
	deliver?: "attention" | "issue" | "comment";          // where results go
	state: "active" | "paused" | "done"; // only the human sets done
};
```

Duet's Stripe request has no brief, checklist or territory, and nobody hands it off, which is
why it does not fit an issue. Claude Duet makes the same choice about closing: the agent may
suggest a task is complete, and only the user marks it done. The watch follows Quarterdeck: a
command or tool runs first with no model, the first successful check sets a baseline without
firing, and a model run starts only on new items or a change.

The job names its folder by scope URI, never by path. On the other machine the path differs and
the scope resolves to that machine's checkout. A job with no scope runs with no project folder,
which is the only kind of job a dot can take.

"Item kind" needs care. Kabane's item kind (`task`, `issue`) is `ItemKindSchema` on the task row
in core, and ARCHITECTURE.md keeps any change to the task row a core migration. A data module
can own a `jobs` table and its tools without touching core, but `kabane list`, the board's
columns, search and the brief read tasks and would not show jobs until each learns to. Making
`job` a third value of `ItemKindSchema` shows it everywhere and is a core change. This document
assumes the module table.

### A run is one execution, claimed on one device

```ts
// A row in @cabane/runs (synced), small
type Run = {
	id: string;
	of?: { kind: "task" | "issue" | "job"; id: string };   // absent: an ad hoc kabane_exec or recipe run
	recipe?: { name: string; hash: string };
	agent?: { id: string; hash: string };
	scope?: string;                     // kabane://scope/...; from the job, the issue or the caller's cwd
	dir?: string;                       // relative to the scope root
	runtime: string;
	machine: string;                    // the device that may claim it, set when the run is queued
	cwd?: string;                       // the absolute path it started in on `machine`
	inputs?: Record<string, unknown>;
	state: "queued" | "claimed" | "running" | "waiting" | "succeeded" | "failed"
		| "cancelled" | "interrupted";
	lease?: { owner: string; expires: string };
	attempt: number;
	outcome?: { summary: string; refs: string[] };
	sessions: SessionRef[];             // read shape; session references are their own rows with a run id
	cost?: { quota: string; note?: string };      // e.g. "subscription:claude", "dots:conversation"
};
```

A succeeded run does not close its issue or job. Coral's ADR-0006 keeps the same separation:
ending a Task does not cancel accepted Runs, and a successful Run does not imply a successful goal.

Claiming follows ZACT's local scheduler: one statement claims a queued row with a lease, and a
late result settles only if the row still carries the lease it was given. That statement is
atomic inside one SQLite database. Kabane's sync is not, so two devices that both see a queued
row could both claim it. The rule that prevents this: the router writes `machine` when it queues
the run, and only that device (the hub, for a cloud pull runtime) may claim it. Every other
device reads the row.

State rules the type does not show:

- `claimed` exists for pull runtimes. A push adapter goes from `queued` to `running` when
  `start` returns a session.
- A `waiting` run holds no lease. The answer puts it back to `queued` (fresh session) or straight
  to `running` (resumed session).
- An expired lease ends the run as `interrupted`. Nothing requeues it. ZACT never retries a run
  that starts a fresh session, since a second attempt repeats its side effects. Quarterdeck
  bounds repeats another way: three attempts per item by default, then a question to the human.
- A push runtime's session can outlive the kabane process that started it (an hc terminal, a
  cloud task). No process is left to renew the lease, so the adapter must either poll the
  runtime for status when kabane next runs (hc, `codex cloud`) or have the session report through
  kabane's MCP (routines, which then need the hub). Until one of those happens the row says
  `running` and may be stale.

The heavy part of a run stays on the machine that ran it, as an append-only journal file:
`run.started`, `call.intent`, `call.result`, `call.uncertain`, `ask.opened`, `ask.answered`,
`session.bound`, `run.ended`. It serves inspection and promotion. A replaying runtime may also
use it.

### A session reference is synced, and the transcript stays where the harness wrote it

```ts
type SessionRef = {
	runtime: string;            // "claude-code", "codex", "acp:<agent>", "hc", "dots"
	id: string;                 // the harness's own session id
	run?: string;
	machine: string;
	scope?: string;             // detected from cwd, so sessions list by project on either machine
	cwd?: string;
	title?: string;
	started: string;
	ended?: string;
	status: "live" | "ended" | "unknown";
	transcript?: string;        // a URI on that machine: file:~/.claude/projects/<dir>/<id>.jsonl
	summary?: string;           // a short text, synced, so search works from another machine
};
```

The session index lists sessions kabane started and, through an importer per harness, sessions it
did not start. Only the reference and a short summary are synced, so another machine can find a
session, see where it ran and reopen it there. For an imported session the summary is the
harness's own title or first prompt. Generating one with a model is a run and is left out.

This extends JCAB-316:7 and does not reverse it. Core still keeps no session: an issue's work log
keeps its `session:` URI, `host` still carries no session API, and the index is a data module's
table reached through its tools.

### A runtime reports capabilities, and adapters push or let the runtime pull

```ts
type Runtime = {
	id: string;
	mode: "push" | "pull";
	capabilities: {
		folders: "local" | "clone" | "none"; // starts in this machine's checkout; clones the repo; has no folder
		mcp: "user" | "none" | string[];     // "user": the harness loads the user's own MCP servers
		machine?: string;
		resume: boolean;                 // can continue a session by id
		liveAsks: boolean;               // relays permission and form requests while running
		scripts: boolean;                // can run a script recipe
		replay: boolean;                 // deterministic replay after a crash
		quota: string;                   // which allowance a run spends
	};
	start?(run: Run, brief: Brief): Promise<SessionRef>;   // push runtimes; cwd comes from the run
	resume?(session: SessionRef, message: string): Promise<void>;
	cancel(run: Run): Promise<void>;
};
// Pull runtimes call MCP tools instead: kabane_run_claim (with a lease), kabane_run_report.
```

`folders: "clone"` is a cloud runtime that checks out the scope's repository. It sees the
checked-in `AGENTS.md` and `.kabane/` and misses anything untracked, a gitignored
`CLAUDE.local.md` included.

Candidate adapters:

| Adapter | Mode | Folders | What it gives | Evidence |
|---|---|---|---|---|
| ACP (the loop's today) | push | local | The user's harness started in the run's directory, live asks relayed to the human | `extensions/loop/src/dispatch.ts`, `elicitation.ts` |
| hc (herdr core) | push | local, on any machine added over ssh | Real terminals, programs that survive a core restart, OSC 7501 `blocked` status | icitte `herdr-core-and-app.md` |
| Claude Code routines | push | clone | Cloud runs that use account MCP connectors; HTTP fire endpoint; Claude subscription | `POST /v1/claude_code/routines/{id}/fire` |
| Codex cloud | push | clone | `codex cloud exec`, status and diff from the CLI; shared Codex allowance | Codex docs |
| dots | pull, plus MCP Events | none | A dot connects to kabane's MCP server as a custom plugin and claims runs; kabane can push an event to a subscribed dot | OpenAI "MCP Events" guide lists dots |
| Durable backend (Pi Durable or similar) | push | local | Deterministic replay for unattended script runs | Pi Durable README; experimental API |

Claude Duet gets no adapter. The cloud-runtimes report found no task API, and Duet spends the
same limits as the rest of Claude.

A pull runtime needs kabane's MCP server reachable from the cloud: the hub's `/mcp` with OAuth, or
ChatGPT's Secure MCP Tunnel. Write calls in a dot default to confirmation, and remembered
permission is per conversation, so an unattended claim may stop on an approval. That has to be
tried with a real dot before anything depends on it.

### The router filters by folder and needs, then picks by preference and cost

A run states what it needs, from its job, recipe and profile: a scope, MCP servers, a machine, a
tier. The router:

1. Drops every runtime whose `folders` cannot serve the run's scope: `none` when the run has a
   scope, `local` on a machine with no checkout of it, `clone` when the scope has no git remote.
2. Drops every runtime that lacks a needed MCP server, machine or capability.
3. Picks the first survivor in the profile's `prefer` list, else in the user's configured cost
   order.

A run in a project folder therefore stays on a machine that has the folder, or goes to a cloud
runtime that can clone it. A job with no scope and no local MCP need is what a dot can take.

### Every surface reads one attention feed

```ts
type AttentionItem = {
	id: string;
	kind: "question" | "result" | "failure" | "digest";
	about: { kind: "run" | "job" | "task" | "issue"; id: string };
	scope?: string;
	why: string;              // one line: why this reached you
	created: string;
	seen?: string;
};
```

The feed is a read over two sources. Open questions come from `@cabane/questions` as they are
and are not copied. `result`, `failure` and `digest` items are rows in `@cabane/runs`, written by
`emit` and by a run's end, and `seen` is stored on those rows only.

The board's copilot and a small dashboard read the feed now. A notification shell hook and
herdr, through OSC 7501, can read it later. A wake that found nothing writes a run row and no
attention item. The Anthropic article says to start quiet, and the SGit retrospective reports
nine days of no-news wakes.

## Packaging: primitives are packages, and extensions stay leaves

David's constraint: no extension that needs a second extension that needs a third. His two
alternatives map onto kabane's layers as follows.

| Layer (ARCHITECTURE.md) | Package | Owns |
|---|---|---|
| core + data module | `job` value in `ItemKindSchema`; `@cabane/jobs` | The kind, so list, board and search show jobs; the module holds schedule, watch and delivery fields and their tools |
| data module | `@cabane/runs` | Run rows, session references, attention rows, their tools (`kabane_run_*`) |
| harness client | `@cabane/acp` (exists) | ACP transport |
| harness client | `@cabane/acp` (grows), later `@cabane/runtime` | The runtime port, the ACP adapter, routing, the ask relay. Extracted from the loop's `dispatch.ts` and its relay files (`elicitation.ts`, `permission.ts`, `questions.ts`, `question-body.ts`). It starts inside `@cabane/acp` and splits out when a second adapter needs it |
| harness client | `@cabane/script` (new) | The script runner: a sandbox (candidate: `@earendil-works/pi-codemode`, MIT, QuickJS, one runtime dependency, documented Bun worker support), the run API, the journal |
| extension | `extensions/loop` | Its opinions: gates, lenses, worktrees, landing. Moves onto the shared runtime port |
| extension | `extensions/agent` (new) | `kabane run`, `kabane job`, `kabane recipe`, the two code-mode tools, a board dispatcher; bundles runtime and script |

No extension imports another. The loop and the agent extension share code by bundling the same
harness-layer packages. The two data modules hold ids of each other's rows and do not import
each other.

Checked against ARCHITECTURE.md and `scripts/layers.ts`, the table fits in three places and
breaks a rule in three:

- Fits: the hub "depends on core and the data modules alone", so registering `@cabane/jobs` and
  `@cabane/runs` there is allowed. Both must run in Workers, and the hub needs a manual redeploy.
- Fits: an extension reaches a first-party module's rows through `host.record.call`, so every
  run and job operation has to be a tool. That is also what lets a dot use them.
- Fits: a board dispatcher and `TriggerInput` are existing contract ports.
- Breaks: "never on a package of its own layer". `@cabane/runtime` importing `@cabane/acp` for
  its ACP adapter and for `FormField`, which the relay uses at runtime, is a harness-client to
  harness-client edge. Either the layer splits in two (a harness transport below a harness
  runtime), which is a rule change, or the port and relay go into `@cabane/acp` until a second
  adapter exists, which needs no rule change and leaves `@cabane/runtime` for later.
- Breaks: "the harness client depends on core alone". The relay today takes `Host` from
  `@cabane/extension`, and a relay that files tracker questions would want `@cabane/questions`.
  In a harness-layer package it has to take a narrow record port from the extension that
  bundles it and import neither.
- Needs widening: the extension rule allows "a harness client, which it bundles", and
  `scripts/layers.ts` allows exactly `@cabane/loop -> @cabane/acp`. Two extensions bundling two
  or three harness-layer packages needs those edges added and the prose made plural. The layer's
  description ("driving a coding harness over ACP") does not cover a script sandbox either.

The other way to draw it keeps the harness part out of kabane entirely: kabane ships only the
record (jobs, runs, sessions, attention) and its MCP tools, and an outside runner (hc, a dot, a
Claude routine, a separate project) does all execution. That is the smallest kabane, it needs no
layer change, and North Star 1 leans toward it: "Where someone else already does a practice
well, kabane points to theirs instead of redoing it." It gives up the ask relay the loop already
has, which relays harness permission and form requests to the human as questions on the board.
That relay is 915 lines (`elicitation.ts`, `permission.ts`, `questions.ts`, `question-body.ts`)
beside the 1,091-line `dispatch.ts`.

## Each kind of thing reaches the other machine by one route

| What | How it reaches the other machine |
|---|---|
| Home agent profiles, home recipes, skills | chezmoi, as files |
| Project profiles and recipes under `.kabane/` | git, with the repository |
| Jobs, runs, session references, attention | kabane sync through the hub. Nothing syncs through it today |
| The folder a job or run names | The scope URI syncs; each machine resolves it to its own checkout |
| Transcripts and journals | They stay on the machine that wrote them; the reference says which |
| Live sessions on the other machine | hc `machine add` over ssh, if hc is the runtime |

## What this does not decide

- Whether a job is a module table, a third core item kind, or a task with a recurrence field
  (see the note under Job).
- Which process fires a job's `schedule` and dispatches a queued run. Kabane has no daemon.
  Candidates: the OS scheduler calling a `kabane job` command, the board while it is open, or
  the runtime's own schedule (a routine, a dot).
- Whether a profile is worth a kabane file at all. Claude Code already has `.claude/agents/`,
  chezmoi already shares it, and the loop's `agent:` tag already runs one. A kabane profile earns
  its place only if the same agent must run on Codex or a dot.
- Where a saved candidate is written. `$KABANE_HOME/recipes/` is a chezmoi target, and a file
  kabane writes there is drift until it is added to the source. A `candidates/` directory that
  chezmoi does not manage, with promotion as the move, would make `status` a location.
- Whether a project script recipe runs without explicit trust. ZACT required trust for a
  project-scope recipe before it ran. Here `sh` is limited to home recipes, and `record.*` writes
  are not.
- Whether the relay files its questions as `@cabane/questions` rows. Today the loop keeps them
  in its run store (`questions.jsonl`), so an ask raised on one machine cannot be answered from
  the other.
- The port's name. Core already exports a `Runtime` (`Runtime.configure`).
- Which sandbox runs scripts, and whether scripts get `sh` at all in v1.
- Whether the hub comes back into use for jobs, runs and dots.
- The order of the runtime adapters after ACP.
- Retention. Coral keeps execution history 30 days, and an issue's rationale can outlive that.

## Not verified

- Nothing here was run. The claims about other systems come from source and documentation
  reading in the reports.
- No dot has been connected to an MCP server or subscribed to an event. The dots notes come from
  OpenAI docs read on 2026-11-16.
- `pi-codemode` has not been run under Bun 1.4.1. Its docs report that some long built-ins can
  keep a worker computing after cancellation.
- The session importers assume harness transcript locations seen on this machine
  (`~/.claude/projects`, `~/.codex/sessions`); their formats are not a stable contract.
- Whether an ACP harness started by the runtime loads the user's own MCP servers depends on
  the adapter (claude-agent-acp, codex-acp); the loop has not been checked for this.
- Whether kabane can already resolve a scope URI to a local checkout root.
- That herdr shows a kabane program as `blocked` is inferred from its docs in the herdr note.
