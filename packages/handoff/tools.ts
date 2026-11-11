import {
	authorTypeOf,
	defineTool,
	err,
	ok,
	Planner,
	type Result,
	type Task,
	type TaskEntry,
	type ToolDef,
} from "@cabane/core";
import { z } from "zod";
import { COMPACT_TEMPLATE, HANDOFF_KIND } from "./template";

/** A recorded handoff: the entry, the issue's label, and how many handoffs came before it. */
export type HandedOff = { entry: TaskEntry; label: string; earlier: number };

/** The task `id` names, short id or ULID; an error when there is none. */
export const findIssue = async (
	basePath: string,
	id: string,
): Promise<Result<Task>> => {
	const resolved = await Planner.resolveTaskId(basePath, id);
	if (!resolved.ok) return resolved;
	const task = await Planner.getTask(basePath, resolved.value);
	if (!task.ok) return task;
	return task.value ? ok(task.value) : err(new Error("No task has that ULID."));
};

/**
 * Record a handoff on an issue as an entry of kind `handoff` by `actor`. The body is
 * stored as given, trailing whitespace aside, and never checked against the template.
 * Nothing else on the issue changes: handing off is not closing.
 */
export const handOff = async (
	basePath: string,
	{ id, body }: { id: string; body: string },
	actor: string,
): Promise<Result<HandedOff>> => {
	const content = body.trimEnd();
	if (!content.trim())
		return err(
			new Error(
				"A handoff needs a body: markdown under Summary, Evidence, Not verified and Risk, or the headings the work needs.",
			),
		);
	const task = await findIssue(basePath, id);
	if (!task.ok) return task;
	const entry = await Planner.addEntry(basePath, {
		taskId: task.value.id,
		kind: HANDOFF_KIND,
		author: actor,
		authorType: authorTypeOf(actor),
		content,
	});
	if (!entry.ok) return entry;
	const all = await Planner.getEntries(basePath, task.value.id, {
		kind: HANDOFF_KIND,
	});
	if (!all.ok) return all;
	return ok({
		entry: entry.value,
		label: task.value.shortId ?? task.value.id,
		earlier: all.value.length - 1,
	});
};

/** The one line every surface answers a handoff with. */
export const handoffReceipt = ({ label, earlier }: HandedOff): string =>
	`${label} handed off · ${earlier} earlier on record`;

export const handoffTools: readonly ToolDef[] = [
	defineTool({
		name: "kabane_handoff",
		kind: "write",
		description: `Hand off your part of an issue (short id or ULID) to whoever reads next, another agent or the human, whatever the work was: a code change, a research note, a design. Show, do not tell. body is markdown under these headings, each holding what its line says:
${COMPACT_TEMPLATE}
A summary can be a sketch of the diff for a code change, three findings for a research note, the states of a screen for a design. Drop a heading that does not apply and add one the work needs: nothing checks the body. Handing off is not closing: it adds an entry and leaves the issue's state and review flag as they are. Every call adds one; the brief (kabane_context, section handoff.latest) shows the latest under the description and counts the earlier ones. Returns one line: JCAB-12 handed off · 2 earlier on record.`,
		input: {
			id: z
				.string()
				.min(1)
				.describe("Task id: the short label (JCAB-12) or the ULID."),
			body: z
				.string()
				.describe("Markdown: the handoff, under the headings above."),
		},
		handler: async (args, ctx) => {
			const handed = await handOff(ctx.basePath, args, ctx.actor);
			return handed.ok ? ok(handoffReceipt(handed.value)) : handed;
		},
	}),
];
