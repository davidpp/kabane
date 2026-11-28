# 0012: The shipped thread kinds stay declared in core, and the extension contract is unchanged

- Status: proposed
- Date: 2026-11-28
- Issue: JCAB-725, under JCAB-724
- Decided by: claude, while David was away; proposed, waiting on his answer on JCAB-725

## Context

JCAB-724 asked to take `task`, `issue` and `job`, and their workflow policy, out of generic
core and put them behind the extension contract. Their behavior already lives with its owners:
the loop claims issues, the jobs extension schedules jobs, and the questions module needs an
issue. What core still holds is a declaration for each kind and two policy fields read by its
generic paths: `initialState` for creation and `unlisted` for default listings. Those fields
are code-only, so a job stays out of every work queue on a device where the jobs extension is
off and on the hub (ADR 0010, `wiki/thread-kind-workflow-boundary.md`).

## Decision

The four core declarations stay in `CORE_THREAD_KINDS`. `ThreadKindSchema` and
`KabaneModule.threadKinds` stay identity-only. No API change is made until a module or extension
needs a kind of its own that starts in a state or stays out of default listings.

The reasons are in `wiki/shipped-kind-declarations.md`, with a sandbox run of a real extension:

- The jobs extension cannot own job exclusion. Its module is not registered where it is
  disabled, and the hub never registers an extension module.
- A first-party package could own the policy only if every host registers it, and core's own
  tests cannot: `scripts/layers.ts` gives core no data-module dependency. A host that leaves it
  out raises no error. It creates stateless tasks and lists jobs. With the fields stripped, 32
  tests fail.
- No other single package owns `task`.
- North Star 1 is already met: the practice on these kinds (claim, schedule, dispatch, questions)
  lives outside the base. What stays is the record's default reading, which ADR 0010 says must
  hold without any extension.

## Consequences

Shipped kinds keep their names, their `core` source in `kabane_threadKinds`, and their behavior
on every host. Old rows, disabled providers and duplicate names behave as they do now (the note's
sandbox steps 4 to 8). An extension author who declares `initialState` or `unlisted` gets the
`Unrecognized keys` stop line, not a silent change. ADR 0010's single declaration contract holds
for identity but not for policy, which only core can declare. That gap is accepted until a
module needs a workflow kind of its own.

## Replaceable by

`CodeThreadKind` from the note: a module's code declaration may carry `initialState` and
`unlisted`, read at call time with core's. The core declarations would keep their place. Build
it when a module or extension asks for a workflow kind of its own. The hub would honor that
policy only for first-party modules. A full move to a first-party `@kabane/work` package needs
an owner that core's tests can register first.
