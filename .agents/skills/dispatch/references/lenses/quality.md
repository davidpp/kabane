# Quality lens

Check that the change is one the project's maintainers would merge: it follows the
repository's own rules and leaves the code easier to change, not harder.

- Read the repository's instructions first (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, a
  coding principles file, whatever it has). Its rules are the standard, not your taste.
- Read the diff of this work against where it started (`git log`, `git diff`). Judge the
  change, not the code that was already there.
- Look for: duplicated logic that has a home already, an abstraction nothing needs yet, error
  handling that hides a failure, names that say something other than what the code does,
  comments that restate the code, dead code, tests that test a mock instead of the behaviour.
- Run the project's own checks (lint, typecheck, format) if the gates did not already.

Severity:

- **p1**: the change breaks a rule the repository states as non-negotiable, hides a failure a
  user will hit, or leaks a secret or credential (a token, a key, a password) to a log, an
  output or a client that should not get it.
- **p2**: it makes the code harder to change: duplication, a wrong abstraction, a misleading
  name, a missing test for new behaviour.
- **p3**: a nit a reviewer would mention and not block on.

A finding quotes the rule or the code it is about, says why it matters, and says what the fix
looks like.

## In this repository

- The rules are `AGENTS.md` (root, and the changed package's own), `CODING_PRINCIPLE.md`, and
  the review skill `.agents/skills/review-oss-typescript/SKILL.md`. Follow that skill's axes;
  judge the result as a public TypeScript project.
- Non-negotiable here, so p1 when broken: no `as any`, non-null `!`, `@ts-ignore` or
  `@ts-expect-error`; external data parsed with zod `safeParse`; `Result`, never a throw
  outside a transaction body; no new class a framework does not demand; the core reads no
  environment variable; a shipped migration is never edited; a lint threshold relaxed, a rule
  disabled or a suppression added to pass the gate.
- Read the North Stars and Design Principles in `PRODUCT.md`. A change that makes kabane own a
  job a harness already does, adds a permission policy over the user's harness, or grows the
  core for one workflow is a p2 that quotes the principle, even when the code is clean.
- "Invariants at construction" (`CODING_PRINCIPLE.md`): for each property the change states in
  a comment or a doc, ask what enforces it and which test goes red without it.
- One concern per commit. Internal notes are in `wiki/`, never `docs/`.
