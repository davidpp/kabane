// Made-up props the render tests and the gallery's stories share, so a component is drawn from the
// same data in both: what a test pins is what David looks at.
import { TASK_STATE_DISPLAY, type Task } from "@cabane/core";
import type { BoardData } from "../data";
import type { BoardNav } from "../nav";
import type { ActivityCard, CopilotElicitation } from "../ports";
import type { BoardTabs } from "../tabs";

export namespace Fixtures {
	/** A described single choice with an `Other` text field behind it, as claude-agent-acp sends one. */
	export const STORE: CopilotElicitation = {
		id: "form-1",
		message: "Which store should the cache use for the session tokens?",
		fields: [
			{
				key: "question_0",
				title: "Store",
				required: false,
				type: "choice",
				options: [
					{
						value: "Redis",
						label: "Redis",
						description: "Shared, survives restarts",
					},
					{ value: "Memory", label: "Memory" },
				],
			},
			{
				key: "question_0_custom",
				title: "Other",
				required: false,
				type: "text",
			},
		],
	};

	/** The same question with bare labels: no descriptions, nothing behind it. */
	export const UNDESCRIBED: CopilotElicitation = {
		...STORE,
		fields: [
			{
				key: "question_0",
				title: "Store",
				required: true,
				type: "choice",
				options: [
					{ value: "Redis", label: "Redis" },
					{ value: "Memory", label: "Memory" },
				],
			},
		],
	};

	export const TAGS: CopilotElicitation = {
		id: "form-2",
		message: "Which tags apply?",
		fields: [
			{
				key: "tags",
				title: "Tags",
				required: true,
				type: "choices",
				options: [
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
					{ value: "c", label: "Gamma" },
				],
			},
		],
	};

	/** A described choice whose message and descriptions wrap at 80 columns. */
	export const DELIVERY: CopilotElicitation = {
		id: "form-3",
		message:
			"Which delivery contract should the runner hold to when a harness drops its session?",
		fields: [
			{
				key: "delivery",
				title: "Delivery",
				required: true,
				type: "choice",
				options: [
					{
						value: "most",
						label: "At most once",
						description: "Drop the turn and report it failed",
					},
					{
						value: "least",
						label: "At least once",
						description: "Replay the turn from its last checkpoint",
					},
					{ value: "ask", label: "Ask the human" },
				],
			},
		],
	};

	export const SLUG: CopilotElicitation = {
		id: "form-4",
		message: "What should the new scope be called?",
		fields: [
			{
				key: "slug",
				title: "Slug",
				description: "Lowercase letters, used in every issue id",
				required: true,
				type: "text",
				maxLength: 12,
			},
		],
	};

	export const PERMISSION: BoardNav.CopilotAsk = {
		type: "permission",
		request: {
			id: "p1",
			title: "kabane_edit JREP-1",
			options: [
				{ id: "once", label: "Allow once" },
				{ id: "always", label: "Allow always" },
				{ id: "no", label: "Reject" },
			],
		},
	};

	/** The copilot before its first prompt: nothing typed, nothing asked. */
	export const copilot = (
		over: Partial<BoardNav.CopilotState> = {},
	): BoardNav.CopilotState => ({
		text: "",
		paletteAt: 0,
		history: [],
		historyAt: 0,
		turn: "idle",
		hasLog: false,
		shortcuts: [],
		commands: [],
		actor: null,
		asks: [],
		...over,
	});

	export const task = (over: Partial<Task> = {}): Task => ({
		id: "01H000000000000000000000AA",
		shortId: "JAKE-42",
		title: "Wire the board",
		kind: "issue",
		state: "next",
		priority: "high",
		provenance: { source: "human", discoveredAt: new Date().toISOString() },
		needsReview: false,
		tags: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...over,
	});

	export const section = (
		state: BoardData.SectionState,
		rows: BoardData.BoardRow[],
	): BoardData.BoardSection => ({
		state,
		label: TASK_STATE_DISPLAY[state].label,
		rows,
	});

	/** A loop's finished card with a tab of its own, numbered `n`. */
	export const loop = (n: number): ActivityCard => ({
		id: `loop:r${n}`,
		kind: "loops",
		label: "loop",
		status: "completed",
		taskShortId: `JREP-${n}`,
		startedAt: `2026-10-10T00:0${n}:00.000Z`,
		detail: [],
		hasEvents: true,
		tab: true,
		sessionIds: [`s${n}`],
	});

	/** A session's question about JREP-`n`; no choices makes it a freeform one. */
	export const question = (
		n: number,
		choices: string[],
	): BoardTabs.Question => ({
		taskId: `t${n}`,
		taskShortId: `JREP-${n}`,
		sessionId: "s1",
		questionActivityId: `q${n}`,
		question: `Install dependencies ${n}?`,
		choices,
		multiSelect: false,
		allowFreeform: choices.length === 0,
		agent: "claude",
		askedAt: `2026-10-10T00:0${n}:00.000Z`,
	});
}
