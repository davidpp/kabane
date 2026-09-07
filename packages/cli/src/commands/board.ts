import type { Command } from "../context";
import type { Outcome } from "../output";

/** Replaced by `@cabane/board`'s `startBoard` once JCAB-9 merges. */
const pending: Outcome = {
	exitCode: 2,
	json: { error: "not yet available", lands: "JCAB-9" },
	text: "The kanban board lands with JCAB-9 (@cabane/board). Until then, use `cabane list`.",
};

export const board: Command = {
	name: "board",
	summary: "Open the terminal kanban (lands with JCAB-9)",
	usage: "cabane board",
	run: async () => pending,
};
