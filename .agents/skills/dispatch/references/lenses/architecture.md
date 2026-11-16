---
applies: where code lives and what it may reach, such as a new package or workspace dependency, an edit to scripts/layers.ts, code moved between packages, anything under packages/core, the extension contract (packages/extension) or what an extension gets from kabane, a new MCP tool, a new settings namespace, a new table, and an @cabane/* import in extensions/
---

# Architecture lens

Check that the change puts each thing in the layer that should own it and keeps every package
inside what its layer may reach. The rules are in `ARCHITECTURE.md`; read the sections this
diff touches before you judge it. `bun run layers` (part of `bun run check`) already fails a
`package.json` dependency or an import that `scripts/layers.ts` does not allow. This lens is
for what that check cannot see: an edit to the table itself, code in the wrong package, and an
extension surface that differs from the one `ARCHITECTURE.md` specifies.

- List what the diff adds or moves across a package boundary: a package, a workspace
  dependency, a file or export in `packages/core`, a migration, an MCP tool, a field of the
  extension contract, a settings namespace, an `@cabane/*` import under `extensions/`. Take
  it from the diff (`git diff --stat`, then the files), not from the briefs.
- For each, ask the questions below that fit it. Each question checks one rule; a change that
  breaks the rule is a finding.

## Questions

1. **Does every edge added to `scripts/layers.ts` keep the layer order?** For an entry added
   to a package's `dependencies`: is the target in a layer listed before the package's own in
   `ARCHITECTURE.md`'s layer table, never the same layer, and inside the four narrowings under
   it? An entry added to `devDependencies` is a test allowance: check it against the narrowing
   that allows test-only edges (a data module or a client may use the storage adapter in
   tests), not against the order. An added `exceptions` or `relativeImports` entry is a
   forbidden edge the check now lets through: does the brief name it, and does it carry the
   issue that removes it? An edge already listed as an exception, or retagged to another
   issue, is not a new finding.
   ("The layer table is `scripts/layers.ts`, and the gate fails a dependency it does not list")
2. **Does each thing added to `packages/core` pass all four questions?** Is it the record,
   how the record replicates, or a definition every reader goes through? Do two packages in
   different layers, core itself not counted, use it in this diff or on main? Does it run in Workers, with no
   Bun, Node or process call reachable from `packages/core/index.ts` beyond the ones
   `CODING_PRINCIPLE.md` names as never called by the hub? Is kabane the only tool that keeps
   it, or should the record hold a URI to it? Name where a "no" sends it. A subpath export
   keeps a call off the barrel but is no more Workers-safe: something new on one that only a
   device runs is a finding too, and needs naming in the verdict table even when it sits beside
   a file the table lists. Test support is exempt: the `./testing` and `./git-fixture`
   subpaths and the files core's entry in `scripts/layers.ts` lists as `testSupport`.
   ("Core keeps only what passes four questions")
3. **Does a new replicated table go in a data module?** A new table in core's
   `storage/migrations.ts` is a finding unless it changes the task row itself. A first-party
   data module is registered by both hosts, in `MODULES` in `packages/cli/src/context.ts` and
   the module list in `packages/worker/src/hub.ts`. An extension's module registers only on
   devices that enable the extension, and the hub parks its ops.
   ("Every process that opens the database registers the same modules")
4. **When a package was created or split, did its code move with it?** A new package whose
   files re-export another package's code, or whose old copy stays behind, is a finding.
   (the last paragraph of "The layer table is `scripts/layers.ts`...")
5. **Could a second client do what the board now does?** In `packages/board`, does the change
   use only the exports of core, the data modules, the contract and the harness client? An
   import from the CLI or a deep path into another package's files, and SQL against a table
   another package owns, are findings. ("A client uses only what another client could")
6. **Does the contract and `host` match what `ARCHITECTURE.md` specifies?** A field added to
   `Extension` is one of the optional fields listed under "An extension contributes through
   six optional fields", with the shape given there; modules come from the manifest's modules
   entry, not a field. A `host` member is one the `Host` type in "What `host` carries in api 1"
   lists; a member outside it comes with the brief's reason and the change to
   `ARCHITECTURE.md` in the same diff. `store` is scoped to the calling extension's modules,
   and no member hands an extension storage internals (`Planner`, `atomic`, or a `Db` outside
   `host.store`). A contract type that is a component or carries a client's framework (React,
   OpenTUI) is a finding: a second client could not use it. ("Extension API v1", "Ports")
7. **Does every `host.record` operation have an MCP tool behind it?** An operation on
   `host.record` that no tool or tool input offers is a finding; the fix is a new tool or tool
   input. A module's own writes go through `host.store` instead, under question 9.
   ("The record half of `host` is the MCP tools' operations")
8. **Does a new MCP tool live with what it operates on?** A tool over core's record goes in
   `packages/core/mcp/tools.ts`; a tool over a data module's own records goes in that module's
   `tools`; a tool over the device's own configuration belongs to the host
   (`packages/cli/src/config-tools.ts`) and is served over stdio only; an extension's tool is
   named `kabane_<extension>_<verb>`, comes from its `mcp` field, and the hub never serves it.
9. **Does code under `extensions/` take only types from kabane, apart from the harness client
   it bundles?** A new value used from `@cabane/core`, `board`, `checklist` or `extension` is
   new dependence on kabane's internals: every value an extension needs from kabane arrives on
   `host`, and `scripts/layers.ts` refuses a production value import from an extension's
   development dependencies. An extension module writes only the tables it declares and
   changes tasks only through `tx.updateTask`; raw SQL on another package's table is a finding.
   ("The host passes values and the extension imports types only", "An extension's data
   modules get a storage kit")
10. **Is base kabane free of text that describes an extension?** Text that base kabane writes
    in the copilot's instructions, the board, the CLI's help or a shipped template and that
    names the loop or tells the reader to use it is a finding, as a new entry on the existing
    list under "The code breaks these rules today in named places". Kabane showing text an
    extension contributed (its commands' usage, its settings, its procedures) is not.
11. **Is every rule this change states held by something?** A rule added to `ARCHITECTURE.md`,
    `CODING_PRINCIPLE.md` or a package's `AGENTS.md` names its check, or says it is held by
    review. And does every package's `AGENTS.md` still describe its package after this diff,
    including one the diff made stale without editing it?

Rows in the table under "The code breaks these rules today in named places" are not findings
on their own. `bun run layers` fails an exception whose edge is gone, but nothing checks the
table: a diff that removes a named exception and leaves its row there is a finding.

## Severity

- **p1**: a forbidden production edge added to `scripts/layers.ts`, or an exception added
  with no issue that removes it; a new Bun, Node or process call reachable from core's barrel
  beyond the ones `CODING_PRINCIPLE.md` names; a new replicated table in core's migrations; a
  contract type a second client could not use; a `host.record` operation no tool offers.
- **p2**: something placed in a layer that should not own it but cheap to move now (a helper
  with one consumer in core, a device-only export on a core subpath, a board import that only
  the CLI could satisfy); a `host` member or `Extension` field outside what `ARCHITECTURE.md`
  specifies with no change to it; a value code under `extensions/` imports from kabane instead of taking it from `host`; a
  first-party data module registered by one host only; a package's `AGENTS.md` that the
  change made false.
- **p3**: a rule stated with nothing holding it and no sentence saying review holds it; a row
  left in "The code breaks these rules today in named places" after the code stopped breaking
  it.

A finding names the question, the section of `ARCHITECTURE.md` that states the rule, the
`file:line`, and the package or layer the thing belongs in instead.
