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
		/** `esc` on the board has something to clear: marks, a committed search, a narrowed scope. */
		clearable?: boolean;
		/** The copilot's buffer is empty and there are prompts to recall. */
		history?: boolean;
		/** The dispatch picker has triggers to move through. */
		ready?: boolean;
		/** The `?` sheet is taller than the pane. */
		scrollable?: boolean;
		/** Setup found harnesses to tick. */
		harnesses?: boolean;
	};

	type Tier = "footer" | "help";

	type Binding = Hint & {
		tier: Tier;
		/** The key names this hint stands for, as nav.ts's KeyInput carries them. */
		keys: readonly string[];
		when?: (situation: Situation) => boolean;
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
		| "transcript"
		| "sidebar"
		| "copilot"
		| "palette"
		| "dispatch"
		| "help"
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

	/** `?` itself: last in every footer where the sheet opens. */
	const HELP: Binding = {
		key: "?",
		label: "help",
		tier: "footer",
		keys: ["?"],
	};

	/** The keys that work wherever the sheet opens: board, detail, transcript, sidebar. */
	export const EVERYWHERE: readonly Binding[] = [
		HELP,
		{ key: "A :", label: "ask the copilot", tier: "help", keys: ["A", ":"] },
		{
			key: "tab ⇧tab",
			label: "next · previous pane",
			tier: "help",
			keys: ["tab", "shift+tab"],
		},
		{ key: "b", label: "show · hide sidebar", tier: "help", keys: ["b"] },
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
					label: "tabs",
					tier: "footer",
					keys: ["h", "l", "left", "right"],
				},
				{ key: "v", label: "review", tier: "footer", keys: ["v"] },
				{ key: "y", label: "copy brief", tier: "footer", keys: ["y"] },
				{ key: "m", label: "mark", tier: "footer", keys: ["m"] },
				{
					key: "1-3",
					label: "go to a tab",
					tier: "help",
					keys: ["1", "2", "3"],
				},
				{
					key: "j/k",
					label: "scroll",
					tier: "help",
					keys: ["j", "k", "down", "up"],
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
				{ key: "esc q", label: "back", tier: "footer", keys: ["escape", "q"] },
			],
		},
		sidebar: {
			name: "sidebar",
			sheet: true,
			bindings: [
				{
					key: "j/k",
					label: "move",
					tier: "footer",
					keys: ["j", "k", "down", "up"],
				},
				{ key: "enter", label: "open", tier: "footer", keys: ["return"] },
				ESC_BOARD,
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

	/** Whose keys a view's footer shows and what is true right now; app.tsx builds it from BoardNav. */
	export type Live = { context: ContextId; situation: Situation };

	const available = (binding: Binding, situation: Situation): boolean =>
		binding.when === undefined || binding.when(situation);

	const asHint = ({ key, label }: Binding): Hint => ({ key, label });

	/** The footer for a context: its available `footer` tier in order, then `? help` where the sheet opens. */
	export const footer = (id: ContextId, situation: Situation = {}): Hint[] => {
		const context = CONTEXTS[id];
		const own = context.bindings
			.filter((b) => b.tier === "footer" && available(b, situation))
			.map(asHint);
		return context.sheet ? [...own, asHint(HELP)] : own;
	};

	type SheetRow = Hint & { available: boolean };
	export type SheetGroup = { title: string; rows: SheetRow[] };

	/** The `?` sheet for a context: its own keys under its name, then the keys that work everywhere. */
	export const sheet = (
		id: ContextId,
		situation: Situation = {},
	): SheetGroup[] => {
		const row = (binding: Binding): SheetRow => ({
			...asHint(binding),
			available: available(binding, situation),
		});
		return [
			{ title: CONTEXTS[id].name, rows: CONTEXTS[id].bindings.map(row) },
			{ title: "everywhere", rows: EVERYWHERE.map(row) },
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
