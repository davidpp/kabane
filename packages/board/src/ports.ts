// The seams a host plugs into the board. The board never learns what a "loop" or a "recipe" is: the
// host projects whatever it runs into flat activity cards, offers whatever it can start on a task as
// trigger descriptors, answers the `A` prompt with a copilot that streams updates, and may have one
// line to announce. All default to no-ops so the board runs standalone with no activity strip, a "no
// dispatcher configured" hint on `a`, a "no copilot configured" hint on `A`, and nothing announced.
import type {
	CopilotElicitationAnswer,
	CopilotFormField,
} from "@cabane/acp/form-field";
import { ok, type Result, type Task } from "@cabane/core";
import type {
	ActivityCard,
	ActivitySource,
	ActivityToolDetail,
	CopilotShortcut,
	Dispatcher,
	NoticeSeverity,
	SettingField,
} from "@cabane/extension";
import type { BoardContext } from "./context";
import { stillMark } from "./still";

// The one event type the view draws as a rule rather than as a row: what was ASKED, which opens a
// turn and so separates it from the one before. Shared vocabulary — a host whose cards run more than
// one turn can emit it too.
export const PROMPT_EVENT = "prompt";

// One entry of the agent's own todo list for the turn. The harness owns the wording; the board only
// counts and renders it.
export type PlanEntryStatus = "pending" | "in_progress" | "completed";
export type PlanEntry = { content: string; status: PlanEntryStatus };

// The step kinds that advance a turn, each carrying the line the transcript shows: `text` is the
// agent's prose, `thought` its reasoning, `tool_call` a tool call opening and `tool_result` or
// `tool_failed` its end, `mode` the harness mode that decides what the session asks, `error` and
// `done` end the turn.
export type CopilotStep =
	| "text"
	| "thought"
	| "tool_call"
	| "tool_result"
	| "tool_failed"
	| "mode"
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

// Where a setting's value is decided, lowest first: the schema's default, then global (every project
// on this device), shared (the file checked into the repo), local (this project, only you), and the
// caller's own overrides for one run.
export type SettingLayer = "default" | "global" | "shared" | "local" | "caller";

// A value a lower layer sets that the deciding layer hides, and the file it is in.
export type SettingHeld = { layer: SettingLayer; from: string; value: unknown };

// One setting as it resolves for the project on screen: `kabane config list --json`'s row. `value`
// is already redacted (a secret reads `<set>`); `from` is the file the deciding layer is stored in;
// `namespace` is the extension that declares it, absent for the device's own keys. `label`, `group`,
// `options` and `none` are how it reads; `layers` are where it can be written, and `target` the one a
// write that names none goes to; `restart` says when a change applies.
export type SettingRow = {
	key: string;
	namespace?: string;
	value: unknown;
	layer: SettingLayer;
	from?: string;
	hides: readonly SettingHeld[];
	field: SettingField;
	label: string;
	group: string;
	options?: readonly (string | number)[];
	none?: string;
	description: string;
	layers: readonly SettingLayer[];
	target: SettingLayer;
	secret: boolean;
	restart: "start" | "resolve";
	readOnly: boolean;
	protected: boolean;
};

// What a save writes: a value of the setting's kind, or the key removed from the layer.
export type SettingWrite = string | number | boolean | { unset: true };

// A save as `kabane config set --json` reports it: the layer and file written, the value (a secret
// `<set>`), and when it applies. `shadowedBy`: a higher layer still sets the key, so the value seen
// is not the one written. `fallsBackTo`: after an unset, the layer that now decides. `unresolved`:
// saved, but the layers no longer resolve (another file is invalid), and why.
export type SettingChange = {
	key: string;
	layer: SettingLayer;
	from: string;
	value?: unknown;
	unset?: true;
	shadowedBy?: SettingHeld;
	fallsBackTo?: SettingHeld;
	unresolved?: string;
	restart: "start" | "resolve";
};

// The settings the `,` view lists, read when it opens and never before, and where it saves a
// change. Absent, the view says settings are not available here.
export interface SettingsSource {
	list(): Promise<Result<SettingRow[]>>;
	set(
		key: string,
		value: SettingWrite,
		layer: SettingLayer,
	): Promise<Result<SettingChange>>;
}

// The harness stopped mid-turn to ask the human to fill a form (AskUserQuestion, a
// `request_user_input`), and is BLOCKED until it hears back. `id` is unique within the session;
// `answerElicitation` names it to answer. A form with no fields asks only for a yes.
export type CopilotElicitation = {
	id: string;
	message: string;
	fields: readonly CopilotFormField[];
};

// One streamed update of a copilot turn: a step, the turn's plan, or a question the human has to
// answer. A plan is STATE, not a step — the harness re-sends the whole list every time an entry
// moves, so it replaces rather than appends. A permission or a form is neither: it is a turn
// stopped dead until someone answers it, and the board is the only thing that may. `withdrawn` is
// the harness taking one of those back unanswered (`id` names it): the board stops asking, and
// `summary` is the line its transcript keeps.
export type CopilotUpdate =
	// A tool call's steps carry its `callId`, so its opening and its end read as one row, and its
	// `detail` as known then. `wrote` marks the end of a call that changed tracker state, which is
	// what the board reloads on.
	| {
			type: CopilotStep;
			summary: string;
			at: string;
			callId?: string;
			detail?: ActivityToolDetail;
			wrote?: boolean;
	  }
	| { type: "plan"; entries: readonly PlanEntry[]; at: string }
	| { type: "permission"; request: CopilotPermission; at: string }
	| { type: "elicitation"; request: CopilotElicitation; at: string }
	| { type: "withdrawn"; id: string; summary: string; at: string }
	// Something the harness wants the human to know that is not the agent's reply (a mode it fell
	// back from, a model it swapped): a line of the turn's log that changes nothing else, recorded as
	// a `notice` event with its severity.
	| {
			type: "notice";
			severity: NoticeSeverity;
			summary: string;
			at: string;
	  }
	// How full the session's context window is, the latest reading replacing the last: STATE, for the
	// footer. `cost` is the session's so far, only from a harness that reports one.
	| ({ type: "usage"; at: string } & CopilotUsage)
	// The harness's own `/` commands, the whole list each time it changes: STATE, like a plan. The
	// `/` picker offers them after the host's shortcuts, labelled with `source` (the harness).
	| {
			type: "commands";
			source: string;
			commands: readonly CopilotCommand[];
			at: string;
	  };

// `used` of the window's `size` tokens are in context now.
export type CopilotUsage = {
	used: number;
	size: number;
	cost?: { amount: number; currency: string };
};

// A `/name` the harness itself runs. Picking one puts `/name ` in the prompt, and the prompt goes to
// the harness as written, since the command is the harness's. `hint` says what its input expects.
export type CopilotCommand = {
	name: string;
	description: string;
	hint?: string;
};

// The copilot the `A` prompt talks to. `run` streams one turn for a prompt with the board's context
// attached; `cancel` stops the turn in flight; `shortcuts` lists the host's own `/` expansions, which
// never change (the harness's commands arrive on the stream). The board never learns which protocol
// or harness sits behind it.
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
	// Answer an `elicitation` update, the same way: accepted with what was filled in, or declined.
	answerElicitation(id: string, answer: CopilotElicitationAnswer): void;
	// The actor uri this copilot's writes are stamped with, so the board can tell the rows it just
	// changed from the ones the human or another agent did. Absent for a copilot that writes nothing
	// through the tracker — no row then ever matches, which is the truth.
	readonly actor?: string;
}

// One line the host wants read once the board is up (a newer release, say). The board asks once,
// after its first frame, and shows the line over the board's footer until `esc` dismisses it. Null
// is nothing to say, and so is a failure: an announcement is never worth an error on screen.
export interface Announcer {
	announce(): Promise<Result<string | null>>;
}

// Requests from outside the board to show the human a task: `kabane board --issue <id> --to <pid>`
// from another terminal today, an agent's tool some day. The board subscribes with what opens a task
// once its first load is in, and calls what `subscribe` returned as it comes down. The host has
// resolved the id, so the board gets the task itself, whose scope and kind say which filters must
// widen to hold it. Each one lands the way `enter` on its row would (BoardNav.openTask).
export type OpenRequests = {
	subscribe(open: (task: Task) => void): () => void;
};

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
	answerElicitation: () => {},
};

export const noAnnouncer: Announcer = {
	announce: async () => ok(null),
};

export const isInFlight = (card: ActivityCard): boolean =>
	card.status === "pending" ||
	card.status === "running" ||
	stillMark(card.status) !== undefined;
