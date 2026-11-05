import { type ModuleContextSection, ok } from "@cabane/core";
import { questionMarkdown } from "./markdown";
import { Questions } from "./storage";

export const decisionsSection: ModuleContextSection = {
	name: "questions.decisions",
	after: "discussion",
	render: async (basePath, task) => {
		const questions = await Questions.list(basePath, { id: task.id });
		if (!questions.ok) return questions;
		const rows = questions.value.filter((row) => row.status !== "withdrawn");
		return ok(
			rows.length
				? `## Decisions\n\n${rows.map((row) => questionMarkdown(row, true)).join("\n\n")}`
				: null,
		);
	},
};
