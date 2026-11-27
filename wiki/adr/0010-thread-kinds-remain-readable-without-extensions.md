# 0010: Every thread kind is readable without its extension

- Status: accepted
- Date: 2026-11-27
- Issue: JCAB-706, alongside JCAB-671 under JCAB-652
- Decided by: David

## Context

A monitor wants to file a signal. Its kind tells a reader what the thread is. An
attribute can say what sort of signal it is, for example a finding. The board,
another device and a hub-only agent may each have different extensions installed.
ADR 0001 put jobs in core so all three could read a job. With custom thread
kinds, adding every new kind to core would make each project's vocabulary a
Kabane release decision.

## Decision

A plain thread is usable on its own. Shipped and project-defined kinds use the
same declaration contract. A declaration can give a kind a name and a display
label. That alone is enough for someone to file and recognize a signal.

Core owns the readable record. The default client shows the kind and gives the
reader access to the thread's content, attributes, entries and refs through
the ordinary thread view. It can use declared labels when available. If the
declaration is missing, stored identifiers and values are sufficient to read
the record. This applies to existing threads when an extension is disabled.

An extension owns the behavior and specialized UI it adds to a kind. A jobs
extension can schedule a job and show its next run. Every client can still
read the job's request and history without running scheduler code.

## Consequences

A scope can introduce a kind without shipping executable code. Clients can
choose a compact list presentation and expose the full record in detail.
Kind-specific actions are available where their extension runs.

This supersedes ADR 0001's choice to enumerate `job` in core and retains its
decision to keep scheduling and commands in the extension. JCAB-706 carries
the implementation. The packaging and migration order of existing workflows
remain separate decisions.
