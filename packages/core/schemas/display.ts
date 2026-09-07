/**
 * Display Configuration
 *
 * Label and color configs for task enums.
 * Uses `satisfies` to ensure completeness when schemas change.
 *
 * This is the single source of truth for display properties.
 * Dashboard imports these and adds icons (React dependency stays there).
 */

import type { CONTEXT_REF_KINDS } from "./context-ref";
import type { ProposalAction } from "./proposal";
import type { ACTIVITY_TYPES, SESSION_STATES } from "./session";
import type { TaskPriority, TaskSource, TaskState } from "./task";

export type DisplayConfig = {
	label: string;
	color: string;
	bgColor?: string;
};

export const TASK_STATE_DISPLAY = {
	inbox: { label: "Inbox", color: "text-gray-400", bgColor: "bg-gray-400/10" },
	next: { label: "Next", color: "text-blue-500", bgColor: "bg-blue-500/10" },
	in_progress: {
		label: "In Progress",
		color: "text-yellow-500",
		bgColor: "bg-yellow-500/10",
	},
	waiting: {
		label: "Waiting",
		color: "text-purple-500",
		bgColor: "bg-purple-500/10",
	},
	someday: {
		label: "Someday",
		color: "text-gray-500",
		bgColor: "bg-gray-500/10",
	},
	done: { label: "Done", color: "text-green-500", bgColor: "bg-green-500/10" },
	cancelled: {
		label: "Cancelled",
		color: "text-red-500",
		bgColor: "bg-red-500/10",
	},
} satisfies Record<TaskState, DisplayConfig>;

export const TASK_PRIORITY_DISPLAY = {
	urgent: { label: "Urgent", color: "text-red-500", bgColor: "bg-red-500/10" },
	high: {
		label: "High",
		color: "text-orange-500",
		bgColor: "bg-orange-500/10",
	},
	normal: {
		label: "Normal",
		color: "text-gray-400",
		bgColor: "bg-gray-400/10",
	},
	low: { label: "Low", color: "text-gray-500", bgColor: "bg-gray-500/10" },
} satisfies Record<TaskPriority, DisplayConfig>;

export const TASK_SOURCE_DISPLAY = {
	human: { label: "Human", color: "text-blue-400" },
	ai: { label: "AI", color: "text-purple-400" },
	linear: { label: "Linear", color: "text-indigo-400" },
	github: { label: "GitHub", color: "text-gray-400" },
	email: { label: "Email", color: "text-yellow-400" },
	calendar: { label: "Calendar", color: "text-green-400" },
	meeting: { label: "Meeting", color: "text-pink-400" },
	session: { label: "Session", color: "text-cyan-400" },
	prd: { label: "PRD", color: "text-orange-400" },
	intelligence: { label: "Intelligence", color: "text-emerald-400" },
	other: { label: "Other", color: "text-gray-500" },
} satisfies Record<TaskSource, DisplayConfig>;

/**
 * Display config for context ref kinds. Covers the suggested CONTEXT_REF_KINDS;
 * `kind` is a soft string, so consumers must fall back for unknown kinds.
 */
export const CONTEXT_KIND_DISPLAY = {
	PRD: { label: "PRD", color: "text-orange-400" },
	ADR: { label: "ADR", color: "text-purple-400" },
	research: { label: "Research", color: "text-cyan-400" },
	exemplar: { label: "Exemplar", color: "text-green-400" },
	transcript: { label: "Transcript", color: "text-pink-400" },
	design: { label: "Design", color: "text-blue-400" },
	spec: { label: "Spec", color: "text-indigo-400" },
	doc: { label: "Doc", color: "text-gray-400" },
} satisfies Record<(typeof CONTEXT_REF_KINDS)[number], DisplayConfig>;

/**
 * Display config for agent session states. Covers well-known SESSION_STATES;
 * `state` is a soft string, so consumers must fall back for unknown states.
 */
export const AGENT_SESSION_STATE_DISPLAY = {
	pending: {
		label: "Pending",
		color: "text-gray-400",
		bgColor: "bg-gray-400/10",
	},
	active: {
		label: "Active",
		color: "text-yellow-500",
		bgColor: "bg-yellow-500/10",
	},
	awaiting_input: {
		label: "Awaiting Input",
		color: "text-purple-500",
		bgColor: "bg-purple-500/10",
	},
	complete: {
		label: "Complete",
		color: "text-green-500",
		bgColor: "bg-green-500/10",
	},
	error: { label: "Error", color: "text-red-500", bgColor: "bg-red-500/10" },
	stale: { label: "Stale", color: "text-gray-500", bgColor: "bg-gray-500/10" },
} satisfies Record<(typeof SESSION_STATES)[number], DisplayConfig>;

/**
 * Display config for agent activity types. Covers well-known ACTIVITY_TYPES;
 * `type` is a soft string, so consumers must fall back for unknown types.
 */
export const AGENT_ACTIVITY_TYPE_DISPLAY = {
	progress: { label: "Progress", color: "text-gray-400" },
	action: { label: "Action", color: "text-blue-400" },
	finding: { label: "Finding", color: "text-orange-400" },
	verification: { label: "Verification", color: "text-cyan-400" },
	decision: { label: "Decision", color: "text-indigo-400" },
	handoff: { label: "Handoff", color: "text-pink-400" },
	response: { label: "Response", color: "text-green-400" },
	error: { label: "Error", color: "text-red-400" },
	question: { label: "Question", color: "text-purple-400" },
} satisfies Record<(typeof ACTIVITY_TYPES)[number], DisplayConfig>;

export const PROPOSAL_ACTION_DISPLAY = {
	ask_question: { label: "Question", color: "text-cyan-500" },
} satisfies Record<ProposalAction, DisplayConfig>;
