import type { KabaneModule } from "@kabane/core";

/** The session outcomes kept on the issue's timeline. Handoffs have their own module. */
export const OUTCOME_KINDS = {
	decision: "outcome.decision",
	finding: "outcome.finding",
	verification: "outcome.verification",
	summary: "outcome.summary",
} as const;

/** No table, migration, tool or section renderer: core stores and renders these entries. */
export const outcomeModule: KabaneModule = {
	name: "outcome",
	kinds: [
		{
			name: OUTCOME_KINDS.decision,
			title: "Decision",
			template:
				"The question that was asked, then → and the choice, and who chose.",
			projection: "discussion",
		},
		{
			name: OUTCOME_KINDS.finding,
			title: "Finding",
			template:
				"What was found and where, with its severity (P1, P2 or P3) when it has one.",
			projection: "discussion",
		},
		{
			name: OUTCOME_KINDS.verification,
			title: "Verification",
			template: "What was checked, how, and what it showed.",
			projection: "discussion",
		},
		{
			name: OUTCOME_KINDS.summary,
			title: "Session summary",
			template:
				"The session's final message: what it did and where it stopped.",
			projection: "discussion",
		},
	],
};
