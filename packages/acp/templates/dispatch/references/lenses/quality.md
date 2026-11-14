---
applies: a change to code, meaning source, tests, scripts, or lint, type and build configuration; a change to prose alone (docs, READMEs, skill text) has nothing for it
---

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
- Never rerun a gate your brief says passed on this tree, whole or in part: run only a check
  no gate covers. When the brief says no gates ran, run the project's own checks (lint,
  typecheck, format).

Severity:

- **p1**: the change breaks a rule the repository states as non-negotiable, hides a failure a
  user will hit, or leaks a secret or credential (a token, a key, a password) to a log, an
  output or a client that should not get it.
- **p2**: it makes the code harder to change: duplication, a wrong abstraction, a misleading
  name, a missing test for new behaviour.
- **p3**: a nit a reviewer would mention and not block on.

A finding quotes the rule or the code it is about, says why it matters, and says what the fix
looks like.
