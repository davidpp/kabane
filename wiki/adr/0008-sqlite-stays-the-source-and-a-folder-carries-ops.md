# 0008: SQLite stays each device's source of truth; a shared folder may carry sync ops, never records

- Status: proposed (draft for David's review; nothing is built)
- Date: 2026-11-23
- Issue: JCAB-573, under goal JCAB-652
- Decided by: not decided. Drafted by Claude from the JCAB-573 research
  (`wiki/storage-and-sync-shapes.md`).

## Context

David asked whether kabane's records should live as plain files, with SQLite as an index, so that
git, Syncthing or iCloud could carry them and `rg`, `jq` and editors could read them. ADR 0006
gives the record a file form and a rebuild test, and leaves the source of truth to a later ADR.
This is that ADR.

The research found that sync does not converge today. Under the hub's own order, a delete racing
an older edit and `short_id` labels minted offline on three devices both diverge. Without the
hub's order, a child arriving before its parent is also dropped for good. Three changes to
`packages/core/sync/apply.ts`, together with a final delete, made 40 random three-device workloads
converge through the hub and through a folder of per-device files, with renames left out; renames
still diverged. Searching a folder took 23 to 126 ms against FTS5's few milliseconds, and all three
harnesses ship their own search tool. beads, the closest precedent, ran JSONL in git as its source
with a SQLite cache, shipped resurrection and data-loss bugs in that layer, and replaced it in
2026.

## Decision

1. Local SQLite stays authoritative on every device, as `CODING_PRINCIPLE.md:31` says. Records
   never live as files that a sync tool merges.
2. A shared folder may be a sync target: a `SyncTransport` over one append-only JSONL file per
   device, written from `sync_oplog` at push. Each file has one writer, so a sync tool copies
   files and never merges them. Reading the record with file tools is ADR 0006's export.
3. No sync target without a total order ships until sync converges without one. That takes
   durable delete evidence, a child that waits for its parent, `version` kept at the highest value
   seen, a ruling on whether a delete is final, and a `short_id` rule that converges. The hub fails
   the delete and rename cases today, so these belong in core whether or not a folder transport
   follows.

## Consequences

- Nothing moves out of `packages/core`, the `Db` port stays the storage boundary, and the hub stays
  one more device on Durable Object SQLite. It syncs through its own log and never reads the
  folder.
- `SyncTransport` gains a watermark per file in place of one `serverSeq` integer, and an extension
  that contributes a transport is a contract addition (`wiki/record-primitives.md`, "Where a
  sharing domain syncs").
- `CODING_PRINCIPLE.md:33`, "any two devices that applied the same ops hold the same rows", is
  false today. It becomes a tested property: convergence tests with ops in shuffled per-device
  orders and split passes, as well as in the relay's order.
- The delete rule and the `short_id` rule are open questions on JCAB-573. Point 3 cannot be built
  until both are answered.
- How large a folder grows is unmeasured: each op is a full row snapshot, and nothing prunes
  `sync_oplog`.

## Alternatives rejected

- Files as the source of truth, SQLite as an index: contradicts `CODING_PRINCIPLE.md:31`, `:32`
  and `:35`, leaves the hub without storage, and moves index consistency and concurrent writers
  outside a transaction, which is where beads, git-bug and Logseq had their bugs.
- The oplog itself as files, SQLite materialised from them: the same bytes as decision 2, with each
  local write appending to a file outside its SQLite transaction.
- Syncing the SQLite file through a folder: SQLite's own docs list copying a database
  mid-transaction or without its WAL as a way to corrupt it.
