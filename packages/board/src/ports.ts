// The two seams a host plugs into the board. The board never learns what a "loop" or a "recipe"
// is: the host projects whatever it runs into flat activity cards, and offers whatever it can start
// on a task as trigger descriptors. Both ports default to no-ops so the board runs standalone with
// no activity strip and a "no dispatcher configured" hint on `a`.
import { ok, type Result } from "@cabane/core";

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

export const noActivity: ActivitySource = {
	load: async () => ok([]),
};

export const noDispatcher: Dispatcher = {
	triggers: async () => ok([]),
	dispatch: async () => ok("no dispatcher configured"),
};

export const isInFlight = (card: ActivityCard): boolean =>
	card.status === "pending" ||
	card.status === "running" ||
	card.status === "paused";
