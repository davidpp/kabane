import type { KabaneModule } from "@kabane/core";

/**
 * The shipped work kinds (ADR 0012). Always registered by both standard hosts,
 * so their policy holds where the jobs or loop extension is off and on the hub,
 * which loads no extension: a job never lands in a default listing.
 */
export const workModule: KabaneModule = {
	name: "work",
	threadKinds: [
		{
			name: "task",
			label: "Task",
			description: "Personal work: inbox, next, done.",
			initialState: "inbox",
			defaultFor: ["add"],
		},
		{
			name: "issue",
			label: "Issue",
			description: "Work an agent runtime picks up.",
			initialState: "inbox",
			defaultFor: ["apply"],
		},
		{
			// A standing request a schedule runs, not work to pick up. Its schedule and
			// runs belong to the jobs extension.
			name: "job",
			label: "Job",
			description: "A standing request a schedule runs.",
			initialState: "inbox",
			unlisted: true,
		},
	],
	// The run-book lines name issue and its states, so they follow the definitions.
	instructions: `Three kinds of item have a workflow: 'task' is human GTD work (inbox → next → done); 'issue' is work an agent runtime picks up; 'job' is a standing request a schedule runs, which a listing leaves out unless it names kind job. kabane_add with no kind makes a task; a kabane_apply thread with no kind is an issue.
To brainstorm into work: kabane_add with kind issue, a description that is the brief, state next, and assignee set to the runtime (claude, hermes, codex).
To pick up work as a runtime: kabane_list with responseFormat concise, your assignee and state next (follow nextCursor with the same filters), kabane_context on the chosen id, kabane_edit to in_progress with responseFormat concise, then kabane_log and kabane_comment as you go, kabane_done with responseFormat concise at the end. Use kabane_get for full fields; omitted/full formats remain legacy and unbounded.`,
};
