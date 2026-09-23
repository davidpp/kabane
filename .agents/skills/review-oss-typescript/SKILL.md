---
name: review-oss-typescript
description: Review a TypeScript project or change for correctness, simplicity, architectural fit, public API quality, security, performance, and open-source readiness. Use before merging implementation or refactoring work, when reviewing agent-generated code, and when auditing the repository for public release.
---

# Review OSS TypeScript

Judge whether the resulting repository is healthier and easier for an external maintainer to trust. Do not demand perfection or block on personal style.

## Establish the contract

1. Read `CLAUDE.md`, `CODING_PRINCIPLE.md`, and the task or specification.
2. State the intended behavior and public surface before inspecting implementation details.
3. Inspect tests first. Ask whether each behavioral claim has a test that would fail without its enforcement.
4. Review the resulting files and dependency graph, not only the diff.

## Review axes

### Correctness

- Check the specified behavior, error paths, empty and boundary inputs, concurrency, and state transitions.
- Treat external data as `unknown` until a zod schema accepts it through `safeParse`.
- Check that fallible functions return `Result` and that a `throw` appears only inside a transaction body to roll it back.
- Question silent fallbacks, casts, optional fields, and assertions that hide an invariant. `as any`, non-null `!`, and `@ts-ignore` are always findings.
- Confirm the architectural invariants in `CODING_PRINCIPLE.md` remain structurally enforced: local SQLite authoritative, the hub one more device, every replicated write captured into the append-only oplog, private rows kept out of it, the core running in Bun and Workers, migrations appended and never edited.

### Readability and simplicity

- Require names to use the repository vocabulary and identify domain responsibility. Flag vague names such as `data`, `result`, `manager`, `handler`, or `utils` when context does not make them precise.
- Search for the canonical implementation before accepting a new helper, type, dependency, or pattern.
- Prefer direct control flow. Flag nested conditionals, pass-through wrappers, speculative configuration, and single-implementation abstractions.
- Ensure comments explain durable intent, constraints, or evidence—not code mechanics.

### Architecture

- Keep feature-specific logic with its owner; do not turn shared modules into dumping grounds.
- Keep dependencies flowing toward core contracts. The core receives runtime dependencies through `Runtime.configure` ports, never from the environment, and reaches storage only through the `Db` port.
- A new class is a finding unless a framework demands the subclass; logic belongs in namespaces.
- Treat a conditional bolted onto an unrelated flow as a design finding. Repeated conditionals over the same shape may indicate a missing model or dispatcher.
- Test a refactor by counting concepts a reader must hold. Prefer a design that removes branches, modes, or layers over one that relocates them.
- Prefer deleting an abstraction over polishing unnecessary indirection.

When raising a structural finding, propose the named move: collapse duplicate branches, reuse the canonical helper, make a type boundary explicit, separate orchestration from policy, move logic to its owner, or delete a pass-through layer.

### Open-source readiness

- Verify a fresh root install provides every dependency required by documented checks and examples.
- Keep the OSS dependency closure free of private packages, credentials, private data, and company-only assumptions. Isolate optional private adapters.
- Review the public API for one obvious entrypoint per capability, inference-first types, stable ownership, and actionable errors.
- Check README examples, environment setup, package metadata, license choice, contribution commands, and generated-file rules against the repository's actual behavior.
- Review new dependencies for an existing alternative, maintenance, license compatibility, size, security, and transitive lockfile changes.
- Ensure fixtures, logs, screenshots, and example configuration are safe to publish.

### Security and performance

- Check secrets, authorization, injection, path traversal, unsafe deserialization, and external-data validation where the changed surface can exercise them.
- Check unbounded work, N+1 queries, resource leaks, synchronous work in async paths, and avoidable allocations in measured hot paths.
- Require evidence before performance-driven complexity.

## Optional heuristic scan

For a repository-wide audit, `aislop` may be run one-off with `bunx` to generate issue candidates. Do not add it to project dependencies, scripts, CI, badges, or required contributor checks.

Treat its output as untrusted triage, not findings. Inspect the cited code and discard generic judgments, test-discovery mistakes, localhost-secret warnings, and other context-free false positives. Create an issue only when the repository itself proves a concrete impact and the issue can name the smallest credible remedy. Record that evidence in the issue; do not use the scanner score as evidence.

## Findings and verdict

Report only actionable findings. A few high-conviction findings beat a list of nits.

- **P0:** private row leaked to the oplog or hub, credential exposure, data loss, divergent sync, or critical security defect.
- **P1:** broken behavior, public contract, installation path, or architectural invariant.
- **P2:** concrete maintainability, duplication, ownership, or performance regression.
- **P3:** optional improvement; do not block approval.

For each finding, include the smallest relevant file and line range, evidence, impact, and the simpler proposed shape. Order findings by severity. Do not soften a real defect or inflate a preference into one.

End with:

1. Verification actually performed (`bun run check`, `bun run typecheck`, `bun run test`, anything run by hand) and important gaps.
2. **Approve** when the change improves overall health with no unresolved P0-P2 regression, otherwise **Request changes**.

Do not accept “clean it up later” for debt introduced by the reviewed change. Flag unrelated pre-existing debt separately without expanding the change.
