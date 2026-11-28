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
		},
		{
			name: "issue",
			label: "Issue",
			description: "Work an agent runtime picks up.",
			initialState: "inbox",
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
	instructions:
		"Three kinds of item have a workflow: 'task' is human GTD work (inbox → next → done); 'issue' is work an agent runtime picks up; 'job' is a standing request a schedule runs, which a listing leaves out unless it names kind job.",
};
