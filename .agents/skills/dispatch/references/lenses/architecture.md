---
applies: where code lives and what it may reach, such as a new package or workspace dependency, an edit to scripts/layers.ts, code moved between packages, anything under packages/core, the extension contract (packages/extension) or what an extension gets from kabane, a new MCP tool, a new settings namespace, a new table, and an @cabane/* import in extensions/
---

# Architecture lens

Check that the change puts each thing in the layer that should own it and keeps every package
inside what its layer may reach. The rules are in `ARCHITECTURE.md`; read the sections this
diff touches before you judge it. `bun run layers` (part of `bun run check`) already fails a
`package.json` dependency or an import that `scripts/layers.ts` does not allow. This lens is
for what that check cannot see: an edit to the table itself, code in the wrong package, and a
surface that grew for one consumer.

- List what the diff adds or moves across a package boundary: a package, a workspace
  dependency, a file or export in `packages/core`, a migration, an MCP tool, a field of the
  extension contract, a settings namespace, an `@cabane/*` import under `extensions/`. Take
  it from the diff (`git diff --stat`, then the files), not from the briefs.
- For each, ask the questions below that fit it. A question answered "no" is a finding.

## Questions

1. **Did the diff edit `scripts/layers.ts`?** For each edge it added, is the target in a
   layer listed before the package's own in `ARCHITECTURE.md`'s layer table, never the same
   layer, and inside the four narrowings under it? An added `exceptions` or `relativeImports`
   entry is a forbidden edge the check now lets through: does the brief name it, and does it
   carry the issue that removes it?
   ("The layer table is `scripts/layers.ts`, and the gate fails a dependency it does not list")
2. **Does each thing added to `packages/core` pass all four questions?** Is it the record,
   how the record replicates, or a definition every reader goes through? Do two packages in
   different layers use it in this diff or on main, not one? Does it run in Workers, with no
   Bun, Node or process call reachable from `packages/core/index.ts`? Is kabane the only
   tool that keeps it, or should the record hold a URI to it? Name where a "no" sends it.
   A subpath export (`@cabane/core/scope`, `@cabane/core/self`) keeps a call off the barrel
   but is no more Workers-safe, and `ARCHITECTURE.md` already sends both to the host
   (JCAB-328): something new there that only a device runs is a finding too.
   ("Core keeps only what passes four questions")
3. **Does a new replicated table go in a data module?** A new table in core's
   `storage/migrations.ts` is a finding unless it changes the task row itself. A data module
   registered by one host and not the other (`MODULES` in `packages/cli/src/context.ts`, the
   module list in `packages/worker/src/hub.ts`) is a finding unless the brief says why.
4. **When a package was created or split, did its code move with it?** A new package whose
   files re-export another package's code, or whose old copy stays behind, is a finding.
   (the last paragraph of "The layer table is `scripts/layers.ts`...")
5. **Could a second client do what the board now does?** In `packages/board`, does the change
   use only the exports of core, the data modules, the contract and the harness client? An
   import from the CLI or a deep path into another package's files, and SQL against a table
   another package owns, are findings. ("A client uses only what another client could")
6. **Does the contract or `host` grow only for something an extension cannot do itself?** For
   each field added to `packages/extension` or member planned for `host`: does kabane itself
   act on it, or only one extension (look on main and in the parent's other briefs for the
   consumer before calling it one)? Can only the host see it (the device config, the
   process, the runtime it configured)? Could an extension not do it correctly with the
   tools and `host` members it already has, even with care? A member only one extension
   needs, or one that hands out storage internals (`Planner`, `atomic`, `Db` outside
   `host.store`), is a finding. A contract type that is a component or carries a client's
   framework (React, OpenTUI) is a finding: a second client could not use it.
   ("Extension API v1", "Ports")
7. **Does every new `host.record` operation, or record operation an extension calls, have an
   MCP tool behind it?** An operation an agent cannot perform through a tool is a finding;
   the fix is a new tool or tool input. ("The record half of `host` is the MCP tools'
   operations")
8. **Does a new MCP tool live with what it operates on?** A tool over core's record goes in
   `packages/core/mcp/tools.ts`; a feature's tool goes in its data module's `tools`; an
   extension's tool is named `kabane_<extension>_<verb>` and is never served by the hub.
9. **Does code under `extensions/` take only types from kabane, apart from the harness client
   it bundles?** A new value import from `@cabane/core`, `board`, `checklist` or `extension`
   adds to what JCAB-326 removes, even though the named exception keeps the check green. An
   extension module's raw SQL on a table it does not declare is a finding.
   ("The host passes values and the extension imports types only", "An extension's data
   modules get a storage kit")
10. **Does base kabane now describe an extension?** Text in the copilot's instructions, the
    board, the CLI's help or a shipped template that names the loop or tells the reader to
    use it is a finding, as a new entry on the existing list under "The code breaks these
    rules today in named places".
11. **Is every rule this change states held by something?** A rule added to `ARCHITECTURE.md`,
    `CODING_PRINCIPLE.md` or a package's `AGENTS.md` names its check, or says it is held by
    review. And does every package's `AGENTS.md` still describe its package after this diff,
    including one the diff made stale without editing it?

Rows in the table under "The code breaks these rules today in named places" are not findings
on their own. `bun run layers` fails an exception whose edge is gone, but nothing checks the
table: a diff that removes a named exception and leaves its row there is a finding.

## Severity

- **p1**: a forbidden edge added to `scripts/layers.ts`, or an exception added with no issue
  that removes it; a Bun, Node or process call reachable from core's barrel; a new replicated
  table in core's migrations; a contract type a second client could not use; a record
  operation an extension can do that no tool offers.
- **p2**: something placed in a layer that should not own it but cheap to move now (a helper
  with one consumer in core, a device-only export on a core subpath, a member on `host` for one extension, a board import that only
  the CLI could satisfy); a new value import under `extensions/` that widens JCAB-326; a data
  module registered by one host only; a package's `AGENTS.md` that the change made false.
- **p3**: a rule stated with nothing holding it and no sentence saying review holds it; a row
  left in "The code breaks these rules today in named places" after the code stopped breaking
  it.

A finding names the question, the section of `ARCHITECTURE.md` that states the rule, the
`file:line`, and the package or layer the thing belongs in instead.
