# The record as four tables: columns, reasons, and the four uses walked through

Design record for ADR 0006 (proposed). The four tables and their sync rules are built
(JCAB-658, "How the four tables converge" below), and migration 14 moved the tracker into them
(JCAB-660, "The migration" below); the rest is not built. Counts come from David's tracker
database, read on 2026-11-23. They are used for cost and risk only. Low use of a field so far is
not treated as a reason to drop it, because David plans to move work from other systems into
kabane.

Terms used below: the **loop** is the extension that drives a parent issue's subtasks through
several agents. The **herdr panel** is the side panel in herdr desktop that lists a folder's
issues. An **actor** is the URI kabane stores for whoever wrote a row.

## What goes in this version

David's rule, 2026-11-23: "if harnesses have the feature, and there is no real benefit to handle
that through kabane I would not include in this version." And: "if has to do with the stability
of being able to sync, risk of duplicates etc when running in programmed/loop systems, I would
include."

| In, because sync or unattended runs depend on it | In, because no harness has it and the record is where it lives | Out of this version |
|---|---|---|
| Ids derived from keys, for filed plans, retried adds and imported events | `to` and `re` on entries, and the read of what waits on a person | A delayed follow-up: each harness has its own |
| The claim holder derived from claim entries | `kabane wait` across harnesses, and reactions (ADR 0007) | Expiry of a dead claim by time: the `tend` skill puts stale claims back |
| The `ready` read, so an agent does not start a blocked thread | Scope paths and subtree reads | A `failed` state: a kind can record a failure later with no schema change |
| The sharing domain on every sync op | Kinds and keys declared as data | Access to one project only: waits on sharing |
| Attribute tombstones, version on typed rows, the rebuild test | | An event log, labels on entries |

## A thread is where the conversation and the pointers meet

David, 2026-11-23, on how he works: sometimes "we attach threads to a primary item (ex: a
design file we are commenting on)", sometimes "the thread and its sub thread ARE the primary
thing" and the code is attached to it, and sometimes "the PR is one angle of it, the
Issue/Request is another, and they usually meet in the middle".

In all three, kabane's unit is the same. A thread holds the conversation and points at
everything else. It is never the design file, the code or the PR.

| His case | What the thread is about | The other angles |
|---|---|---|
| A design file being commented on | A ref of kind `about` to the file | None |
| The discussion is the work | Nothing outside | Log entries pointing at the code |
| A PR and an issue that meet in the middle | The request, in the thread's own body | Two `upstream` refs, with events from both arriving as entries |

A sub-thread is a child thread.

The layout is a forum's, which David named as the comparison: forum, category, sub-forum,
thread, post. In kabane those are the record, a scope path, a deeper scope path, a thread and an
entry. The difference from a forum, in his words, is that a conversation is now also attached
beside a deliverable. So a thread is reached two ways: by place, through its scope, as on a
board or in the herdr panel; and by what it is about, through the URI of the deliverable, as in
a panel beside a design file or a PR. The second is why refs are indexed by URI.

## Request, finding, idea, and how far along: attributes, with the rules on top

David, 2026-11-23: a finding or surfaced element "could self expire / archive itself, an idea
might be pruned if not acted upon after, where a request shouldnt because its a hard ask." And a
complex idea progresses: research gets attached, without all of it landing in the thread.

His herdr panel listed 17 threads under "next" that looked alike. All 17 were written by an
agent (428 of the 474 open threads are), yet some were asked for by him and most were noticed by
an agent. The record holds who wrote a row. It does not hold whether anyone asked for it.

| What | Where | How |
|---|---|---|
| A thread is a request, a finding or an idea | The record | One declared attribute, set when the thread is filed |
| Who asked, for a request | The record | An actor on that attribute's entry, since an agent files on a person's behalf |
| How far along it is (needs research, needs a brief, ready) | The record | A second attribute. The `needs-brief` and `ready` tags do this today. |
| Research on a thread, kept out of its brief | The record | A child thread holds the research and its entries. The parent gets one entry with the conclusion and a ref to the result. A brief already shows a child's state and none of its entries. |
| A finding expires, an idea is pruned, a request never is | On top | A scheduled job with that rule. Expiring closes the thread as `cancelled` with an entry that says why. |
| Requests listed apart from findings | On top | The board and the herdr panel filter on the attribute |

Kabane does not enforce who may call something a request. It records who asked.

## The four tables

| Table | Identity | Fixed columns | Open part | How it resolves across devices |
|---|---|---|---|---|
| Thread | id (a ULID) | id, short id, sharing domain, kind, title, body, scope, parent, state, assignee, created by, timestamps, deleted at | `kind` | last writer wins, per group of fields (below); a delete is final |
| Entry | id (a ULID) | id, thread, kind, kind version, author, body, time, `to`, `re`, `data` | `kind`, `data` | append-only |
| Attribute | thread and key | thread, key, key version, value, updated by, updated at, removed at | `key` | last writer wins per thread and key |
| Ref | thread, URI and kind | thread, URI, kind, kind version, title, `data`, removed at | `kind`, URI scheme | last writer wins per thread, URI and kind; a removal sets `removed at` |

A row's identity is its natural key, stored as it is: there is no id to derive. Two devices that
set the same attribute or make the same ref write one row. A link between two threads is a ref:
its URI is `kabane://thread/<id>` and its kind is the link type. Key versions on attributes are
not built yet.

Every row also carries the three replication columns that exist today (`updated_by`, `version`,
`visibility`), and the id of the device that wrote it.

### Thread

A thread holds only what every kind has. A coding issue, a personal task, a job and a
conversation each have a title, a scope and an author. A conversation has no priority and a job
has no deadline, so those leave the row and become attributes.

`state` stays a column with today's seven values, and may be empty. Kabane's own board (its terminal UI), the herdr panel
and the loop all filter on it, and a state any writer could set to any string would mean nothing
to a second client. It may be empty because a conversation has nothing to finish.

`parent` stays a column and the `parent` and `child` link types go, so there is one way to
nest. Nesting has no depth limit and may cross scopes; the tracker already holds 247
grandchildren and 51 children outside their parent's scope. A big project or an initiative is an
thread with children, and needs no kind of its own.

These leave the row: priority, deadline, defer and tags (attributes), the provenance block
(`created by` and a ref carry it), `confidence`, the GTD `context` field, `projectId` and the
`projects` table, `scopeRefs`, the three review columns, `verification`, and `evidence`.

The thread row resolves in two groups, each with its own clock: the claim (state and assignee)
and everything else that changes (title, body, kind, scope, parent). Today the row resolves as a
whole, so a title edit made offline can undo another agent's claim. This came from Codex's
review. The delete is a third group of its own (below).

Who holds a claim is derived, and stored nowhere. An agent claims a thread by writing a `claim`
entry and setting the state. Entries are append-only, so when two machines claim the same thread
offline, both entries survive the sync. The holder is the earliest claim entry that nothing has
released, by time and then id, which every device computes the same way. The other agent can
check that it lost, and `kabane wait` can tell it. This is what stops two machines doing the same
work, and it is why a reaction that starts a run is safe on two machines: the run claims first,
and the one that lost stops.

`sharing domain` is set when the thread is created and never changes. It names what the thread is
shared as, and every sync op carries it, deletes included. Its rules are open (see "Two
people").

### Entry

An entry is what a thread's timeline is made of, as today. Three columns are new.

- `to` lists the actors an entry is addressed to. Empty means it is for whoever reads the thread.
- `re` is the entry this one answers.
- `data` holds the fields a kind defines. Core stores it without checking or indexing it.

Entries stay append-only, so two devices never conflict on one. "Handled" is therefore derived:
an addressed entry is handled when one of its addressees writes an entry with it as `re`, or
when its author withdraws it. A follow-up by the author does not count.

An entry written for an outside event takes an id built from the sharing domain, the provider,
the account and the event's own id. A script that polls GitHub from two machines then writes the
same row twice, and the second write is skipped. Two importers that disagree on the content are
reported. Such an id is not built yet (JCAB-661 holds threads created from a key); attributes and
refs need none, because their key is their identity.

`kind version` records the version of the kind's declaration the entry was written under.

### Attribute

One row per thread and key: `priority = high`, `agent = codex`, `tier = frontier`,
`ms = first-playable`. A plain tag such as `finding` is a key with an empty value.

A value changes without touching the thread row. An agent setting `agent = codex` on one machine
and a person editing the title on another both keep their change. Core has the resolver for
this shape (`natural-key-lww`, used for context refs).

Queries become joins on key and value, such as `kind = issue`, `agent = codex`, and no `review`
entry. Today a list takes one exact tag.

Attributes are on threads only. This reverses what Claude told David earlier on 2026-11-23, that messages
arriving from Slack would need labels on entries. A fact about an entry that changes later (it
was triaged, it was handled) is a reply to it, which stays append-only and says who did it. If
that proves too weak, attributes on entries are a new table, which is an addition.

### Ref, and links as refs

A ref is a URI a thread keeps pointing at, with a kind: an input (`spec`, `research`, `ADR`), a
maintained output (`artifact`, ADR 0003), the thread's counterpart in another tracker
(`upstream`), or another thread. Context refs, upstream links and links all fold into it.

- **A link is a ref to a thread.** Its URI is `kabane://thread/<id>` and its kind is the link
  type: `blocks`, `related`, `duplicate`, `follows`. `parent` and `child` are not link types;
  nesting is the thread's `parent` column. Refs are indexed by URI, so "what points at this
  thread", such as what blocks it, is a lookup. A link shows while both threads show.
- **An upstream ref's URI is the provider's stable id** for the item, in the provider's own form,
  and its URL, which can change, lives in `data`. Two devices that link the same outside item
  with different URLs write one row, whose `data` the later write decides.
- **Removing** sets `removed at` instead of deleting the row, so a ref removed on one device and
  made again on another resolves by the later write.

The work log stays a record of occurrences. Each row becomes an entry of kind `log` whose `data`
lists the URIs (`commit:`, `pr:`, `branch:`, `session:`), so the same commit can be mentioned
twice. Core keeps a local index of the URIs in entries, rebuilt from them and never replicated,
so a view can narrow to a branch and an outside event can find its thread.

## How the four tables converge

Built in JCAB-658. Today's sync does not converge (`wiki/storage-and-sync-shapes.md`), and
JCAB-654's attempt to fix it by holding rows failed review. Every finding there came from the
shape of today's rows, so the record converges by its shape: nothing is held, retried or
snapshotted. `packages/core/sync/resolve.ts` ("The 2.0 record") holds the rules, and
`packages/core/storage/record.ts` the reads.

1. **The natural key is the identity.** An attribute's primary key is its thread and key; a
   ref's, its thread, URI and kind; a thread's and an entry's, their ULID. Two devices that write
   the same key write the same row. The sync log names a row with one text, `row_id`: a
   one-column key is the value itself, and a composite key is the JSON array of its parts in key
   order, in `JSON.stringify` form (`RecordKey` in `packages/core/schemas/record.ts`). That is an
   encoding, not a hash: no part's characters can make two keys look alike, and apply skips an
   op whose `row_id` does not name its own row's key in that one form.
2. **Tombstones, never hard deletes.** A thread has `deleted_at`, and a delete is final. A ref or
   attribute has `removed_at`, written like any other change to the row, so a removed one can be
   added again. Entries are never removed. Apply skips an op that hard-deletes a record
   row.
3. **No foreign key or UNIQUE check at apply.** The tables declare none. Apply writes the winning
   row whatever has or has not arrived, and a read decides what shows: a row whose thread is
   deleted or has not arrived is hidden; a thread whose parent has not arrived shows at the root;
   a thread under a deleted thread is hidden, unless a later write moves it out.
4. **Registers.** Each row is one or more registers, and a register keeps whichever of two values
   is greater by its clock, then its counter, then its writing device, then its content. An
   attribute, ref or entry is one register, its key aside. A thread is three: the claim (state, assignee), the
   rest of its fields, and the delete, whose clock is `deleted_at`. A live thread's `deleted_at`
   is empty and loses to any delete, so a write made after a delete is kept in the row but never
   shown.
5. **A tie never depends on the receiver.** Every comparison reads only the two rows, never the
   device applying them, and applying an op twice changes nothing. The counter (`version`,
   `state_version`) orders two writes one device made in the same clock tick.
6. **A parent cycle breaks at read.** In a cycle, the member with the lowest id is read as having
   no parent. No thread disappears.
7. **The claim holder is derived.** It is the earliest `claim` entry, by time and then id, that no
   later `release` entry by the same author has released (`RecordRead.claimHolder`).

Apply checks the boundary before it compares or stores, and skips and counts what fails: a string
holding ill-formed Unicode, which SQLite would store as a replacement character, so the value that
won a tie would not be the one stored; a clock not in `toISOString` form (UTC, milliseconds, `Z`),
since clocks compare as strings; a `row_id` that does not name the row's key. Only an untagged op on a record table reaches these rules: a
module-tagged one parks like any module op. A delete hides what sits under it along the stored
parent edges before any cycle is broken, so a cycle holding a deleted thread is hidden whole.

A writer has one duty for this to hold: a write stamps the group it changes with a clock no lower
than the one stored, a counter one past it, and its own device id. A device that never armed sync
has no device id and writes an empty one; its rows still converge, by counter and then content.
`RecordWrite` (`packages/core/storage/record-write.ts`) is that writer for every storage path.

## The migration (JCAB-660)

Migration 14 (`packages/core/storage/record-migration.ts`) moves every row and drops no stored
value. A task is a thread; each column that left the row is an attribute under its column name
(tags stay one JSON array, so their order holds); a comment is an entry, a work-log row an entry
of kind `log`; links, context refs and linked issues are refs, and a `parent` or `child` link
becomes the child's parent. Ids of links, context refs and linked issues are not carried: a ref's
identity is its key. Every value comes from the source row, so two copies migrated apart write
the same rows. The old `tasks` table is renamed `retired_tasks` rather than dropped, because a
module table still referencing it would lose its rows to the cascade; `tasks` is then a view that
assembles the old row over the visibility read, which is how every client keeps the `Task`
shape. On David's tracker (1548 threads) it reconciles row for row, `kabane export --check`
matches, and two devices through a local hub hold identical tables.

The harness (`packages/core/sync/record-convergence.test.ts`) reads each device's ops in every
interleaving that keeps a device's own order, as one pass and as one op per pass, delivers every
op a second time, and requires the same stored and visible rows each time. A seeded workload runs
three devices through the four tables, with clocks repeating so that exact ties are common.

## Kinds and keys are declared as data

A declaration is a name, a title, and a JSON Schema for the fields. Entry kinds are already
declared without code (`KabaneModule.kinds`) so that a project's config can declare one. A
schema keeps that and adds typed fields.

- The schema is checked at the tool that writes. Storage and sync never check it, because a
  device that lacks the declaration must still store another device's rows.
- A declaration has a version, and a row records the version it was written under. A reader
  converts an older row when it loads it, and falls back to the raw value when it cannot. Rows
  are never rewritten in place to follow a new version of a kind.
- The generic write tools take a kind and its fields, and answer a mismatch with the fields the
  kind expects. A dedicated tool per kind is opt-in for a project, because the tool list is
  being reduced (JCAB-438).
- A name is `<module>` or `<module>.<key>`, as entry kinds are today. Core refuses a second
  declaration of the same name.
- Core's own kinds and keys (`issue`, `job`, `priority`) are written in the same declaration
  format, with a test that keeps the format and the code equal. icitte does this for its
  built-in card types (`plans/custom-cards.md:159` in that repo).
- A converter between two versions of a kind ships with a test of its fallback. icitte has one
  converter of this sort, for its old card kinds, and it lost data once (icons, per
  `plans/custom-cards.md:203`).

Open, from a comparison with icitte on 2026-11-23: how a declaration reaches another device.
icitte's card types live in `.icitte/`, which does not sync, so a type defined on one machine is
unknown on the next (`plans/custom-card-propagation.md:5`). A kabane declaration made in a
project's config has the same problem unless declarations replicate with the record. Also open:
whether a nearer scope may replace a declaration, as icitte's nearest folder does, now that
scopes are paths. The draft refuses a second declaration of a name.

## A feature's own table

A feature keeps a table when its rows change after they are written and are queried on their own
columns. Checklist steps (ticked and reordered), job schedules and run rows qualify. Such a
table holds an id, its thread, the replication columns and one JSON column, and gains real columns
only when the shape has stopped moving. The jobs tables took nine migrations between 2026-11-16
and 2026-11-22.

Questions do not qualify. A question is an entry addressed to someone, its answer is an entry
that replies to it, and a withdrawal is a reply by the asker. `@kabane/questions` becomes the
declaration of those three kinds plus its tools.

## Scope is a path

`botpress` and `botpress/viber` are scopes, and `botpress/` names both and everything under
them. A list or a board can take a subtree.

Branch and package leave the scope's identity. Fourteen of the tracker's 28 scopes are a base
scope plus `?branch=…&package=…`, which splits one project in two. The branch and pull request
a thread belongs to are refs (459 `branch:` and 180 `pr:` URIs today), and a view narrows by
those.

## Outside systems: kabane defines the write, something else fetches

Kabane does not poll, hold tokens for other services, or receive webhooks. It fixes how an
outside event looks once written:

- an entry on the thread that has a ref to the outside thing, with an id derived from the event;
- when no thread has that ref, a new thread assigned to the person, with an id derived from the
  outside URI so two machines create the same one;
- optionally an attribute under the source's name for the current outside state, dated like
  every attribute.

The entry says what happened and links to it. The content itself is not copied.

The fetching is done by whatever the person runs: a scheduled job whose recipe uses `gh` or a
Linear or Slack MCP server, a plain script on cron, a webhook relay, or an automation service.
All of them write through the same CLI or MCP call. Kabane can ship a source as an extension
that carries the declarations and a recipe. The recipe names the kind of tool it needs, and the
person's settings bind it to a product (Design Principle 7 in `PRODUCT.md`).

## A portable form, so a portion can leave and the store can be rebuilt

David raised two things after the first draft: a portion of the record should be able to sync
through a patente artifact later, and files could become the source of truth with SQLite as an
index rebuilt from them.

This draft does not move the source of truth. It adds one guarantee that keeps both open: the
record has a defined file form, and the database can be rebuilt from it.

- The form is one JSON document per row, grouped by thread: the thread, then its entries,
  attributes, links and refs. Each document carries its table, its kind or key, and the
  declaration version it was written under.
- `kabane export <scope>/` writes a subtree in that form, and `kabane import` rebuilds rows
  from it. A test rebuilds a database from an export and compares it with the original.
- A portion that leaves kabane (to a patente artifact, a git repository, a backup) leaves in
  this form. Entries are append-only, so what comes back from a shared copy is new entries and
  changed attributes, never rewritten history.

Whether files then become the source of truth is JCAB-573, a research issue filed on 2026-11-19
whose research has not been run yet. Its brief lists four shapes. This draft's file form is its
shape (a), a mirror for tooling with SQLite authoritative. The per-domain sync target below is
where its shape (d) fits: a `SyncTransport` over a synced folder with one append-only JSONL file
per device, carried by git, Syncthing or iCloud. The brief already notes that files as the
source of truth contradict three written invariants (`CODING_PRINCIPLE.md:31`, `:32`, `:35`). The five shapes are the same
either way, and the rebuild test is what would make the switch safe. Two costs argue against
deciding it here. The hub runs the same core in a Cloudflare Worker with no file system, so it
would need a file store of its own. Several agents write at once, and SQLite gives them
transactions that a folder of files does not.

## A plan is filed as one file, and filing it twice changes nothing

Today a plan of twelve issues is twelve `kabane_add` calls and a link call per dependency. Each
add makes a new thread, so a retry after a crash makes duplicates, and each call costs an agent a
tool round trip.

- **A plan is a file in the portable form above**: threads, their attributes and the links
  between them. Each thread carries a key the planner chose in place of an id, and a link names
  its two ends by key or by an existing id.
- **`kabane apply <file> --key <plan key>`** creates what the file describes. A thread's id is
  derived from the plan key and the thread's key, so applying the same file again lands on the
  same ids and creates nothing. One MCP tool takes the same document, for an agent with no
  shell.
- **The one-at-a-time way stays.** `kabane_add` and `kabane_link` are unchanged, and `kabane_add`
  takes an optional key with the same effect, for an agent that adds a single thread and may
  retry. Board offers both ways too: `tasks create` and `tasks needs` one at a time, or
  `tasks create --file plan.json --idempotency-key <k>`.

This adds no table. It is a second use of ids taken from a key, after outside events.

## Where a sharing domain syncs is chosen per domain, behind one interface

David wants to be able to write an adapter that syncs one project through another platform, his
employer's for example, without kabane knowing that platform. The draft needs three properties
for that, and core has the first already.

- **One interface.** A sync target is anything that accepts ops and hands them back in one
  order. Core defines that as `SyncTransport`, with `push` and `pull`
  (`packages/core/sync/transport.ts:70`). The HTTP hub and the in-process relay used by tests
  both implement it.
- **One target per sharing domain.** Today a device has one target for everything. With the
  sharing domain on every op, a device can send a personal domain to its hub, a work project to
  an adapter, and keep a third on the device only.
- **The wire form is the portable form above**: one versioned document per row. An adapter
  stores and orders documents. It never needs kabane's tables.

An adapter is then an extension that contributes a `SyncTransport`. The extension contract
exposes no such field today, so that is a contract addition for a later ADR. Nothing about a
particular platform belongs in core.

## The four uses, walked through

| Use | A real case | How it is recorded | What stays outside kabane |
|---|---|---|---|
| Coding work | JCAB-650, a loop fix merged through PR #167 | A thread of kind `issue` with a state and an assignee. `agent` and `tier` attributes route it. `commit:` and `pr:` refs point at the work. The closing entry is a `handoff` or `outcome.summary`. A check by the other harness is an entry of kind `review`; the tracker holds 33 of those. | The code, the PR, the transcript |
| Personal agents | JCAB-546 "Steward" and JSEC-1 "Keep second-brain current as an LLM wiki" | A thread of kind `job`. Its schedule and run rows stay in the jobs extension's tables. Each run writes one entry on the job. What the job maintains is a ref of kind `artifact`. Something for David is an entry with him in `to`. | What fires the schedule, the run's session, the fetching |
| Agents on several harnesses, one person | A loop run, which today passes questions through `questions.jsonl` and answers through `inbox.jsonl` in the run's own store | A worker's question is an entry with the lead or David in `to`. The answer is an entry with `re`. The plan is child threads with `blocks` links. | Waking the agent that asked, and knowing a claim is still alive |
| Agents of two people | No real case yet | Both people replicate one scope subtree. An agent of one writes an entry with the other person, or one of their agents, in `to`. | Who may join the scope, proving who someone is, the transport |

## Two people: one thing fixed now, one left open

**Fixed now: an actor names the person an agent acts for.** `kabane://actor/<person>` is a
person and `kabane://actor/<person>/<agent>` is an agent acting for them. Today's
`kabane://actor/agent/claude` cannot say whose Claude wrote a row. Core reads the URI: it tells
an agent from a human by the `agent/` and `human/` prefixes (`packages/core/mcp/tools.ts:79`),
so that code changes with the format. Changing the format also rewrites stored data, which is what seven of the twenty
migrations did, so it changes once, in the same migration as the tables.

**Left open: the rules of a sharing domain.** An op in `sync_oplog` carries a table, a row id
and a payload, and a delete carries no payload at all. Nothing on an op says who may receive
it. Codex's review named this the first change the draft would be forced into, so the thread gets
an immutable sharing domain and every op carries it. Still to design: how a domain relates to a
scope path, what happens to a child whose parent is in another domain, how a thread moves
between domains, and the snapshot a new subscriber starts from.

`visibility` stays what it is today, a row's own switch: a private row never leaves the device.

Kabane keeps no permissions. Who may join a scope, and binding `<person>` to a login, belong to
the layer that shares it: the hub today, or a service such as patente (David's hosted artifact
project). Anyone who can write to a shared scope can change a thread's row, and the last write
wins. Entries cannot be changed by anyone and attributes conflict only per key, so what two
people can overwrite of each other's is the thread's own fields, the value of a shared attribute
key, and a shared ref.

## Tested against Vercel Board, feature by feature

Board is the closest published design, so the draft was checked against each of its features.
Sources are Board's blog post and its concept, guide and getting-started pages, fetched on
2026-11-23. Its access, CLI-reference and SDK pages were not read.

| Board feature | Kabane today | Under this draft | Still missing |
|---|---|---|---|
| Board: a separate space with its own channels and grants | One database; scopes | A scope root, plus the sharing domain Codex's review asks for | The sharing domain's rules |
| Channel as a path, `www/` names the subtree | Flat scope, exact match | Scope path with a trailing slash | Nothing once built |
| Thread: a root message and its replies | Thread and its timeline | Thread and entries, `re` naming the entry answered | Nothing |
| Message: Markdown, labels, reactions, attachments | Entry: Markdown and a kind | Entry with `data`; a reaction is an entry kind | Attachments as stored files. Kabane keeps a URI. |
| Message edit and delete, with a tombstone | Entries are never edited or deleted | Same | Left out on purpose |
| Label `key=value`, one value per key, filter by it | Plain tags, one exact tag per query | Attributes on threads | Labels on entries; `--if` check-and-set |
| Reserved `board.` labels | None | A declared name belongs to its module | Nothing |
| Structured data against a registered schema (`security-finding@1`) | Entry kinds with a Markdown template | Kind declarations with a JSON Schema and a version | Nothing |
| Actors and profiles, "fx via ada" | `human/<name>` and `agent/<runtime>` actors | An actor that names the person and the agent | Proving who a person is, which stays outside |
| Mentions, `read --mentions` | None | `to` on an entry | Mentions typed inside a body. Kabane never parses a body. |
| Event log with cursors, `tail`, `wait --after` | A sync log of row snapshots, no read for clients | Not covered | A cursor read and a wait |
| Watchers that wake a deployment on an event | `jobs.onAttention` shell hook, for job runs only | Not covered (ADR 0002 left it undecided) | Waking an agent on a reply |
| `schedule <thread> "…" --in 5m` | Jobs on a cron expression | Same | A one-off delayed follow-up |
| Task states: waiting, ready, claimed, blocked, completed, failed, canceled | inbox, next, in_progress, waiting, someday, done, cancelled | Same seven, or none | `failed`; "waiting on a dependency" as a state |
| Claim with a lease, `renew`, `claim_lost` | `in_progress` by convention; the loop keeps claims in its run store | A claim entry beside the state | Leases; a claim that is atomic across devices |
| `--needs`, completing a task readies its dependents | `blocks` links; only the loop derives readiness | Same links | A "ready" read in core |
| A plan file that creates many tasks, with an idempotency key | One `kabane_add` per thread | Derived ids could make a repeat safe | Bulk create |
| `--for <profile>`, or the pool | `assignee`; `agent:` and `tier:` tags | `assignee`; `agent` and `tier` attributes | Nothing |
| Hold for a person, `block --kind awaiting_approval` | `waiting` state, `kabane_ask` | An ask entry addressed to the person | Nothing |
| A task from an existing thread | Every thread already has a state | A conversation thread gains a state | Nothing |
| Task ownership (`task_not_owned`), grants per channel, `grants explain` | None | None; the sharing layer's job | Left out on purpose |
| Two-way sync with Slack, GitHub and Linear | Upstream links: identity only | The write contract for inbound events | The fetchers; outbound mirroring is left out on purpose |
| `--no-sync` for internal notes | A `private` row never leaves the device | Same | Nothing |
| Sandbox policy: scoped access with no credential inside | The hub's MCP for one person | Not covered | Scoped credentials for a remote agent |
| Live viewer, `board inspect` | The board TUI and the herdr panel | Same | Live updates across machines need the hub |
| "Who did what" from the event log | `updated_by` on rows, authored entries | Same | A history of changes to a thread's own fields |
| Swarm and factory templates | The loop extension and the dispatch skill | Same | Nothing |

The last column holds more gaps than the eight below. These eight change what a person or an
agent can do. Kabane's loop covers waiting, continuing on an answer and claims, inside one run
on one machine, in its own store.

### What the eight missing pieces would let you do

| What it allows | With Board | In kabane today | Board's mechanism | Where the drafts leave it |
|---|---|---|---|---|
| An agent can wait for something and be resumed when it happens | A lead agent hands out work, ends its turn, and is resumed the moment a worker completes, fails or asks. Nothing that happened in between is missed. | An agent that hands work to another harness has to keep listing issues and comparing, or you tell it. Claude cannot know Codex finished except by polling. | Event log with a cursor, `wait --after` | **Covered by ADR 0007.** `kabane wait`, for a session that is alive. Not for an agent that only has MCP. |
| An answer continues the work on its own | You approve a deploy from Slack on your phone. The agent that asked picks up from there with no session left running. | You answer the question and the issue stays in `waiting` until you open a session or a scheduled job notices. | Watchers | **Covered by ADR 0007.** For a run kabane started. Otherwise a notification or a fresh run on the thread. |
| A dead worker's task goes back in the queue, and two workers never take the same one | A laptop sleeps mid-task. Five minutes later the task is claimable again and another worker takes it. A pool of identical workers needs no coordinator. | The claim stays `in_progress` until someone notices; the tracker holds 30 older than 30 days. Two machines that claim offline both do the work. | Leases, `claim_lost` | **Half covered by ADR 0006.** Two workers cannot both hold a thread: the holder is derived from claim entries. A dead claim does not expire; that is out of this version. |
| A step shows up as doable when the step before it finishes | You file the fix and its review together. The review appears to reviewers when the fix completes, so a second harness reviews every change with nobody remembering to ask. | Outside a loop run, a blocked issue is listed as `next` like any other. An agent can pick it before its blocker is done. | `--needs`, the `ready` state | **Covered by ADR 0007.** The `ready` condition, as a read in core. |
| You can see what was tried and failed | A worker gives up with a reason. The lead is told, nothing that depended on it starts, and a retry is one command. | An agent that gives up leaves the issue `in_progress` or puts it back with a comment. A failed attempt looks like work not started, and you cannot list failures. | The `failed` state, `reopen` | **Out of this version.** A kind can record a failure later with no schema change. |
| A whole plan is filed in one step, and filing it twice is harmless | The lead writes twelve tasks and their dependencies in a file you can read first, then submits it once. A retry after a crash creates nothing new. | Twelve add calls and a link call per dependency. An agent that dies halfway leaves half a plan, and a retry makes duplicates. | Plan files, `--idempotency-key` | **Covered by ADR 0006.** `kabane apply <file> --key`, with ids derived from the keys. |
| An agent can come back to something later without staying alive | After opening a PR the agent schedules a CI check on the same thread in five minutes and ends its turn. | The agent sleeps inside its session, or the check does not happen. Jobs only repeat on a cron schedule. | `schedule --in 5m` | **Left to the harness.** On a local machine each harness has its own way to wake later, and kabane does not duplicate it (David, 2026-11-23). It comes back as a need for an agent in a sandbox or in the cloud, whose session cannot stay alive. |
| An agent can be given one project and nothing else | A cloud agent, or someone else's, reads and posts in one channel and holds no token of yours. | An agent that reaches the hub sees every scope, as you. | `sandboxPolicy()`, grants | **Out of this version.** Waits on the sharing domain's rules. |

Three of the eight are covered, all by ADR 0007
(`wiki/adr/0007-agents-wait-on-conditions-and-the-tick-runs-reactions.md`): waiting, continuing
on an answer, and a step showing up when it is doable. ADR 0006 covers filing a plan in one step, and the half of claims that prevents two workers
holding one thread. Left out of this version: expiry of a dead claim, a failed state, and access
to one project only. Access to one project waits on the sharing domain. The delayed follow-up is
left to the harness on a local machine. "What goes in this version", at the top, sorts all of
them by David's rule.

## Codex's review (gpt-6.2-astra, 2026-11-23): accept with changes

Codex read both files against the code, read-only. Its verdict: the five tables fit the four
uses as a model, and it would not call the schema additive until the draft says what a replica
may see, what concurrent writes keep, and how a reader interprets an older row. It ran no code.

What it found wrong, each checked against the file it cites and accepted:

- Actor URIs are not opaque. Core tells an agent from a human by the `agent/` and `human/`
  prefixes (`packages/core/mcp/tools.ts:79`), so a new format changes behaviour.
- Backfill derives an operation id, never a row id, and thread lookup special-cases 26-character
  ids (`packages/core/storage/tasks.ts:138`). A row id derived from an outside event has no
  precedent. Two importers could also derive the same id and write different bodies.
- The three ref tables have different identities. A work-log row is one occurrence with several
  URIs. An upstream link is unique by provider and external id, with the URL stored beside it.
  Folding them into one row per thread and URI loses repeated mentions.
- Two people can overwrite each other on a shared attribute key and a shared ref, as well as on
  the thread row.

What it would change, and where this draft now stands:

| Codex's change | Stance |
|---|---|
| Give each thread an immutable sharing domain, stamped on every sync op including deletes. A delete carries no scope and no payload today. | Taken. It is the first forced change, so it belongs in the one migration. Its rules need David. |
| Keep state and assignee together as one versioned claim, and let title and body merge on their own. | Taken as the direction. It needs a clock per group on the thread row. |
| Give an attribute a fixed id from its thread and key, and keep a dated tombstone when it is removed. | Taken. |
| Keep URIs that record an occurrence on the log entry, and keep the provider's id on an upstream ref. | Taken. Refs hold what a thread maintains or points at. Core keeps a local, rebuildable index of the URIs in entries, so a view can still narrow by branch. |
| Put `kind_version` beside every typed payload and keep unknown fields. | Taken. |
| Name imported event ids by domain, provider, account and event, and report a duplicate whose content differs. | Taken. |
| Keep "is this ask resolved" in the questions module. A reply alone cannot tell an answer from a clarification, and one recipient's reply should not clear the others. | Taken. Core stores `to` and `re`. A kind's declaration says which reply kinds close it, and whether one answer or one per addressee is needed. |
| Keep SQLite authoritative. For patente, start with a read-only snapshot of one sharing domain, with ids that do not depend on storage and a versioned envelope. | Agrees with the portable form above. |

Codex's three questions for David are added below.

## What this does not cover

- Waking an agent when its question is answered. ADR 0007 (proposed) covers it with
  `kabane wait` and reactions.
- Leases on a claim. A claim is the `in_progress` state plus an entry by the agent that took it.
  The tracker holds 30 claims with no activity in 30 days, mostly in two quiet scopes.
- A read of everything new since a client's last visit. The promised read is by state:
  addressed to me and not closed. ADR 0007 builds on state for the same reason and keeps no
  event log.
- A conversation that belongs to several threads. An entry has one thread. A conversation about
  three issues is its own thread with links to them.
- Per-reader read marks. Whether one answer closes an entry for every addressee, or each must
  answer, is declared by the entry's kind.
- The content of outside systems, and agent transcripts. Both stay where they are, behind a URI.

## For David to rule on

1. Decided 2026-11-23: the first level is a thread.
2. Whether anyone else has kabane 1.2.0 installed. If so the one migration needs an upgrade path
   that the rest of this ignores.
3. `PRODUCT.md` says kabane is "for one person and their agents" and lists a team tracker as a
   non-goal. Two people sharing a scope fits "a team can adopt and extend it" only if joining
   and identity stay outside kabane. The sentence about one person needs rewriting either way.
4. Design Principle 3, "store identity, never content". An attribute that caches an outside
   state is a dated copy. Without it, a query such as "approved and not merged" has to ask the
   outside system.
5. Which systems kabane is meant to replace. Each brings kinds and sources that would test this
   shape.
6. From Codex: can a collaborator only add to shared history, or also rewrite and delete it?
7. From Codex: must a reply reach one particular run, a lasting agent identity, or anyone acting
   for its owner?
8. From Codex: when sharing ends, is stopping future delivery enough, or must the other person's
   copies be erased?

## Not verified

- Whether the four tables' rules converge beyond the tests in "How the four tables converge":
  every interleaving of the named cases and a seeded three-device workload, not a proof. Today's
  tables still diverge (`wiki/storage-and-sync-shapes.md`) until they are migrated into these.
- Two threads created offline in one scope can carry the same `short_id`: the table has no
  UNIQUE index and no rename (JCAB-573:2).

- How the table renames interact with the full-text tables, parked sync ops and the names
  extension API v1 exposes (`childOfTasks`, `parentTaskId`).
- Any claim about patente, and how Board stores task state internally. Half of Delta's docs
  were not read.
- The herdr panel reads kabane through the CLI (`kabane list --format concise`, `questions`,
  `job`, `show`). Which fields of those outputs it depends on was not read line by line.
