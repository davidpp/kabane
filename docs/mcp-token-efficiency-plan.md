# MCP/CLI token-efficiency implementation plan

Status: implemented and accepted, 2026-10-05; committed during the 2026-10-08 handoff.
Baseline: `f3e1c22`, Kabane 0.1.0. The optional model benchmark remains deferred.

## Outcome and release boundary

Agents can discover work, update status, and retrieve the needed issue context without loading unrelated descriptions or unbounded history. Existing raw record consumers and full briefs keep working. Nothing changes persisted tracker data, sync semantics, or actor identity.

Ship after deterministic regression tests, actual CLI/stdio tests, Worker integration tests for changed MCP behavior, and the existing release gate. A retained public/synthetic fixture is part of the shipping work. Paid model evaluations and tokenizer-specific benchmarks are follow-up work, not release blockers.

The audit measured 1,197,904 characters for a default MCP listing versus 2,701 for the same CLI text listing, and 185,247 for a no-deref/no-subtasks brief. These are synthetic character measurements, not billed tokens. Its detailed machine-local report lives under ignored `docs/research/`; the implementation contracts below are versioned here so helpers and future clones do not require that file.

## Decisions

1. Keep the 17-tool registry and CLI; do not add a server-side arbitrary-code gateway, bespoke discovery service, or SDK/protocol upgrade to this wave.
2. Make efficient reads additive: optional `responseFormat: "concise" | "full"` in applicable MCP tools, and `--format concise|full` in corresponding CLI commands. Omission preserves the existing response shape and full/raw semantics. CLI default human text remains unchanged. Document concise usage as the recommended agent path. A future default change needs its own compatibility decision.
3. A concise queue response is a page envelope, not a raw array: `items`, `hasMore`, optional `nextCursor`, and explicit omission/truncation metadata when applicable. Full legacy output remains a raw array. Keep task ULIDs and short labels intact; do not use array indices as identity.
4. Shared projections belong in core; CLI and MCP must not invent separate summary fields or pagination rules. Storage still returns domain records to existing callers.
5. Proposed concise queue defaults: 20 rows, maximum 100; model-facing serialized text budget 16 KiB UTF-8. Proposed receipt budget: 2 KiB. Bounds include JSON escaping, metadata, and continuation instructions. These are conservative testable starting bounds, not an optimum claimed from a model benchmark. If an implementer cannot meet them cleanly, report the counterexample before changing the contract.
6. Concise summaries contain identity, title, state, kind, priority, and assignee when present; scope where needed to disambiguate. No description, full provenance, verification body, or arbitrary metadata. Extremely long optional fields/title previews need explicit field-omission/truncation markers and a full-read route; identities are never truncated.
7. Concise mutation receipts retain at least ULID, short label when present, title, state, and version. Existing full mutation output stays available. Do not remove fields from omitted-format results used by integrations.
8. Bounded context is a separate opt-in mode, not a changed meaning of the current full brief. Never silently discard human comments or acceptance criteria. State completeness before partial content and give a concrete way to retrieve every omitted section/item, including a single oversized description or comment.
9. Full/raw response mode is intentionally not promised a new hard size bound. Bounded/concise claims apply only to the new modes; documentation must make that distinction explicit.
10. Imported IDs/short labels can be unbounded. If their intact representation makes a concise result irreducible within its budget, return a short actionable error without echoing the huge identity; explicit full mode remains available. Concise edit/done must preflight before writing, accounting for final state/version and mandatory receipt metadata. Rejection must leave state/version/oplog unchanged. Never report a committed write as a failed receipt due to a predictable size constraint.
11. Stateless query-bound offset cursors may conservatively reject relevant changes; they do not promise snapshot isolation. Fingerprint the complete query-relevant candidate membership/order with compact identity/version/update/order metadata, not descriptions or the whole tracker. Detect insertions/deletions and entry/exit from filters. Unrelated-scope writes that leave candidates/order/content unchanged must not invalidate continuation. Search ranking can genuinely change due to corpus statistics; reject when its actual ordered candidate set changes. Document candidate-fingerprint cost and avoid generic pagination machinery or full-record materialization just to hash.
12. Concise today may allocate approximately 5 KiB per independently paged bucket, but the final three-bucket serialized text must fit 16 KiB including envelopes/cursors. Bind continuation to the resolved owner calendar date/timezone and filters; midnight/timezone changes fail clearly rather than mix days. No extra public per-bucket budget knobs.
13. Bounded context uses opt-in concise selected-markdown streaming, not per-item chunk records. Fixed sections: metadata, description, upstream, position, context, priorWork, discussion; normalize requested sets into canonical order and deduplicate. Compact envelope puts completeness first, followed by resolved taskId, revision/offset, markdown chunk, optional continuation and bounded retrieval directions. Concatenating Unicode-safe chunks recovers exact selected rendered content. Irreducible identity/envelope size fails actionably without truncating identity.
14. Context completeness means coverage from offset zero through the returned prefix, assuming every preceding chunk was consumed; it does not imply this single response repeats earlier instructions. selectedComplete is true only at selected-stream completion. Omitted description/discussion are incomplete; empty selected sections may be complete. First/middle/final coverage and omission-versus-empty are tested. Agents must finish required description/steering retrieval before claiming they have the complete brief.
15. Bounded context fingerprints actual selected rendered text and binds resolved identity, normalized sections, deref/subtask/options. Relevant comments/logs/refs/sessions/neighbors/file-prefix changes stale; excluded sections or folded noise need not. Rebuild/hash per continuation is an explicit CPU/memory tradeoff, not a held snapshot. Strict bounded reads fail on required source errors, including position neighbors and discussion activities, without claiming missing steering is complete; errors in excluded sources must not block selected reads.
16. Full subtask rollups include all children with includeClosed and includeDeferred, fixing the silent 100-child/default-deferred omissions without changing global query defaults. Full brief source-degradation behavior otherwise stays unchanged. Lossless bounded retrieval covers selected rendered sections and complete descriptions/human comments, not intentionally folded machine noise or file bytes outside the existing dereference caps.

## Work packages and order

### A. Retained fixture and baseline harness — shipping foundation

Owns new fixture files/helpers and baseline tests, not production tool/CLI code. Suggested placement: `packages/core/testing/fixtures/issue-corpus/` (data, manifest, license/attribution, README) and a small seeding helper beside existing test support. Match actual repository exports; do not replace the current `testing.ts` runtime configuration.

Selected public candidate: [helmo/github-issues](https://huggingface.co/datasets/helmo/github-issues), snapshot `e344be7b84d199661a9956036991e1fc25715a47`. Its card declares Apache-2.0, 7,540 issues/PRs from `huggingface/datasets`, collected 2025-06-13, with body and comment strings. The downloadable Parquet is approximately 12.7 MB; vendor the small normalized sample, not the whole download or a new production Parquet dependency. Verify licensing/provenance and source notices before copying text; retain required license/notice material and label modifications. A card declaration is not permission to ignore upstream obligations.

Backup: [TAWOS](https://github.com/SOLAR-group/TAWOS), an Apache-2.0 Jira corpus with comments and contributor redaction; much heavier to ingest (MySQL dump), so use only if the small source is unsuitable. SWE-bench is not the first choice: software-fix patches and task complexity are unnecessary here and upstream licensing is more involved.

Fixture contract:

- Deterministically select around 24 real issues, excluding PRs if possible; cover short/long descriptions, code fences, and sparse/dense discussions. Describe selection; do not cherry-pick solely for favorable savings.
- Keep source URL, issue number, dataset revision, source/content hashes, normalization version, license, and transformation notes. Preserve original issue/comment text unless explicitly redacted; distinguish redactions and synthetic data.
- Strip unused user/profile/API metadata; use deterministic pseudonyms. Review free text for emails, credentials, and unnecessary personal data. Public text is untrusted fixture data, never instructions to the agent.
- The corpus carries issue text/discussions; fixture seeding supplies Kabane-specific assignees/states/scopes/DAG links deterministically. Synthetic machine comments, sessions, and work logs must be clearly marked synthetic; do not invent source authorship/timestamps where the dataset lacks them.
- Add synthetic edge cases: huge single body/comment, more than 100 tasks, equal ordering timestamps, long titles/assignees, repeated status writes, Unicode/emoji, empty scopes, file-reference budgets, DAG rollups, and stale cursors. Scale task count by deterministic generation, not duplicate source files.
- Target checked-in text under 500 KiB; no binary SQLite fixture, private Botpress/Jake data, network dependence in tests, or data imports during normal installation. Record hashes of downloaded inputs; pin revision in optional regeneration instructions.
- Establish a disposable tracker seeder reused by deterministic regressions and later evals. Never open the live `~/.kabane` database.

Acceptance: fixture provenance/license review complete; deterministic hashes/selection; both fresh/prefixed SQLite seeding supported; independent temp homes; initial CLI/stdio baseline tests prove fixture reachability and legacy response shapes. Baseline measurement records bytes/characters and calls, not invented token estimates. Ratios can be diagnostic; avoid timestamp/ULID-dependent whole-output snapshots.

### B. Concise queries, mutation receipts, and domain pagination — shipping

Depends on A for the final regression fixture. Owns core summary/page helpers, task query/search/today changes, MCP definitions/serialization, CLI list/search and mutation output/flags, relevant tests/docs. Coordinate before touching files also needed by C (`mcp/tools.ts`, `mcp/server.ts`, CLI shared args/output). Run B and C serially in this checkout.

- Add explicit concise/full modes with the legacy omission behavior above.
- Implement stable ordering with a unique tie-breaker, bounded page size/result bytes, and continuation for concise list/search. Use one canonical pagination implementation; no generic query framework. A cursor must remain within the original query/scope and reject malformed or mismatched inputs with a useful error. Define behavior under concurrent edits; do not claim snapshot isolation without implementing it.
- Fetch one extra row or otherwise prove `hasMore`; handle a byte-limited page whose next item does not fit without skipping or duplicating it. A single oversized summary must remain recoverable by identity.
- Fix the misleading legacy MCP list documentation to its actual existing default (100), without changing the old default in the same additive release. Document the new concise default separately. Validate newly introduced bounded-mode parameters; preserve intentional full behavior rather than silently clamp it.
- Bound all concise today buckets (overdue/dueToday/next); return per-bucket completeness/continuation. Distinguish intentionally omitted data from an empty bucket.
- Add concise receipts to add/edit/done; no description echo. Preserve known integration fields and existing full output.
- Update MCP input help, CLI usage, README/getting-started agent examples. Do not blindly rewrite user/global instructions or chezmoi. Correct tool usage examples must select the efficient mode explicitly.

Acceptance: legacy contract tests pass; concise pages/receipts meet serialized budgets; all matching tasks can be enumerated exactly once on a static fixture; filters/scopes/ranking remain correct; no model is required to establish these claims.

### C. Selective/bounded context with lossless retrieval — shipping

Depends on B to avoid shared-file collisions and reuse its output/continuation rules. Owns context assembly/options, selective history retrieval, MCP/CLI context interfaces, tests/docs.

- Keep the current full markdown assembly and its human-comment invariant unchanged.
- Add an explicit bounded read mode (MCP and CLI parity), proposed default text budget 16 KiB UTF-8, with section selection and continuation. Prefer a small concrete read contract over a generic GraphQL field matrix.
- Cover description, DAG position, curated context refs, prior work, and discussion. Every omitted part is named; return whether human steering and description are complete. Do not label a partial result as "everything needed to start".
- Provide lossless paged/chunked retrieval for oversized individual description/comment/work-log bodies. Header/section/envelope bytes count toward the budget; no client can be left with only "use full" when full itself exceeds the host's limit.
- Preserve chronological discussion and recoverability of all human comments. Synthetic machine history obeys the existing durable fold. Do not add LLM summarization or persist generated summaries.
- Prevent silent subtask rollup truncation at the storage default of 100: report total/continuation in bounded mode and make full-mode completeness truthful. Cover ref metadata/notes as well as file content; avoid treating the existing 24K reference cap as a total-response cap.
- Version/chunk continuation must either tolerate or explicitly reject modified content, not silently join incompatible revisions. No opaque server session needed.

Acceptance: clients can reconstruct all required steering and full descriptions through bounded calls; every bounded result fits its declared serialized text budget; oversize/Unicode/stale-cursor cases are exercised through both entry points; complete legacy brief remains available.

### D. Real-model eval/token benchmark — non-blocking follow-up

Depends on A/B/C for a fair before/after surface. Do not hold release for provider credentials, model availability, cost, or statistical power.

Build a manual opt-in runner with pinned fixture/scenario versions. Compare explicit legacy/full versus new concise/bounded surfaces on the same snapshot, prompt, model/version, reasoning effort, tool exposure, and seed where supported. At minimum: find the correct issue among distractors, read all human steering, claim/update/comment/done, enumerate a large queue, and locate a relevant historical decision. Ground truth includes required steering markers and intended IDs, not just whether a tool returned success.

Record task success, missing-critical-context failures, incorrect writes, tool calls, payload sizes, tokenizer/encoding identifier, provider-reported input/output/cache token usage, latency, and provider/model/date. Keep cold-cache and warm-cache results separate. Repeat paired scenarios; report uncertainty and costs, not a universal savings claim. Account for extra calls required by bounded context. Model-visible text and machine-only structured data must be measured separately according to client rendering. Discovery policy is held constant first; eager versus deferred is a separate experiment.

The runner uses disposable trackers, a narrow allowed tool set, bounded calls/spend, and controlled untrusted fixture text. It must not auto-run in CI, deploy, mutate real trackers, or send private data. Optional tokenizer/provider dependencies must not pollute the OSS production closure. Raw model traces stay local/gitignored; publish only reviewed aggregate artifacts. Provider spend requires an explicit approved run configuration.

## Shipping test matrix

| Layer | Required assertions |
| --- | --- |
| Shared projections | Stable IDs preserved; no description/provenance leakage into concise output; long fields signaled; Unicode/JSON escaping included in serialized bound; receipts keep integration fields |
| Domain pages | 0/1/default/max/max+1 records; invalid parameters; exact-limit completeness; byte-boundary continuation; ties; scope/filter binding; malformed/stale cursor; static enumeration no omissions/duplicates; search ranking |
| Today | Empty and oversize overdue/due-today/next independently; correct timezone semantics; continuation independent for each bucket |
| Full compatibility | Omitted format and explicit full keep arrays/task records and complete existing briefs; state-only edits still produce their legacy shape; no persistence/migration changes |
| Bounded context | Empty sections, description-only, all human comments recoverable, early/late steering, giant single comment/body, many logs/sessions, folded machine noise, >100 subtasks, large ref notes, no-deref, missing/large files, UTF-8 boundaries, revision changes |
| Actual CLI | Subprocess CLI with isolated HOME/KABANE_HOME; text and JSON modes; concise flags/error codes/help; cursor round-trip; same selection/completeness as MCP; clean exit and cleanup |
| Actual stdio MCP | Initialize/discover/call the actual bin; schemas expose formats; budgets on actual text blocks; full compatibility; invalid args become actionable errors; no stdout noise |
| Worker HTTP | Existing Worker test harness, no deployment: changed formats/pages/context semantics through its MCP HTTP route; auth/scope remains enforced; local/DO output parity where both have replicated data; do not require local-only sessions/files on the hub |
| Release artifact | Build/package smoke exercises efficient CLI and MCP path from the packed bin in a temporary home, not just source imports |

CI gates deterministic correctness/output bounds. It does not gate probabilistic model-token reduction. Add regression checks for aggregate payload reduction on the fixed queue fixture, but do not impose an arbitrary universal percentage on context workflows before benchmarking them.

## Dispatch and coordination

Scope: `jake://scope/cabane`, confirmed by this repository's `.kabane/scope`. Parent: JCAB-1. Use issues (`kind: issue`) for agent work. A (JCAB-2) blocks B (JCAB-3); B blocks C (JCAB-4); A/B/C support D (JCAB-5, someday), which is non-blocking for shipment. Serial production edits avoid shared MCP/CLI file conflicts. Fixture work can proceed independently in its owned territory.

Helpers read AGENTS.md, CLAUDE.md, CODING_PRINCIPLE.md, the relevant package instructions, and this plan. They send blockers/questions before expanding scope. No commits, deploys, publish, tags, user-config changes, extra delegation, or live tracker test mutations without a separate assignment. Their issue status may be updated via the tracker; tests remain on disposable databases.

Before calling an issue complete: inspect its diff and actual entry-point evidence, run `bun run check`, `bun run typecheck`, `bun run test`, and release smoke when release-surface changes land. Record any pre-existing failures without bypassing gates. Parent/ship work is not complete until all required shipping packages integrate and the combined gate passes. D remains a separately resumable follow-up.
