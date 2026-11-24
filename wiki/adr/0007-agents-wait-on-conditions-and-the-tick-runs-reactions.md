# 0007: An agent waits on a condition over the record, and the tick runs a command when one becomes true

- Status: proposed (draft for David's review). If accepted it supersedes ADR 0002.
- Implementation: 2.0.0-beta.0 shipped `kabane wait` for answered, state, ready and addressed.
  General tick reactions remain proposed.
- Companion: ADR 0006 (proposed) defines the record this reads. Its Board comparison in
  `wiki/record-primitives.md` says which gaps each of the two covers.
- Date: 2026-11-23
- Issue: none filed yet
- Decided by: not decided. David reopened ADR 0002 on 2026-11-23 ("its old and we've learned
  things since"). The verdicts below are Claude's until he rules.

## Context

ADR 0002 left "events and watches" undecided and pointed notification at one shell hook,
`jobs.onAttention`, which fires only for a job's run. Since then David has named four uses for
kabane, and two of them are agents on different harnesses working together, for one person and
for two.

Checked against Vercel Board, kabane lacks two things those uses need. An agent cannot stop and
be resumed when something it waits for happens: Claude can learn that Codex finished only by
listing issues again. And an answer does not continue the work: the issue stays in `waiting`
until a person opens a session.

Board solves both with an event log and watchers. An event happens once, so a listener that
was asleep, sandboxed or on another machine needs cursors and replay to catch up. David also
required that the shape work the same on one machine and across a synced or shared record.

## Decision

Kabane checks what is true in the record, and keeps no event log.

1. **A condition is a named question about the record** with a yes or no answer: this ask is
   answered, this thread reached a state, this thread's blockers are all done, this run is waiting.
   The set is small and fixed in code. There is no query language.
2. **`kabane wait <condition>` blocks until the condition is true**, prints the ids it concerns
   and how it came true, and exits. A condition that is already true returns at once. A
   timeout has its own exit code. Every harness can run a shell command and wait for it, so this needs nothing from the
   harness.
3. **A reaction is a condition and a shell command.** `kabane job tick`, which launchd or cron
   already runs every minute, runs the command once each time the condition becomes true.
   `jobs.onAttention` stays, as the first reaction.
4. **The record is the only thing that crosses machines.** A condition reads the local
   database. A change made on another machine, or by another person, makes it true here when
   sync delivers the row. No message bus, daemon or webhook is added.

`wiki/conditions-wait-reactions.md` holds the conditions, the rules for which machine fires,
who may configure a command, and ADR 0002's rows, each marked kept or changed.

## Consequences

- A lead agent can hand work to another harness and resume when it completes, with one command.
  A run that kabane started can be continued when its ask is answered.
- A reaction fires within the tick's minute. `kabane wait` re-reads every second. A change made
  on another machine is seen when this device next syncs, and nothing schedules that today.
- A reaction suits a condition that stays true until someone acts: an answered ask, a finished
  thread. A state that comes and goes inside a minute, such as a run that waits and resumes
  between two ticks, is missed. `jobs.onAttention` has that limit today.
- An agent that reaches kabane only through MCP, such as a browser client on the hub, cannot run
  `kabane wait`.
- A reaction fires at least once on each machine that configures it. Two synced machines can
  both start a run on the same answer. ADR 0006 makes that safe: each run claims the thread
  first, the holder is derived from the claim entries, and the run that lost stops.
- A session kabane did not start (an interactive one) can only `wait` while it is alive. Once
  it has ended, a reaction can notify the person or start a fresh run on the thread, which reads
  the record.
- A reaction's command is read from the global and local settings layers only, never from a
  file checked into a repo, and it receives ids, never an entry's text.
- The hub runs no reactions, because a Worker has no shell.
- Four conditions work on today's schema, so this does not wait for ADR 0006.
- ADR 0002's rejection of relaying every harness ask into a kabane question is kept.

## Alternatives rejected

- An event log with cursors, and hooks fired by the writing process: an event missed is lost
  without replay, and the writer is sometimes a sandboxed MCP server that cannot spawn a
  process.
- A daemon that pushes to subscribers: it is a long-lived process to install and keep alive.
  The tick is a one-minute scheduled command that the jobs extension already installs, and a
  machine without it still has `kabane wait`.
- A query language for conditions: a named set can be checked, documented and served by a hub
  later.
- Running the tick when the database file changes: the tick writes to that database itself. It
  is left as an untested way to cut latency.
