# Compatibility lens

Check that someone who already uses kabane can take this change without losing anything.
Existing persisted data is not disposable, and a released interface is a promise.

- List what the work changed that outlives a process or crosses a boundary:
  - the database: tables, columns, migrations, what a write captures into the oplog;
  - files under `KABANE_HOME` (`config.json`, run files, anything it adds) and in a repository
    (`.kabane/`, the dispatch skill);
  - the sync wire: op shapes, the schema version, what the hub accepts;
  - the CLI: commands, flags, exit codes, `--json` output;
  - the MCP tools: names, inputs, result shapes;
  - names that rows and deployed hubs store: `@cabane/*`, `cabane-worker`, `cabane://actor/…`.
- For each, ask what a device that ran the last release holds, and make that state: write the
  old file or row by hand in `bun run sandbox`, in the shape the last release wrote (`git
  show <last tag>:<path>` shows the code that wrote it, and `git tag` lists the releases).
  Then run the new code on it. It must read it, keep it, and say so when it no longer uses it.
- Check the direction of every change:
  - a migration is appended, never edited or reordered (`CODING_PRINCIPLE.md`), and a database
    from the last release migrates with its rows intact;
  - a file kabane used to read is still read, or the change says who moves it. Kabane does
    not move, rewrite or delete a user's file on its own;
  - a renamed flag, value or field keeps the old one accepted on input. Where output changes,
    the docs and the release notes must say so;
  - a removed or renamed MCP tool or input breaks every agent whose instructions name it.
- Check what two versions do together: two devices on different versions syncing through one
  log, and a board or MCP server still running the old code while the CLI runs the new.
- Read `docs/getting-started.md`, "Updating", and `docs/release.md`. A change they would have
  to mention, and do not, is a finding.
- When a brief says a break is accepted, check that the break is exactly the one it names and
  that the user is told, and do not file the break itself.

Severity:

- **p1**: data a user has is lost, unreadable, silently ignored or rewritten; a shipped
  migration was edited; two versions corrupt or diverge each other's data; a released command,
  flag or tool stops working with no accepted path.
- **p2**: old state still works but with no notice where the user needs one; an old name is
  accepted in one surface and refused in another; an output change that scripts read is
  undocumented.
- **p3**: a compatibility path that works and is untested, or one kept with no note of when
  it can go.

A finding names the old state (the file, row, flag or version), how to make it, what the new
code does with it, and what it should do.
