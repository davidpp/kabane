# Thread labels in 2.0: a ULID suffix in place of a counter and its renames

JCAB-663, 2026-11-24, for goal JCAB-652. Research only; nothing here is built.

## Recommendation

A thread's label is its scope's prefix and the last six characters of its ULID, both computed when
it is shown: JCAB-663, whose id is `01M87FATK4T415JC8P2W1DQJHD`, would read `JCAB-1DQJHD`. A lookup
ignores the prefix and matches the suffix against every thread. Two matches give a list of
candidates, as an ambiguous ULID prefix does today. The 1,548 labels that exist stay on their threads
as they are, and they are shown and resolved by exact match. No new number is ever handed out.

That takes out the counter, the rename and its history. The suffix never changes. When a thread moves
scope its printed prefix follows the new scope, and a label printed before the move still resolves,
because the prefix plays no part in the lookup. What it costs: the label isn't in
creation order and is harder to say. With six characters, the expected number of ambiguous pairs grows with
the square of the thread count: about 1.2 once the tracker holds 50,000 threads, about 4.7 at
100,000.

| | Scheme | Example | Offline-safe | Stable forever | Readable | What it removes | Old labels |
|---|---|---|---|---|---|---|---|
| **A** | **Prefix from the current scope + last 6 ULID characters, fixed length; lookup by suffix** | `JCAB-1DQJHD` | yes | yes, except that a later look-alike makes it list two candidates (about 1.2 pairs expected in a 50k-thread tracker) | 6 Crockford characters, not sequential | `sequences`, `short_id_history`, the rename in resolve and apply, minting, the scope-move relabel | kept frozen on their threads, resolved by exact match |
| B | Same, but the shortest unique suffix (≥4) that the device holds (git `core.abbrev`, Beads adaptive length) | `JCAB-1DQJ` | yes | **no**: the length depends on which threads a device has seen, so two devices can print different labels for one thread | 4–5 characters while the tracker is small | as A | as A |
| C | Per-scope ordinal computed at read | `JCAB-664` | yes | **no**: a thread synced in late, or a thread moved in, renumbers every thread after it | yes | as A | they would be renumbered unless frozen as in A |
| D | The hub hands out numbers | `JCAB-664` | **no**: a thread made offline has no label until it syncs | yes | yes | the rename and history; adds an assignment step at the hub | kept |
| E | What the 2.0 record allows today: a counter, no UNIQUE, no rename | `JCAB-664` | the label mints, but two devices can mint the same one | yes, but a duplicate stays ambiguous forever | yes | the rename and `short_id_history` | kept |
| F | Today's 1.x protocol carried into 2.0: the counter and the rename | `JCAB-664` | yes | **no**: a label can move, and with three devices renames diverge (JCAB-573:2) | yes | nothing | kept |
| G | A counter per device with a device mark | `JCAB-M664` | yes, if the marks are unique | yes | mostly | the rename and history | kept |

The letters match the choices in JCAB-663:2. G is not offered there: it only moves the collision
to the device marks, which must be unique across every device, and across two people once a scope
is shared.

E is the least code of any option. That matters because of JCAB-573:2, where David chose "no
code, so we can test", and it keeps numbers people can say. It is not quite no code: nothing mints
a label for a 2.0 thread yet (`storage/record.ts` never writes `short_id`), and apply leaves record
ops out of the labels it raises counters past (`apply.ts:502`, `if (isRecordOp(op)) continue;`).
So E needs a mint for threads and the counter raised on a pulled thread. The cost: two devices that
both file in one scope between two syncs hand out the same numbers, and those labels stay
ambiguous. A ULID suffix collides only by chance (about 1.2 pairs in a 50k-thread tracker). A counter collides every
time two devices write to one scope at once. That is why A is recommended over E.

## How A works

- **Shown.** The thread's frozen 1.x label if it has one. Otherwise `derivePrefix(scope)`
  (`packages/core/storage/helpers.ts:164`) plus `-` plus the last six characters of the id. Nothing
  is stored. A thread moved to another scope shows the new prefix.
- **Resolved**, in this order (today's resolver is `packages/core/storage/tasks.ts:132-201`):
  1. A full ULID passes through, as at `tasks.ts:138`.
  2. An exact, case-insensitive match on a stored 1.x label (today's `short_id = ? COLLATE NOCASE`,
     `tasks.ts:143-148`).
  3. `<prefix>-<suffix>` with a suffix of four or more Crockford characters: drop the prefix and
     match `id LIKE '%' || suffix` over every thread. One match is the thread. Several give an error
     that lists the candidates, the way `tasks.ts:186-197` already does for an ambiguous ULID prefix.
  4. A bare token stays a ULID prefix, as now. ARCHITECTURE.md:420 and
     `extensions/loop/AGENTS.md:29` already describe this, so they stay true.
- **Why the prefix is ignored at lookup.** A thread can move scope, and nesting crosses scopes
  (`wiki/record-primitives.md:103`: "Nesting has no depth limit and may cross scopes"). A label
  printed before a move has to find the thread after it. So a suffix must be unique across the whole
  database, not within a scope, and the collision counts below are global.
- **Why a fixed length and not the shortest unique one.** A shortest-unique label depends on which
  threads a device holds, and that is the defect that broke the rename: "A `short_id` rename depends
  on what the device has seen, and is never shared" (`wiki/storage-and-sync-shapes.md:70`). With a
  fixed length, every device prints the same label from the id alone. Lookup accepts any suffix of
  four or more characters, so the length printed can grow from 6 to 7 later without breaking a label
  already printed.
- **1.x labels can't be confused with new ones.** The highest 1.x number is 657 in the snapshot,
  three digits, and no more are handed out. A new label always has six characters. Four threads have
  an all-digit six-character suffix, and those are still six characters long.

## The constraints, and where each is written

- Several devices offline. PRODUCT.md:37-38, North Star 4: "Your work lives on your machine, and
  one machine is a complete setup." A thread made offline needs its label at once, which rules out D.
- "agents write labels into commits, PR titles and memory files, so a label must keep resolving
  forever". That is the JCAB-663 brief. It rules out B, C and F.
- "people type and say labels". Also the brief. It is A's cost, not a rule against it.
- "a thread can move scope, and nesting crosses scopes". The brief, and `record-primitives.md:103`.
- "two people may later share a scope (JCAB-653)". The brief. A per-device counter (G) needs a
  device mark unique across both people's devices, and a counter (E) collides between them. A
  suffix doesn't care who wrote the thread.
- Instant (PRODUCT.md:27): "Nothing ships that puts a wait on the common path." A suffix lookup is
  a `LIKE '%…'` scan, which no index serves. On 1,548 rows that wasn't measured as a cost. An
  expression index can come if it ever shows.
- **A written rule this research reopens.** `packages/core/AGENTS.md:63`: "Do not propose block
  leasing, hash IDs, or an ID format change. Considered and rejected; the rename protocol is the
  agreed repair." The JCAB-663 brief asks for exactly this comparison ("He's now asking whether
  identity should be the ULID alone"), and `wiki/storage-and-sync-shapes.md:131-133` already said
  that ruling had become question 2. If A, B, C, D or G is chosen, that line goes (see
  "Instructions to remove").
- **No rule found** asks for labels to be sequential, to show creation order, or to be unique
  within a scope rather than across the whole database.

## Measured on a copy of David's tracker

The copy is `~/.kabane-tracer/source.db`, snapshot of 2026-11-24 12:39, copied with `cp` and
queried with `sqlite3`. These are counts only. The copy has been deleted.

| What | Count |
|---|---|
| Threads (`tasks`) | 1,548: 1,510 issues, 33 tasks, 5 jobs. All are labelled, with 1,548 distinct labels |
| `projects` | 0 |
| Prefixes | 14, one for each base scope. There are 30 scope URIs once branch and package variants count, and no prefix is shared by two base scopes |
| `short_id_history` rows | **0** |
| `sync_oplog`, `sync_state`, `sync_parked` rows | 0, 0, 0. Sync was never turned on in this database, so no sync rename has ever happened in it |
| Numbers handed out with no thread holding them now (counter − labels) | 10 of 1,558. The cause is a deleted thread or a scope-move relabel (`tasks.ts:469-477`), and the database can't tell which. A scope move doesn't write `short_id_history`; only `apply.ts:431` does |

Labels per prefix, with each prefix's counter:

| Prefix | Labels | Scope variants | Lowest–highest | Counter |
|---|---|---|---|---|
| JCAB | 656 | 9 | 1–657 | 657 |
| JICI | 280 | 3 | 1–283 | 283 |
| JLIV | 232 | 4 | 1–234 | 234 |
| JPAT | 177 | 1 | 2–178 | 178 |
| JSPE | 65 | 2 | 1–65 | 65 |
| JTOK | 43 | 2 | 1–43 | 43 |
| JDIA | 36 | 1 | 1–39 | 39 |
| JSTA | 32 | 2 | 1–32 | 32 |
| JKAB | 9 | 1 | 1–9 | 9 |
| JSEC | 7 | 1 | 1–7 | 7 |
| JPID | 5 | 1 | 1–5 | 5 |
| JMON, JFAM, JDAV | 2 each | 1 | 1–2 | 2 |

Collisions, counted across all 1,548 threads. Expected pairs are n(n−1)/2 ÷ 32^k, since every task id
comes from plain `ulid()` (`helpers.ts:35`), so its last 16 characters are random. Only entries use
the monotonic factory (`storage/comments.ts:33`).

| Suffix length | Colliding pairs observed | Expected at 1,548 | Expected at 12,700 (one year at the last 30 days' rate) | Expected at 50,000 |
|---|---|---|---|---|
| 3 | 33 (66 threads) | 36.5 | — | — |
| 4 | 1 | 1.14 | 77 | 1,192 |
| 5 | 0 | 0.036 | 2.4 | 37 |
| **6** | **0** | 0.0011 | **0.075** | **1.2** |
| 7 | 0 | — | 0.002 | 0.036 |

The 1,548 threads were created over 49 days, 42 of them active, with 1,040 in the last 30 days and
at most 29 in one hour in one prefix. A ULID *prefix* would make a poor label. Ids share their first
8 characters with another thread for 530 threads, because the first ten characters are the
timestamp. At 10 characters there are 0 collisions.

How far today's labels reach:

- **Commits.** In this repository, 1,631 of 2,128 commits mention a label, with 449 distinct
  labels. Nine of those match no thread in the snapshot: four JCAB labels made after it, and five
  under prefixes this database doesn't have.
- **Files.** 108 tracked files mention a `JCAB-` label.
- **Tracker text.** 971 descriptions and 1,774 comments mention a label, 1,354 distinct ones. Of
  those, 91 match no thread: 8 inside a counter's range (the gaps above), 2 above it (made after the
  snapshot), and 81 under 26 prefixes that have no counter here (test or sandbox scopes, or older
  scopes; not told apart).
- **Memory.** 26 of the 35 files in David's Claude memory for kabane mention a label.

So freezing the 1,548 labels is required, not a courtesy. Most of what has been written about the
work names them.

## How others do it

I read these myself unless a line says otherwise. A WebFetch result is a summary of the page made
by a small model, quoting it, and I mark each one.

- **git short SHA.** Local `man git-config` (git 2.50.1), core.abbrev: "If unspecified or set to
  'auto', an appropriate value is computed based on the approximate number of packed objects in your
  repository, which hopefully is enough for abbreviated object names to stay unique for some time …
  The minimum length is 4." gitrevisions (WebFetch): "a leading substring that is unique within the
  repository." Running `git rev-parse 0000` in this repository printed `error: short object ID
  0000 is ambiguous` and listed the candidates. So git accepts that a short name printed today can
  become ambiguous, and answers an ambiguous one with the candidates. That is A's lookup rule.
- **git-bug.** Source `entity/id.go`: `const HumanIdLength = 7`. `doc/design/data-model.md`: "this
  hash is displayed truncated to a 7 characters string … you can enter as few characters as you
  want, as long as there is no ambiguity. If multiple entities match your prefix, git-bug will
  complain and display the potential matches." A fixed display length with lookup by any
  unambiguous part is A.
- **Radicle** (WebFetch of radicle.dev/guides/user). An issue's id is the 40-hex Git OID of its
  collaborative object, shown as 7 characters in `rad issue` lists, and "as long as the given
  prefix is unambiguous, Radicle will resolve it". Same as git-bug.
- **Fossil tickets** (WebFetch of `www/tickets.wiki`). `tkt_uuid` is a random 40-hex number, "large
  so that the chance of collision between any two tickets is vanishingly small", and the internal
  `tkt_id` "may change when doing a fossil rebuild". The page says nothing about how long a prefix
  must be.
- **Taskwarrior** (WebFetch of taskwarrior.org/docs/ids). A number is "the index (1-based) of the
  tasks in the working set" and "ID numbers change occasionally". The UUID is permanent. That is C,
  and Taskwarrior keeps the UUID for anything lasting. The page says nothing about short UUIDs.
- **Beads.** Source `docs/core-concepts/hash-ids.md`, `adaptive-ids.md`, `internal/idgen/hash.go`.
  An id is a base36 hash of title, description, creator, timestamp and a nonce (`bd-a1b2`), with
  "Children auto-increment" (`bd-a3f8e9.1`). Its length adapts to the database's size, "0-500 → 4
  chars, 501-1500 → 5, 1501+ → 6", and the hash is the identity itself. README:265 says "IDs resolve
  exactly", but that is about the HTTP backend client ("Three CLI-level differences"). Partial
  matching applies locally. Beads' hash-ids page states the same problem kabane has: "Traditional
  sequential IDs … break when multiple agents create issues simultaneously."
- **GitHub** (WebFetch of the transfer docs). A transferred issue's "original URL redirects to the
  new issue's URL". The autolink docs show a SHA shortened to 7 characters. That issue numbers are
  shared with pull requests within a repository is from memory; I didn't read it.
- **Linear.** Not read: `linear.app/docs/move-to-new-team` and `editing-issues.md` both returned
  404. A search snippet credited to that page says that on a move "we generate a new issue ID and
  unique URL … Old URLs will still work and redirect", and that inline references "won't update
  visually". Treat it as unverified.
- **Jira** (WebFetch of the Atlassian KB "Moved Issues no longer redirect …"). After a move, "the
  table `moved_issue_key` is updated with the now-previous Issue key", and old keys redirect. A
  community post adds that the redirect breaks once the old project key is reused; that is
  unverified.

What they share: the centralised trackers make the number at one authority and keep old labels as
aliases (Jira's `moved_issue_key`, GitHub's and Linear's redirects). git, git-bug, Radicle and
Beads show a fixed or adaptive slice of a random or hashed id that never changes. Taskwarrior is the
exception: its working-set numbers change by design, and anything lasting uses the UUID. None of
them renames a lasting label after the fact.

## What each option changes in the code

Line numbers are from main at `48e6b5c3`. `packages/core/sync/apply.ts` holds a NUL byte, so plain
`grep` calls it binary; use `grep -a`. The line numbers in the brief and the older wiki notes for it
are out of date.

**Removed by A, B and C:**
- The `sequences` table (`packages/core/db/schema.ts:298-303`), and on the mint side:
  `shortIdFor`, `prospectiveShortId`, `nextSequence` and `generateShortId`
  (`storage/helpers.ts:192-246`). Their callers are `tasks.ts:223-231` (create),
  `tasks.ts:469-477` (the scope-move relabel), `task-receipts.ts:45-58` and `projects.ts:127-133`.
- The `short_id_history` table (`schema.ts:528-537`).
- The rename. In `sync/resolve.ts`, the `rename` decision at :174-190, `byShortId` at :210-215 and
  the contest at :390-402. In `sync/apply.ts`, `SHORT_ID_TABLES` at :102 and :197, the `renamed` count at
  :157-158, the rename helpers and `mintShortId` at :335-470, batch labels at :495-510,
  `reserveBatchLabels` at :560-575, the `case "rename"` at :669-672 and the call at :793.
- Sync status: `renamedShortIds` and `sync.renamed` (`sync/namespace.ts:201-205`, :337, :360,
  :388).
- Portable export and import of counters (`portable/format.ts:54`, `portable/index.ts:116-123`).
- The 1.x `UNIQUE` on `short_id` (`schema.ts:115`, `migrations.ts:60`) goes with the 1.x tables.

**Changed by A:**
- `SHORT_ID_PATTERN` (`helpers.ts:44`, `/^[A-Z0-9]{2,4}-\d+$/i`) is used by `tasks.ts:143` and
  `projects.ts:50`. It must also accept a Crockford suffix, with lookup in the order above.
- `packages/board/src/now-feed.tsx:138` has its own regex,
  `/(?:^|:)([A-Z][A-Z0-9]*-\d+(?:#\d+)?)$/`, which reads a label from a session name, so it misses a
  new label. That is the only other label parser in the repository. A wider search covered
  `packages`, `extensions` and `scripts`, outside tests, wiki and docs.
- `threads.short_id` (`schema.ts:550`, index :575) keeps only the frozen 1.x labels, and new threads
  leave it empty.

**Unchanged by A:**
- The ULID branch at `tasks.ts:138`.
- Question handles. `Questions.resolve` (`packages/questions/storage.ts:173`) splits on
  `^(.+):([1-9]\d*)$` and resolves whatever comes before the colon, and a handle is printed from
  `short_id ?? task_id` (`storage.ts:80`). So `JCAB-1DQJHD:1` works once that line prints the shown
  label.

**E** removes the rename and history. It keeps the counter and a way to raise it past labels it
receives (today's `reserveBatchLabels`), because without that a synced device would mint numbers
already taken. Neither exists for 2.0 threads yet (`apply.ts:502`), so both are added. **F** keeps all of it and adds the rename to the record. That goes against the
record's own design, under which the four tables "converge by shape, with none of the machinery
above" (`packages/core/AGENTS.md:87`). **D** adds an assignment path in the Worker and a state for
a thread that has no label yet. **G** adds a device mark that must be chosen, stored and kept
unique.

## Coupling points and open unknowns

- **JCAB-661: a thread whose id is a key.** JCAB-652's decision of 2026-11-24 18:47 leaves open
  that a thread created from a plan key may have "the key itself rather than a hash" as its id, and
  that "thread lookup then has to accept an id that isn't a ULID". The last six characters of such
  an id aren't random. Two plans with a step called `review` would end in the same suffix. A, B and
  C's suffix rule assumes a ULID, and this decides between a label computed from the id and one
  stored on the thread. It has to be settled together with 661. I didn't guess a rule for it.
- **The herdr panel** reads labels through `kabane list --format concise` and `kabane questions`
  (`record-primitives.md`, "Not verified"). It lives outside this repository, so whether it parses a
  label's shape wasn't checked.
- **Branch and worktree names** are built from a lowercase label (`jcab-654-sync-converges`). A
  Crockford suffix lowercases cleanly. The dispatch and loop code that builds them wasn't read line
  by line.
- **Typing a label.** Crockford base32 has no I, L, O or U. Whether lookup should map I and L to 1
  and O to 0, as Crockford decoding does, is a small choice left to whoever implements it.
- **JCAB-660** migrates labels as they are into `threads.short_id`. Under A that column becomes the
  store of frozen labels with no other change, so nothing in 660 has to move.

## Instructions to remove (for A)

Files are on main at `48e6b5c3`. Nothing here has been edited.

`packages/core/AGENTS.md`:
- :55 `## \`short_id\` is a nickname, not an identity`. Remove the section and put the replacement
  below in its place.
- :57 "`id` (ULID) is identity. `short_id` (`JCAB-42`) is a human-facing label minted from a
  per-prefix **machine-local** counter, so two devices working offline both hand out `JCAB-42`."
  Remove.
- :59 "**Ruling.** In a collision the ULID-earlier row keeps the label live; the other is
  relabelled at apply time. … A stale external reference (a commit message) resolves to the
  winner." Remove.
- :61 "Never key on `short_id` across machines. Resolve to the ULID first
  (`Planner.resolveTaskId`)." Replace: an agent could otherwise store a label in a ref or link.
- :62 "`sequences` does not replicate. `sync/apply.ts` raises each counter past every label a batch
  delivered." Remove.
- :63 "Do not propose block leasing, hash IDs, or an ID format change. Considered and rejected; the
  rename protocol is the agreed repair." Remove.
- :64 "`\d+` is hardcoded in `SHORT_ID_PATTERN` in `storage/helpers.ts`. `next_number` stores the
  *last used* number." Remove.
- :85 "Excluded: `sequences`." Remove.
- :87 "…and record ops never feed today's `short_id` renames." Remove the clause once the 1.x tables
  and the rename are gone.

Replacement for :55-64, only because an agent would otherwise get it wrong:

> ## A label is shown, never stored
>
> A thread's label is its 1.x `short_id` when it has one, otherwise its scope's prefix and the last
> six characters of its ULID. The prefix follows the scope, so resolve a label to the ULID
> (`Planner.resolveTaskId`) before you store or compare it. Lookup ignores the prefix; a suffix
> that matches two threads is an error listing both.

No line about `short_id`, `sequences` or renames is in `CODING_PRINCIPLE.md` or the root
`AGENTS.md`. Two lines stay true as written: `ARCHITECTURE.md:420` ("`get` accepts
case-insensitive short ids, full ULIDs and unique ULID prefixes") and
`extensions/loop/AGENTS.md:29`. `extensions/jobs/AGENTS.md:93` is about run ids, not labels.

Other text that would go stale, which isn't agent instruction:
- the code comments that cite the ruling: `schema.ts:528-531`, `resolve.ts:175-182` and
  `apply.ts:412-415`, which also points at a `packages/planner/CLAUDE.md` that no longer exists.
  They go with the code.
- the docs: `docs/getting-started.md:924` ("Short ids start with `J`"), `docs/deploy.md:645` and
  `docs/concise-reads.md:68`.
- `wiki/adr/0008…md:59`: "The `short_id` gap is accepted (JCAB-573:2)."

## Not verified

- Linear's behaviour on a move. Both doc URLs returned 404, and only a search snippet was read.
- The Jira redirect breaking once an old key is reused. That is a community post.
- That GitHub issue numbers are shared with pull requests. Not read.
- Whether the herdr panel, or any script outside this repository, parses the shape of a label.
- How much a suffix `LIKE '%…'` scan costs at 50k threads. It wasn't run.
- Whether the 10 gaps in the counters came from deleted threads or from scope moves, and what the
  81 tracker-text labels under unknown prefixes refer to.
- How labels should work for key-derived thread ids (JCAB-661).
- The collision projections assume the ULID's random part is uniform, which holds for `ulid()`. A
  thread id made with `monotonicFactory` inside one millisecond still differs in its last
  character, but I didn't test that.
