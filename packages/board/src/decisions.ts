// The decisions agents file on issues (`kabane_ask`), as plain functions over the board's state
// beside the rest of the key routing in nav.ts. Two surfaces, and neither is the `!` queue, which
// stays the live sessions' own:
//
// - The board counts every issue's open decisions on its row, and `u` narrows the list to the issues
//   that have one; `esc` takes the filter off again, a level of its own in the board's esc chain.
// - An issue's detail asks its open decisions one at a time, oldest first, as the copilot's form
//   (DecisionForm): a decision on screen takes the form's keys ahead of the view, the way a question
//   pinned over the view does, and outranks the copilot's own ask, whose row then says how to reach
//   it. The answer goes to `Questions.answer`; the next decision, or the brief, takes its place.
//
// A typed field has the keys the moment it is on screen, as the copilot's input does: every key but
// `esc`, `tab` and `enter` is text, ctrl and alt chords included, so typing never acts on the issue
// under it. `esc` clears a decision under way back to its first field, and on one not yet touched
// goes on to the view's own `esc`.
import type { QuestionView } from "@kabane/questions";
import { DecisionForm } from "./decision-form";
import { ElicitationForm } from "./elicitation-form";
import type { BoardNav } from "./nav";

export namespace BoardDecisions {
	type State = BoardNav.BoardState;
	type Step = { state: State; effect: BoardNav.Effect };
	type Decision = DecisionForm.Decision;

	/** The human's draft of one decision. */
	type Draft = {
		questionId: string;
		draft: ElicitationForm.Draft;
	};

	export type Decisions = {
		// Open decisions by task id, over the whole tracker, as of the last poll.
		counts: ReadonlyMap<string, number>;
		// `u`: the board shows only the issues that have one.
		only: boolean;
		// The open detail view's task and its open decisions, oldest first, as of its last records.
		open: { taskId: string; questions: readonly Decision[] } | null;
		draft: Draft | null;
		// Answered from this board, the write still landing: hidden until the records drop them, and
		// taken back if the write fails.
		pending: ReadonlySet<string>;
	};

	export const NONE: Decisions = {
		counts: new Map(),
		only: false,
		open: null,
		draft: null,
		pending: new Set(),
	};

	const NOTHING: BoardNav.Effect = { type: "none" };

	const patch = (state: State, next: Partial<Decisions>): State => ({
		...state,
		decisions: { ...state.decisions, ...next },
	});

	// ── the board ───────────────────────────────────────────────────────────────────────────────

	/** The poll's counts; the same state when it read none. */
	export const withCounts = (
		state: State,
		counts: ReadonlyMap<string, number> | undefined,
	): State => (counts ? patch(state, { counts }) : state);

	/** The counts the list narrows to while `u` is on, else undefined. */
	export const filter = ({
		only,
		counts,
	}: Decisions): ReadonlyMap<string, number> | undefined =>
		only ? counts : undefined;

	/** Whether `u` has something to show or to take off: a loaded task with an open decision. */
	export const listed = (state: State): boolean =>
		state.decisions.only ||
		state.sections.some((section) =>
			section.rows.some(({ task, children }) =>
				[task, ...children].some(
					(t) => (state.decisions.counts.get(t.id) ?? 0) > 0,
				),
			),
		);

	export const toggle = (state: State): State =>
		patch(state, { only: !state.decisions.only });

	export const clear = (state: State): State => patch(state, { only: false });

	// ── the detail view ─────────────────────────────────────────────────────────────────────────

	/**
	 * The detail view's records, as far as decisions go: `rows` are the task's questions, every
	 * status, or none at all when no task is open. A draft or a pending answer for a question no
	 * longer open goes with it.
	 */
	export const withOpen = (
		state: State,
		taskId: string | null,
		rows: readonly QuestionView[] = [],
	): State => {
		if (taskId === null)
			return state.decisions.open === null
				? state
				: patch(state, { open: null, draft: null });
		const questions = rows
			.filter((row) => row.status === "open")
			.map(DecisionForm.of);
		const ids = new Set(questions.map((q) => q.id));
		const { draft, pending } = state.decisions;
		return patch(state, {
			open: { taskId, questions },
			draft: draft && ids.has(draft.questionId) ? draft : null,
			pending: new Set([...pending].filter((id) => ids.has(id))),
		});
	};

	/** The write failed: the decision is asked again. */
	export const withFailed = (state: State, questionId: string): State => {
		const pending = new Set(state.decisions.pending);
		return pending.delete(questionId) ? patch(state, { pending }) : state;
	};

	export type Shown = {
		decision: Decision;
		draft: ElicitationForm.Draft;
		// How many more wait behind it.
		waiting: number;
	};

	/**
	 * The decision the open detail view asks: its task's oldest open one this board has not just
	 * answered. A session question pinned over the view comes first, and keeps the view's keys.
	 */
	export const shown = (state: State): Shown | undefined => {
		const { view } = state;
		const { open, pending, draft } = state.decisions;
		if (view.type !== "detail" || view.banner || open?.taskId !== view.taskId)
			return undefined;
		const waiting = open.questions.filter((q) => !pending.has(q.id));
		const decision = waiting[0];
		if (!decision) return undefined;
		const own = draft?.questionId === decision.id ? draft : undefined;
		return {
			decision,
			draft: own?.draft ?? ElicitationForm.start(),
			waiting: waiting.length - 1,
		};
	};

	/** The decision on screen, while the board has the keys and no prompt is open. */
	const inHand = (state: State): Shown | undefined =>
		state.focus === "board" && !state.prompt.open ? shown(state) : undefined;

	const typed = (shown: Shown): boolean =>
		ElicitationForm.typed(
			ElicitationForm.field(shown.decision.request, shown.draft),
		);

	// Nothing to clear: the view's own `esc` applies.
	const untouched = ({ draft }: Shown): boolean =>
		draft.at === 0 &&
		draft.picked.length === 0 &&
		draft.error === undefined &&
		Object.keys(draft.values).length === 0;

	/** What `esc` does on the decision on screen: clears one under way, else leaves the view. */
	export const escapes = (asked: Shown): string =>
		untouched(asked) ? "back" : "start over";

	/** The decision in hand's `esc`, for the footer to name as its block does. */
	export const situation = (state: State): { decisionEsc?: string } => {
		const asked = inHand(state);
		return asked ? { decisionEsc: escapes(asked) } : {};
	};

	/**
	 * How many open decisions the detail view's task has that this board has not just answered,
	 * the one on screen included: what a question pinned over the view leaves waiting.
	 */
	export const waiting = (state: State): number => {
		const { view } = state;
		const { open, pending } = state.decisions;
		if (view.type !== "detail" || open?.taskId !== view.taskId) return 0;
		return open.questions.filter((q) => !pending.has(q.id)).length;
	};

	/** Whether the decision on screen has the keys its block names: the form's, or its input's. */
	export const keysInHand = (state: State): boolean =>
		inHand(state) !== undefined;

	/** Whether the decision on screen's text field has the keys, every one but `esc` and `tab`. */
	export const typing = (state: State): boolean => {
		const asked = inHand(state);
		return asked !== undefined && typed(asked);
	};

	/**
	 * Who has the keys the decision on screen waits for, and the key that hands them over, while it
	 * lacks them; its block says so in place of keys that would go elsewhere.
	 */
	export const reach = (state: State): BoardNav.AskReach | undefined => {
		const asked = shown(state);
		if (!asked || keysInHand(state)) return undefined;
		return state.prompt.open
			? { key: "esc", holder: "the prompt" }
			: { key: "esc", holder: "the copilot" };
	};

	/** What a digit answers on it, for BoardNav.sight: a field of its own, as on the copilot's form. */
	export const target = (state: State): string | undefined => {
		const asked = inHand(state);
		return asked && !typed(asked)
			? `${asked.decision.id}#${asked.draft.at}`
			: undefined;
	};

	/** Whether `key` gives an answer rather than moving through one, so it is held while unread. */
	export const answers = (state: State, key: BoardNav.KeyInput): boolean => {
		const asked = inHand(state);
		if (!asked || typed(asked) || ["escape", "up", "down"].includes(key.name))
			return false;
		return (
			ElicitationForm.reduceKey(asked.decision.request, asked.draft, key) !==
			null
		);
	};

	const withDraft = (
		state: State,
		asked: Shown,
		draft: ElicitationForm.Draft,
	): State => patch(state, { draft: { questionId: asked.decision.id, draft } });

	// A step of the form: the draft moved on, or its answer sent, or refused and asked again from its
	// first field with why.
	const advance = (
		state: State,
		asked: Shown,
		step: ElicitationForm.Step,
	): Step | null => {
		if (!step) return null;
		if ("draft" in step)
			return {
				state: withDraft(state, asked, step.draft),
				effect: NOTHING,
			};
		if (step.answer.action !== "accept")
			return { state: patch(state, { draft: null }), effect: NOTHING };
		const { decision } = asked;
		const answer = DecisionForm.answerOf(decision, step.answer.content);
		if (!answer.ok)
			return {
				state: withDraft(state, asked, {
					...ElicitationForm.start(),
					error: answer.error.message,
				}),
				effect: NOTHING,
			};
		return {
			state: patch(state, {
				draft: null,
				pending: new Set([...state.decisions.pending, decision.id]),
			}),
			effect: {
				type: "answerDecision",
				questionId: decision.id,
				handle: decision.handle,
				...answer.value,
			},
		};
	};

	/**
	 * A key on the decision in hand, ahead of every view key. Null for a key it does not answer,
	 * which then routes as it would without one. While its input has the keys, every key but `tab`
	 * stops here, a ctrl or alt chord too (alt-d is a word delete there, `d` on the issue), so typing
	 * never acts on the board under it.
	 */
	export const reduceKey = (
		state: State,
		key: BoardNav.KeyInput,
	): Step | null => {
		const asked = inHand(state);
		if (!asked) return null;
		if (key.name === "escape")
			return untouched(asked)
				? null
				: { state: patch(state, { draft: null }), effect: NOTHING };
		if (typed(asked))
			return key.name === "tab" ? null : { state, effect: NOTHING };
		if (key.ctrl || key.meta) return null;
		return advance(
			state,
			asked,
			ElicitationForm.reduceKey(asked.decision.request, asked.draft, key),
		);
	};

	/** `enter` in the decision's input, with what it holds. */
	export const submit = (state: State, text: string): Step => {
		const asked = inHand(state);
		const step = asked
			? advance(
					state,
					asked,
					ElicitationForm.submit(asked.decision.request, asked.draft, text),
				)
			: null;
		return step ?? { state, effect: NOTHING };
	};

	export type Click =
		| { type: "decisionOption"; index: number }
		| { type: "decisionKey"; name: string }
		| { type: "decisionReach" };

	/**
	 * A click on the decision's block, through the reducers its keys take: an answer is its digit, a
	 * hint its key, and the row that says how to reach it needs nothing more: the board already has
	 * the keys by then (BoardNav.reduceMouse). A pointer aims at what is drawn, so nothing is held.
	 * Null for a hint whose key the decision hands on, as the key router would (`esc back` on an
	 * untouched one goes to the view's own `esc`).
	 */
	export const click = (state: State, action: Click): Step | null => {
		const none = { state, effect: NOTHING };
		const asked = inHand(state);
		if (!asked) return none;
		switch (action.type) {
			case "decisionOption":
				return (
					advance(
						state,
						asked,
						ElicitationForm.pick(
							asked.decision.request,
							asked.draft,
							action.index,
						),
					) ?? none
				);
			case "decisionKey":
				return reduceKey(state, { name: action.name });
			case "decisionReach":
				return none;
		}
	};
}
