import { type ModuleContextSection, ok } from "@cabane/core";
import { checklistMarkdown } from "./markdown";
import { Checklist } from "./storage";

export const itemsSection: ModuleContextSection = {
	name: "checklist.items",
	after: "description",
	render: async (basePath, task) => {
		const items = await Checklist.list(basePath, task.id);
		return items.ok ? ok(checklistMarkdown(items.value)) : items;
	},
};
