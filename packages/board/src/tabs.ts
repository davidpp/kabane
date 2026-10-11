// The tab bar and the attention queue, as plain functions over the board's state, beside the rest of
// the key routing in nav.ts rather than inside it.
//
// The tracker is always the first tab. Every other tab is a host card that asked for one
// (`ActivityCard.tab`), in the order it appeared; a finished card keeps its tab until `w` closes it,
// and a closed one does not come back this session. While a card's tab is on screen the tracker's
// own view is kept aside, so returning to it lands where the human left.
//
// The queue is every core session question nobody has answered, oldest first, whoever asked it. `!`
// walks it: a question one of a tabbed card's sessions asked lands on that card's tab, pinned under
// its header, any other on its task's detail view with the question pinned over the brief as a
// banner. Either way a digit answers it in place, through `Planner.answerQuestion`.
import type { BoardActivity } from "./activity";
import type { BoardNav } from "./nav";
import { type ActivityCard, type CardAction, isInFlight } from "./ports";
import { BoardPrompt } from "./prompt";

export namespace BoardTabs {
	type State = BoardNav.BoardState;
	type View = State["view"];
	type Step = { state: State; effect: BoardNav.Effect };
	export type Question = BoardActivity.AwaitingQuestion;

	// What the tab bar keeps of a card between polls: what `w`, `o`, `!` and the card's own keys
	// route on.
	type TabCard = {
		finished: boolean;
		sessionIds: readonly string[];
		taskId?: string;
		taskShortId?: string;
		lanes?: readonly string[];
		laneNoun?: string;
		liveLanes?: readonly string[];
		actions?: readonly CardAction[];
	};

	// How a card's tab is being read, kept per card so a tab looks the same when the human comes
	// back to it: the lane on screen (null is every lane), and whether its header is expanded (`e`).
	export type CardView = { lane: string | null; expanded: boolean };

	export type Tabs = {
		// Card ids with a tab, in the order they opened.
		open: readonly string[];
		// Closed with `w`; a card listed again does not reopen.
		closed: ReadonlySet<string>;
		// The tab on screen; null is the tracker.
		active: string | null;
		// The tracker's view while a card's tab is on screen.
		tracker?: View;
		// Every card that asked for a tab, as of the last poll.
		cards: ReadonlyMap<string, TabCard>;
		// Unanswered session questions, oldest first.
		queue: readonly Question[];
		// The question `!` last landed on, which is where the next press continues from.
		landed?: string;
		// What this board answered a question still in the queue with, by question id: set on the
		// keypress, taken back when the write fails, dropped once the poll no longer lists it.
		answered: ReadonlyMap<string, string>;
		// Each card tab's own reading state, by card id.
		views: ReadonlyMap<string, CardView>;
	};

	/**
	 * A question pinned over its task's detail view. `question` is a snapshot, so the banner can
	 * still say what was asked once the answer takes it out of the queue; `answer` is what this board
	 * answered; `cardId` is the tab `b` goes back to, when the question is a tabbed card's.
	 */
	export type Banner = {
		question: Question;
		cardId?: string;
		answer?: string;
	};

	export const NONE: Tabs = {
		open: [],
		closed: new Set<string>(),
		active: null,
		cards: new Map(),
		queue: [],
		answered: new Map(),
		views: new Map(),
	};

	const NOTHING: BoardNav.Effect = { type: "none" };

	const notice = (state: State, text: string): Step => ({
		state,
		effect: { type: "notice", notice: { text, tone: "success" } },
	});

	const withTabs = (state: State, tabs: Partial<Tabs>): State => ({
		...state,
		tabs: { ...state.tabs, ...tabs },
	});

	/** The open tab whose card owns the session that asked, if any. */
	const ownerOf = (tabs: Tabs, question: Question): string | undefined =>
		tabs.open.find((id) =>
			tabs.cards.get(id)?.sessionIds.includes(question.sessionId),
		);

	/** The `?n` on a tab: every question for the tracker, the ones its sessions asked for a card. */
	export const waitingOn = (tabs: Tabs, id: string | null): number =>
		id === null
			? tabs.queue.length
			: tabs.queue.filter((q) => ownerOf(tabs, q) === id).length;

	/** Whether the banner's question is settled: answered here, or gone from the queue some other way. */
	export const isAnswered = (tabs: Tabs, banner: Banner): boolean =>
		banner.answer !== undefined ||
		!tabs.queue.some(
			(q) => q.questionActivityId === banner.question.questionActivityId,
		);

	/** The questions the sessions of the card on screen wait on, oldest first. */
	const cardQuestions = (tabs: Tabs): Question[] =>
		tabs.queue.filter((q) => ownerOf(tabs, q) === tabs.active);

	/**
	 * The question a card's tab shows, pinned and answered in place: the one `!` landed on when it is
	 * this card's, else the oldest of its own.
	 */
	export const cardQuestion = (tabs: Tabs): Question | undefined => {
		const mine = cardQuestions(tabs);
		return mine.find((q) => q.questionActivityId === tabs.landed) ?? mine[0];
	};

	/** How many of the card's questions wait besides the one its tab shows, unanswered. */
	export const moreOnCard = (tabs: Tabs): number => {
		const shown = cardQuestion(tabs);
		return cardQuestions(tabs).filter(
			(q) => q !== shown && !tabs.answered.has(q.questionActivityId),
		).length;
	};

	const tabCard = (card: ActivityCard): TabCard => ({
		finished: !isInFlight(card),
		sessionIds: card.sessionIds ?? [],
		...(card.taskId ? { taskId: card.taskId } : {}),
		...(card.taskShortId ? { taskShortId: card.taskShortId } : {}),
		...(card.lanes && card.lanes.length > 0 ? { lanes: card.lanes } : {}),
		...(card.laneNoun ? { laneNoun: card.laneNoun } : {}),
		...(card.liveLanes ? { liveLanes: card.liveLanes } : {}),
		...(card.actions && card.actions.length > 0
			? { actions: card.actions }
			: {}),
	});

	// Everything a poll can change that the bar or the keys read, as one comparable string.
	const fingerprint = (tabs: Tabs): string =>
		JSON.stringify([
			tabs.open,
			[...tabs.cards],
			tabs.queue.map((q) => q.questionActivityId),
		]);

	/**
	 * The poll's cards and questions, into the bar: a card that asks for a tab opens one at the end
	 * unless it was closed, a card the host stopped listing loses its tab (the tracker comes back if
	 * it was on screen), and the queue is replaced. The same state when nothing moved, so the poll
	 * re-renders nothing.
	 *
	 * New tabs open oldest first, whatever order the host lists its cards in (activity is newest
	 * first), so the bar reads the same at launch as when the cards arrive one poll at a time.
	 */
	export const withActivity = (
		state: State,
		cards: readonly ActivityCard[],
		queue: readonly Question[],
	): State => {
		const { tabs } = state;
		const tabbed = cards.filter((card) => card.tab);
		const listed = new Set(tabbed.map((card) => card.id));
		const opened = tabbed
			.filter(
				(card) => !tabs.open.includes(card.id) && !tabs.closed.has(card.id),
			)
			.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))
			.map((card) => card.id);
		const waiting = new Set(queue.map((q) => q.questionActivityId));
		const next: Tabs = {
			...tabs,
			open: [...tabs.open.filter((id) => listed.has(id)), ...opened],
			cards: new Map(tabbed.map((card) => [card.id, tabCard(card)])),
			queue,
			answered: new Map(
				[...tabs.answered].filter(([questionId]) => waiting.has(questionId)),
			),
		};
		if (fingerprint(next) === fingerprint(tabs)) return state;
		const moved = { ...state, tabs: next };
		return next.active !== null && !next.open.includes(next.active)
			? show(moved, null)
			: moved;
	};

	/**
	 * One card as the event view on its tab just refreshed it, so the keys see a new lane the moment
	 * its chip appears rather than at the next board poll. The same state when nothing moved.
	 */
	export const withCard = (state: State, card: ActivityCard): State => {
		const { tabs } = state;
		if (!card.tab || !tabs.cards.has(card.id)) return state;
		const cards = new Map(tabs.cards).set(card.id, tabCard(card));
		const next = { ...tabs, cards };
		return fingerprint(next) === fingerprint(tabs)
			? state
			: { ...state, tabs: next };
	};

	// Leaving the tracker drops a banner whose question is settled, so the task reads as itself when
	// the human comes back. One still waiting stays pinned.
	const leaving = (tabs: Tabs, view: View): View =>
		view.type === "detail" && view.banner && isAnswered(tabs, view.banner)
			? {
					type: "detail",
					taskId: view.taskId,
					...(view.tab ? { tab: view.tab } : {}),
				}
			: view;

	/** Put tab `id` on screen (null is the tracker), keeping the tracker's view for its return. */
	const show = (state: State, id: string | null): State => {
		const { tabs } = state;
		const tracker =
			tabs.active === null ? leaving(tabs, state.view) : tabs.tracker;
		if (id === null)
			return {
				...state,
				focus: "board",
				view: tracker ?? { type: "board" },
				tabs: { ...tabs, active: null, tracker: undefined },
			};
		return {
			...state,
			focus: "board",
			view: { type: "events", cardId: id, fromView: "board" },
			tabs: { ...tabs, active: id, tracker },
		};
	};

	// `{` `}`: the previous or next tab, the tracker included, wrapping.
	const step = (state: State, delta: 1 | -1): Step => {
		const all = [null, ...state.tabs.open];
		if (all.length === 1) return notice(state, "no other tabs");
		const at = all.indexOf(state.tabs.active);
		const next = all[(at + delta + all.length) % all.length] ?? null;
		return { state: show(state, next), effect: NOTHING };
	};

	// Where the human is in the queue: the question pinned over the detail view, or the one the card
	// tab on screen shows. Anywhere else the next press starts from the oldest.
	const position = (state: State): string | undefined => {
		const { view, tabs } = state;
		if (view.type === "detail") return view.banner?.question.questionActivityId;
		return tabs.active === null
			? undefined
			: cardQuestion(tabs)?.questionActivityId;
	};

	// The question's task in the tracker, with the question pinned over it.
	const pin = (state: State, question: Question, cardId?: string): State => {
		const tracker = show(state, null);
		return {
			...tracker,
			view: {
				type: "detail",
				taskId: question.taskId,
				banner: { question, ...(cardId ? { cardId } : {}) },
			},
			tabs: { ...tracker.tabs, landed: question.questionActivityId },
		};
	};

	// `!`: the next question after the one in hand, oldest first, wrapping. The one on screen, alone in
	// the queue, says so rather than landing where the human already is with nothing moved.
	const nextQuestion = (state: State): Step => {
		const { queue } = state.tabs;
		if (queue.length === 0) return notice(state, "nothing is waiting on you");
		const here = position(state);
		const at = queue.findIndex((q) => q.questionActivityId === here);
		const next = queue[(at + 1) % queue.length];
		if (!next) return { state, effect: NOTHING };
		if (next.questionActivityId === here)
			return notice(state, "nothing else is waiting on you");
		const owner = ownerOf(state.tabs, next);
		if (owner === undefined)
			return { state: pin(state, next), effect: NOTHING };
		const shown = show(state, owner);
		return {
			state: withTabs(shown, { landed: next.questionActivityId }),
			effect: NOTHING,
		};
	};

	// `w`: close a finished card's tab for good, and tell the host so it stops listing the card across
	// a relaunch too. A running one says why it stays.
	const close = (state: State, id: string): Step => {
		if (!state.tabs.cards.get(id)?.finished)
			return notice(state, "still running · w closes it once it ends");
		const { tabs } = state;
		const closed = new Set(tabs.closed).add(id);
		const open = tabs.open.filter((tab) => tab !== id);
		return {
			state: show(withTabs(state, { open, closed }), null),
			effect: { type: "dismiss", cardId: id },
		};
	};

	const taskIdOfShortId = (state: State, shortId: string): string | undefined =>
		state.sections
			.flatMap((section) => section.rows)
			.flatMap((row) => [row.task, ...row.children])
			.find((task) => task.shortId === shortId)?.id;

	// `o` on a card's tab: the question it shows, pinned over its task; with none, the card's task.
	const open = (state: State, id: string): Step => {
		const question = cardQuestion(state.tabs);
		if (question) return { state: pin(state, question, id), effect: NOTHING };
		const card = state.tabs.cards.get(id);
		const taskId =
			card?.taskId ??
			(card?.taskShortId
				? taskIdOfShortId(state, card.taskShortId)
				: undefined);
		if (!taskId) return { state, effect: NOTHING };
		const tracker = show(state, null);
		return {
			state: { ...tracker, view: { type: "detail", taskId } },
			effect: NOTHING,
		};
	};

	const isKey = (key: BoardNav.KeyInput, char: string): boolean =>
		!key.ctrl && !key.meta && (key.name === char || key.sequence === char);

	/** The bar's keys, the same from every view: `{` `}` and `!`. Null for any other key. */
	export const reduceGlobalKey = (
		state: State,
		key: BoardNav.KeyInput,
	): Step | null => {
		if (isKey(key, "}")) return step(state, 1);
		if (isKey(key, "{")) return step(state, -1);
		if (isKey(key, "!")) return nextQuestion(state);
		return null;
	};

	/**
	 * A card's own tab: the question it shows takes a digit or, offering no answers, `enter`; `esc`/`q`
	 * go to the tracker rather than down a stack, `o` to the question's task, `w` closes it. Null for
	 * the keys the event view under it answers (j/k).
	 */
	export const reduceCardTabKey = (
		state: State,
		id: string,
		key: BoardNav.KeyInput,
	): Step | null => {
		const shown = cardQuestion(state.tabs);
		const answered = shown
			? answerKey(state, shown, isSettled(state.tabs, shown), key)
			: null;
		if (answered) return answered;
		// A letter by what it types, as on CardTab: shift+w is `W`, not close.
		switch (key.name.length === 1 ? (key.sequence ?? key.name) : key.name) {
			case "escape":
			case "q":
				return { state: show(state, null), effect: NOTHING };
			case "o":
				return open(state, id);
			case "w":
				return close(state, id);
			default:
				return null;
		}
	};

	// A question still waiting that offers no answers to pick: it takes a typed one.
	const freeform = (question: Question, settled: boolean): boolean =>
		!settled && question.choices.length === 0;

	// A question a card's tab shows is settled once this board answered it; the poll then drops it.
	const isSettled = (tabs: Tabs, question: Question): boolean =>
		tabs.answered.has(question.questionActivityId);

	// The digit a key types, 1-9, or undefined. A shifted digit is not one: a terminal that reports
	// shift+1 by its base key (kitty's protocol without alternate keys) means `!`, never answer 1.
	const digitOf = (key: BoardNav.KeyInput): number | undefined =>
		key.shift || !/^[1-9]$/.test(key.name) ? undefined : Number(key.name);

	/** Open the prompt for a typed answer to `question` (`enter` on its banner or its card's tab). */
	export const typeAnswer = (state: State, question: Question): Step =>
		BoardPrompt.open(state, {
			target: { type: "answer", questionId: question.questionActivityId },
			title: "answer",
			aim: question.taskShortId,
			placeholder: "type the answer · enter sends it",
		});

	/**
	 * The keys that answer the question in hand, on its banner or on its card's tab: `enter` types the
	 * answer to one that offers none, and a digit picks the answer it numbers. One past the answers,
	 * or any once it is settled, does nothing rather than reaching the view under it. Null for every
	 * other key.
	 */
	const answerKey = (
		state: State,
		question: Question,
		settled: boolean,
		key: BoardNav.KeyInput,
	): Step | null => {
		if (key.ctrl || key.meta) return null;
		if (key.name === "return" || key.name === "enter")
			return freeform(question, settled) ? typeAnswer(state, question) : null;
		const digit = digitOf(key);
		if (digit === undefined) return null;
		const answer = settled ? undefined : question.choices[digit - 1];
		if (answer === undefined) return { state, effect: NOTHING };
		// Answered on the keypress, not when the write lands, so a second digit pressed before it
		// does cannot answer again. A failed write takes it back (withoutAnswer).
		const questionId = question.questionActivityId;
		return {
			state: withAnswered(state, questionId, answer),
			effect: { type: "answerQuestion", questionId, answer },
		};
	};

	/**
	 * The banner over a detail view: `b` goes back to the card's tab, and the answering keys are the
	 * banner's alone while it is pinned, so a digit never switches the section under it.
	 */
	export const reduceBannerKey = (
		state: State,
		banner: Banner,
		key: BoardNav.KeyInput,
	): Step | null => {
		if (
			key.name === "b" &&
			banner.cardId &&
			state.tabs.open.includes(banner.cardId)
		)
			return { state: show(state, banner.cardId), effect: NOTHING };
		return answerKey(
			state,
			banner.question,
			isAnswered(state.tabs, banner),
			key,
		);
	};

	const withBanner = (
		state: State,
		questionId: string,
		patch: (banner: Banner) => Banner,
	): State => {
		const { view } = state;
		if (
			view.type !== "detail" ||
			view.banner?.question.questionActivityId !== questionId
		)
			return state;
		return { ...state, view: { ...view, banner: patch(view.banner) } };
	};

	/**
	 * The question was answered with `answer`: a banner stays up saying so until the human leaves, and
	 * a card's tab says so until the poll drops the question.
	 */
	export const withAnswered = (
		state: State,
		questionId: string,
		answer: string,
	): State => {
		const pinned = withBanner(state, questionId, (banner) => ({
			...banner,
			answer,
		}));
		if (!state.tabs.queue.some((q) => q.questionActivityId === questionId))
			return pinned;
		const answered = new Map(state.tabs.answered).set(questionId, answer);
		return withTabs(pinned, { answered });
	};

	/** The write of `answer` failed: the question takes digits again, unless it has since moved on. */
	export const withoutAnswer = (
		state: State,
		questionId: string,
		answer: string,
	): State => {
		const pinned = withBanner(state, questionId, (banner) =>
			banner.answer === answer
				? {
						question: banner.question,
						...(banner.cardId ? { cardId: banner.cardId } : {}),
					}
				: banner,
		);
		if (state.tabs.answered.get(questionId) !== answer) return pinned;
		const answered = new Map(state.tabs.answered);
		answered.delete(questionId);
		return withTabs(pinned, { answered });
	};

	/** A click on a tab (null is the tracker), or on the `index`th answer of the question on screen. */
	export const reduceMouse = (
		state: State,
		action:
			| { type: "tab"; id: string | null }
			| { type: "answer"; index: number },
	): Step => {
		if (action.type === "answer") {
			const { view, tabs } = state;
			// A click on answer n is the digit n: one path, so the two can never disagree.
			const digit = { name: String(action.index + 1) };
			const answered =
				view.type === "detail" && view.banner
					? reduceBannerKey(state, view.banner, digit)
					: view.type === "events" && tabs.active !== null
						? reduceCardTabKey(state, tabs.active, digit)
						: null;
			return answered ?? { state, effect: NOTHING };
		}
		const known = action.id === null || state.tabs.open.includes(action.id);
		return known && action.id !== state.tabs.active
			? { state: show(state, action.id), effect: NOTHING }
			: { state, effect: NOTHING };
	};

	/** Facts the footer's `when`s read. */
	export const situation = (
		state: State,
	): {
		waiting: boolean;
		tabs: boolean;
		closable: boolean;
		back: boolean;
		unanswered: boolean;
		pinned: boolean;
		freeform: boolean;
	} => {
		const { tabs, view } = state;
		const banner = view.type === "detail" ? view.banner : undefined;
		const shown =
			view.type === "events" && tabs.active !== null
				? cardQuestion(tabs)
				: undefined;
		// The question in hand and whether it is settled: the banner's, else the card tab's.
		const asked = banner
			? { question: banner.question, settled: isAnswered(tabs, banner) }
			: shown
				? { question: shown, settled: isSettled(tabs, shown) }
				: undefined;
		return {
			freeform: asked !== undefined && freeform(asked.question, asked.settled),
			waiting: tabs.queue.length > 0,
			tabs: tabs.open.length > 0,
			closable:
				tabs.active !== null && tabs.cards.get(tabs.active)?.finished === true,
			back: banner?.cardId !== undefined && tabs.open.includes(banner.cardId),
			unanswered:
				asked !== undefined &&
				!asked.settled &&
				asked.question.choices.length > 0,
			pinned: banner !== undefined,
		};
	};
}
