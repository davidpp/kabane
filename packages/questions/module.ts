import type { KabaneModule } from "@kabane/core";
import { questionKinds } from "./kinds";
import { migrations } from "./migrations";
import { decisionsSection } from "./section";
import { Questions } from "./storage";
import { questionTools } from "./tools";

export const questionsModule: KabaneModule = {
	name: "questions",
	migrations,
	// Questions are entries on the record (migration 4), which core replicates.
	syncTables: [],
	kinds: questionKinds,
	contextSections: [decisionsSection],
	tools: questionTools,
	onTaskStateChange: Questions.withdrawOnClose,
	instructions:
		"When a decision belongs to the human, file it with kabane_ask (choices, your recommendation, and why) and leave the issue waiting, instead of writing the options into its description. Before acting on an issue that has open questions, read them with kabane_questions. When you record with kabane_answer a reply the human gave you in this conversation, set relayed: true so the decision is credited to them; never set it for an answer of your own, the recommended one included.",
};
