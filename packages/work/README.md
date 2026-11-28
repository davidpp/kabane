# @kabane/work

The kinds of thread that carry work: `task`, `issue` and `job`. The module declares them and
what Kabane does with each, and nothing else: no table, migration, tool or section.

| Kind | Label | Starts in | In a listing that names no kind |
|---|---|---|---|
| `task` | Task | `inbox` | listed |
| `issue` | Issue | `inbox` | listed |
| `job` | Job | `inbox` | left out |

A thread of one of these kinds keeps a state: `kabane edit --state none` on it is refused. A
job is a standing request a schedule runs; the jobs extension schedules it, but the job stays
out of default listings and `state: next` queues whether that extension is on or off.

The CLI and the hub always register `workModule`, first among the data modules. Core itself
declares only the plain `thread`. A host that leaves this module out still reads stored tasks,
issues and jobs under their names, but creates them with no state and lists jobs.

`kabane registry kinds` and `kabane_threadKinds` report the three as `module:work`.
