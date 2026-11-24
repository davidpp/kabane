# 0006: Core's record is four tables with open kinds and keys, so a new need adds data and leaves core's schema alone

- Status: proposed (draft for David's review). The four tables and their sync rules are built
  beside today's tables (JCAB-658); nothing reads or migrates into them yet.
- Date: 2026-11-23
- Issue: none filed yet
- Companion: ADR 0007 (proposed) says how agents wait and how work continues on this record.
  The two are separate because 0007 replaces ADR 0002 and works on today's schema.
- Decided by: not decided. Drafted by Claude from the 2026-11-23 discussion with David.
  Reviewed by Codex (gpt-6.2-astra) the same day: accept with changes, listed in
  `wiki/record-primitives.md`.

## Context

David wants kabane to be the ledger for four uses: coding work, personal agents, messages
between agents on several harnesses for one person, and messages between the agents of two
people. He asked for a core schema that later needs extend by adding data, and said to ignore
what the change costs to migrate.

Core's record today is a thread row with about thirty columns, a timeline, and separate tables
for tags-in-a-column, context refs, upstream links, the work log and projects. Three facts from
his own tracker shaped the proposal:

- 20 migrations ran between 2026-11-04 and 2026-11-22 (7 in core, 13 in modules). Seven
  rewrote a name stored in data (`jake://` to `kabane://`, `cabane://` to `kabane://`, recipes
  to jobs). Eight created or changed a feature's own tables. The other five were core changes:
  two added columns, one bookkeeping table, one dropped table, and sessions moved onto the
  timeline.
- The timeline needed none for new kinds of entry. The `handoff` and `outcome` modules have no
  migrations and hold 854 entries. The `agent:` and `tier:` tags that route work needed none
  either.
- A tag is a plain string, matched by a text search over a JSON array, and `kabane_edit`
  replaces the whole array. The thread row resolves as last-writer-wins on the whole row
  (`packages/core/sync/resolve.ts`), so a tag edit on one device and a title edit on another
  lose one of the two.

Vercel Board was read as a reference. Its container is a conversation, and a task is a
conversation with a state that the platform keeps: the `board.` labels cannot be set by hand.
Zed's Delta makes the conversation its unit too; the pages read describe no task states.

## Decision

Core's record is four tables. `wiki/record-primitives.md` holds the columns, the reason for
each, and the four uses walked through.

1. **Thread.** The container: identity, sharing domain, kind, title, body, scope, parent, state,
   assignee. `kind` is an open string. `state` keeps its closed set and may be empty, because a
   conversation has no work state. The claim (state and assignee) and the text (title and body)
   resolve separately across devices.
2. **Entry.** One authored, dated, append-only line on a thread's timeline, with an open `kind`.
   It gains `to` (the actors it is addressed to), `re` (the entry it answers) and `data` (the
   fields its kind defines).
3. **Attribute.** One row per thread and key. It replaces tags, priority, deadline and defer, and
   resolves per key across devices.
4. **Ref.** A URI a thread keeps pointing at, with a kind. It replaces context refs, upstream
   links and links. A link between threads is a ref to `kabane://thread/<id>` whose kind is the
   link type; `parent` stays the thread's column. An upstream ref's URI is the provider's stable
   id, with the URL in `data`. The work log becomes entries.

A row's identity is its natural key, stored as it is: a thread's and an entry's ULID, an
attribute's thread and key, a ref's thread, URI and kind (David, 2026-11-24). Nothing is hashed
or derived.

A kind or a key is declared as data: a name, a title, and a JSON Schema for its fields. The
schema is checked where a tool writes, never in storage or sync, and a row no declaration covers
is stored and returned as it is. Tool inputs and CLI flags are derived from the declarations.

Scope becomes a path, and a trailing slash names the subtree, as Board's channels do.

Kabane holds no sync mechanism for outside systems. It defines how an outside event is written
on the record, and whatever the person already runs does the fetching.

The four tables converge across devices by their shape, in any delivery order
(`wiki/record-primitives.md`, "How the four tables converge"):

- A row's key is its identity, so two devices that set the same attribute or make the same ref
  write one row. The sync log names a composite key as the JSON array of its parts.
- Nothing is hard-deleted. A thread has `deleted_at`, and a delete is final. A ref or
  attribute has `removed_at`, a write like any other, so a removed one can be added again.
  Entries are never removed.
- Apply checks no foreign key and no UNIQUE key. It writes the winning row whatever has arrived,
  and a read decides what shows.
- A tie is broken by the two rows' own clocks, counters and writing devices, never by the device
  receiving them.
- A parent cycle breaks at its lowest id when read. Who holds a claim is derived from `claim`
  and `release` entries when read.

Core's schema changes once, in one migration. After that, a change to these four tables needs a
new ADR. New tables, kinds and keys are additions. The tables landed first, empty (migration 13,
JCAB-658); the data moves into them in a later migration, and today's tables go then.

## Consequences

- A new practice (a review flow, a digest, a source such as GitHub) is a declared kind or key.
  It needs no core change.
- What is waiting on a person becomes one query: entries addressed to them that no addressee
  has answered, plus threads assigned to them. ADR 0002 left an attention primitive out "until a
  later ADR brings one back". This brings it back as a query, with no table of its own.
- `@kabane/questions` becomes three entry kinds (ask, answer, withdrawal) and its tools.
  Checklist, jobs and runs keep their own tables, and still migrate when those change. The
  record limits that with one rule: a feature's table keeps its fields in one JSON column until
  the shape stops moving.
- Each typed row records the version of the declaration it was written under, and a reader
  converts an older row when it loads it. Rows are never rewritten to follow a new version of a
  kind.
- The record gets a defined file form, one JSON document per row, and a test that rebuilds the
  database from it. A portion can then leave in that form, for example to an artifact on
  patente, David's hosted artifact project. Whether files become the source of truth, with SQLite as an index, is
  left to a later ADR; this draft only keeps it possible.
- This ADR marks none of 0001 to 0005 superseded. (ADR 0007, drafted the same day, would
  supersede 0002.) 0001's decision (a job is a thread kind)
  holds, and only the kind list stops being closed. 0003's holds: an artifact is a ref of kind
  `artifact`. What this replaces is outside the ADRs: `packages/core/schemas/task.ts`, the
  record list in `ARCHITECTURE.md`, the task, tag and storage rules in `packages/core/AGENTS.md`,
  and the attention thread in `wiki/agent-work-contracts.md`.
- Two lines in `PRODUCT.md` need David's ruling before this is accepted: "for one person and
  their agents", and Design Principle 3, because an attribute that caches an outside state is a
  dated copy.
- Left open: the rules of a sharing domain, and who may join one. Every sync op would carry the
  domain, deletes included, which changes the sync log (`wiki/record-primitives.md`, "Two
  people").
- Checked against Vercel Board feature by feature (`wiki/record-primitives.md`). Eight things
  Board allows are missing from kabane today and were not left out on purpose. This ADR covers
  a plan filed as one file, where filing it twice changes nothing, and it stops two workers
  holding the same thread, because the holder is derived from claim entries. ADR 0007 covers three: an agent waiting until something happens, an
  answer continuing the work, and a step showing up when the one before it finishes. Left out
  of this version, by David's rule on what to include: expiry of a dead claim, a failed state,
  and giving an agent one project only. The eighth, a delayed follow-up, is left to the harness on a local
  machine.

## Alternatives rejected

- State as a label owned by a workflow: every client filters on state, and Board itself keeps it
  in the platform.
- Labels as a JSON column on the thread: every label write would contend with every other edit to
  that thread.
- A table per feature in core, as today: it is where the core migrations came from.
- Mirroring outside systems, as Board's sync does: Board's docs warn that a synced channel "is
  as readable as the platform channel it syncs with".

The first level is called a thread, decided by David on 2026-11-23. In his own description of
his work, the thread was kabane's unit every time, and the thing it is about (a design file, a
PR, a Linear issue) was the outside thing it attaches to. "Item" was dropped because it carries
no meaning for an agent and sounds like the thing itself. In Codex, Zed and Amp a thread is an
agent session; kabane records those as `session:` URIs, and its docs say "kabane thread" where
both could be meant.
