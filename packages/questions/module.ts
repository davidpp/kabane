import type { KabaneModule } from "@cabane/core";
import { migrations, QUESTIONS_TABLE } from "./migrations";
import { decisionsSection } from "./section";
import { Questions } from "./storage";
import { questionTools } from "./tools";

export const questionsModule: KabaneModule = {
	name: "questions",
	migrations,
	syncTables: [
		{
			table: QUESTIONS_TABLE,
			family: "row-lww",
			clock: "updated_at",
			childOfTasks: true,
		},
	],
	contextSections: [decisionsSection],
	tools: questionTools,
	onTaskStateChange: Questions.withdrawOnClose,
	instructions:
		"When a decision belongs to the human, file it with kabane_ask (choices, your recommendation, and why) and leave the issue waiting, instead of writing the options into its description. Before acting on an issue that has open questions, read them with kabane_questions.",
};
