/** Extension-facing board ports, produced by extensions and read by clients and the host. */

import type { Result } from "@kabane/core";

// `unreported` is in flight, but the host has no word on whether the work is running or waiting, so
// the board draws it neither with a spinner nor as paused.
export type ActivityStatus =
	| "pending"
	| "running"
	| "paused"
	| "unreported"
	| "completed"
	| "stopped"
	| "failed";

// One in-flight or recent unit of host work, projected for display. `kind` is what the header strip
// counts it as (the host picks the word: "loops", "runs"); `label` is the short name on the row;
// `detail` lines are joined with ` · ` after the label. A card may reference its task by ULID, by
// shortId (when the host only knows the label), or not at all.
// `stopped` is over, like `completed` and `failed`, but neither: the work was halted on purpose (a
// human, a budget) before it finished. Why goes in `error`.
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
	// Whether `ActivitySource.events` has anything for this card (`o` opens the event view).
	hasEvents?: boolean;
	// Show this card as a tab of its own beside the tracker. A finished card keeps its tab until the
	// human closes it with `w`.
	tab?: boolean;
	// Named streams inside the card (one per agent session, say), in a stable order: on the card's
	// tab `h/l` pick one, and every line of the all-lanes stream is tagged with its lane in a color
	// that stays the lane's. Append, never reorder: a lane's place is its color.
	lanes?: readonly string[];
	// What the lanes are, for the first chip (`all agents · live`). "lanes" when absent.
	laneNoun?: string;
	// The lanes an action aimed at a lane can still go to, the one to aim at first leading (the most
	// recently started, say). On the all-lanes view such an action goes to the only one, or opens its
	// prompt on the first with `tab` walking the rest. Absent, every lane is taken as one.
	liveLanes?: readonly string[];
	// Keys the human can press on the card's tab, run through `ActivitySource.act`. The host lists
	// what makes sense now (no `stop` on a card that is over).
	actions?: readonly CardAction[];
	// The work's steps in the order they run, the ones still to come included: the card's tab draws
	// them as a map with a cursor in place of its lane chips. Absent, the tab keeps its stream.
	steps?: readonly ActivityStep[];
	// What the work left for the human once it is over: issues to look at, with how each was left
	// and why. Absent or empty, nothing was left.
	left?: readonly ActivityLeft[];
	// What the work runs with, in words (its limits and settings, `slots` `1/2`), for where the
	// human asks for more: the board lists them on the card tab's `?` sheet.
	facts?: readonly ActivityFact[];
};

export type ActivityFact = { label: string; value: string };

// Where a step or one of its sessions stands. `stopped` is over without finishing, as on a card.
export type ActivityStepState =
	| "pending"
	| "running"
	| "done"
	| "failed"
	| "stopped";

// One step of a card's work. `result` is one line in the host's words, whole parts joined with
// ` · ` so a narrow row can drop the tail ones. Time is `startedAt` while it runs (the client counts
// it) and `durationMs` once it is over, so the card does not change every second.
export type ActivityStep = {
	name: string;
	state: ActivityStepState;
	result?: string;
	startedAt?: string;
	durationMs?: number;
	// The sessions the step ran or will run, in order. `lane` names the card lane that holds a
	// session's events; a session still to come has none.
	sessions?: readonly ActivitySession[];
};

export type ActivitySession = {
	name: string;
	state: ActivityStepState;
	lane?: string;
	result?: string;
	startedAt?: string;
	durationMs?: number;
};

// One thing the work left for the human: an issue (`taskId` or `taskShortId`) or, with neither, a
// line of its own. `how` is how it was left (`reopened by functional`), `reason` a one-line why.
export type ActivityLeft = {
	taskId?: string;
	taskShortId?: string;
	how: string;
	reason?: string;
};

// The action `x` runs on a card's tab: the board reserves `x` for stopping, as on the copilot's
// transcript, so a host offers stop under this id and no other action can take the key.
export type StopAction = "stop";

// One key on a card's tab. `input` is the placeholder of the prompt the board opens first (the
// copilot's own input), whose text goes to `act`; `lane` says the action is aimed at one lane: the
// one on screen, else one of the card's `liveLanes`. A key the board answers on a card's tab is never
// offered.
export type CardAction = {
	id: string;
	key: string;
	label: string;
	input?: string;
	lane?: boolean;
};

// A host describes its card header; the board owns polling, colors and one-row layout.
// Width is the room inside the board's one-column padding on each side.
export type HeaderView = { width: number; expanded: boolean };
export type HeaderPart =
	| PanelPart
	| { text: string; series: number; bold?: boolean };
export type Header = (
	card: ActivityCard,
	view: HeaderView,
) => Promise<Result<readonly (readonly HeaderPart[])[]>>;

// One file a tool call changed, as the harness reported it: the whole text before (absent for a file
// it created) and after. The board makes the patch.
export type ActivityDiff = { path: string; oldText?: string; newText: string };

// What a tool call was given and gave back, for its row opened. Text, already capped by the host:
// the board shows the head of the input and the tail of the output, and never asks for more.
export type ActivityToolDetail = {
	// The harness's word for the call (ACP's `read`, `edit`, `search`, `execute`, `fetch`): a run
	// of reads and searches folds into one row.
	kind?: string;
	input?: string;
	output?: string;
	diffs?: readonly ActivityDiff[];
};

// How much a notice matters: the event view draws a warning in the accent and an error in the
// failed hue, and information muted.
export type NoticeSeverity = "info" | "warning" | "error";

export type ActivityEvent = {
	seq: number;
	at: string;
	type: string;
	summary: string;
	// A `notice` event's severity. Absent, a notice written as `<severity>: <text>` is read by its
	// prefix, which is how the loop's runs on disk carry it.
	severity?: NoticeSeverity;
	// Which of the card's `lanes` this event belongs to; absent, it shows under every lane.
	lane?: string;
	// Include this event in the card's run-wide activity, including when it belongs to a lane.
	run?: true;
	// Earlier event sequence numbers already shown in this row's summary or detail. A transcript
	// displays those events on their own until this row arrives.
	includes?: readonly number[];
	// The tool call this event belongs to, unique within its lane: a call and its end carry the same
	// id and read as one row. Without one, an end pairs with the open call of the same summary.
	callId?: string;
	// The call as known when this event was written. A later event of the call replaces each field
	// it carries.
	detail?: ActivityToolDetail;
};

export type ActivityQuestion = {
	// The host's question id, named by `answer`.
	id: string;
	// The card that owns this question, in the same source's card id space.
	cardId: string;
	// The owning card's lane to show when the question is opened.
	lane?: string;
	// Optional task identities; with neither, a question can be placed only through its card.
	taskId?: string;
	// The task's short label; a client may resolve it when `taskId` is absent.
	taskShortId?: string;
	// The question as shown to the human, already parsed by its owner.
	question: string;
	// Choice labels in display order, also used to answer.
	choices: readonly string[];
	// Whether several choices may be selected together.
	multiSelect: boolean;
	// Whether the human may send free text besides the choices.
	allowFreeform: boolean;
	// Whether this asks permission to run a tool.
	permission?: boolean;
	// The displayed name of whoever asked.
	asker: string;
	// When it was asked, as an ISO timestamp; clients order the queue oldest first.
	askedAt: string;
};

export interface ActivitySource {
	// Everything worth showing, newest first, already capped by the host.
	load(): Promise<Result<ActivityCard[]>>;
	// Refresh one card (the event view polls it until terminal). Optional: without it the view
	// shows the card as loaded.
	card?(id: string): Promise<Result<ActivityCard | null>>;
	// Events after `afterSeq`, oldest first. Optional: without it cards never open an event view.
	events?(id: string, afterSeq: number): Promise<Result<ActivityEvent[]>>;
	// Run one of a card's `actions`, with the prompt's text when it takes some and the lane on screen
	// when one is picked. Resolves to the footer notice. Optional: without it no action runs.
	act?(
		id: string,
		actionId: string,
		input: { text?: string; lane?: string },
	): Promise<Result<string>>;
	// The human closed a finished card's tab with `w`: stop listing it, for good, so it stays closed
	// across a relaunch. Optional: without it the tab stays closed for this session only.
	dismiss?(id: string): Promise<Result<void>>;
	// Questions waiting on the human, with display text already parsed by their owner.
	// Optional: without it the source contributes no questions.
	questions?(): Promise<Result<ActivityQuestion[]>>;
	// Answer the host's question id with a choice's label, multi-select labels joined as
	// "Gamma, Alpha", a permission option's label, or free text when `allowFreeform`.
	// Resolves to the notice the client shows. Optional: without it answers are refused.
	// No identity is passed: each source records the actor it was built with; a client cannot attest it.
	answer?(questionId: string, answer: string): Promise<Result<string>>;
}

// One setting a trigger takes. A trigger whose every input has a `default` and either `options` or
// a `number` or `boolean` type is filled in on the board, in a form, before it fires; any other
// input is the host's to collect.
export type TriggerInput = {
	/** Context for this default, shown below its value. */
	hint?: string;
	type: string;
	required: boolean;
	default?: unknown;
	// What the form's row calls it; the input's name otherwise.
	label?: string;
	// The titled section the form files it under. Inputs of one group sit together, in the host's
	// order.
	group?: string;
	// The values `h/l` cycle through, as the row shows them; the one picked is what `dispatch` gets.
	options?: readonly string[];
};

// A tone is a role, not a color: the board maps it onto its own palette, light or dark, so a host
// says what a part is (a request, work in flight) and never which hue it is.
export type PanelTone =
	| "default"
	| "faint"
	| "secondary"
	| "muted"
	| "working"
	| "done"
	| "failed"
	| "accent";
export type PanelPart = { text: string; tone?: PanelTone; bold?: boolean };
// One line a host composes from toned parts. The board draws it and never reads it; a line too long
// for its room wraps rather than losing its tail.
export type PanelLine = readonly PanelPart[];

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
	// What the form shows beside its settings: whatever the host wants read before it starts (a
	// plan, say). Only a trigger with a form shows it.
	preview?: readonly PanelLine[];
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
	// Resolves to the footer notice on success. `inputs` carries the form's values, by input name,
	// when the trigger had a form: an option input's value is the option picked, as written.
	// `edited` names the inputs the human moved, even back to their default, so a dispatcher can
	// tell a default it offered from a value the human chose.
	dispatch(
		triggerId: string,
		target: DispatchTarget,
		inputs?: Readonly<Record<string, unknown>>,
		edited?: readonly string[],
	): Promise<Result<string>>;
}

// A job's run as its runtime last reported it. `waiting` is a session that wants the human.
export type JobRunState = "live" | "running" | "waiting" | "idle" | "ended";

export type JobRun = {
	id: string;
	state: JobRunState;
	// ISO timestamp.
	startedAt: string;
	// The command that opens the run's session in a terminal, for the human to copy: the board
	// never renders a session itself.
	open: string;
};

// What a job is beyond its item (title, request, scope, state): how and when it runs, and its
// runs. The board draws it; a client without a source shows the item alone.
export type JobFacts = {
	// The schedule as the job was given it (a cron expression).
	schedule: string;
	// When it fires next, ISO; absent when it never will, with why in `problem`.
	next?: string;
	problem?: string;
	recipe: string;
	inputs: Readonly<Record<string, unknown>>;
	// The command its runs start; absent, the source's configured default.
	harness?: readonly string[];
	// `fresh`: each fire starts a new session; `keep`: a fire wakes the job's idle session.
	session: "fresh" | "keep";
	// The folder its runs start in on this machine; absent when this machine has none yet.
	folder?: string;
	// Newest first, already capped by the source.
	runs: readonly JobRun[];
};

// Facts about jobs the board already lists from the tracker. A job the source does not know is
// left out of the record.
export interface JobSource {
	facts(
		jobIds: readonly string[],
	): Promise<Result<Readonly<Record<string, JobFacts>>>>;
}

// What a setting's value is, as its schema declares it (`Settings.fields` in @kabane/extension):
// the kinds of `CopilotFormField`, plus a list, a record and a group of settings. `other` is a value
// no kind describes. `optional`: absent is a valid setting; `default`: what the schema fills in when
// no layer sets it.
export type SettingValue = {
	optional: boolean;
	default?: unknown;
	description?: string;
} & SettingKind;

export type SettingKind =
	| { kind: "enum"; values: readonly string[] }
	| {
			kind: "number";
			integer: boolean;
			minimum?: number;
			maximum?: number;
			exclusiveMinimum?: number;
			exclusiveMaximum?: number;
	  }
	| { kind: "boolean" }
	| { kind: "string"; minLength?: number; maxLength?: number; pattern?: string }
	| { kind: "list"; item: SettingValue }
	| { kind: "record"; keyPattern?: string; value: SettingValue }
	| { kind: "group" }
	| { kind: "other" };

// One setting of a namespace, at `path` in its document.
export type SettingField = SettingValue & { path: readonly string[] };

// A `/name` the prompt window expands client-side into `template`, so the human reads exactly what
// will be sent before pressing enter. `hint` is the one-line description shown while picking.
export type CopilotShortcut = { name: string; hint: string; template: string };
