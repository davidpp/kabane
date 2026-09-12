// The three seams a host plugs into the board. The board never learns what a "loop" or a "recipe"
// is: the host projects whatever it runs into flat activity cards, offers whatever it can start on a
// task as trigger descriptors, and answers the `A` prompt with a copilot that streams updates. All
// three default to no-ops so the board runs standalone with no activity strip, a "no dispatcher
// configured" hint on `a`, and a "no copilot configured" hint on `A`.
import { ok, type Result } from "@cabane/core";
import type { BoardContext } from "./context";

export type ActivityStatus =
	| "pending"
	| "running"
	| "paused"
	| "completed"
	| "failed";

// One in-flight or recent unit of host work, projected for display. `kind` is the sidebar section
// it groups under (the host picks the word: "loops", "runs"); `label` is the short name on the row;
// `detail` lines are joined with ` · ` after the label. A card may reference its task by ULID, by
// shortId (when the host only knows the label), or not at all.
export type ActivityCard = {
	id: string;
	kind: string;
	label: string;
	status: ActivityStatus;
	taskId?: string;
	taskShortId?: string;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	// A running card whose host state stopped updating — rendered without animation, dimmed.
	stale?: boolean;
	detail: string[];
	error?: string;
	// Whether `ActivitySource.events` has anything for this card (enter/`o` opens the event view).
	hasEvents?: boolean;
};

export type ActivityEvent = {
	seq: number;
	at: string;
	type: string;
	summary: string;
};

// The one event type the view draws as a rule rather than as a row: what was ASKED, which opens a
// turn and so separates it from the one before. Shared vocabulary — a host whose cards run more than
// one turn can emit it too.
export const PROMPT_EVENT = "prompt";

export interface ActivitySource {
	// Everything worth showing, newest first, already capped by the host.
	load(): Promise<Result<ActivityCard[]>>;
	// Refresh one card (the event view polls it until terminal). Optional: without it the view
	// shows the card as loaded.
	card?(id: string): Promise<Result<ActivityCard | null>>;
	// Events after `afterSeq`, oldest first. Optional: without it cards never open an event view.
	events?(id: string, afterSeq: number): Promise<Result<ActivityEvent[]>>;
}

export type TriggerInput = {
	type: string;
	required: boolean;
	default?: unknown;
};

// Something the host can start on a task. `satisfiable` is false when the trigger needs inputs the
// board cannot supply; `hint` is what the footer flashes in that case.
export type TriggerDescriptor = {
	id: string;
	label: string;
	description?: string;
	source?: string;
	inputs: Record<string, TriggerInput>;
	satisfiable: boolean;
	hint?: string;
};

export type DispatchTarget = {
	id: string;
	shortId: string;
	title: string;
	// The assembled brief, so a dispatcher can hand the agent exactly what `y` copies.
	brief: string;
};

export interface Dispatcher {
	triggers(taskId: string): Promise<Result<TriggerDescriptor[]>>;
	// Resolves to the footer notice on success.
	dispatch(triggerId: string, target: DispatchTarget): Promise<Result<string>>;
}

// One entry of the agent's own todo list for the turn. The harness owns the wording; the board only
// counts and renders it.
export type PlanEntryStatus = "pending" | "in_progress" | "completed";
export type PlanEntry = { content: string; status: PlanEntryStatus };

// The step kinds that advance a turn, each carrying the line the transcript shows: `text` is the
// agent's prose, `thought` its reasoning, the tool pair its writes (a `tool_result` is what the
// board reloads on), `error` and `done` end the turn.
export type CopilotStep =
	| "text"
	| "thought"
	| "tool_call"
	| "tool_result"
	| "error"
	| "done";

// One choice the harness offers for a permission request: `id` is what an answer names back, `label`
// what the human reads on the numbered row.
export type CopilotPermissionOption = { id: string; label: string };

// The harness stopped mid-turn to ask before doing something, and is BLOCKED until it hears back.
// `id` is unique within the turn; `answerPermission` names it to answer.
export type CopilotPermission = {
	id: string;
	title: string;
	options: readonly CopilotPermissionOption[];
};

// One streamed update of a copilot turn: a step, the turn's plan, or a question the human has to
// answer. A plan is STATE, not a step — the harness re-sends the whole list every time an entry
// moves, so it replaces rather than appends. A permission is neither: it is a turn stopped dead
// until someone answers it, and the board is the only thing that may.
export type CopilotUpdate =
	| { type: CopilotStep; summary: string; at: string }
	| { type: "plan"; entries: readonly PlanEntry[]; at: string }
	| { type: "permission"; request: CopilotPermission; at: string };

// A `/name` the prompt window expands client-side into `template`, so the human reads exactly what
// will be sent before pressing enter. `hint` is the one-line description shown while picking.
export type CopilotShortcut = { name: string; hint: string; template: string };

// The copilot the `A` prompt talks to. `run` streams one turn for a prompt with the board's context
// attached; `cancel` stops the turn in flight; `shortcuts` lists the `/` expansions. The board never
// learns which protocol or harness sits behind it.
export interface Copilot {
	run(
		prompt: string,
		context: BoardContext.Context,
	): AsyncIterable<CopilotUpdate>;
	cancel(): Promise<void>;
	shortcuts(): CopilotShortcut[];
	// Answer a `permission` update: the chosen option's id, or null to decline. Returns nothing and
	// cannot fail — the board has said its piece, and a turn that has meanwhile ended has nobody
	// left to hear it. A request the human never answers simply keeps the turn waiting, which
	// `cancel` is the way out of.
	answerPermission(id: string, optionId: string | null): void;
	// The actor uri this copilot's writes are stamped with, so the board can tell the rows it just
	// changed from the ones the human or another agent did. Absent for a copilot that writes nothing
	// through the tracker — no row then ever matches, which is the truth.
	readonly actor?: string;
}

export const noActivity: ActivitySource = {
	load: async () => ok([]),
};

export const noDispatcher: Dispatcher = {
	triggers: async () => ok([]),
	dispatch: async () => ok("no dispatcher configured"),
};

// A copilot that answers every prompt with the same refusal, for hosts that want an explicit value
// rather than leaving `copilot` undefined (both surface "no copilot configured").
export const noCopilot: Copilot = {
	run: async function* () {
		yield {
			type: "error",
			summary: "no copilot configured",
			at: new Date().toISOString(),
		};
	},
	cancel: async () => {},
	shortcuts: () => [],
	answerPermission: () => {},
};

export const isInFlight = (card: ActivityCard): boolean =>
	card.status === "pending" ||
	card.status === "running" ||
	card.status === "paused";
