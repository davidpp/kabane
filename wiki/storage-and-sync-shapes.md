# Files as kabane's store or as a sync path: what sync needs first, and which shape to take

JCAB-573, 2026-11-23. David asked whether kabane's records should live as plain files with
SQLite as an index, and what that would do to sync. The steward of goal JCAB-652 put one
question ahead of the rest: does sync converge without the total order the hub assigns
(`serverSeq`)? Any sync target other than the hub depends on that.

It does not. Two cases diverge under the hub's own order as well: a delete racing an older edit,
and `short_id` labels minted offline on three devices. A third case, a child that arrives before
its parent, diverges only without the hub's order. Three changes to `packages/core/sync/apply.ts`,
together with a rule that a delete is final, made 40 random three-device workloads converge,
through the hub and through a simulated folder of per-device files alike, as long as no two
devices minted labels in the same scope offline. Renames still diverge with those changes, and the
obvious fix for them does not work. The delete rule and the rename rule are David's to decide
(questions 1 and 2 on JCAB-573).

On storage, SQLite should stay authoritative. A folder holding one append-only JSONL file of sync
ops per device is a sound sync target once the fixes land, and the file export ADR 0006 already
plans gives `rg`, `jq` and editors the record. Files as the source of truth do worse on the
criteria the brief ranks (the North Stars in `PRODUCT.md`, then concurrent writers, sync
conflicts, search speed, what the Worker can run, migration cost), and the closest precedent,
beads, removed that design in 2026. Proposed ADR 0008 records this.

A note on terms. A `short_id` is the human label (`JCAB-42`): a prefix derived from the scope,
then a number from a counter on the device that created the row. "Shared prefix" below means
devices creating tasks in the same scope while out of sync, so their counters hand out the same
labels. In results, `b1=4` means the task titled `b1` ended labelled with number 4.

## Sync diverges in three cases, two of them under the hub's own order

`CODING_PRINCIPLE.md:33` says "any two devices that applied the same ops hold the same rows". A
scratch test captured ops through the real storage layer (`Planner` calls on armed devices) and
checked that claim two ways. Hub runs used the real `Sync.push` and `Sync.pull` through
`LocalRelay`, which is how the hub orders ops. Order runs regrouped the same ops by device and
handed them to fresh devices through `Apply.applyBatch`, in different orders and split into
different passes. Every replicated table was then compared row for row, and the end state of each
converging case was printed to check it was not empty. The test is described in the appendix and
was not committed.

| Case | In the hub's order | In other orders |
|---|---|---|
| Two devices edit one task (row LWW) | converges¹ | converges |
| Same upstream link added on two devices (natural-key LWW) | converges¹ | converges |
| Same `blocks` link added on two devices (natural-key dedupe) | converges | converges |
| Task and its comments deleted on A; B edits it later and comments | converges¹ | converges |
| Project deleted on A; B files a task in it (`SET NULL`) | converges¹ | converges |
| A's clock is an hour ahead; B edits after A in real time | converges (A wins) | not run |
| B deletes a task that A edited earlier, offline | **diverges**, in both push orders | **diverges** when the delete and the edit land in different passes |
| B comments on a task A created; a reader gets B's ops first | converges | **diverges**: the comment is dropped for good |
| Three devices mint labels in one scope offline | **diverges**, and with the same order but a different page size | **diverges** |

¹ The authoring devices received each other's ops through `Apply.applyBatch` in the log's order,
not through `Sync.pull`; the other hub-order rows used `Sync.pull`.

**A delete is forgotten after the pass that applied it.** `applyOps` builds its delete evidence
as a new map for each pass (`packages/core/sync/apply.ts:704`), and `applyOrdered` passes none
(`apply.ts:733`). The resolver documents the evidence as deletes "applied earlier in this pass or
in a previous one" (`packages/core/sync/resolve.ts:206-208`), which the applier does not provide.
The device that made the delete has no evidence at all, because a pull withholds a device's own
ops (`packages/core/sync/local-relay.ts:101`, `packages/worker/src/log.ts:53`). In the hub run, B
deleted the task, pulled A's older edit, found no row and no evidence, and wrote the row back. A
applied B's delete. A ended with no task; B with "edited at t1".

**A child that arrives before its parent is skipped for good.** `apply.ts:663` counts it as
`orphan-parent` and moves past it. Under the hub this cannot happen: B can only comment on a task
it has pulled, so the task sits earlier in the log. Files from separate devices carry no such
ordering. A reader that read B's file first dropped the comment; readers that read A's file first
kept it.

**A `short_id` rename depends on what the device has seen, and is never shared.**
`mintShortId` takes the highest number in the local table and in the current page
(`apply.ts:369-384`), and the rename is not captured (`apply.ts:440`), so nothing reconciles two
devices that minted differently. A minted 1 and 2, B minted 1, C minted 1, 2 and 3, all offline
in one scope. After one round through the hub, A and B held `b1=4, c1=5, c2=6` and C held
`c1=4, c2=5, b1=6`, and six rounds left that unchanged. Two observers pulling the same hub log,
one in pages of 500 and one in pages of 1, also ended with different labels. The existing test
`convergence.test.ts:371` ("heals a rename") uses two devices and passes.

**`version` is raised only when the incoming row wins.** `withVersion` (`apply.ts:306`) takes the
higher `version` on an applied write. A `not-newer` skip leaves the local one, so devices whose
content agrees can hold different values, and `version` is a step in the tie-break chain
(`resolve.ts:298-305`) that can decide a later exact-clock tie. The random runs below show it.

**Applying the same op twice can change a row.** The last tie-break compares the op's device id
with the receiving device's own id (`resolve.ts:316`), not with the id of whoever wrote the row
it holds. On a device whose id sorts after the author's, an identical op wins again, and for a
renamed row that triggers another rename. In the order runs, delivering the same three files a
second time moved labels 4, 5 and 6 to 7, 8 and 9. A device pulling from the hub never re-applies
an op, because its watermark moves in the same transaction as the apply. A folder reader that
loses its cursor would.

## Three changes to apply, and a final delete, make everything but renames converge

The scratch patch (appendix) changed `apply.ts` only:

1. **Durable delete evidence.** Each pass starts from a table of every delete seen, plus the
   device's own deletes from `sync_oplog`. No code outside tests deletes from `sync_oplog`
   (`rg sync_oplog` over `packages` and `extensions`), so a device's own deletes stay there.
   `sync_parked_deletes` already keeps evidence this way for parked rows (`apply.ts:806-838`).
2. **A child whose parent is absent waits**, unless the parent has delete evidence. Waiting ops
   are retried until none applies.
3. **`version` takes the higher value on a skip too.**

A seeded random workload exercised them. Each seed ran three devices through 60 random steps (add
a task, edit a title, comment, delete a task, link two tasks, add the same context ref, add a
work-log entry, or a partial sync with a page size of 1 to 6), then eight full rounds of push and
pull. In folder mode each device wrote its own append-only file and each pull read the other
files in a random order. Counts are seeds that diverged, out of 40.

| Configuration | Hub, separate scopes | Folder, separate scopes | Hub, shared scope | Folder, shared scope |
|---|---|---|---|---|
| Code as it is | 18 | 18 | 40 | 40 |
| Changes 1 to 3, a newer edit still beats a delete | 10 | 7 | 40 | 40 |
| Changes 1 to 3, a delete is final | **0** | **0** | not run | not run |
| The row above, plus each rename captured as an update | not run | not run | 35 | 20 |

Changes 1 to 3 alone are not enough. Under today's rule that a newer edit beats a delete
(`resolve.test.ts:449`), the task comes back, but its children's deletes were captured one by one
and apply everywhere, while a child written on the device that kept the task survives only on
some devices. In the three leftover seeds inspected, the difference was in context refs and
links, and in one also a task's `version`. A final delete removed every leftover. TaskChampion
resolves the same race the same way: its transform keeps the delete and drops the update, with
the comment "Given a delete and an update, prefer the delete"
([op.rs](https://github.com/GothenburgBitFactory/taskchampion/blob/main/src/server/op.rs)). The
cost is that an edit made on one device after another device deleted the task is lost.

Capturing each rename as an ordinary update let the three-device hub case settle after three
rounds, at `c1=7`: A and B had `c1=5` and C had `c1=4` before both moved to 7. Across random
workloads it still left 35 of 40 hub seeds and 20 of 40 folder seeds apart. The tie-break above
is one cause: a receiving device compares against its own id. Renames that collide with labels
minted later are another. `packages/core/AGENTS.md` rules out block leasing, hash ids and a label
format change, and calls the rename protocol the agreed repair. With three or more devices the
protocol does not converge, so that ruling is question 2 rather than something to work around.

## The four sync questions in the brief, answered

**Two devices edit one record through a file-sync tool that knows nothing about kabane.** Under
shape (d) the tool never sees a record, only per-device files with one writer each, so it has
nothing to merge. The rows then resolve as above. Clock skew changes who wins but not whether
devices agree: clocks are row fields that every device compares the same way, and a device an
hour ahead won against a later edit on every device. A partial write and a conflict copy are file
concerns, covered under "What a folder transport needs".

**Is the oplog still needed?** Yes. It is what each device's file is written from, and with change
1 it is also the device's own delete evidence. What changes is that nothing reads it for a total
order: each device's own `seq` is enough.

**Does convergence depend on the log's total order or only on the per-row tie-break chain?**
Today it depends on more than the chain: on order for orphans, on pass boundaries for deletes,
and on page contents for renames. With the three changes and a final delete, the random runs
converged in every order tried, which is evidence that the per-row rules suffice for everything
except renames. Forty seeds of one workload is not a proof.

| Resolver family | Tables | Without the hub's order, today | With the changes |
|---|---|---|---|
| row LWW | `tasks`, `projects`, module tables | converges for edits; deletes diverge across passes | converges |
| append-only | `task_comments`, `task_work_log` | orphans are dropped | converges |
| natural-key dedupe | `task_links` | converges (single case run) | converges |
| natural-key LWW | `task_context_refs`, `upstream_links` | converges for adds; children of a revived task diverge | converges |
| `short_id` rename | `tasks`, `projects` | diverges | diverges |

Module tables (questions, checklist, jobs) use the row LWW family and were not run on their own.

**Can the hub stay one more device?** Yes, as a separate target. A Worker has no file system, so
it cannot read the folder; it syncs through its own log as now. `wiki/record-primitives.md`
("Where a sharing domain syncs") already plans one target per sharing domain. A device relaying
between a folder and the hub would have to push other devices' ops under their own ids, and
whether the hub's push accepts that was not checked.

## What a folder transport needs in place of `serverSeq`

`SyncTransport` (`packages/core/sync/transport.ts:70-75`) has one integer watermark, `sinceSeq` in
and `throughSeq` out, stored as `sync_state.last_applied_seq`. A folder has one file per device, so
a reader needs one position per file. The scratch transport kept a map from device id to line
count and numbered pulled ops in arrival order. Apply only sorts a page by `serverSeq`
(`apply.ts:731`), so an arrival number works there, and with the changes above the result did not
depend on it. Parked module ops are compared by `server_seq` per row (`apply.ts:564-570`). An
arrival number keeps one device's ops for a row in that device's order, but that path was not
run.

Syncthing writes each received file to a temporary name and renames it over the original, so a
reader sees an older whole version, never a half-written one. A reader on the writer's own
machine, or on iCloud, whose write behaviour is not documented, can still see a last line cut off.
A reader therefore stops at the last newline and keeps its cursor there. A conflict copy can only
appear when two machines write under one device id, a misconfiguration to report. A file iCloud
has evicted under Optimize Storage must be downloaded before it is read.

## Judged against the five-table record of ADR 0006

The steward asked for (d) to be judged against the record in `wiki/record-primitives.md` ("The
five tables"), not today's task row.

- **Thread.** It resolves last-writer-wins in two groups, the claim and the text, each with its
  own clock. That is row LWW per group, which converged in every order. Deleting a thread raises
  question 1.
- **Entry.** Append-only, so it converges once an entry waits for its thread (change 2). `re`
  names another entry and "handled" is derived when read, so an answer arriving before its ask
  changes nothing stored. The claim holder is "the earliest claim entry that nothing has released,
  by time and then id", which every device computes from the same entries; skew can change who
  holds it, not whether devices agree.
- **Attribute.** Its id is derived from thread and key, and removal sets `removed at` rather than
  deleting the row. A removal is then an update, so a final delete never blocks setting the key
  again. The draft's own open item, a removal against a concurrent set, resolves by the clock like
  any row LWW update.
- **Link and Ref.** Links are inserted and deleted, never updated; a re-added link gets a new ULID,
  so a final delete of the old one does not block it. Refs are natural-key LWW, which converged.
- **Derived ids interact with a final delete.** `kabane apply <file> --key` derives a thread's id
  from the plan key and the thread's key. If a delete is final, a thread deleted and then
  re-applied from the same plan stays deleted on every device, and the plan needs a new key to
  bring it back. Question 1 says so.
- **The sharing domain on every op** maps onto the folder directly: one folder, or one set of
  files, per domain.
- **Reactions (ADR 0007)** read the local database, so a condition becomes true on each device
  when sync delivers the row. That needs no order between devices. Which machine fires a
  reaction is set in `wiki/conditions-wait-reactions.md` (the run's own machine), and a reaction
  that starts a run is guarded by the claim entry.
- **The thread keeps `short_id`**, so question 2 applies to the new record unchanged.

## Today's shape: what is bound to SQLite beyond the `Db` port

The port (`packages/core/db/port.ts`) is SQL-shaped: `query`, `run`, `exec`, `transaction`.
Several parts assume SQLite beyond it.

- Search is FTS5. `tasks_fts` and `task_comments_fts` are external-content tables kept by `_ai`,
  `_ad` and `_au` triggers (`packages/core/db/schema.ts:75-91`) and queried with
  `MATCH ... ORDER BY bm25` (`packages/core/storage/task-selection.ts:150`). The conformance suite
  requires both (`packages/core/db/conformance.ts`).
- Sync lives in tables: `sync_oplog`, `sync_state`, `sync_quarantine` and `short_id_history`
  (`schema.ts:470-533`), plus `sync_parked` and `sync_parked_deletes`. Capture is an explicit call
  after each write, in the same transaction (`packages/core/storage/oplog.ts:391-405`).
- Migrations are numbered SQL, per core and per module, each module with its own version table
  (`packages/core/AGENTS.md`). Three modules replicate tables: questions
  (`packages/questions/module.ts:10`), checklist (`packages/checklist/module.ts:9`) and jobs
  (`extensions/jobs/src/jobs.ts:101`). Jobs also keeps tables that never leave the machine.
- Concurrency is SQLite's: WAL with a 5 s busy timeout (`packages/sqlite/index.ts:61-62`),
  `BEGIN IMMEDIATE` for each atomic unit (`packages/core/runtime.ts:186`), and one write turn per
  process in extensions (`packages/extension/host-store.ts:42`). The board, several agent sessions
  through `kabane mcp`, the loop runner and the job tick all write the same database at once.

The loop's run store is the one file-based store in the repo: one writer per file, `run.json`
replaced by rename, append-only JSONL for the rest (`extensions/loop/src/store.ts:1-11`). It
holds state that never leaves the machine.

## File search takes tens of milliseconds where FTS5 takes a few, fast enough for a person either way

The corpora were a read-only `.backup` of the live database (1,526 tasks and 3,198 entries) and a
synthetic database made by cloning every task and entry three more times (6,104 and 12,792). Each
was exported as one JSON file per task with its entries (13 MB and 54 MB) and as one JSONL file of
rows (10 MB and 40 MB). Times are medians in milliseconds on David's Mac, with a warm page cache,
over five terms. The range runs from the term with no match to the most common one.

| Method | 1.5k tasks | 6.1k tasks |
|---|---|---|
| FTS5 `MATCH` + `bm25`, top 50 tasks and top 50 entries, in process | 0.04 to 0.55 | 0.02 to 6.1 |
| SQLite `LIKE` scan, in process | 4.6 to 10.6 | 20 to 40 |
| `rg -l -i -F` over the per-task files, one process each | 23 to 26 | 74 to 87 |
| Bun `Glob`, read and `includes`, in process | 60 to 65 | 231 to 248 |
| `rg -c -i -F` over the one JSONL file, one process each | 4.0 to 6.6 | 9.6 to 12.8 |

FTS5's time grows with how many rows it ranks, not with corpus size: "handoff" and "worktree"
match thousands of rows in the larger corpus and took 3.4 and 6.1 ms, while the term with no match
took 0.02. In a fresh process, as an agent's shell call runs it, Bun opening the database and
running one FTS query took 12 ms (1.5k) and 10 ms (6.1k), `rg` over the folder 48 and 126 ms, and
Bun scanning the folder 50 and 195 ms.

Bun's own glob and read do the job without `rg` at these sizes, at about three times `rg`'s cost.
Neither ranks results. A scan returns every file that mentions the word (496 files for "handoff",
where FTS5 returns its best 50), and it also matches JSON keys. Speed is no reason to want files.
The reason is the other tools a person or a harness already has, and ADR 0006's export gives
them that.

## Every harness ships its own search tool

Claude Code runs `find` and `grep` through Bash with embedded `bfs` and `ugrep`, and its Grep tool
"is built on ripgrep", which it bundles
([tools reference](https://code.claude.com/docs/en/tools-reference)). Codex has no grep tool;
its base prompt says "prefer using `rg` or `rg --files`" and its packaging requires ripgrep
([base instructions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md)).
Gemini CLI has `glob`, `grep_search`, `list_directory` and `read_file`; its source vendors `rg`
binaries and `tools.useRipgrep` defaults to true, while its docs describe a `git grep` fallback
([file-system tools](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/file-system.md)).
A user of these three needs nothing installed to search a folder. A folder lets a harness read the
record with no MCP server configured. Writes still go through kabane, which captures, resolves and
keeps each write in one transaction.

## The four shapes against the brief's criteria

| | (a) SQLite authoritative, files exported | (b) Files authoritative, SQLite an index | (c) Oplog as JSONL, SQLite materialised | (d) SQLite authoritative, per-device op files as a transport |
|---|---|---|---|---|
| Base complete without extensions | unchanged | unchanged | unchanged | unchanged; the transport is optional |
| Instant | unchanged | each write is a file write plus an index update, and a read after another process's write must check the files first | each write appends to a file outside its SQLite transaction | unchanged; files are written at push, after commit |
| Yours, everywhere | a read-only copy for tools | any file tool carries the record | any file tool carries the log | a sync tool carries the log |
| Concurrent writers on one device | SQLite transactions | locking and atomic replace across files, with the index refreshed on every outside change | a crash between commit and append loses or duplicates an op | SQLite transactions; one writer per file |
| Sync conflicts | none added | conflict copies of records for kabane to merge | as (d) | none at the file level; rows resolve as above |
| Query and FTS speed | as today | as today once indexed; keeping the index right is the cost | as today | as today |
| What the Worker can run | as today | needs a file store of its own; contradicts `CODING_PRINCIPLE.md:31`, `:32`, `:35` | as today, plus a second log format | as today; the hub is a separate target |
| Code that moves out of core | none | most of `packages/core/storage` | the capture path | none; the transport lives in a host or an extension |

Shapes (c) and (d) carry the same bytes. (c) makes the file the device's log of record; (d) copies
`sync_oplog` to a file at push and keeps one transaction per write.

## Prior art

The closest precedent ran shape (b) and replaced it. beads kept `.beads/issues.jsonl` in git as
the source of truth, with a gitignored SQLite cache exported after a 5 s debounce and re-imported
when the file was newer ([v0.9.11](https://pkg.go.dev/github.com/steveyegge/beads@v0.9.11)). Its
[changelog](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md) records a race in dirty
tracking that "could cause data loss during concurrent operations" (0.9.1, 2025-10-14), deleted
issues resurrected by auto-import ("Cleaned up 497+ resurrected issues from production database",
0.24.0, 2025-11-20), and a change check that missed edits because "Git doesn't preserve mtime on
checkout" (0.24.3, 2025-11-24). Version 0.50.0 (2026-02-14) made Dolt the default and removed the
daemon (about 19,663 lines) and the JSONL sync layer (about 7,634 lines); 0.53.0 deleted the
sync-branch pipeline (about 11,000 lines). JSONL is now "an export… not the source of truth or a
backup" ([README](https://github.com/gastownhall/beads)).

| System | Merge | Concurrent writers | Keeping the index right | What went wrong |
|---|---|---|---|---|
| [git-bug](https://github.com/git-bug/git-bug/blob/master/doc/design/data-model.md) | each entity a DAG of JSON operation packs in git, ordered by Lamport clock, ties by pack id | a repo-wide lock file, removed in PR #1692 (2026-10-16) | a cache beside the repo, moved from bleve to one SQLite with FTS5 (PR #1689) | the cache does not notice a push or a ref change (#409, #1589, #1583) |
| [Fossil tickets](https://fossil-scm.org/home/doc/trunk/www/tickets.wiki) | immutable change artifacts applied in timestamp order; a `+field` appends, others replace | not documented | `TICKET` tables "can always be reconstructed" and are rebuilt as artifacts arrive | a synced custom view broke config pull and `fossil rebuild` ([forum, 2021-04](https://fossil-scm.org/forum/forumthread/c9b8322fdedc8fa9)) |
| [TaskChampion](https://gothenburgbitfactory.org/taskchampion/sync-model.html) | the server keeps one linear chain and a client rebases until its parent is the latest; later timestamp wins per property; delete beats update | "database is locked" on two concurrent reads (#3676) | not applicable | the docs warn that Syncthing or `rsync` setups "can cause corruption and are not supported" ([sync docs](https://taskwarrior.org/docs/sync/)) |
| [cr-sqlite](https://github.com/vlcn-io/cr-sqlite) | per-column LWW, deletes by causal length | not documented | the CRDT is the table | last release 2024-01-17; its author has no time for it for "1-2 years" (#444) |
| [Logseq](https://discuss.logseq.com/t/database-version-too-drastic-choice/20346) | files merged by the sync tool | not applicable | a database built from Markdown | moved to a database as the source over "bad sync experience due to file system complexity" (2023-08-06); iCloud "doesn't notify apps on file updated" ([FAQ](https://discuss.logseq.com/t/im-using-logseq-with-icloud-but-experiencing-data-loss-or-file-conflict-errors-whats-going-on/13393)) |
| [Joplin](https://joplinapp.org/help/apps/conflict) | remote wins; the local copy goes to a Conflict notebook | lock files on the sync target ([spec](https://github.com/laurent22/joplin/blob/dev/readme/dev/spec/sync_lock.md)) | not applicable | only forum reports found |
| Linear (reverse-engineered by [wzhudev](https://github.com/wzhudev/reverse-linear-sync-engine); no primary source) | the server's incrementing `syncId` is the total order | server transactions | the client is a cache | not found |

Syncthing "never writes directly to a destination file", and on a conflict renames the older
version to `<file>.sync-conflict-<date>-<time>-<device>.<ext>`
([docs](https://docs.syncthing.net/users/syncing.html)). iCloud Drive keeps conflicting versions
through `NSFileVersion` ([TN2336](https://developer.apple.com/library/archive/technotes/tn2336/_index.html)).
SQLite's own docs list copying a database mid-transaction, or without its WAL, as a way to corrupt
it ([howtocorrupt](https://www.sqlite.org/howtocorrupt.html)), which rules out syncing the database
file. David's own review for icitte reached the same place for Markdown: Syncthing produces
conflict copies, and folding them back was costed at about 1,000 to 2,000 lines of merge code
(`../icitte/docs/history/2026-10-28-sync-engine-review.md:73`).

beads, git-bug and Logseq kept files as the source with a database beside them, and each shipped
bugs where the database missed a change made outside the program. Shape (d) keeps the database as
the source, so no index can miss an outside change. It still needs the apply changes above to
converge.

## Migration cost

- **(a)** No data migration and no contract change. The export and its rebuild test are already
  in ADR 0006's single migration.
- **(b)** Every storage function, every module's storage, `host.store`'s semantics, FTS, the hub's
  storage, and the rule that core runs only through the `Db` port. Existing data would be exported
  once. The cost is the code.
- **(c)** The capture path in core, plus a second log format the hub does not read.
- **(d)** The apply changes are in core, and the hub needs them anyway. A per-file watermark changes
  the `SyncTransport` seam, and an extension contributing a transport is a contract addition
  (`record-primitives.md` already notes it). Existing ops in `sync_oplog` are what the files would
  hold. On the copy of David's database used here, `sync_oplog` is empty: sync has never been armed
  on that device.

The `cabane://` to `kabane://` rename that the original brief weighed this against is done
(migration 12, `storage/actor-scheme.ts`).

## Measured, read, and not verified

Measured: every convergence and divergence result above, the effect of each apply change, every
search timing, and the empty `sync_oplog` on the database copy. The database was read only through
a `.backup` copy in a scratch directory, deleted afterwards.

Read but not run: the prior art and the harness tools, gathered from the linked sources by a
research subagent (the beads changelog entries and TaskChampion's transform were re-fetched and
quoted to confirm them); the cost columns for (b) and (c); how Syncthing and iCloud handle a
partial or concurrent write.

Not verified: module tables, and the parking path with an arrival number in place of `serverSeq`;
private rows in the random workload; whether the hub's push accepts ops relayed under another
device's id; how large a folder grows, since each op is a full row snapshot; whether the changes
hold beyond 40 seeds of one workload; any fix for renames.

## Appendix: reproducing the results

Two scratch test files ran from `packages/core` and were deleted before the commit.

- `sync/zz-order-scratch.test.ts` held the named scenarios. Ops were captured by real `Planner`
  calls on armed devices and pushed to a `LocalRelay`. For order runs the relay's ops were grouped
  by `deviceId` and handed to fresh devices through `Apply.applyBatch` in a chosen order, with
  `serverSeq` rewritten to that order, one `applyBatch` per pass. Hub runs used `Sync.push` and
  `Sync.pull` unchanged. Each device's seven replicated tables were compared as JSON.
- `sync/zz-random-scratch.test.ts` held the seeded workload (mulberry32) in hub mode
  (`LocalRelay.transportFor`) or folder mode: a `SyncTransport` holding one array per device,
  idempotent on `opId`, with a cursor per file and a random read order per pull.
- The apply changes sat behind environment variables in a patch to `apply.ts`, reverted after:
  `ZZ_FIX` for changes 1 to 3, `ZZ_DELETE_WINS` for a final delete, `ZZ_FIX_RENAME` for captured
  renames. `ZZ_COLLIDE=1` puts all three devices in one scope.

```bash
bun test sync/zz-order-scratch.test.ts
ZZ_SEEDS=40 bun test sync/zz-random-scratch.test.ts
ZZ_FIX=1 ZZ_SEEDS=40 bun test sync/zz-random-scratch.test.ts
ZZ_FIX=1 ZZ_DELETE_WINS=1 ZZ_COLLIDE=0 ZZ_SEEDS=40 bun test sync/zz-random-scratch.test.ts
ZZ_FIX=1 ZZ_DELETE_WINS=1 ZZ_FIX_RENAME=1 ZZ_COLLIDE=1 ZZ_SEEDS=40 bun test sync/zz-random-scratch.test.ts
```

Their result lines, as printed (`collide` is the shared scope):

```
RESULT mode=hub collide=false fix=0 rename=0: 18/40 seeds diverged 1,2,3,4,6,8,13,14,16,17
RESULT mode=hub collide=true fix=0 rename=0: 40/40 seeds diverged 1,2,3,4,5,6,7,8,9,10
RESULT mode=folder collide=false fix=0 rename=0: 18/40 seeds diverged 2,3,7,16,18,22,24,25,26,27
RESULT mode=folder collide=true fix=0 rename=0: 40/40 seeds diverged 1,2,3,4,5,6,7,8,9,10
RESULT mode=hub collide=false fix=1 rename=0: 10/40 seeds diverged 8,13,16,17,24,28,31,35,36,39
RESULT mode=hub collide=true fix=1 rename=0: 40/40 seeds diverged 1,2,3,4,5,6,7,8,9,10
RESULT mode=folder collide=false fix=1 rename=0: 7/40 seeds diverged 2,7,18,22,24,26,33
RESULT mode=folder collide=true fix=1 rename=0: 40/40 seeds diverged 1,2,3,4,5,6,7,8,9,10
RESULT mode=hub collide=false fix=1 rename=0: 0/40 seeds diverged        (with ZZ_DELETE_WINS=1)
RESULT mode=folder collide=false fix=1 rename=0: 0/40 seeds diverged     (with ZZ_DELETE_WINS=1)
RESULT mode=hub collide=true fix=1 rename=1: 35/40 seeds diverged 1,3,4,5,6,8,9,10,11,12   (with ZZ_DELETE_WINS=1)
RESULT mode=folder collide=true fix=1 rename=1: 20/40 seeds diverged 2,5,7,8,9,11,12,13,14,15   (with ZZ_DELETE_WINS=1)
```

The search benchmark exported the copy with `bun:sqlite`, built the synthetic database by inserting
three clones of every task and entry with suffixed ids (the FTS triggers indexed them), and timed
each method with `performance.now()`: 20 FTS runs, 5 scan runs and 10 `rg` spawns per term. Terms:
`handoff`, `convergence`, `OAuth`, `worktree`, `zzqxnotfound`. Its output, one line per corpus and
term (the `out` values are match counts):

```
{"corpus":"real","files":1526,"term":"handoff","fts5_bm25_top50":{"ms":0.55,"out":100},"sqlite_like_scan":{"ms":7.11,"out":324},"bun_glob_read_includes":{"ms":62,"out":496},"rg_files":{"ms":25.6,"out":496},"rg_one_jsonl":{"ms":5.7,"out":"965"}}
{"corpus":"real","files":1526,"term":"convergence","fts5_bm25_top50":{"ms":0.11,"out":37},"sqlite_like_scan":{"ms":9.86,"out":25},"bun_glob_read_includes":{"ms":62.18,"out":25},"rg_files":{"ms":23.79,"out":25},"rg_one_jsonl":{"ms":4.64,"out":"37"}}
{"corpus":"real","files":1526,"term":"OAuth","fts5_bm25_top50":{"ms":0.14,"out":62},"sqlite_like_scan":{"ms":10.56,"out":35},"bun_glob_read_includes":{"ms":59.66,"out":35},"rg_files":{"ms":23.88,"out":35},"rg_one_jsonl":{"ms":4.03,"out":"63"}}
{"corpus":"real","files":1526,"term":"worktree","fts5_bm25_top50":{"ms":0.49,"out":100},"sqlite_like_scan":{"ms":4.84,"out":480},"bun_glob_read_includes":{"ms":60.17,"out":480},"rg_files":{"ms":23.16,"out":480},"rg_one_jsonl":{"ms":6.59,"out":"832"}}
{"corpus":"real","files":1526,"term":"zzqxnotfound","fts5_bm25_top50":{"ms":0.04,"out":0},"sqlite_like_scan":{"ms":4.59,"out":0},"bun_glob_read_includes":{"ms":64.85,"out":0},"rg_files":{"ms":24.03,"out":0},"rg_one_jsonl":{"ms":4.15,"out":""}}
{"corpus":"syn","files":6104,"term":"handoff","fts5_bm25_top50":{"ms":3.35,"out":100},"sqlite_like_scan":{"ms":29.35,"out":1296},"bun_glob_read_includes":{"ms":248.26,"out":1984},"rg_files":{"ms":83.25,"out":1984},"rg_one_jsonl":{"ms":12.76,"out":"3860"}}
{"corpus":"syn","files":6104,"term":"convergence","fts5_bm25_top50":{"ms":0.2,"out":100},"sqlite_like_scan":{"ms":34.76,"out":100},"bun_glob_read_includes":{"ms":241.7,"out":100},"rg_files":{"ms":74.16,"out":100},"rg_one_jsonl":{"ms":9.64,"out":"148"}}
{"corpus":"syn","files":6104,"term":"OAuth","fts5_bm25_top50":{"ms":0.33,"out":100},"sqlite_like_scan":{"ms":40.2,"out":140},"bun_glob_read_includes":{"ms":232.89,"out":140},"rg_files":{"ms":86.85,"out":140},"rg_one_jsonl":{"ms":10.86,"out":"252"}}
{"corpus":"syn","files":6104,"term":"worktree","fts5_bm25_top50":{"ms":6.1,"out":100},"sqlite_like_scan":{"ms":28.72,"out":1920},"bun_glob_read_includes":{"ms":231.43,"out":1920},"rg_files":{"ms":80.79,"out":1920},"rg_one_jsonl":{"ms":10.12,"out":"3328"}}
{"corpus":"syn","files":6104,"term":"zzqxnotfound","fts5_bm25_top50":{"ms":0.02,"out":0},"sqlite_like_scan":{"ms":19.93,"out":0},"bun_glob_read_includes":{"ms":233.08,"out":0},"rg_files":{"ms":85.11,"out":0},"rg_one_jsonl":{"ms":12.15,"out":""}}
{"corpus":"real","cold_bun_process_fts_ms":12.4,"cold_rg_process_ms":47.5,"cold_bun_process_scan_ms":50.3}
{"corpus":"syn","cold_bun_process_fts_ms":10.2,"cold_rg_process_ms":125.5,"cold_bun_process_scan_ms":195.4}
```

The scratch patch to `apply.ts`:

<details><summary>apply-fix.patch</summary>

```diff
diff --git a/packages/core/sync/apply.ts b/packages/core/sync/apply.ts
index 16c40f1..ac56aa9 100644
--- a/packages/core/sync/apply.ts
+++ b/packages/core/sync/apply.ts
@@ -132,6 +132,10 @@ const PARENTS: Record<SyncTable, readonly ParentRef[]> = {
 
 type Row = Record<string, unknown>;
 
+const ZZ_FIX = process.env.ZZ_FIX === "1";
+const ZZ_FIX_RENAME = process.env.ZZ_FIX_RENAME === "1";
+const ZZ_DELETE_WINS = process.env.ZZ_DELETE_WINS === "1";
+
 /** Everything SQLite will accept from a JSON row snapshot. */
 type BindValue = string | number | null;
 
@@ -433,6 +437,10 @@ const executeRename = (
 		const minted = mintShortId(db, meta, shortId, batchLabels, now);
 		writeRow(db, meta, rowId, { ...row, short_id: minted });
 		recordSupersession(db, { loserId, oldShortId: shortId, now });
+		if (ZZ_FIX_RENAME) {
+			db.run(`UPDATE ${meta.table} SET version = version + 1 WHERE id = ?`, [loserId]);
+			Oplog.afterWrite(db, meta.table, "update", loserId);
+		}
 		return;
 	}
 
@@ -446,6 +454,10 @@ const executeRename = (
 	]);
 	writeRow(db, meta, rowId, row);
 	recordSupersession(db, { loserId, oldShortId: shortId, now });
+	if (ZZ_FIX_RENAME) {
+		db.run(`UPDATE ${meta.table} SET version = version + 1 WHERE id = ?`, [loserId]);
+		Oplog.afterWrite(db, meta.table, "update", loserId);
+	}
 };
 
 // ============================================================
@@ -661,12 +673,35 @@ const applyOne = (pass: Pass, op: RelayOp) => {
 	// failure that takes the whole batch down with it. Deletes carry no
 	// payload and no FK, so only writes can land here.
 	if (!prepared.parentPresent) {
+		if (ZZ_FIX) {
+			const parents = parentsOf(op.tbl, rule);
+			const evidence = parents.some((p) => {
+				const v = asString(prepared.op.payload?.[p.column]);
+				return v !== undefined && !rowExists(db, p.table, v) && pass.deletedAt.has(deleteKey(p.table, v));
+			});
+			if (!evidence) {
+				db.run(`INSERT INTO zz_pending (op_id, op) VALUES (?, ?) ON CONFLICT(op_id) DO NOTHING`, [op.opId, JSON.stringify(op)]);
+				return;
+			}
+		}
 		counts.skipped["orphan-parent"]++;
 		return;
 	}
 
 	const payload = prepared.op.payload;
 	const localById = selectRow(db, meta.table, "id = ?", [op.rowId]);
+	if (ZZ_DELETE_WINS) {
+		const key = deleteKey(op.tbl, op.rowId);
+		if (op.op === "delete") {
+			const known = pass.deletedAt.get(key);
+			if (known === undefined || op.capturedAt > known) pass.deletedAt.set(key, op.capturedAt);
+			db.run(`INSERT INTO zz_tombstones (tbl, row_id, deleted_at) VALUES (?, ?, ?) ON CONFLICT(tbl, row_id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)`, [op.tbl, op.rowId, op.capturedAt]);
+			if (localById !== undefined) { deleteRow(db, meta.table, op.rowId); counts.applied++; }
+			else counts.skipped["already-absent"]++;
+			return;
+		}
+		if (pass.deletedAt.has(key)) { counts.skipped.deleted++; return; }
+	}
 	const localByKey = byNaturalKey(db, meta, payload);
 	const decision = Resolve.decide(prepared.op, {
 		byId: localById,
@@ -686,9 +721,14 @@ const applyOne = (pass: Pass, op: RelayOp) => {
 		const known = pass.deletedAt.get(key);
 		if (known === undefined || op.capturedAt > known)
 			pass.deletedAt.set(key, op.capturedAt);
+		if (ZZ_FIX)
+			db.run(`INSERT INTO zz_tombstones (tbl, row_id, deleted_at) VALUES (?, ?, ?) ON CONFLICT(tbl, row_id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)`, [op.tbl, op.rowId, op.capturedAt]);
 	}
 
 	execute(pass, meta, decision, localById ?? localByKey);
+	if (ZZ_FIX && decision.kind === "skip" && decision.reason === "not-newer" && localById !== undefined && typeof op.payload?.version === "number") {
+		db.run(`UPDATE ${meta.table} SET version = MAX(version, ?) WHERE id = ?`, [op.payload.version, op.rowId]);
+	}
 };
 
 /**
@@ -718,7 +758,32 @@ const applyOps = (
 			parked: 0,
 		},
 	};
+	if (ZZ_FIX) {
+		db.exec(`CREATE TABLE IF NOT EXISTS zz_tombstones (tbl TEXT, row_id TEXT, deleted_at TEXT, PRIMARY KEY (tbl, row_id))`);
+		db.exec(`CREATE TABLE IF NOT EXISTS zz_pending (op_id TEXT PRIMARY KEY, op TEXT)`);
+		const seeded = db.query<{ tbl: string; row_id: string; at: string }, []>(
+			`SELECT tbl, row_id, MAX(deleted_at) AS at FROM (
+			   SELECT tbl, row_id, deleted_at FROM zz_tombstones
+			   UNION ALL SELECT tbl, row_id, captured_at FROM ${TABLES.sync_oplog} WHERE op = 'delete')
+			 GROUP BY tbl, row_id`).all();
+		for (const t of seeded) {
+			const key = deleteKey(t.tbl, t.row_id);
+			const known = pass.deletedAt.get(key);
+			if (known === undefined || t.at > known) pass.deletedAt.set(key, t.at);
+		}
+	}
 	for (const op of ops) applyOne(pass, op);
+	if (ZZ_FIX) {
+		// Retry pending orphans until no progress.
+		for (let round = 0; round < 50; round++) {
+			const pending = db.query<{ op_id: string; op: string }, []>(`SELECT op_id, op FROM zz_pending`).all();
+			if (pending.length === 0) break;
+			db.run(`DELETE FROM zz_pending`);
+			for (const row of pending) applyOne(pass, JSON.parse(row.op) as RelayOp);
+			const left = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM zz_pending`).get()?.n ?? 0;
+			if (left === pending.length) break;
+		}
+	}
 	reserveBatchLabels(db, pass.batchLabels, now);
 	return pass.counts;
 };
```

</details>
