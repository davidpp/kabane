import { type BoardDeps, startBoard } from "@cabane/board";
import type { ParsedArgs } from "../args";
import { type Command, type Ctx, resolveScope } from "../context";
import { failure, success } from "../output";

/**
 * What the CLI hands the board: this device's home as the storage handle,
 * both host ports at their no-op defaults (no activity feed, no dispatcher —
 * those are a host's business, JCAB-14 is Jake's), and the CLI's own scope
 * rule (`--scope`, else `./.cabane/scope`) so the board opens where `list`
 * would. Pure so the wiring is testable without a TTY.
 */
export const boardDeps = (args: ParsedArgs, ctx: Ctx): BoardDeps => {
	const scopeUri = resolveScope(args, ctx);
	return {
		cwd: ctx.cwd,
		basePath: ctx.home,
		resolveScope: async () => (scopeUri ? { scopeUri, label: scopeUri } : null),
	};
};

export const board: Command = {
	name: "board",
	summary: "Open the terminal kanban for this device",
	usage: "cabane board [--scope <uri>]",
	run: async (args, ctx) => {
		// The board owns a full-screen renderer; on a pipe it would block forever.
		if (!process.stdout.isTTY)
			return failure("cabane board needs a terminal; use `cabane list` here");
		await startBoard(boardDeps(args, ctx));
		return success({ closed: true }, "");
	},
};
