import type { KabaneModule } from "@cabane/core";
import { ITEMS_TABLE, migrations } from "./migrations";
import { itemsSection } from "./section";
import { checklistTools } from "./tools";

export const checklistModule: KabaneModule = {
	name: "checklist",
	migrations,
	syncTables: [
		{
			table: ITEMS_TABLE,
			family: "row-lww",
			clock: "updated_at",
			childOfTasks: true,
		},
	],
	contextSections: [itemsSection],
	tools: checklistTools,
	instructions:
		"Break one change into steps with a checklist: kabane_checklistAdd files them on the issue, kabane_checklistTick ticks each as it lands, and the brief's checklist.items section lists them. An item has no assignee, no state beyond done and no brief. When a piece of work needs any of those, or is a separate deliverable, make it a subtask (kabane_add with parentTaskId) instead of an item.",
};
