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
		{ key: "b", label: "sidebar" },
		{ key: "?", label: "help" },
	];

	export const DETAIL_FOOTER: readonly Hint[] = [
		{ key: "a", label: "dispatch" },
		{ key: "v", label: "review" },
		{ key: "y", label: "copy" },
		{ key: "?", label: "help" },
	];

	// The full list, grouped for the help overlay. Keep every binding here — this is the reference
	// the trimmed footers point at.
	export const HELP_GROUPS: readonly HelpGroup[] = [
		{
			title: "navigate",
			hints: [
				{ key: "j/k", label: "move row (detail: scroll)" },
				{ key: "space", label: "expand/collapse subtasks" },
				{ key: "h/l", label: "collapse · expand (h on child: parent)" },
				{ key: "enter", label: "open detail" },
				{ key: "esc", label: "back · clear search · widen scope" },
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
				{ key: "o", label: "open event log (detail view)" },
				{ key: "y", label: "copy agent brief" },
				{ key: "⌃z", label: "undo last change" },
				{ key: "/", label: "search (filter as you type)" },
				{ key: "i", label: "cycle kind filter" },
				{ key: "b", label: "toggle sidebar" },
				{ key: "tab", label: "focus sidebar / board" },
				{ key: "r", label: "refresh" },
				{ key: "q", label: "quit (detail: back)" },
			],
		},
	];

	export const hintLine = (hints: readonly Hint[]): string =>
		hints.map((h) => `${h.key} ${h.label}`).join(" · ");
}
