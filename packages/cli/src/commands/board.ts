import { Keymap } from "@cabane/board/keymap";
import type { Command } from "../context";

export const board: Command = {
	name: "board",
	summary: "Open the terminal kanban for this device",
	usage: [
		"kabane board [--issue <id>] [--scope <uri>] [--copilot <harness>]",
		"kabane board --issue <id> --to <pid>",
		"",
		"--issue opens on that issue's detail (a short id or a ULID), on its own scope unless --scope says otherwise.",
		"--to opens it in the board already running as that pid instead, from any terminal, and starts no board here.",
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
