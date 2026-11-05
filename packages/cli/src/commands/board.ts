import { Keymap } from "@cabane/board/keymap";
import type { Command } from "../context";

export const board: Command = {
	name: "board",
	summary: "Open the terminal kanban for this device",
	usage: [
		"kabane board [--scope <uri>] [--copilot <harness>]",
		"",
		"Keys by view; availability depends on selection and state. Press ? in the board for current help and extension actions.",
		...[
			{ name: "everywhere the help sheet opens", bindings: Keymap.EVERYWHERE },
			...Object.values(Keymap.CONTEXTS),
		].flatMap(({ name, bindings }) => [
			"",
			`${name}:`,
			...bindings.map(({ key, label }) => `  ${key.padEnd(12)} ${label}`),
		]),
	].join("\n"),
	run: async (args, ctx) =>
		(await import("./board-runtime")).runBoard(args, ctx),
};
