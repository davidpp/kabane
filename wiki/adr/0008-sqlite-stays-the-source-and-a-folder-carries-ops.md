# 0008: SQLite stays each device's source of truth; a shared folder may carry sync ops, never records

- Status: proposed (draft for David's review; nothing is built)
- Date: 2026-11-24
- Issue: JCAB-573, under goal JCAB-652
- Decided by: not decided. Drafted by Claude from the JCAB-573 research
  (`wiki/storage-and-sync-shapes.md`).

## Context

David asked whether kabane's records should live as plain files, with SQLite as an index, so
that git, Syncthing or iCloud could carry them and `rg`, `jq` and editors could read them. ADR 0006
gives the record a file form and a rebuild test, and leaves the source of truth to a later ADR.
This is that ADR.

The research found that sync today converges only when no delete races an older edit and no two
devices mint the same `short_id` offline, under the hub's own order as well as without it.
Three changes to `packages/core/sync/apply.ts` made 40 random three-device workloads converge
through the hub and through a folder of per-device files, with renames left out. Searching files
measured 10 to 100 times slower than FTS5 (well under a second at 6k tasks), and all three
harnesses ship their own search tool. beads, the closest precedent, ran JSONL in git as its
source with a SQLite cache, shipped resurrection and data-loss bugs in that layer, and replaced it
in 2026.

## Decision

1. Local SQLite stays authoritative on every device, as `CODING_PRINCIPLE.md:31` says. Records
   never live as files that a sync tool merges.
2. A shared folder may be a sync target: a `SyncTransport` over one append-only JSONL file per
   device, written from `sync_oplog` at push. Each file has one writer, so git, Syncthing and
   iCloud copy files and never merge them. Reading the record with file tools is ADR 0006's
   export.
3. No sync target that lacks a total order ships until sync converges without one. That takes
   durable delete evidence, a child that waits for its parent instead of being dropped, `version`
   kept at the highest value seen, and a `short_id` rule that converges. Since the hub fails the
   first and the last of these today, the fixes belong in core whether or not a folder transport
   follows.

## Consequences

- Nothing moves out of `packages/core`, the `Db` port stays the storage boundary, and the hub
  stays one more device on Durable Object SQLite. It is a second sync target, not a reader of
  the folder.
- `SyncTransport` gains a per-file watermark in place of one `serverSeq` integer, and an
  extension that contributes a transport is a contract addition (`wiki/record-primitives.md`,
  "Where a sharing domain syncs").
- The `CODING_PRINCIPLE.md:33` invariant, "any two devices that applied the same ops hold the
  same rows", is false today and becomes a tested property: convergence tests with ops in
  shuffled and per-device orders, not only in the relay's order.
- Whether a delete is final against a later edit, and how `short_id` labels converge, are open
  questions on JCAB-573. Until they are answered, the decision in point 3 cannot be built.
- Folder size is unmeasured: each op is a full row snapshot and `sync_oplog` is never pruned.

## Alternatives rejected

- Files as the source of truth, SQLite as an index: breaks `CODING_PRINCIPLE.md:31`, `:32` and
  `:35`, leaves the hub without storage, and puts index consistency and concurrent writers
  outside a transaction, which is where beads, git-bug and Logseq had their bugs.
- The oplog itself as files with SQLite materialised from them: the same bytes as decision 2, but
  every local write appends to a file outside its SQLite transaction.
- Syncing the SQLite file through a folder: SQLite's own docs list copying a database
  mid-transaction or without its WAL as a way to corrupt it.
