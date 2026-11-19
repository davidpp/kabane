# 0003: An output artifact is a context ref of kind `artifact`

- Status: accepted
- Date: 2026-11-19
- Issue: JCAB-562 (under JCAB-548, "Jobs that reach me")
- Decided by: David, on JCAB-562's four questions (JCAB-562:1-4), 2026-11-19

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
   replicates and renders in the brief's Context section. The kind is what tells a reader "this
   is the thing you maintain". The only change is `contextAdd`'s description, which names both
   what a task reads and what it maintains.
2. **The kind means "kept up to date", on any task kind.** An output an issue produces once (a
   PR, a commit, a research note) is a work-log ref (`kabane_log`: `pr:`, `commit:`, `file:`), as
   today. A handoff stays prose and names what the work log or the Context section points at.
3. **The job preamble stays as it is.** A job whose run maintains an artifact says so in its own
   description, case by case. The run still writes one comment on the job.
4. **No run-to-comment link.** The artifact's own history (git, the doc's versions, the vault's
   `log.md`) is the audit trail. The run id matters only while the run is live; the preamble
   already gives it to the agent, which may quote it in the comment.

## Consequences

- The change is one tool description, and attaching the artifacts of the existing jobs
  (wiki-maintenance, steward). Nothing migrates.
- Whether a run updates its artifact and reports what changed depends on each job's description,
  not on a shared contract. A frontend agent reading "what did my jobs do" gets comments in
  whatever shape each job asked for.
- A `file:` artifact is dereferenced into the brief like any file ref, within the existing caps.
- Listing every job's artifacts is a filter on context refs by kind. A view that needs it builds
  it then.
- A kind is a convention, not a check: a misspelled kind (`Artifact`, `output`) makes a ref an
  input. Add a check only after that happens.
- Undecided: whether the board shows artifacts apart from inputs.

## Alternatives rejected

- A `role` or `direction` column on `task_context_refs`: a core migration to carry what the kind
  already carries, and every other kind is input by definition.
- A separate `artifacts` data module with its own table: it duplicates the registry's URI, kind,
  label, note and upsert to hold the same row.
- Attaching artifacts to runs: a run is throwaway, and its rows live in one extension.
- A refs field on `kabane_handoff`, or the artifact kind for every output: the work log already
  holds what work produced once, and the brief shows it.
- A shared preamble line telling every job run to update its artifact and say what changed: David
  kept the preamble as it is and leaves it to each job's description.
- A structured link from a run's comment to its run: the run is throwaway, and the artifact's
  history already records what changed.
