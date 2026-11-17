# 0002: For long-running agents, kabane owns the record and the schedule, and points to other tools for the rest

- Status: accepted
- Date: 2026-11-17
- Issue: JCAB-548 (goal "Jobs that reach me")
- Decided by: David, row by row on a decision page, 2026-11-17

## Context

Research on always-on and long-running agents lists what such agents need: schedules and
event triggers, memory between wakes, asking the human, notification, budgets, run history,
sessions, execution and recovery. The research is the always-on research and the long-running
monitor notes in Second Brain, plus `wiki/agent-work-contracts.md`. The research says what
the parts are. It does not say which of them belong to kabane. Each goal that touched jobs
argued that line again, one feature at a time.

The line follows from the North Stars in `PRODUCT.md` (a base to build practice on, a small
core, explains itself) and from David's rules: wrap the harness and never replace it, Unix hooks
over code, strip features before adding them, and add a guard only after something breaks.

## Decision

Each need gets one verdict. **Owns** means kabane has the mechanism and its data. **Records**
means something else does it and kabane keeps the trace. **Points to** means another tool does
it and kabane hands off through a hook, a command or a URI. **Out** means it is not kabane's.

| Need | Verdict | What that means, and David's note |
|---|---|---|
| Schedules | Owns | The schedule lives on the job, and the OS fires `kabane job tick` (ADR 0001). |
| Events and watches | Undecided | When a cheap check is needed, write it as a code-mode recipe, then see how often it fires. Code-mode recipes are not built. |
| Overlap | Owns | Tick skips a job whose last run is still going. Skips are not recorded. |
| A run asking mid-session | Records | The harness asks in its own session. Kabane, through hc, shows the first line or two of the question where it can; that text is not stored and is not a `kabane_question`. Opening the session is one shortcut away, through hc and not inside kabane. |
| Knowing a run waits | Points to | The harness, hc or herdr report it, and kabane reads what they report. |
| Notification | Points to | One shell hook (`recipes.onAttention`). Kabane's CLI may later list attention or keep an outbox. That is to be thought about after JCAB-548. |
| Decisions on record | Out, for jobs | `kabane_ask` is for issues. A job's question that warranted no issue was not worth keeping, for example a permission approval. |
| Budgets | Records | What each run spent, when the harness reports it. No cap until a job actually runs away. |
| Routing between allowances | Owns the choice per job | The job's harness field. No automatic router until a second runtime pays off. |
| Memory between runs | Owns only the record | The job's timeline is its memory. The folder, the skills and tools such as Obsidian or icitte hold the rest, which varies too much by job to standardize. |
| Run history | Owns | |
| Sessions and transcripts | Records a reference | The harness session id, the machine and where the transcript is. The transcript stays where the harness wrote it. A session store can be pointed to later, through hooks and commands. |
| Executing and stepping into a run | Points to | hc runs and attaches it. Kabane still wraps the command as its own abstraction, because hc ships with kabane and not everyone uses herdr. |
| Crash recovery and replay | Out | A fresh run reads the record. Durable execution is a separate axis, for later. |
| Creating and changing jobs | Points to a skill | A skill that knows the CLI. No new MCP surface while MCP weight is being reduced; MCP is to be revisited. |

## Consequences

- Most of the return path for JCAB-548 is integration work: reading what hc and the harness
  report, and binding the hook. It needs little new kabane state.
- The `attention` primitive, the ask relay, the runtime router, the replay journal and a memory
  store from `wiki/agent-work-contracts.md` are out until a later ADR brings one back.
- Without a recorded decision, kabane cannot answer "why did that job do X" from its own
  record. The transcript, found through the session reference, carries it.
- Budgets need the harness to report cost. Where it doesn't, the run has no spend recorded.

## Alternatives rejected

- A `watch` field on the job, run by tick (the contracts proposal): Jake's declared triggers went
  unused (2 of 26 recipes). Wait for a real cheap check before designing one.
- Relaying every harness ask into a kabane question: it duplicates the harness's own question
  UI and loses the session's context (JCAB-417).
- Caps on runs per day or time per run, as Quarterdeck defaults: speculative until something
  runs away.
- An MCP tool to define jobs: it adds MCP weight for what a skill over the CLI already does.
