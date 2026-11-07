import { defineTool, ok, type ToolDef } from "@cabane/core";
import { changeReceipt, editReceipt } from "./markdown";
import { AddSchema, EditSchema, TickSchema } from "./schema";
import { Checklist } from "./storage";

const SHIFT =
	"A handle number can shift after sync brings in an earlier item from another device; each item's line in the brief ends with id:<ULID>, which never does.";

export const checklistTools: readonly ToolDef[] = [
	defineTool({
		name: "kabane_checklistAdd",
		kind: "write",
		description: `Add 1–50 steps to an issue's checklist (short id or ULID), in the order given: at the end, or from a 1-based position. An item is a step of this one change, with no assignee, no state beyond done and no brief; work that needs any of those, or is a separate deliverable, is a subtask (kabane_add with parentTaskId). Returns one line: the issue, its progress (done/total), and each new item's handle (JCAB-12.3) with id:<ULID>. The brief lists the checklist: kabane_context with sections: ["checklist.items"].`,
		input: AddSchema.shape,
		handler: async (args, ctx) => {
			const change = await Checklist.add(ctx.basePath, args);
			return change.ok
				? ok(changeReceipt(change.value, "added", true))
				: change;
		},
	}),
	defineTool({
		name: "kabane_checklistTick",
		kind: "write",
		description: `Tick checklist items of one issue by handle (JCAB-12.3) or ULID; done: false unticks them. An item already in that state is left as it is. Returns one line: the issue, its progress (done/total), and the items. ${SHIFT}`,
		input: TickSchema.shape,
		handler: async (args, ctx) => {
			const change = await Checklist.tick(ctx.basePath, args, ctx.actor);
			return change.ok
				? ok(changeReceipt(change.value, args.done ? "ticked" : "unticked"))
				: change;
		},
	}),
	defineTool({
		name: "kabane_checklistEdit",
		kind: "write",
		description: `Change one checklist item by handle (JCAB-12.3) or ULID: new text, a new 1-based position, or both; or remove: true alone. Handles count every item ever added to the issue, so moving or removing one renumbers none. Returns one line: the issue, its progress (done/total), and what changed. ${SHIFT}`,
		input: EditSchema.innerType().shape,
		handler: async (args, ctx) => {
			const change = await Checklist.edit(ctx.basePath, args);
			return change.ok ? ok(editReceipt(change.value, args)) : change;
		},
	}),
];
