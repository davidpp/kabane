# 0003: An artifact is a context ref of kind `artifact`, and a run reports what it changed there

- Status: proposed, awaiting David's choice on JCAB-562
- Date: 2026-11-18
- Issue: JCAB-562 (under JCAB-548, "Jobs that reach me")
- Decided by: not yet. This draft is an agent's recommendation.

## Context

David, 2026-11-18: a run is throwaway, and its transcript stays in the harness and hc. What a job
keeps updating (a Claude artifact, a doc, a repo, a vault folder) belongs to the job. Context is
the input, an artifact is the output. A frontend agent answering "what did my jobs do" reads each
job's artifacts and its latest run comment (JCAB-548).

What exists: `kabane_contextAdd` (`packages/core/mcp/tools.ts`, `contextAdd`) attaches a URI
with a soft `kind` to any task, jobs included, and its description calls a ref "the input side".
`task_context_refs` (`packages/core/db/schema.ts`) has no direction column. The work log holds
append-only refs to what work produced (`commit:`, `pr:`, `branch:`, `file:`). Runs are rows in
the recipes extension (`extensions/recipes/src/runs.ts`) with no record attached, and the job
preamble (`extensions/recipes/src/run-command.ts`, `preamble`) asks for one comment on the job.
Wiki-maintenance (JSEC-1) and steward (JCAB-546) already maintain outputs that nothing names.

Constraints: kabane points at an artifact and never stores its contents (ADR 0002). It works
across harnesses. No speculative fields.

## Decision

1. **An artifact is a context ref with `kind: "artifact"`.** No table, no column, no module. The
   registry already holds one URI per task with a soft kind, upserts on `(task_id, uri)`,
   replicates and renders in the brief's Context section. What the brief needs to tell a reader
   is "this is the thing you maintain", and the kind says it. `contextAdd`'s description changes
   from "the input side" to name both: what the task reads, and what it maintains (`artifact`).
2. **It applies to any task kind, but the work log stays where one-off outputs go.** An artifact
   is something kept up to date across runs or sessions. A PR, a commit or a research note an
   issue produced once is a work-log ref (`kabane_log`), as today. A handoff stays prose and
   names what the work log or the Context section already points at; it gets no refs field.
3. **The job preamble gains one line:** if the job's context lists an artifact, it is what this
   job maintains; update it there, and in the comment say which artifact changed and what
   changed. The run still writes one comment on the job.
4. **No run-to-comment link.** The artifact's own history (git, the doc's versions, the vault's
   `log.md`) is the audit trail. The run id matters while the run is live, and the preamble's
   first line already gives it to the agent, which may quote it in the comment.

## Consequences

- The change is a tool description, one preamble line, and attaching the artifacts of the two
  existing jobs. Nothing migrates.
- A `file:` artifact is dereferenced into the brief like any file ref, within the existing caps.
  A run reading what it maintains is useful; a large file is cut to a head by the caps.
- "List every job's artifacts" is a filter on context refs by kind. A view that needs it builds
  it then.
- A kind is a convention, not a check: a typo (`Artifact`, `output`) makes a ref an input. Add
  a check only after that happens.
- Undecided: whether the board shows artifacts apart from inputs.

## Alternatives rejected

- A `role` or `direction` column on `task_context_refs`: a core migration to carry what the kind
  already carries, and every other kind is input by definition.
- A separate `artifacts` data module with its own table: it duplicates the registry's URI, kind,
  label, note and upsert to hold the same row.
- Attaching artifacts to runs: a run is throwaway, and its rows live in one extension.
- A refs field on `kabane_handoff`: the work log already holds produced refs, and the brief
  shows both.
