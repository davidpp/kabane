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

- **p1**: a promise is not kept (a constraint a brief states, such as "never write X" or
  "validate every Y", is a promise too), the main path errors, data is lost, corrupted or
  exposed to something that should not see it, or a test claims coverage it does not have. The
  work is not done until it is fixed.
- **p2**: an edge case or error path behaves badly, or a promise is kept only partly.
- **p3**: something works but surprises a user: a confusing message, an inconsistent flag.

A finding names what was promised, what happens instead, and how to see it happen.

## In this repository

- Each brief has a **Verify** section. Those steps are promises: run every one of them
  yourself and compare what you see with what the brief says. A step the implementer reported
  as run is still yours to run.
- Run kabane through `bun run sandbox [kabane args]` (AGENTS.md, "Gate"). It gives kabane a
  throwaway `KABANE_HOME` and git repo. Never run a check against `~/.kabane`: it is the
  maintainer's real tracker.
- A board change is checked in the real board under tmux, on your own `-L` socket, and with
  `bun run gallery --print <story>` (AGENTS.md, "Validating a UI change"). An MCP change is
  checked by driving `bun run sandbox mcp` over stdio with a real `tools/call`.
- A passing test over a mock, a fixture or a scripted agent does not show that the command,
  the board or the tool works. When a promise is covered only that way, and the real path can
  be run, run it. When it cannot be run here (a logged-in harness, a mouse click, a deploy),
  file what is left unverified as a p3 that names the manual check.
- The work is promised for both readers: a human at the CLI or the board, and an agent through
  the MCP tools. Check the one the brief names, and the other when the change reaches it.
