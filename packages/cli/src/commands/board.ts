import { type BoardDeps, startBoard } from "@cabane/board";
import type { ParsedArgs } from "../args";
import { type Command, type Ctx, resolveScope } from "../context";
import { failure, success } from "../output";

/**
 * What the CLI hands the board: this device's home as the storage handle,
 * both host ports at their no-op defaults (no activity feed, no dispatcher —
 * those are a host's business, JCAB-14 is Jake's), and the CLI's own scope
 * rule, so the board opens where `list` would. The board calls the port with
 * its own cwd; it is the same one, and passing the resolver through rather
 * than a resolved value keeps the detection lazy and off the TTY path.
 */
export const boardDeps = (args: ParsedArgs, ctx: Ctx): BoardDeps => ({
	cwd: ctx.cwd,
	basePath: ctx.store,
	resolveScope: async () => (await resolveScope(args, ctx)) ?? null,
});

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
