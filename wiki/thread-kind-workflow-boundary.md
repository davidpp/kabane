# Where shipped workflow behavior lives (JCAB-709)

An audit of the task, issue and job paths against ADR 0010, as of the JCAB-706 wave: which
behavior is a specialized action owned by a module or extension, which is a generic record
operation in core, and what moved.

## Claim, ready and scheduling were already with their owners

- **Claiming work** is the loop's: `LoopPlan.canClaim` and `isActive`
  (`extensions/loop/src/plan.ts`) take only `kind === "issue"` in `inbox` or `next`. Core has no
  claim or ready operation; `kabane_list` with `assignee` and `state` is a plain filter.
- **Scheduling** is the jobs extension's: the schedule, session mode and check live in its
  `jobs_jobs` table (`extensions/jobs/src/jobs.ts`), and the tick, dispatcher and `kabane job`
  command (`job-command.ts`, `dispatcher.ts`) name `job` themselves.
- **Questions** require an issue in the questions module (`packages/questions/storage.ts`), its
  own policy.

Nothing of these moved.

## What moved: a stateless child is not a run's work

`LoopPlan.isWork` counted every non-finding child of a run's parent as work the plan needs
closed. A signal or plain thread filed under the parent has no state, so it never closed: the
run held open on it as "a human's task", and an issue whose only children were signals stopped
being its own work node. A child is now work only once it has a work state
(`isWork`, `isWorkOf`); a write that gives a signal `next` makes it work again, unclaimable as
any non-issue is.

## What stays in core, as data on the kind's declaration

Two reading defaults name shipped kinds. They are now fields on `CORE_THREAD_KINDS`
(`packages/core/schemas/thread-kind.ts`) instead of literals at their call sites:

- `initialState`: `task`, `issue` and `job` start in `inbox`; any other kind starts with none
  (`initialStateOf`, read by `storage/tasks.ts`). This replaces `WORKFLOW_KINDS`/`hasWorkflow`.
- `unlisted`: a listing that names no kind leaves `job` out (`UNLISTED_KINDS`, read by
  `storage/task-selection.ts`). This replaces `kind != 'job'`.

They stay in core, and code-only, because they must hold where the kind's extension is off. A
job is created in `next`. With the jobs extension disabled on a device, or on the hub, which
never registers it, a job whose exclusion lived in the extension would appear in every default
listing and in `state: next`, a work queue. The sandbox shows the rule holding with the
extension off: `list` and `list --state next` leave the job out, `list --kind job` and `show`
read it, and over MCP `kabane_list` and `kabane_today` leave it out. A module or scope declaration still carries identity only (`ThreadKindSchema` is
strict); `kabane_threadKinds` strips these fields from core's entries.

The default creation kind (`task`, in `kabane_add` and the draft schema) and `kabane_apply`'s
default (`issue`) are record defaults, not workflow behavior, and stay.

## Left as it is, with the reason

- `Stats.stats` counts stale `in_progress` issues only (`storage/stats.ts`). It has no
  production caller; its doc says personal tasks never count. Widening it would change a
  count nobody reads yet.
- A job's schedule is readable only where the jobs extension runs: it lives in `jobs_jobs`,
  not in the thread's attributes. ADR 0010 gives the extension "schedule a job and show its
  next run" and asks every client for "the job's request and history". With the extension
  off, the sandbox reads the request (description), state, and the history a fired run left:
  the `run:` ref in the work log, which `show` lists and the brief's Prior work names. What a
  run did (its state, terminal, harness) stays in `jobs_runs`, the extension's.
- The board's Jobs tab reads `kind: "job"` itself (`packages/board/src/data.ts`). It shows
  stored jobs without the extension's source, which ADR 0010 asks for; the specialized panel
  comes from the extension's job source.
