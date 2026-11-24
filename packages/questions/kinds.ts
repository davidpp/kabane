import type { EntryKind } from "@kabane/core";

/** A question: an entry addressed to the human asked, its body the decision. */
export const ASK_KIND = "questions.ask";
/** An answer: a reply (`re`) to the question, its body the answer. */
export const ANSWER_KIND = "questions.answer";
/** A withdrawal: a reply to the question, with the reasoning and no answer. */
export const WITHDRAW_KIND = "questions.withdraw";

/** The replies that close a question; any other reply leaves it open. */
export const REPLY_KINDS = [ANSWER_KIND, WITHDRAW_KIND] as const;

/**
 * The three kinds, projected `none`: the brief shows questions in the
 * module's own `questions.decisions` section, never in the Discussion.
 */
export const questionKinds: readonly EntryKind[] = [
	{
		name: ASK_KIND,
		title: "Question",
		template: "",
		projection: "none",
		closedBy: [...REPLY_KINDS],
	},
	{ name: ANSWER_KIND, title: "Answer", template: "", projection: "none" },
	{
		name: WITHDRAW_KIND,
		title: "Withdrawn question",
		template: "",
		projection: "none",
	},
];
