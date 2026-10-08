# Concise queues, mutation receipts and bounded context

Concise output is opt-in. MCP `kabane_list`, `kabane_search`, `kabane_today`,
`kabane_add`, `kabane_edit`, `kabane_done`, and `kabane_context` accept `responseFormat: "concise"`.
CLI `list`, `search`, `add`, `edit`, `done`, and `context` accept `--format concise`.
Omission or explicit `full` preserves legacy raw arrays/task records, and CLI
human text unless `--json` is selected. Full mode has no new byte bound. The
full `kabane_context` / `kabane context` brief remains available; its subtask
rollup now includes every child, including deferred and closed children, rather
than silently stopping at the query default of 100. Other full-source fallback
behavior and global task-query defaults are unchanged.

## Agent workflow

```bash
kabane list --assignee codex --state next --format concise
kabane list --assignee codex --state next --format concise --cursor '<nextCursor>'
kabane show JCAB-12 --json                 # own full fields
kabane context JCAB-12 --format concise --no-deref
kabane context JCAB-12 --format concise --no-deref --cursor '<nextCursor>'
kabane edit JCAB-12 --state in_progress --format concise
kabane done JCAB-12 --format concise
kabane search license --format concise
```

MCP equivalents:

```json
{"name":"kabane_list","arguments":{"assignee":"codex","state":"next","responseFormat":"concise"}}
{"name":"kabane_context","arguments":{"id":"JCAB-12","responseFormat":"concise","deref":false}}
{"name":"kabane_edit","arguments":{"id":"JCAB-12","state":"in_progress","responseFormat":"concise"}}
```

Repeat the same query/filter/scope/sort and format with the returned `nextCursor`
as `cursor` (CLI `--cursor`). Page size may change. `hasMore: false` means this
static enumeration is complete, not that the tracker cannot change later.
`items` always contain stable ULIDs and short labels when available, never
page indices as identity. Summaries carry title/state/kind/priority and
assignee/scope when present. `omittedFields` names deliberately excluded body,
provenance, verification, history and other full fields. `truncatedFields`
identifies shortened previews; `fullRead` gives the lossless own-record route.
Descriptions and human comments are not shortened in persistence or full reads.

Default concise page size is 20, maximum 100 (positive integers only). A page
can contain fewer rows to fit its serialized budget. Follow continuation rather
than assuming `items.length === limit`. Legacy list's default remains 100;
legacy search's default remains 20. `cursor` in full/omitted mode is an error.
The CLI still detects its directory scope; MCP list/search/today span scopes
unless `scopeUri` is supplied. Pass matching scopes for cross-transport paging.

## Budgets and imported identities

A concise queue page's **actual serialized JSON text** is at most 16 KiB UTF-8;
a concise mutation receipt is at most 2 KiB. JSON escaping, Unicode, omission
metadata, full-read instructions and cursors count. Compact JSON is used on
both entry points, including CLI `--json`; concise CLI success has no trailing
newline, so its entire stdout remains within the bound. These are text payload
bounds, not token counts or MCP transport-envelope bounds.

Receipts keep id, shortId when present, title preview, state and version. They
do not echo description or arbitrary metadata. Extreme previews shrink further
with explicit markers to accommodate identity. An imported id/shortId that
cannot fit even with minimal previews is never truncated: concise mode returns
a short actionable error directing the caller to full mode. Concise edit/done
preflight identity plus prospective state/version and required receipt metadata
**before any write**; explicit scope edits also preview the next label from the
canonical prefix/counter before allocating a sequence. Preflight rejection leaves
scope/state/labels/version/oplog/sequences unchanged and says no mutation occurred. The existing
storage update/read is not a held transaction: if an external identity
replacement or counter allocation races the preflight/update/read, the response explicitly says the task
was updated and requires a full read before retrying, never falsely claiming
no mutation. Full mode continues to read/update these records losslessly. Locally added records mint normal small
identities. No persisted schema, sync or identity rules change.

## Cursor semantics and cost

Cursors are stateless, versioned, query-bound continuations; treat them as opaque,
not credentials or authorization. A stable unique id tie-breaker augments the
legacy ordering only in concise mode. List retains its sort semantics; search
retains SQLite FTS5 BM25 ranking, then id for tied ranks. A byte-limited page's
cursor advances past only emitted rows: the next row is not skipped.

Each call fingerprints the **entire eligible candidate set in actual SQL order**,
using compact id/short-label/version/update metadata, not bodies. Labels participate
because sync collision repair can rename them without bumping clocks or version. The complete membership
and order catch inserts, deletes, changes entering/leaving the predicate and
relevant edits anywhere in the queue, including beyond the current page. Two
compact reads also reject a relevant writer racing page assembly. Cost is
O(matching candidates) metadata per call; only the requested bounded row batch
is materialized as full records. No all-tracker fingerprint or held server
session is used. Unrelated-scope/filter-excluded writes do not stale list
continuation. FTS corpus statistics can change search ranking after an unrelated
write: rejection is legitimate when the actual eligible order changes, not merely
because another task was edited.

This is **not snapshot isolation** or a concurrent-write enumeration guarantee.
A matching change yields a stale-cursor error: restart without cursor. Malformed,
oversized or query-mismatched cursors yield actionable errors. Static enumeration
is tested for exact completeness and no duplicate identities. Deferred-task
visibility uses the first page's clock for that enumeration.

## Today

MCP `kabane_today` concise output has three independent page envelopes:
`overdue`, `dueToday`, and `next`. The final combined serialized text is at most
16 KiB, not three independent 16 KiB payloads. Each bucket receives a conservative
5 KiB share and its own `hasMore` / `nextCursor`; empty complete buckets are
explicit. Continue one or more buckets using
`cursors: {"overdue": "<nextCursor>"}` and the same filters/format. Other buckets
start at their first page when no cursor is supplied. `limit` applies per bucket;
there is no new CLI today command. Full today's legacy bucket arrays/limits stay
unchanged.

Today cursors bind the resolved owner's calendar date and timezone as well as
bucket, scope and filters. Midnight or timezone changes require a restart; a
cursor from one bucket cannot be used for another. Calendar-date and instant
deadlines retain the existing owner's-timezone semantics.

## Bounded selected context

Use `kabane_context` with `responseFormat: "concise"` or `kabane context <id>
--format concise`. Default sections are all seven, in canonical order:
`metadata`, `description`, `upstream`, `position`, `context`, `priorWork`,
`discussion`. `sections` (CLI `--sections description,discussion`) selects a set;
order/duplicates normalize before rendering and cursor binding. An empty MCP
array (CLI `--sections ''`) explicitly selects nothing. Sections/cursor require
concise mode; they cannot silently change a full brief.

The compact envelope is ordered **completeness first**, then intact resolved
`taskId`, `revision`, `offset`, `markdown`, optional `nextCursor`, and `retrieval`
instructions. Each actual serialized text result is at most16KiB UTF-8, including
JSON escaping, cursors and directions. It is not an MCP HTTP-envelope or input
request-size limit. Giant descriptions, individual human comments, work-log
notes/labels, reference notes and rendered position/metadata split across chunks,
not into summaries or irreversible previews. Concatenating every `markdown` in
`offset` order reconstructs the exact selected rendered sections. Offsets count
UTF-16 code units, not bytes; boundaries never split Unicode code points.

`completeness` describes coverage **from offset zero through the end of this
chunk, assuming ALL preceding chunks were consumed**. It does not claim this
single response repeats earlier instructions:

- `selectedComplete` is true only at the final selected-stream chunk.
- `descriptionComplete` / `humanSteeringComplete` indicate coverage of the
  selected description / discussion respectively. Omitted sections are false,
  not empty. Empty **selected** sections may be complete on the first page.
- `completedSections`, `remainingSections`, and `omittedSections` name coverage
  and intentional exclusions. Discussion covers ALL human comments in chronology,
  plus the existing bounded durable machine signal; progress/noise is folded as
  before. Prior work retains every work-log reference and note.

**Do not start work or claim complete acceptance criteria/steering until required
description and human discussion have been consumed.** Repeat the SAME bounded
command with the same id/options and `nextCursor` as `cursor` / `--cursor`.
Retrieve an omitted required section by selecting it and reading its bounded
stream; a full-only fallback is never needed for oversized bodies/comments.
Intact imported identity that cannot fit the envelope fails with a short
full-read direction, without writes or identity truncation.

Context cursors bind resolved identity, canonical sections, deref/subtask toggles
and all assembly caps, plus a digest of the actual selected rendered text's
lossless JSON representation. Comments/logs/refs/sessions/neighbor metadata and
read file prefixes can change independently of task.version; relevant rendering
changes invalidate continuation. Excluded sections and folded noise that leave
selected rendering unchanged do not. Malformed/mismatched/stale cursors fail
explicitly: restart without cursor, discard the previous prefix, and reconstruct
the new revision. Cursors are opaque continuations, not authorization credentials;
forging an offset does not prove earlier steering was consumed.

Every continuation loads the task record, then rebuilds and hashes the selected
stream. Server reads, materialization, hashing and transient allocations include
the **whole task record and selected sources**, not just16KiB; this bounds
model-visible text, not server memory/CPU.
No server session or held snapshot exists. Concurrent sources are observed
independently; no atomic multi-source revision or concurrent-write guarantee is
claimed. Selected-source failures (including discussion activities and position
neighbors) return an explicit error, never a successful empty section that claims
all steering was read. Failed excluded sources do not block unrelated selections.

Existing file policy remains: `file:` content uses per-ref/total caps (defaults
8000/24000); capped prefixes carry truncation notes, missing files carry pointers,
non-file URIs/no-deref refs remain pointers with all metadata/notes preserved.
Bounded unreadable/unavailable files explicitly say pointer-only on this host;
full mode keeps its old fallback. Other references may downgrade to pointers when
the existing total cap is exhausted. Lossless reconstruction covers selected
**rendered** text, not intentionally folded machine noise or file bytes beyond
those caps. Sessions/activities do not replicate, and the hub cannot read device
files; human comments/worklogs/ref metadata do replicate. Local/hub completeness
is relative to available host data, not a claim that the hub read local sessions.

## Regression evidence

Tests use the retained Apache-2.0 public corpus and explicitly synthetic edges
in disposable homes and fresh/prefixed SQLite. Actual CLI and stdio enumeration
of the same scope measured:

| Fixture | Full list text (1 call) | All concise page text | Calls |
| --- | ---: | ---: | ---: |
| 24 public issues (fixture v2) | 48,418 bytes | 6,181 bytes | 2 |
| 130 scoped public + synthetic issues (fixture v2) | 536,097 bytes | 30,222 bytes | 7 |

The synthetic fixture also has one unscoped row, excluded here on both transports.
These are fixed-input UTF-8 bytes, not model tokens or a universal savings claim.
Domain tests cover escaped byte boundaries, ties, filters, relevance/staleness,
105-row queues and each today bucket. Worker tests exercise the authenticated
HTTP entry point; the pack/install smoke exercises the installed CLI and MCP.

Actual CLI/stdio context reconstruction (`deref: false`, all sections, including
all106 synthetic children) measured identically on fresh/prefixed SQLite:

| Context | Full text bytes / characters / calls | Complete concise stream bytes / characters / calls |
| --- | ---: | ---: |
| First retained public issue | 9,985 / 9,941 / 1 | 10,687 / 10,643 / 1 |
| Synthetic giant description + human steering + ref notes | 886,234 / 768,864 / 1 | 942,350 / 824,980 / 58 |

Full here is the actual pretty-printed MCP text envelope; concise is the sum of
actual compact text blocks (the CLI emits identical chunks). Characters are JS
string lengths (UTF-16 code units), bytes are UTF-8. Exact context reconstruction
adds envelopes/calls: it is **not universal aggregate savings**, unlike selective
workflows that intentionally exclude sections. No billed-token or task-success
claim, model evaluation, server CPU benchmark or peak-memory measurement follows
from these payload measurements. Tests cover first/middle/final coverage, omitted
versus empty sections, all retained steering, giant escaping-heavy Unicode,
multiple logs/sessions, durable folding, all children including deferred/done,
source failures, stale/non-boundary cursors, and authenticated Worker HTTP over
replicated context only.
