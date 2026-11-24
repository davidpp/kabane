# Files as kabane's store or as a sync path: what sync needs first, and which shape to take

JCAB-573, 2026-11-24. The question was whether kabane's records should live as plain files with
SQLite as an index, and what that would do to sync. The steward's brief for JCAB-652 put one
question first: does sync converge without the total order the hub assigns (`serverSeq`)?
Every sync target other than the hub depends on the answer.

The answer is no, and three of the failures happen under the hub's own order. Three small
changes to `packages/core/sync/apply.ts` make 40 random three-device workloads converge, through
the hub and through a simulated folder of per-device files alike, as long as no two devices mint
the same `short_id` offline. `short_id` renames do not converge in either case, and the obvious
fix does not repair them. That part needs David's ruling.

On the storage question: SQLite stays authoritative. A folder of per-device JSONL op files is a
good sync target once the three fixes land, and the file form ADR 0006 already plans covers
reading the record with `rg` and `jq`. Files as the source of truth lose on every criterion the
brief ranks, and the measurements below show nothing that would pay for the loss. ADR 0008
(proposed) records this.

## Sync diverges today in three cases, two of them under the hub's own order

`CODING_PRINCIPLE.md:33` says "any two devices that applied the same ops hold the same rows".
A scratch test replayed ops captured by the real storage layer to fresh devices, in different
orders and different page splits, and compared every replicated table row for row. The same
test also ran the real `Sync.push` and `Sync.pull` through `LocalRelay`, which is the hub's
total order. The test is in the appendix and is not committed.

| Case | Through the hub (`LocalRelay`, real pull) | Per-device order, different interleavings |
|---|---|---|
| Two devices edit one task (row LWW) | converges | converges |
| Same upstream link added on two devices (natural-key LWW) | converges | converges |
| Task deleted with its comments on A; B edits it later and comments | converges | converges |
| Project deleted on A; B files a task in it (`SET NULL`) | converges | converges |
| B deletes a task; A edited it earlier, offline | **diverges**, in both push orders | **diverges** when the delete and the edit land in different passes |
| B comments on a task A created; a reader gets B's ops first | converges | **diverges**: the comment is dropped for good |
| Three devices each mint labels in one prefix offline | **diverges**; also with the same order and a different page size | **diverges** |

Each of the failures has a mechanism in the code.

**A delete is forgotten after the pass that applied it.** `applyOps` builds its delete evidence
as a new map for each pass (`packages/core/sync/apply.ts:704`); `applyOrdered` passes none
(`apply.ts:733`). The resolver's own doc says the evidence covers deletes "applied earlier in
this pass or in a previous one" (`packages/core/sync/resolve.ts:206-208`), which the applier does
not do. The device that deleted the row never has evidence at all, because pull withholds a
device's own ops (`packages/core/sync/local-relay.ts:101`, `packages/worker/src/log.ts:53`). So in
the hub run, B deletes the task, pulls A's older edit, finds no row and no evidence, and writes
the row back. A applies B's delete. A has no task; B has "edited at t1".

**A child that arrives before its parent is skipped for good.** `apply.ts:663` counts it as
`orphan-parent` and moves the watermark past it. Under the hub this cannot happen, because B
can only comment on a task it has pulled, so the task always sits earlier in the log. Per-device
files lose that ordering: a reader that reads B's file first drops the comment, and the readers
that read A's file first keep it.

**A `short_id` rename depends on what the device has seen, and is never shared.**
`mintShortId` takes the highest number in the local table and in the current page
(`apply.ts:369-384`), and the rename is not captured (`apply.ts:440`), so nothing reconciles two
devices that minted differently. With three devices (A mints 1 and 2, B mints 1, C mints 1, 2
and 3, all offline in one scope), one round through the hub left A and B with `b1=4, c1=5, c2=6`
and C with `c1=4, c2=5, b1=6`. Five more rounds changed nothing. Two observers pulling the same
hub log, one with pages of 500 and one with pages of 1, also ended with different labels. The
existing two-device test (`convergence.test.ts:371`, "heals a rename") passes because two devices
leave fewer ways to order the collisions.

There is a fourth, smaller one. `apply.ts:306` raises `version` to the higher of the two only when
the incoming row wins. A device whose local row wins keeps its own `version`, so the column
differs between devices whose content agrees. `version` is a step in the tie-break chain
(`resolve.ts:298-305`), so the difference can decide a later exact-clock tie.

One more property matters to a folder transport and not to the hub: delivering the same op
twice is not harmless. The last tie-break compares the op's device id with the receiving
device's id (`resolve.ts:316`), not with the id of the device that wrote the row. On a device
whose id sorts after the author's, an identical re-delivered op wins, and for a renamed row it
triggers a second rename. In the scratch run, a second delivery of the same three files moved
labels 4, 5, 6 to 7, 8, 9. The hub never re-delivers (its watermark moves in the same
transaction as the apply), but a folder reader that loses its cursor will.

## Three changes to apply make every workload converge except `short_id` renames

The scratch patch (appendix) changed `apply.ts` only:

1. **Durable delete evidence.** Each pass starts from a table of every delete seen, plus the
   device's own deletes from `sync_oplog`, which is never pruned (`namespace.ts:112` reads it by
   watermark). `sync_parked_deletes` already does this for parked rows (`apply.ts:806-838`).
2. **A child whose parent is absent waits instead of being dropped**, unless the parent has
   delete evidence. The waiting ops are retried until no more apply.
3. **`version` takes the higher value on a skip too.**

A seeded random workload exercised all of it: three devices, 60 steps per seed (add, edit,
comment, delete a task, link, add the same context ref, add a work-log entry, or a partial sync
with a page size of 1 to 6), then eight full rounds. In folder mode each device has its own
append-only file and every pull reads the other files in a random order. Each cell is 40 seeds.

| Configuration | Hub, no shared prefix | Folder, no shared prefix | Hub, one shared prefix | Folder, one shared prefix |
|---|---|---|---|---|
| Code as it is | 18 diverged | 18 diverged | 40 | 40 |
| Changes 1 to 3, the newer edit still beats a delete | 10 | 7 | 40 | 40 |
| Changes 1 to 3, a delete is final | **0** | **0** | not run | not run |
| The above, plus capturing each rename as an update | not run | not run | 35 | 20 |

With "the newer edit beats a delete" (today's rule, `resolve.test.ts:449`), the remaining
divergences were context refs and links: the task comes back, but its children's deletes were
captured explicitly and apply everywhere, while a child written concurrently on the side that
kept the task survives only on some devices. Making a delete final removed every one of them.
That is a change in behaviour: an edit made on one device after another device deleted the
task is lost. It is David's call (question 1 on JCAB-573).

Capturing the rename as an ordinary row update let the three-device hub case settle after three
rounds, with one label moving twice on the way (`c1` went 4, 5, 7). Across random workloads it
still left 35 of 40 hub seeds and 20 of 40 folder seeds apart. The tie-break flaw above is one
reason; renames that collide with labels minted later are another. `packages/core/AGENTS.md`
rules out block leasing, hash ids and a format change, and treats the rename protocol as the
agreed repair. The evidence says the protocol does not converge with three or more devices, so
the ruling needs revisiting rather than working around (question 2 on JCAB-573).

## What a folder transport needs in place of `serverSeq`

`SyncTransport` (`packages/core/sync/transport.ts:70-75`) has one integer watermark: `pull(sinceSeq)`
and `PullPage.throughSeq`, stored as `sync_state.last_applied_seq`. A folder holds one file per
device, so a reader needs one position per file: device id to line count. The scratch transport
kept that map in memory and numbered pulled ops in arrival order. Apply only sorts a page by
`serverSeq` (`apply.ts:731`), so an arrival number works, and with the three changes above the
result no longer depends on it. Parked module ops are compared by `server_seq` per row
(`apply.ts:564-570`); an arrival number keeps one device's ops for a row in that device's order.
That path was not exercised.

What the file layer itself must handle, from how the tools behave (prior art below). A reader
may see an older whole version of a file, never a half-written one from Syncthing, which writes
to a temporary file and renames it; a reader on the writer's own machine, or a tool that does
not document its writes (iCloud), can still see a last line cut off, so a reader stops at the
last newline and leaves its cursor there. A conflict copy can only appear when two machines write
as one device id, which is a misconfiguration to report. An iCloud file evicted by Optimize
Storage has to be downloaded before it is read. One writer per file is what keeps git, Syncthing
and iCloud copying whole files instead of merging them.

The hub stays one more device under this shape. It cannot read a folder, so it is a second
target, not a reader of the first. `wiki/record-primitives.md` ("Where a sharing domain syncs")
already plans one target per sharing domain. A device that relays between a folder and the hub
would have to push other devices' ops under their own ids. Whether the hub's push accepts that
was not checked.

## Today's shape: what is bound to SQLite beyond the `Db` port

The port (`packages/core/db/port.ts`) is SQL-shaped: `query`, `run`, `exec`, `transaction`. What
assumes SQLite beyond it:

- Search is FTS5. `tasks_fts` and `task_comments_fts` are external-content tables kept by
  `_ai`, `_ad` and `_au` triggers (`packages/core/db/schema.ts:75-91`), queried with
  `MATCH ... ORDER BY bm25` (`packages/core/storage/task-selection.ts:150`). The conformance suite
  requires both (`packages/core/db/conformance.ts`).
- Sync is tables: `sync_oplog`, `sync_state`, `sync_quarantine`, `short_id_history`
  (`schema.ts:470-533`), `sync_parked` and `sync_parked_deletes`. Capture is an explicit call
  after each write in the same transaction (`packages/core/storage/oplog.ts:391-405`), never a
  trigger.
- Migrations are numbered SQL per core and per module, each with its own version table
  (`packages/core/AGENTS.md`, "The Db port and runtime wiring"). Three modules replicate tables
  today: questions (`packages/questions/module.ts:10`), checklist (`packages/checklist/module.ts:9`)
  and jobs (`extensions/jobs/src/jobs.ts:101`); jobs also keeps machine-local tables.
- Concurrency is SQLite's: WAL with a 5 s busy timeout (`packages/sqlite/index.ts:61-62`),
  `BEGIN IMMEDIATE` for every atomic unit (`packages/core/runtime.ts:186`), and one write turn per
  process in extensions (`packages/extension/host-store.ts:42`). The board, several agent
  sessions through `kabane mcp`, the loop runner and the job tick all write the same file at
  once.

The loop's run store is the one precedent for files inside the repo: one writer per file,
replace-by-rename for `run.json`, append-only JSONL for the rest (`extensions/loop/src/store.ts:1-11`).
It holds device-local state that never syncs.

## Searching files is 10 to 100 times slower than FTS5 at this scale, and still fast enough for a person

Measured on a read-only `.backup` of the live database (1,526 tasks, 3,198 entries) and on a
synthetic copy made by cloning every task and entry three times (6,104 tasks, 12,792 entries).
Each corpus was exported as one JSON file per task with its entries (13 MB and 54 MB) and as one
JSONL file (10 MB and 40 MB). Times are medians in milliseconds on David's Mac, warm page cache,
over five terms including one with no match. Script and raw output: appendix.

| Method | 1.5k tasks | 6.1k tasks |
|---|---|---|
| FTS5 `MATCH` + `bm25`, top 50 tasks and top 50 entries, in process | 0.04 to 0.55 | 0.02 to 6.1 |
| SQLite `LIKE` scan, in process | 4.6 to 10.6 | 20 to 40 |
| `rg -l -i -F` over the per-task files, one process | 23 to 26 | 74 to 87 |
| Bun `Glob` + read + `includes`, in process | 60 to 65 | 231 to 248 |
| `rg -c -i -F` over the single JSONL file, one process | 4.0 to 6.6 | 9.6 to 12.8 |

A fresh process, as an agent's shell call would run it: Bun opening the database and running one
FTS query took 12 ms and 10 ms; `rg` over the folder 48 ms and 126 ms; Bun scanning the folder
50 ms and 195 ms.

Bun's own glob and read do the job without `rg` up to these sizes, at about three times `rg`'s
cost. Neither ranks: a file scan returns every file that mentions the word (496 files for
"handoff" against FTS5's ranked 50), and it matches JSON keys as well as text. The reason to want
files is the other tools (an editor, `jq`, a harness's own grep), not speed, and the export in
ADR 0006 gives them that without moving the source of truth.

## The four shapes against the brief's criteria

| | (a) SQLite authoritative, files exported | (b) Files authoritative, SQLite an index | (c) Oplog as JSONL, SQLite materialised | (d) SQLite authoritative, a folder of per-device op files as a transport |
|---|---|---|---|---|
| Base complete without extensions | unchanged | unchanged | unchanged | unchanged; the transport is optional |
| Instant | unchanged | every write is a file write plus an index update; a read after another process's write must check the files first | each write appends to a file outside the SQLite transaction | unchanged; files are written by push, after commit |
| Yours, everywhere | read-only copy for tools | any file tool carries the record | any file tool carries the log | git, Syncthing or iCloud carry the log |
| Concurrent writers on one device | SQLite transactions | needs locking and atomic replace across files, the index rebuilt on every external change | a crash between the commit and the append loses or duplicates an op | SQLite transactions; one writer per file |
| Sync conflicts | none added | conflict copies of records, merged by kabane | as (d) | none at the file level; rows resolve as today once the three fixes land |
| Query and FTS speed | as today | as today once indexed; index consistency is the cost | as today | as today |
| What the Worker can run | as today | needs a file store of its own; breaks `CODING_PRINCIPLE.md:31`, `:32`, `:35` | as today, plus a second log format | as today; the hub is a separate target |
| Code that moves out of core | none | most of `packages/core/storage` | the capture path | none; the transport lives in a host or an extension |

Shape (c) and shape (d) carry the same bytes. (c) writes the device's own log to a file as the
source; (d) copies `sync_oplog` to a file at push. Only (d) keeps one transaction per write.

## Prior art

The closest precedent tried shape (b) and removed it. beads kept `.beads/issues.jsonl` in git as
the source of truth with a gitignored SQLite cache, exported after a 5 s debounce and re-imported
when the file was newer ([v0.9.11](https://pkg.go.dev/github.com/steveyegge/beads@v0.9.11)). Its
[changelog](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md) records the failures:
an export that cleared every dirty flag and lost concurrent writes (0.9.1, 2025-10-14),
auto-import resurrecting deleted issues ("Cleaned up 497+ resurrected issues", 0.24.0,
2025-11-20), mtime checks that missed changes because "Git doesn't preserve mtime on checkout"
(0.24.3), and git's 3-way merge re-adding deleted issues (0.25.1). Between 0.50.0 and 0.53.0
(February 2026) it moved to Dolt and deleted the JSONL sync layer (about 7.6k lines), the daemon
(about 19.6k) and the sync-branch pipeline (about 11k). JSONL is now "an export… not the source
of truth or a backup".

The other systems, on the three questions the brief asked:

| System | Merge | Concurrent writers | Keeping the index right | What went wrong |
|---|---|---|---|---|
| [git-bug](https://github.com/git-bug/git-bug/blob/master/doc/design/data-model.md) | each entity a DAG of JSON operation packs in git, ordered by Lamport clock, ties by pack id | a repo-wide lock file, removed in PR #1692 (2026-10-16) | a cache beside the repo; moved from bleve to one SQLite with FTS5 (PR #1689) | the cache does not notice a push or a ref change (#409, #1589, #1583) |
| [Fossil tickets](https://fossil-scm.org/home/doc/trunk/www/tickets.wiki) | change artifacts applied in timestamp order; a `+field` appends, others replace | not documented | `TICKET` tables "can always be reconstructed", rebuilt as artifacts arrive | a synced custom view broke config pull and `fossil rebuild` ([forum, 2021-04](https://fossil-scm.org/forum/forumthread/c9b8322fdedc8fa9)) |
| [TaskChampion](https://gothenburgbitfactory.org/taskchampion/sync-model.html) | the server keeps one linear chain; a client rebases its ops until its parent is the latest; same property: later timestamp wins; delete beats update | "database is locked" on two concurrent reads (#3676) | not applicable | the docs say "Do Not Use External Sync Tools" such as Syncthing or rsync ([taskwarrior.org/docs/sync](https://taskwarrior.org/docs/sync/)) |
| [cr-sqlite](https://github.com/vlcn-io/cr-sqlite) | per-column LWW, deletes by causal length | not documented | the CRDT is the table | last release 2024-01-17; the author has no time for it for "1-2 years" (#444) |
| [Logseq](https://discuss.logseq.com/t/database-version-too-drastic-choice/20346) | files merged by the sync tool | not applicable | a DB built from Markdown | moved to a database as the source because of "bad sync experience due to file system complexity" (2023-08-06); iCloud "doesn't notify apps on file updated" ([FAQ](https://discuss.logseq.com/t/im-using-logseq-with-icloud-but-experiencing-data-loss-or-file-conflict-errors-whats-going-on/13393)) |
| [Joplin](https://joplinapp.org/help/apps/conflict) | remote wins, local copy kept in a Conflict notebook | lock files on the sync target ([spec](https://github.com/laurent22/joplin/blob/dev/readme/dev/spec/sync_lock.md)) | not applicable | not checked beyond forum reports |
| Linear (reverse-engineered, [wzhudev](https://github.com/wzhudev/reverse-linear-sync-engine); no primary source) | the server's incrementing `syncId` is the total order | server transactions | the client is a cache | not found |

On the sync tools themselves: Syncthing "never writes directly to a destination file". It writes
a temporary file and renames it over the original, and on a conflict the older version becomes
`<file>.sync-conflict-<date>-<time>-<device>.<ext>`
([docs](https://docs.syncthing.net/users/syncing.html)). Apple's TN2336 says iCloud Drive keeps
conflicting versions through `NSFileVersion`
([TN2336](https://developer.apple.com/library/archive/technotes/tn2336/_index.html)), and Optimize
Storage keeps only recently opened files on disk. SQLite's own docs list copying a database
mid-transaction or without its WAL as a way to corrupt it
([howtocorrupt](https://www.sqlite.org/howtocorrupt.html)), which rules out syncing the database
file itself.

Two patterns repeat. Each system that kept files as the source and a database beside them
(beads, git-bug, Logseq) shipped bugs where the index missed a change made outside the program.
Each system that converges reliably (TaskChampion, Linear, Fossil's rebuild) either has a total
order from a server or treats every change as an immutable artifact. Per-device append-only
files are the second kind, which is why (d) avoids the problems that sank (b).

## Every harness already ships a search tool, so files need no install

Claude Code runs `find` and `grep` through Bash with embedded `bfs` and `ugrep`, and its Grep tool
"is built on ripgrep", bundled ([tools reference](https://code.claude.com/docs/en/tools-reference)).
Codex has no grep tool of its own; its base prompt says "prefer using `rg` or `rg --files`" and its
packaging requires ripgrep
([base instructions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md)).
Gemini CLI has `glob`, `grep_search`, `list_directory` and `read_file`; its source vendors `rg`
binaries and `tools.useRipgrep` defaults to true, although its docs describe a `git grep`
fallback ([file-system tools](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/file-system.md)).
The brief's worry about users needing `rg` does not apply to these three. What a folder gives a
harness that MCP does not is reading without a configured server. What it cannot give is a write
path that captures, resolves and stays in one transaction, so writes still go through kabane.

## Migration cost

- **(a)** No data migration and no contract change. The export and the rebuild test are already
  part of ADR 0006's single migration.
- **(b)** Every storage function, every module's storage, `host.store`'s semantics, FTS, the
  hub's storage and the rule that core runs only through the `Db` port. The existing data
  would be exported once; the cost is the code.
- **(c)** The capture path in core and a second log format the hub does not read.
- **(d)** The three apply changes are in core and the hub needs them anyway, since two of the
  failures happen through the hub. A per-file watermark is a change to the `SyncTransport`
  seam, and an extension contributing a transport is a contract addition (`record-primitives.md`
  already notes it). Existing data needs nothing: the ops already in `sync_oplog` are what the
  files would hold. On David's database `sync_oplog` and `sync_state` are empty, so sync has
  never been armed there.

The `cabane://` to `kabane://` rename the original brief weighed this against is done
(migration 12, `storage/actor-scheme.ts`), so no joint migration is in question.

## Measured, and only read about

Measured: every divergence and convergence result above (the scratch tests, with the commands
in the appendix), the effect of each apply change, and every search timing. The database was
read only through a `.backup` copy in a scratch directory.

Read, not run: the prior art and what each harness does with a folder, both gathered from the
linked sources by a research subagent and not re-read line by line here; the cost columns for (b) and
(c), and how Syncthing and iCloud treat a partial or concurrently written file.

Not verified: a module table's ops through the parking path with an arrival number in place of
`serverSeq`; the hub's push accepting ops relayed under another device's id; the size a folder
reaches, since `sync_oplog` is never pruned and each op is a full row snapshot; whether the
three changes hold beyond 40 seeds of this workload, or for workloads with module tables and
private rows; any fix for renames.

## Appendix: reproducing the results

Two scratch test files were run from `packages/core` and deleted before the commit. Their logic:

- `sync/zz-order-scratch.test.ts`: named scenarios. Ops are captured by real `Planner` calls on
  armed devices and pushed to a `LocalRelay`. For per-device runs, the relay's ops are grouped
  by `deviceId` and handed to fresh devices through `Apply.applyBatch` in a chosen order, with
  `serverSeq` rewritten to that order, one `applyBatch` per pass. Hub runs use `Sync.push` and
  `Sync.pull` unchanged. Each device's seven replicated tables are compared as JSON.
- `sync/zz-random-scratch.test.ts`: the seeded workload (mulberry32), in hub mode
  (`LocalRelay.transportFor`) or folder mode (a `SyncTransport` holding one array per device,
  idempotent on `opId`, with per-file cursors and a random read order per pull).
- The apply changes sat behind environment variables (`ZZ_FIX` for changes 1 to 3, `ZZ_DELETE_WINS`,
  `ZZ_FIX_RENAME`) in a patch to `apply.ts` that was reverted.

```bash
bun test sync/zz-order-scratch.test.ts                      # the scenario table
ZZ_SEEDS=40 bun test sync/zz-random-scratch.test.ts         # the code as it is
ZZ_FIX=1 ZZ_SEEDS=40 bun test sync/zz-random-scratch.test.ts
ZZ_FIX=1 ZZ_DELETE_WINS=1 ZZ_COLLIDE=0 ZZ_SEEDS=40 bun test sync/zz-random-scratch.test.ts
ZZ_FIX=1 ZZ_DELETE_WINS=1 ZZ_FIX_RENAME=1 ZZ_COLLIDE=1 ZZ_SEEDS=40 bun test sync/zz-random-scratch.test.ts
```

The search benchmark exported the copy with `bun:sqlite` (one JSON file per task holding its
entries, plus one JSONL file of rows), built the synthetic database by inserting three clones of
every task and entry with suffixed ids (the FTS triggers indexed them), then timed each method
with `performance.now()` around 20 FTS runs, 5 scan runs and 10 `rg` spawns per term. Terms:
`handoff`, `convergence`, `OAuth`, `worktree`, `zzqxnotfound`.
