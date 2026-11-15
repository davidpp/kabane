---
always: true
---

# Functional lens

Check that the work does what the parent issue and its subtasks asked for, as a user of it
would find out.

- Read the parent's brief and every subtask's brief and acceptance criteria. List what was
  promised before you look at the code.
- For each promise, find the code that keeps it and exercise it the way a user would: run the
  command, call the API, open the page. Prefer running it over reading it.
- Your brief names each gate that passed on this tree and the command it ran. Do not run those
  commands again, whole or in part. Tests that no listed command runs are still yours to run,
  and so is the real path no gate exercises. When the brief says no gate passed on this tree,
  run the tests that cover each promise yourself.
- Look for what the briefs imply but nobody wrote down: empty input, a missing file, a second
  run, an error path, the state a previous version left behind.
- Read the tests to judge whether they cover the promises, and whether they would fail if a
  promise broke.

Severity:

- **p1**: a promise is not kept (a constraint a brief states, such as "never write X" or
  "validate every Y", is a promise too), the main path errors, data is lost, corrupted or
  exposed to something that should not see it, or a test claims coverage it does not have. The
  work is not done until it is fixed.
- **p2**: an edge case or error path behaves badly, or a promise is kept only partly.
- **p3**: something works but surprises a user: a confusing message, an inconsistent flag.

A finding names what was promised, what happens instead, and how to see it happen.
