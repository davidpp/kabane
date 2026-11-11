import type { KabaneModule } from "@cabane/core";
import { HANDOFF_KIND, HANDOFF_TEMPLATE } from "./template";
import { handoffTools } from "./tools";

/**
 * No table and no section renderer: a handoff is an entry of the kind declared
 * here, and core renders the kind's `latest` projection as `handoff.latest`.
 */
export const handoffModule: KabaneModule = {
	name: "handoff",
	kinds: [
		{
			name: HANDOFF_KIND,
			title: "Handoff",
			template: HANDOFF_TEMPLATE,
			projection: {
				latest: {
					after: "description",
					framing:
						"The author's own account of its work: check the evidence before relying on it.",
				},
			},
		},
	],
	tools: handoffTools,
	instructions:
		"When you finish your part of an issue, hand it off with kabane_handoff before anyone closes it, whatever the work was: a code change, a research note, a design. Show, do not tell: a summary that pictures what was made or changed, and evidence of what you saw rather than what you concluded. Say what you did not verify. The next reader may be another agent or the human, and the brief shows them your latest handoff.",
};
