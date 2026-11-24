# An ADR records why a lasting decision was made

An architecture decision record is one page: a decision, the situation it was made in, and what
follows from it. It is written for the person who asks "why is it like this?" months later.

## Write one when someone will ask why

Write an ADR for a lasting trade-off: the shape of a contract or a schema, a package boundary, a
choice between two reasonable designs, or a decision David made against the obvious path. Scale
by consequence. A bug fix, a rename, a routine implementation choice, or anything the code and
its checks already state gets none.

## Three rules keep them honest

1. **An ADR says why, and never copies what code or a check states.** `ARCHITECTURE.md` tells how
   kabane's predecessor wrote its layer table in an ADR and in its architecture file, and the two
   disagreed ten days later. Name the file or the check and let it say what is true today.
2. **An accepted ADR is not edited to change its decision.** Write a new ADR, and change the old
   one's status to `superseded by NNNN`. Fixing a typo or a dead link is fine.
3. **An ADR says who decided.** David, or an agent while he was away. An agent's assumption does
   not become a permanent rule because it was written down here.

## Files are numbered in order and never renumbered

Copy `0000-template.md` to `NNNN-kebab-title.md` with the next free number, and add its line to
the index below. Aim for a page. A decision that needs more is a design record in `wiki/`, and
the ADR links to it.

An issue that relies on an ADR attaches it with `kabane_contextAdd` (kind `ADR`, a `file:`
reference), which puts the ADR in the implementer's brief.

## Index

- [0001](0001-job-is-a-core-kind-scheduled-by-recipes.md): A job is a core item kind; its
  schedule and commands live in the recipes extension. Accepted.
- [0002](0002-what-kabane-owns-for-long-running-agents.md): For long-running agents, kabane
  owns the record and the schedule, and points to other tools for the rest. Accepted.
- [0003](0003-an-artifact-is-a-context-ref-of-kind-artifact.md): An output artifact is a
  context ref of kind `artifact`. Accepted.
- [0004](0004-extension-how-to-ships-as-skills-served-by-kabane-mcp.md): An extension ships
  how-to as skills that `kabane mcp` serves through two tools; the copilot's instructions carry
  only state, identity and boundaries. Accepted.
- [0005](0005-releases-ship-on-github-not-npm.md): Releases ship on GitHub only, from one
  dispatch; nothing is published to npm. Accepted.
- [0006](0006-the-record-is-threads-entries-attributes-links-and-refs.md): Core's record is
  four tables (thread, entry, attribute, ref) with open kinds and keys, so a new need adds
  data and leaves core's schema alone. Proposed, not decided.
- [0007](0007-agents-wait-on-conditions-and-the-tick-runs-reactions.md): An agent waits on a
  condition over the record, and the tick runs a command when one becomes true. Proposed, not
  decided; it would supersede 0002.
- [0008](0008-sqlite-stays-the-source-and-a-folder-carries-ops.md): SQLite stays each device's
  source of truth; a shared folder may carry sync ops, one append-only file per device, once sync
  converges without the hub's order. Accepted (David, 2026-11-24).
