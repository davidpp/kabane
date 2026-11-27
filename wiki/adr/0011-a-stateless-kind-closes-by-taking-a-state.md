# 0011: A stateless kind closes by taking a state, and an update can take it away again

- Status: accepted
- Date: 2026-11-27
- Issue: JCAB-710, under JCAB-706
- Decided by: claude, while David was away; open to his override

## Context

ADR 0010 lets a thread have a kind with no workflow, such as a plain `thread` or a scope's
`signal`. A thread of that kind starts with no state, and a write can give it one. Before this
decision no update could take a state away again. The board's `⌃z` after `d` on a signal
silently did nothing, so JCAB-705 made the state keys no-ops on a stateless thread. After that
the board had no way to close a signal, and its `threads` section only grew.

## Decision

`TaskUpdate.state` accepts `null`, which takes the thread's state away. Only a kind with no
`initialState` (`initialStateOf`, `schemas/thread-kind.ts`) may do this; a task, issue or job
refuses it, because its workflow starts it in a state. Closing a signal uses the same
`done`/`cancelled` as every other thread, so the open/closed split, listings, claims and
`completed_at` need no second notion of closed. The write path is `Planner.updateTaskIn`. A
clear releases standing claims and removes `completed_at`. It runs no `onTaskStateChange`,
whose `to` is a state.

## Consequences

The board's `d`, `n`, `s` and `x` act on a stateless thread, and `⌃z` returns it to `threads`.
Once a stateless thread has a state it is listed and filtered like any stateful thread, so a
`state` filter finds a closed signal. `kabane_edit` and `kabane edit` take it away with state `none`
(JCAB-712).

## Alternatives rejected

- A close of their own for stateless kinds (an attribute or an entry): every reader of open vs
  closed (`includeClosed`, the board's archive, listings) would need a second rule, and a kind
  would still be able to take a workflow state from an edit.
