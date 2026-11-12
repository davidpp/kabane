// The one place key hints are written. Every footer, the `?` sheet and every overlay's hint row read
// this registry, context by context: the keys that do something where the human is right now, and
// nothing that belongs to another view. Reducers in nav.ts stay the binding authority; this module is
// display copy, and `keymap.test.ts` holds it to them: every key listed here for a context must change
// something through that context's reducer.
//
// A binding carries:
//   - the key as it is written for a human (`j/k`, `⌃z`), and the key names it stands for, in the
//     shape nav.ts's KeyInput carries them (`j`, `down`, `ctrl+z`, `shift+tab`);
//   - a tier: `footer` for the everyday few, `help` for the rest, which only the sheet lists;
//   - optionally `when`, an availability check over facts the view already holds. The footer leaves
//     an unavailable key out (a hint for a key that would do nothing is rent in a narrow pane); the
//     sheet keeps it and draws it faint, so it still teaches the whole view.
export namespace Keymap {
	export type Hint = { key: string; label: string };

	/** Facts a view has in hand that decide whether a key does anything right now. */
	export type Situation = {
		/** A row is selected: the row keys have something to act on. */
		selection?: boolean;
		/** The task in hand points at an issue in another tracker. */
		linked?: boolean;
		/** The open task has host activity with events to read. */
		events?: boolean;
		/** The copilot has a transcript to open, or a turn is live. */
		transcript?: boolean;
		/** The transcript on screen is the copilot's, and its turn is running. */
		stoppable?: boolean;
		/** `esc` on the board has something to clear: marks, a committed search, a filter, a narrowed scope. */
		clearable?: boolean;
		/** An issue on the board has an open decision, or `u` is showing only those. */
		decisions?: boolean;
		/** A decision on the detail view has the keys its form names, the digits among them. */
		deciding?: boolean;
		/** The titles of the kinds the open task has a lifted entry of, which `r` reads in full. */
		lifted?: readonly string[];
		/** The detail view's `now` tab lists checklist items, one under the cursor. */
		checklist?: boolean;
		/** The copilot's buffer is empty and there are prompts to recall. */
		history?: boolean;
		/** The dispatch picker has triggers to move through. */
		ready?: boolean;
		/** A session question waits on the human, so `!` has somewhere to go. */
		waiting?: boolean;
		/** There are tabs besides the tracker. */
		tabs?: boolean;
		/** The card on screen is over, so its tab can close. */
		closable?: boolean;
		/** The banner over the detail view is a tabbed card's, so `b` has a tab to go back to. */
		back?: boolean;
		/** The question on screen (a banner's or a card tab's) still waits, and offers answers to pick. */
		unanswered?: boolean;
		/** A question is pinned over the detail view, so the digits are its own. */
		pinned?: boolean;
		/** The card on screen has lanes to walk. */
		lanes?: boolean;
		/** The question on screen takes a typed answer (it offers none to pick, or allows one), so `enter` types it. */
		freeform?: boolean;
		/** The open prompt's action could go to another lane, which `tab` aims it at. */
		reaimable?: boolean;
		/** The card on screen has a header of its host's, which `e` expands. */
		header?: boolean;
		/** The `?` sheet is taller than the pane. */
		scrollable?: boolean;
		/** Setup found harnesses to tick. */
		harnesses?: boolean;
		/** The settings view has rows to move through. */
		settings?: boolean;
		/** The setting in hand can be changed here: `enter` edits it rather than open its detail. */
		settingEditable?: boolean;
		/** `h/l` step the setting in hand: an enum, a boolean, or one with looked-up steps. */
		settingSteps?: boolean;
		/** The setting in hand can be removed from a layer. */
		settingUnsets?: boolean;
		/** The editor is open on the setting in hand. */
		settingEditing?: boolean;
		/** Its value is being typed, so letters are the value's, not keys. */
		settingTyping?: boolean;
		/** The setting in hand can be saved to more than one layer. */
		settingLayers?: boolean;
		/** A save waits on its y/n. */
		settingConfirming?: boolean;
	};

	type Tier = "footer" | "help";

	type Binding = Hint & {
		tier: Tier;
		/** The key names this hint stands for, as nav.ts's KeyInput carries them. */
		keys: readonly string[];
		when?: (situation: Situation) => boolean;
		/** The label when it depends on what is in hand; `label` stands for it where nothing is. */
		labelOf?: (situation: Situation) => string;
		/**
		 * Who owns these keys when it is not the context's nav.ts reducer: the copilot's textarea (enter
		 * submits, `/` is typed) or the setup screen's own handler. The drift test skips these by name.
		 */
		routed?: "textarea" | "setup";
	};

	export type ContextId =
		| "board"
		| "search"
		| "searchResults"
		| "detail"
		| "decisionText"
		| "transcript"
		| "cardTab"
		| "copilot"
		| "palette"
		| "prompt"
		| "dispatch"
		| "dispatchForm"
		| "help"
		| "reader"
		| "settings"
		| "setupWelcome"
		| "setupForm"
		| "setupWorking"
		| "setupDone";

	type Context = {
		/** What the sheet calls it. */
		name: string;
		bindings: readonly Binding[];
		/** `?` opens the sheet here, so the footer ends in `? help` and the everywhere keys apply. */
		sheet: boolean;
	};

	const selection = (s: Situation): boolean => s.selection === true;

	// The checklist's keys, while no decision on screen has the keys `space` might toggle on it.
	const checklist = (s: Situation): boolean =>
		s.checklist === true && s.deciding !== true;
	// The digits go to the detail's sections while no question or decision on screen takes them.
	const sections = (s: Situation): boolean =>
		s.pinned !== true && s.deciding !== true;

	/**
	 * `t` on an event view: open or close every tool row at once, the keyboard's way to what a call
	 * did. In the footer on the transcript; on a card's tab the host's actions have the footer.
	 */
	const TOOL_DETAILS: Binding = {
		key: "t",
		label: "tool details",
		tier: "footer",
		keys: ["t"],
	};

	/** `?` itself: last in every footer where the sheet opens. */
	const HELP: Binding = {
		key: "?",
		label: "help",
		tier: "footer",
		keys: ["?"],
	};

	/**
	 * `!`: the next question waiting on the human. The one everywhere key a footer shows, and only
	 * while something waits: from any tab, it is the way to whatever is blocked on you.
	 */
	const NEXT_QUESTION: Binding = {
		key: "!",
		label: "answer next",
		tier: "footer",
		keys: ["!"],
		when: (s) => s.waiting === true,
	};

	/** The keys that work wherever the sheet opens: board, detail, transcript, a card's tab. */
	export const EVERYWHERE: readonly Binding[] = [
		HELP,
		NEXT_QUESTION,
		{
			key: "{ }",
			label: "previous · next tab",
			tier: "help",
			keys: ["{", "}"],
			when: (s) => s.tabs === true,
		},
		{ key: ",", label: "settings", tier: "help", keys: [","] },
		{
			key: "A :",
			label: "copilot: config & help",
			tier: "help",
			keys: ["A", ":"],
		},
		{
			key: "tab ⇧tab",
			label: "next · previous pane",
			tier: "help",
			keys: ["tab", "shift+tab"],
		},
		{ key: "⌃z", label: "undo", tier: "help", keys: ["ctrl+z"] },
	];

	// `O` acts on the task in hand, the open one in detail and the selected row on the board, and is
	// hinted only where there is a linked issue to open.
	const OPEN_LINK: Binding = {
		key: "O",
		label: "open issue",
		tier: "footer",
		keys: ["O"],
		when: (s) => s.linked === true,
	};

	// A digit over a question that offers answers: the one it numbers.
	const PICK_ANSWER: Binding = {
		key: "1-9",
		label: "answer",
		tier: "footer",
		keys: ["1", "2"],
		when: (s) => s.unanswered === true,
	};

	// `enter` over a question that offers no answers: the prompt, to type one.
	const TYPE_ANSWER: Binding = {
		key: "enter",
		label: "answer",
		tier: "footer",
		keys: ["return"],
		when: (s) => s.freeform === true,
	};

	// `r` on the detail view: the lifted entries in full. Named after the kind when there is one, as
	// the footer would otherwise promise a read of nothing in particular.
	const READ: Binding = {
		key: "r",
		label: "read",
		tier: "footer",
		keys: ["r"],
		when: (s) => (s.lifted?.length ?? 0) > 0,
		labelOf: (s) =>
			s.lifted?.length === 1 ? `read ${s.lifted[0]?.toLowerCase()}` : "read",
	};

	const ESC_BOARD: Binding = {
		key: "esc",
		label: "board",
		tier: "footer",
		keys: ["escape"],
	};

	export const CONTEXTS: Readonly<Record<ContextId, Context>> = {
		board: {
			name: "board",
			sheet: true,
			bindings: [
				// What waits on the human leads, as `!` does: the issues agents filed decisions on.
				{
					key: "u",
					label: "decisions",
					tier: "footer",
					keys: ["u"],
					when: (s) => s.decisions === true,
				},
				OPEN_LINK,
				{ key: "/", label: "search", tier: "footer", keys: ["/"] },
				{
					key: "d",
					label: "done",
					tier: "footer",
					keys: ["d"],
					when: selection,
				},
				{
					key: "v",
					label: "review",
					tier: "footer",
					keys: ["v"],
					when: selection,
				},
				{
					key: "m",
					label: "mark",
					tier: "footer",
					keys: ["m"],
					when: selection,
				},
				{
					key: "y",
					label: "copy brief",
					tier: "footer",
					keys: ["y"],
					when: selection,
				},
				{
					key: "o",
					label: "copilot transcript",
					tier: "help",
					keys: ["o"],
					when: (s) => s.transcript === true,
				},
				{
					key: "a",
					label: "dispatch",
					tier: "help",
					keys: ["a"],
					when: selection,
				},
				{
					key: "j/k",
					label: "move",
					tier: "help",
					keys: ["j", "k", "down", "up"],
				},
				{
					key: "enter",
					label: "open",
					tier: "help",
					keys: ["return"],
					when: selection,
				},
				{
					key: "space",
					label: "fold subtasks",
					tier: "help",
					keys: ["space"],
					when: selection,
				},
				{
					key: "h/l",
					label: "collapse · expand",
					tier: "help",
					keys: ["h", "l", "left", "right"],
					when: selection,
				},
				{
					key: "[ ]",
					label: "previous · next state",
					tier: "help",
					keys: ["[", "]"],
					when: selection,
				},
				{
					key: "n",
					label: "to next",
					tier: "help",
					keys: ["n"],
					when: selection,
				},
				{
					key: "s",
					label: "to someday",
					tier: "help",
					keys: ["s"],
					when: selection,
				},
				{
					key: "x",
					label: "cancel task",
					tier: "help",
					keys: ["x"],
					when: selection,
				},
				{ key: "f", label: "cycle status filter", tier: "help", keys: ["f"] },
				{ key: "i", label: "cycle kind filter", tier: "help", keys: ["i"] },
				{
					key: "esc",
					label: "clear · widen scope",
					tier: "help",
					keys: ["escape"],
					when: (s) => s.clearable === true,
				},
				{ key: "r", label: "refresh", tier: "help", keys: ["r"] },
				{ key: "q", label: "quit", tier: "help", keys: ["q"] },
			],
		},
		search: {
			name: "search",
			sheet: false,
			bindings: [
				{ key: "enter", label: "apply", tier: "footer", keys: ["return"] },
				{ key: "esc", label: "cancel", tier: "footer", keys: ["escape"] },
				{ key: "⌫", label: "delete", tier: "help", keys: ["backspace"] },
			],
		},
		// The footer under a committed search: its summary, then how to leave it. The board's own keys
		// all still work, and the sheet lists them under `board`.
		searchResults: {
			name: "search",
			sheet: true,
			bindings: [
				{ key: "esc", label: "clear", tier: "footer", keys: ["escape"] },
			],
		},
		detail: {
			name: "detail",
			sheet: true,
			bindings: [
				PICK_ANSWER,
				TYPE_ANSWER,
				{
					key: "b",
					label: "back to its tab",
					tier: "footer",
					keys: ["b"],
					when: (s) => s.back === true,
				},
				// Ahead of `space`: at forty columns the footer has room for one of them, and the digest
				// above the checklist's items is what asks to be opened.
				READ,
				{
					key: "space",
					label: "toggle item",
					tier: "footer",
					keys: ["space"],
					when: checklist,
				},
				OPEN_LINK,
				{
					key: "o",
					label: "events",
					tier: "footer",
					keys: ["o"],
					when: (s) => s.events === true || s.transcript === true,
				},
				{
					key: "h/l",
					label: "sections",
					tier: "footer",
					keys: ["h", "l", "left", "right"],
				},
				{ key: "v", label: "review", tier: "footer", keys: ["v"] },
				{ key: "y", label: "copy brief", tier: "footer", keys: ["y"] },
				{ key: "m", label: "mark", tier: "footer", keys: ["m"] },
				{
					key: "1",
					label: "now: what is in force",
					tier: "help",
					keys: ["1"],
					when: sections,
				},
				{
					key: "2-4",
					label: "description · comments · log",
					tier: "help",
					keys: ["2", "3", "4"],
					when: sections,
				},
				{
					key: "j/k",
					label: "scroll",
					tier: "help",
					keys: ["j", "k", "down", "up"],
				},
				{
					key: "J/K",
					label: "next · previous item",
					tier: "help",
					keys: ["J", "K"],
					when: checklist,
				},
				{ key: "a", label: "dispatch", tier: "help", keys: ["a"] },
				{ key: "n", label: "to next", tier: "help", keys: ["n"] },
				{ key: "s", label: "to someday", tier: "help", keys: ["s"] },
				{ key: "x", label: "cancel task", tier: "help", keys: ["x"] },
				{
					key: "esc q",
					label: "back to the board",
					tier: "help",
					keys: ["escape", "q"],
				},
			],
		},
		// A decision's text field on the detail view, while it has the keys: every key but these is
		// typed into it, so the detail's own hints would only type their letter.
		decisionText: {
			name: "decision",
			sheet: false,
			bindings: [
				{
					key: "enter",
					label: "send",
					tier: "footer",
					keys: [],
					routed: "textarea",
				},
				{ key: "esc", label: "start over", tier: "footer", keys: ["escape"] },
				{ key: "tab", label: "next pane", tier: "footer", keys: ["tab"] },
			],
		},
		transcript: {
			name: "transcript",
			sheet: true,
			bindings: [
				{
					key: "j/k",
					label: "scroll",
					tier: "footer",
					keys: ["j", "k", "down", "up"],
				},
				{
					key: "x",
					label: "stop the turn",
					tier: "footer",
					keys: ["x"],
					when: (s) => s.stoppable === true,
				},
				TOOL_DETAILS,
				{ key: "esc q", label: "back", tier: "footer", keys: ["escape", "q"] },
			],
		},
		// A host card on a tab of its own: its events, the question its sessions asked answered in
		// place, and `o` to the task that question is about.
		cardTab: {
			name: "tab",
			sheet: true,
			bindings: [
				PICK_ANSWER,
				TYPE_ANSWER,
				{
					key: "x",
					label: "stop",
					tier: "footer",
					keys: ["x"],
					when: (s) => s.stoppable === true,
				},
				{ key: "o", label: "its issue", tier: "footer", keys: ["o"] },
				{
					key: "w",
					label: "close tab",
					tier: "footer",
					keys: ["w"],
					when: (s) => s.closable === true,
				},
				{
					key: "h/l",
					label: "lanes",
					tier: "footer",
					keys: ["h", "l", "left", "right"],
					when: (s) => s.lanes === true,
				},
				{
					key: "e",
					label: "more",
					tier: "footer",
					keys: ["e"],
					when: (s) => s.header === true,
				},
				{
					key: "j/k",
					label: "scroll",
					tier: "help",
					keys: ["j", "k", "down", "up"],
				},
				{ ...TOOL_DETAILS, tier: "help" },
				{ key: "esc q", label: "tracker", tier: "help", keys: ["escape", "q"] },
			],
		},
		// Every key is a prompt character while the copilot has focus, so `?` types a `?`: no sheet.
		copilot: {
			name: "copilot",
			sheet: false,
			bindings: [
				{
					key: "enter",
					label: "send",
					tier: "footer",
					keys: [],
					routed: "textarea",
				},
				{
					key: "/",
					label: "shortcuts",
					tier: "footer",
					keys: [],
					routed: "textarea",
				},
				ESC_BOARD,
				{ key: "tab", label: "next pane", tier: "footer", keys: ["tab"] },
				{
					key: "↑",
					label: "previous prompt",
					tier: "help",
					keys: ["up"],
					when: (s) => s.history === true,
				},
			],
		},
		palette: {
			name: "shortcuts",
			sheet: false,
			bindings: [
				{ key: "↑↓", label: "pick", tier: "footer", keys: ["up", "down"] },
				{ key: "tab", label: "expand", tier: "footer", keys: ["tab"] },
				ESC_BOARD,
				{
					key: "enter",
					label: "expand",
					tier: "help",
					keys: [],
					routed: "textarea",
				},
			],
		},
		// The prompt a card's action or a typed answer opens: the copilot's input, so the same keys.
		prompt: {
			name: "prompt",
			sheet: false,
			bindings: [
				{
					key: "enter",
					label: "send",
					tier: "footer",
					keys: [],
					routed: "textarea",
				},
				{ key: "esc", label: "cancel", tier: "footer", keys: ["escape"] },
				{
					key: "tab",
					label: "send to another",
					tier: "footer",
					keys: ["tab", "shift+tab"],
					when: (s) => s.reaimable === true,
				},
				{
					key: "↑",
					label: "previous",
					tier: "footer",
					keys: ["up"],
					when: (s) => s.history === true,
				},
				{
					key: "⇧enter ⌃j",
					label: "newline",
					tier: "help",
					keys: [],
					routed: "textarea",
				},
			],
		},
		dispatch: {
			name: "dispatch",
			sheet: false,
			bindings: [
				{
					key: "enter",
					label: "run",
					tier: "footer",
					keys: ["return"],
					when: (s) => s.ready === true,
				},
				{ key: "esc", label: "close", tier: "footer", keys: ["escape"] },
				{
					key: "j/k",
					label: "move",
					tier: "help",
					keys: ["j", "k", "down", "up"],
					when: (s) => s.ready === true,
				},
				{
					key: "1-9",
					label: "pick",
					tier: "help",
					keys: ["1", "2"],
					when: (s) => s.ready === true,
				},
			],
		},
		// A trigger's settings before it fires (trigger-form.ts).
		dispatchForm: {
			name: "settings",
			sheet: false,
			bindings: [
				{ key: "enter", label: "start", tier: "footer", keys: ["return"] },
				{
					key: "h/l",
					label: "change",
					tier: "footer",
					keys: ["h", "l", "left", "right"],
				},
				{
					key: "j/k",
					label: "field",
					tier: "footer",
					keys: ["j", "k", "down", "up"],
				},
				{ key: "esc", label: "back", tier: "footer", keys: ["escape"] },
			],
		},
		// The sheet's own row: how to move through it and leave it.
		help: {
			name: "help",
			sheet: false,
			bindings: [
				{
					key: "j/k",
					label: "scroll",
					tier: "footer",
					keys: ["j", "k", "down", "up"],
					when: (s) => s.scrollable === true,
				},
				{
					key: "? esc",
					label: "close",
					tier: "footer",
					keys: ["?", "escape", "q"],
				},
			],
		},
		// The reader over the detail view: the lifted entries in full, its own scrollbox and keys.
		reader: {
			name: "reader",
			sheet: false,
			bindings: [
				{
					key: "[ ]",
					label: "headings",
					tier: "footer",
					keys: ["[", "]"],
				},
				{ key: "esc", label: "close", tier: "footer", keys: ["escape", "q"] },
				{
					key: "j/k",
					label: "scroll",
					tier: "footer",
					keys: ["j", "k", "down", "up"],
				},
				{ key: "?", label: "keys", tier: "footer", keys: ["?"] },
			],
		},
		// Every setting and where its value comes from (settings-view.ts), and the editor of the one
		// in hand. Typing a value takes the letters, so only the keys that are no letter work then.
		settings: {
			name: "settings",
			sheet: false,
			bindings: [
				{
					key: "j/k",
					label: "move",
					tier: "footer",
					keys: ["j", "k", "down", "up"],
					when: (s) =>
						s.settings === true &&
						s.settingEditing !== true &&
						s.settingConfirming !== true,
				},
				{
					key: "h/l",
					label: "change",
					tier: "footer",
					keys: ["h", "l", "left", "right"],
					when: (s) => s.settingSteps === true && s.settingConfirming !== true,
				},
				{
					key: "enter",
					label: "edit",
					tier: "footer",
					keys: ["return"],
					when: (s) =>
						s.settingEditable === true &&
						s.settingEditing !== true &&
						s.settingConfirming !== true,
				},
				{
					key: "enter",
					label: "details",
					tier: "footer",
					keys: ["return"],
					when: (s) => s.settings === true && s.settingEditable !== true,
				},
				{
					key: "x",
					label: "unset",
					tier: "footer",
					keys: ["x"],
					when: (s) =>
						s.settingUnsets === true &&
						s.settingEditing !== true &&
						s.settingConfirming !== true,
				},
				{
					key: "tab",
					label: "layer",
					tier: "footer",
					keys: ["tab", "shift+tab"],
					when: (s) => s.settingEditing === true && s.settingLayers === true,
				},
				{
					key: "enter",
					label: "save",
					tier: "footer",
					keys: ["return"],
					when: (s) => s.settingEditing === true,
				},
				{
					key: "y",
					label: "save",
					tier: "footer",
					keys: ["y"],
					when: (s) => s.settingConfirming === true,
				},
				{
					key: "n",
					label: "back",
					tier: "footer",
					keys: ["n"],
					when: (s) => s.settingConfirming === true,
				},
				{
					key: "esc",
					label: "cancel",
					tier: "footer",
					keys: ["escape"],
					when: (s) => s.settingEditing === true,
				},
				{
					key: "?",
					label: "keys",
					tier: "footer",
					keys: ["?"],
					when: (s) =>
						s.settingEditing !== true && s.settingConfirming !== true,
				},
				{
					key: ", esc",
					label: "close",
					tier: "footer",
					keys: [",", "escape"],
					when: (s) =>
						s.settingEditing !== true && s.settingConfirming !== true,
				},
			],
		},
		setupWelcome: {
			name: "setup",
			sheet: false,
			bindings: [
				{
					key: "enter",
					label: "set up",
					tier: "footer",
					keys: [],
					routed: "setup",
				},
				{
					key: "esc",
					label: "quit",
					tier: "footer",
					keys: [],
					routed: "setup",
				},
			],
		},
		setupForm: {
			name: "setup",
			sheet: false,
			bindings: [
				{
					key: "space",
					label: "toggle",
					tier: "footer",
					keys: [],
					routed: "setup",
					when: (s) => s.harnesses === true,
				},
				{
					key: "enter",
					label: "confirm",
					tier: "footer",
					keys: [],
					routed: "setup",
				},
				{
					key: "esc",
					label: "quit",
					tier: "footer",
					keys: [],
					routed: "setup",
				},
				// Tab and the arrows go unsaid in the footer, as j/k do on the board.
				{
					key: "tab ↑↓",
					label: "move",
					tier: "help",
					keys: [],
					routed: "setup",
				},
			],
		},
		// Enter's work is running and every key is ignored until it lands: nothing to say.
		setupWorking: { name: "setup", sheet: false, bindings: [] },
		setupDone: {
			name: "setup",
			sheet: false,
			bindings: [
				{
					key: "enter",
					label: "open the board",
					tier: "footer",
					keys: [],
					routed: "setup",
				},
				{ key: "q", label: "quit", tier: "footer", keys: [], routed: "setup" },
			],
		},
	};

	/**
	 * Whose keys a view's footer shows and what is true right now; app.tsx builds it from BoardNav.
	 * `host` is the card on screen's own actions, which no registry can list: the host names them.
	 */
	export type Live = {
		context: ContextId;
		situation: Situation;
		host?: readonly Hint[];
	};

	const available = (binding: Binding, situation: Situation): boolean =>
		binding.when === undefined || binding.when(situation);

	const asHint = (
		{ key, label, labelOf }: Binding,
		situation: Situation = {},
	): Hint => ({ key, label: labelOf?.(situation) ?? label });

	/**
	 * The footer for a context: a host card's own keys, then the context's available `footer` tier
	 * in order, then `? help` where the sheet opens.
	 */
	export const footer = (
		id: ContextId,
		situation: Situation = {},
		host: readonly Hint[] = [],
	): Hint[] => {
		const context = CONTEXTS[id];
		const own = context.bindings
			.filter((b) => b.tier === "footer" && available(b, situation))
			.map((b) => asHint(b, situation));
		// Where the sheet opens, so do the everywhere keys: `!` leads while something waits on you.
		const waiting = available(NEXT_QUESTION, situation)
			? [asHint(NEXT_QUESTION)]
			: [];
		return context.sheet
			? [...waiting, ...host, ...own, asHint(HELP)]
			: [...host, ...own];
	};

	type SheetRow = Hint & { available: boolean };
	export type SheetGroup = { title: string; rows: SheetRow[] };

	/**
	 * The `?` sheet for a context: a host card's own keys, its own keys under its name, then the keys
	 * that work everywhere.
	 */
	export const sheet = (
		id: ContextId,
		situation: Situation = {},
		host: readonly Hint[] = [],
	): SheetGroup[] => {
		const row = (binding: Binding): SheetRow => ({
			...asHint(binding, situation),
			available: available(binding, situation),
		});
		return [
			...(host.length > 0
				? [
						{
							title: "this card",
							rows: host.map((hint) => ({ ...hint, available: true })),
						},
					]
				: []),
			{ title: CONTEXTS[id].name, rows: CONTEXTS[id].bindings.map(row) },
			// A modal the sheet opens over keeps the keyboard: the everywhere keys wait until it closes.
			...(CONTEXTS[id].sheet
				? [{ title: "everywhere", rows: EVERYWHERE.map(row) }]
				: []),
		];
	};

	export const hintLine = (hints: readonly Hint[]): string =>
		hints.map((h) => `${h.key} ${h.label}`).join(" · ");

	/**
	 * The hints that fit `width` columns whole: hints drop from the end, never cut mid-word, and a
	 * trailing `? help` stays as long as it fits on its own, since it is the way to every hint dropped.
	 */
	export const fitHints = (hints: readonly Hint[], width: number): Hint[] => {
		if (hintLine(hints).length <= width) return [...hints];
		const last = hints.at(-1);
		const sticky = last?.key === HELP.key ? [last] : [];
		const body = hints.slice(0, hints.length - sticky.length);
		while (body.length > 0 && hintLine([...body, ...sticky]).length > width)
			body.pop();
		const kept = [...body, ...sticky];
		return hintLine(kept).length <= width ? kept : [];
	};
}
