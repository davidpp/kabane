// Single source of truth for keybinding hints. The footers show only the app-specific keys (the
// vim-obvious ones — j/k, space, enter — earn nothing by being spelled out and were drowning the
// footer); the `?` help overlay renders the FULL grouped list. Reducers in nav.ts stay the actual
// binding authority — this module is display copy only, kept adjacent so a binding change has one
// obvious hint to update.
export namespace Keymap {
	export type Hint = { key: string; label: string };
	export type HelpGroup = { title: string; hints: readonly Hint[] };

	// Board footer: the discoverable, app-specific actions. Everything else lives behind `?`.
	export const BOARD_FOOTER: readonly Hint[] = [
		{ key: "a", label: "dispatch" },
		{ key: "/", label: "search" },
		{ key: "d", label: "done" },
		{ key: "v", label: "review" },
		{ key: "y", label: "copy" },
		{ key: "m", label: "mark" },
		{ key: "b", label: "sidebar" },
		{ key: "?", label: "help" },
	];

	// Shown while the copilot pane has focus: every board key is a prompt character there, so the
	// board's own hints would be a lie.
	export const COPILOT_FOOTER: readonly Hint[] = [
		{ key: "enter", label: "send" },
		{ key: "/", label: "shortcuts (↑↓ pick)" },
		{ key: "tab", label: "next pane" },
		{ key: "esc", label: "board" },
	];

	export const DETAIL_FOOTER: readonly Hint[] = [
		{ key: "h/l", label: "tabs" },
		{ key: "a", label: "dispatch" },
		{ key: "v", label: "review" },
		{ key: "y", label: "copy" },
		{ key: "m", label: "mark" },
		{ key: "?", label: "help" },
	];

	// Prepended to either footer only while the task in hand has a linked issue. Most tasks do not, and
	// a hint for an action that would flash "no linked issue" is worse than no hint in a narrow pane.
	// The `?` overlay lists it unconditionally, which is what makes it discoverable at all.
	export const OPEN_LINK_HINT: Hint = { key: "O", label: "open issue" };

	// The full list, grouped for the help overlay. Keep every binding here — this is the reference
	// the trimmed footers point at.
	export const HELP_GROUPS: readonly HelpGroup[] = [
		{
			title: "navigate",
			hints: [
				{ key: "j/k", label: "move row (detail: scroll)" },
				{ key: "space", label: "expand/collapse subtasks" },
				{ key: "h/l", label: "collapse · expand (h on child: parent)" },
				{ key: "1-3 h/l", label: "detail: switch tab" },
				{ key: "enter", label: "open detail" },
				{
					key: "esc",
					label: "back · clear marks · clear search · widen scope",
				},
			],
		},
		{
			title: "task state",
			hints: [
				{ key: "[ ]", label: "move through GTD states" },
				{ key: "d", label: "done" },
				{ key: "v", label: "mark reviewed" },
				{ key: "x", label: "cancel" },
				{ key: "n", label: "next" },
				{ key: "s", label: "someday" },
			],
		},
		{
			title: "actions",
			hints: [
				{ key: "a", label: "dispatch (host triggers)" },
				{
					key: "A or :",
					label: "focus the copilot on the selection (/ for shortcuts)",
				},
				{
					key: "o",
					label:
						"event log: the copilot's transcript, else the task's (detail)",
				},
				{ key: "O", label: "open the linked issue in its app or the browser" },
				{ key: "y", label: "copy agent brief" },
				{ key: "m", label: "mark / unmark (the copilot's working set)" },
				{ key: "⌃z", label: "undo last change" },
				{ key: "/", label: "search (filter as you type)" },
				{ key: "i", label: "cycle kind filter" },
				{ key: "f", label: "cycle status (open · done+cancelled · review)" },
				{ key: "b", label: "toggle sidebar" },
				{ key: "tab / ⇧tab", label: "focus board · copilot · sidebar" },
				{ key: "r", label: "refresh" },
				{ key: "q", label: "quit (detail: back)" },
			],
		},
	];

	export const hintLine = (hints: readonly Hint[]): string =>
		hints.map((h) => `${h.key} ${h.label}`).join(" · ");
}
