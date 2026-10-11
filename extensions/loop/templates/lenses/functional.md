# Functional lens

Check that the work does what the parent issue and its subtasks asked for, as a user of it
would find out.

- Read the parent's brief and every subtask's brief and acceptance criteria. List what was
  promised before you look at the code.
- For each promise, find the code that keeps it and exercise it the way a user would: run the
  command, call the API, open the page, run the tests that cover it. Prefer running it over
  reading it.
- Look for what the briefs imply but nobody wrote down: empty input, a missing file, a second
  run, an error path, the state a previous version left behind.
- Check that the tests cover the promises, and that they would fail if a promise broke.

Severity:

- **p1**: a promise is not kept, the main path errors, data is lost or corrupted, or a test
  claims coverage it does not have. The work is not done until it is fixed.
- **p2**: an edge case or error path behaves badly, or a promise is kept only partly.
- **p3**: something works but surprises a user: a confusing message, an inconsistent flag.

A finding names what was promised, what happens instead, and how to see it happen.
