# Conditions, `kabane wait` and reactions: the rules behind ADR 0007

Design record for ADR 0007 (proposed). Nothing here is built. It describes what exists today
where that matters, with the file that holds it.

## What exists today

`kabane job tick` is in the jobs extension. `kabane job add` offers to install it: a launchd
agent on macOS, a crontab line on Linux, each running it every minute
(`extensions/jobs/src/job-tick.ts`). The tick fires due jobs, and it runs `jobs.onAttention`
once when a job's newest run on this machine starts waiting and once when it finishes. What the
tick last saw of each run is in `jobs_attention`, a table that is local to the machine and never
synced. hc is herdr core, which runs each agent session in a background terminal; `hc send`
types text into one, and a job with `--session keep` reuses its terminal between fires. The command runs with `sh -c` and gets ids in `KABANE_*` variables. A command that
fails is reported and not retried.

A run row (`jobs_runs`) records the thread it works on, the machine it runs on, its harness and
its session. Run rows sync.

## The conditions

| Condition | True when | Works on today's schema |
|---|---|---|
| `answered <ask>` | the ask has an answer, or was withdrawn; the output says which | yes: `task_questions.status` |
| `state <thread> <states>` | the thread is in one of the states named, such as `done` or `waiting` | yes |
| `ready <thread>` | every thread that blocks it is `done` or `cancelled` | yes: the `blocks` links |
| `run <run> <states>` | the run's row is in one of the states named: `waiting`, `idle`, `ended` | yes: this is what `jobs.onAttention` reads |
| `addressed <actor>` | something is addressed to that actor and nothing has closed it | partly: open questions today, any addressed entry under ADR 0006 |

`ready` is the rule the loop already applies inside a run (`extensions/loop/src/plan.ts`),
including that a cancelled blocker no longer blocks. It moves to core as a read, so a plain
agent and a list can use it.

A run's state is reported by hc on the run's machine and written to its row in `jobs_runs`.
Run rows sync, so another machine can wait on a run and sees the state when the row arrives. That gives "this step is
doable now" outside a loop run.

Time is not a condition. "Check CI in five minutes" is left to the harness on a local machine,
where each one has its own way to wake later. It becomes kabane's concern only for an agent in a
sandbox or in the cloud, whose session cannot stay alive.

## `kabane wait`

```sh
kabane wait answered <ask id> --timeout 30m
kabane wait state JCAB-650 done cancelled
kabane wait ready JCAB-651
```

- Exit 0 when the condition is true, with one JSON line naming the ids and how it came true
  (`answered` or `withdrawn`, the state reached). Exit 1 on timeout. Any other exit is an error.
- A condition that is already true returns at once, so an agent that starts waiting late
  misses nothing.
- It re-reads the database every second. It holds no lock and writes nothing.
- It takes one id. A reaction is what applies a condition to many threads.
- It is a command in base kabane, so the loop, the jobs extension and a person's own script all
  have it. An extension may not depend on another extension, which is why it cannot live in
  jobs.

## Reactions

A reaction names a condition, optionally a scope subtree and a thread kind to narrow it, and a
shell command.

- **Where it is configured.** In the `jobs` settings, on the global and local layers only. The
  shared layer is a file checked into a repo, and a reaction there would hand a command to
  launchd on every clone. Kabane already refuses device keys that launch a process from that
  layer (`wiki/settings.md`, "Device keys").
- **What the command receives.** Ids in `KABANE_*` variables: the thread, the ask, the run, the
  condition. It never receives an entry's text. Between two people, text in the record is
  information for an agent to read, and must not become a command line.
- **When it fires.** The tick checks the condition for every thread, ask or run inside the
  reaction's filter, and fires once for each one that has gone from false to true since the
  last tick. It records what it last saw per reaction and id in its machine-local table, as it
  does for runs today. What was already true when the reaction was added does not fire.
- **What it misses.** A state that comes and goes between two ticks. Reactions suit conditions
  that stay true until someone acts.
- **A command that fails** is reported on the tick's output and not retried, as today.
- **Which machine fires.** A reaction about a run fires only on the run's machine, which the
  run row names. A reaction about a thread or an ask fires on every machine that configures it
  and knows the project's folder. A machine learns a project's folder when a `kabane job`
  command is run in it, which is how the tick finds projects today.

Reactions stay in the jobs extension, beside the tick and `jobs.onAttention`. A device without
that extension has `kabane wait` and no reactions.

## Who is woken when an ask is answered

An ask records the actor who asked. It does not record a run or a session, so "wake whoever
asked" has three cases.

| Who asked | What happens on an answer |
|---|---|
| A session that is still alive and ran `kabane wait` | The command exits and the session continues. |
| A run kabane started, now idle or ended | A reaction on the run's machine types into its kept terminal with `hc send`, or starts a fresh run on the thread. A fresh run reads the record, which is how ADR 0002 already treats recovery. |
| A session kabane did not start, now gone | Nothing can resume it. A reaction notifies the person, or starts a run on the thread. |

For the second case to target the right run, an ask written by a run should name that run.
Under ADR 0006 that is a field in the ask entry's `data`. Whether a reply must reach one
particular run, a lasting agent identity, or anyone acting for the asker is David's call. It is
Codex's second question in `wiki/record-primitives.md`.

## One machine, several machines, two people

The shape is the same in all three, because a condition only ever reads the local database.

| Setup | How a condition becomes true | What decides the delay |
|---|---|---|
| One machine | A local write | The tick's minute, or `wait`'s polling interval |
| Several of one person's machines | A sync pass applies a row written elsewhere | The sync interval, then the above |
| Two people sharing part of the record | The same, for the shared part | The same |

What does not carry over:

- A reaction about a thread fires on each machine that configures it, so two machines can both
  start a run on the same answer. Each run claims the thread first. Under ADR 0006 the holder is
  derived from the claim entries, the same on every device, and the run that lost stops. On
  today's schema that protection does not exist, so until 0006 such a reaction belongs on one
  machine.
- The hub is a Cloudflare Worker and runs no shell, so it runs no reactions. Because conditions
  are a named set, a hub could later answer `wait` for a browser-only agent. That is not
  designed.
- Nothing here triggers a sync pass. Whether the tick should run one first was not looked at.

## ADR 0002's rows, carried forward

ADR 0002 would be marked superseded by 0007, since an ADR is replaced whole. Thirteen of its
fifteen verdicts are kept as they are.

| Need | ADR 0002 | Under 0007 |
|---|---|---|
| Schedules | Owns | Kept |
| Events and watches | Undecided | Changed: kabane owns conditions and `kabane wait`. It keeps no event log. |
| Overlap | Owns | Kept |
| A run asking mid-session | Records | Kept. A harness ask is not relayed into a kabane question. |
| Knowing a run waits | Points to | Kept. The run's state still comes from hc, and it is one of the conditions. |
| Notification | Points to one shell hook | Changed: a reaction on any condition. `jobs.onAttention` stays as one of them. |
| Decisions on record | Out, for jobs | Kept |
| Budgets | Records | Kept |
| Routing between allowances | Owns the choice per job | Kept |
| Memory between runs | Owns only the record | Kept |
| Run history | Owns | Kept |
| Sessions and transcripts | Records a reference | Kept |
| Executing and stepping into a run | Points to | Kept. A reaction calls hc or the harness; kabane starts nothing itself beyond `kabane run`. |
| Crash recovery and replay | Out | Kept |
| Creating and changing jobs | Points to a skill | Kept |

Outside that table, ADR 0002's consequences said the `attention` primitive was out "until a
later ADR brings one back". ADR 0006 brings it back as a query over addressed entries, and the
`addressed` condition reads it.

## What this closes from the Board comparison

| Board gap (`wiki/record-primitives.md`) | Under 0007 |
|---|---|
| An agent waits and is resumed | Closed by `kabane wait`, for a session that is alive |
| An answer continues the work | Closed for runs kabane started; a notification or a fresh run otherwise |
| A step shows up when the one before it finishes | Closed by `ready` |
| A dead worker's task returns to the queue | Two workers holding one thread is covered by ADR 0006. Expiry of a dead claim is out of this version. |
| A delayed follow-up | Left to the harness on a local machine. |
| Failed outcomes, filing a plan in one step, access to one project only | Not touched |

## Not verified

- `kabane wait` in any harness. Claude Code limits a foreground command to ten minutes and
  re-invokes the agent when a background command exits. Codex's sandbox denies some process
  spawns here. No long blocking command was tried in either.
- Running the tick on a database file change through launchd. The tick writes to the same
  database, so it could re-trigger itself.
- Whether `hc send` into a kept terminal works after the terminal has been idle for hours.
