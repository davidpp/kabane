import { BoardCopilot, Harnesses } from "@cabane/acp";
import { type BoardDeps, startBoard } from "@cabane/board";
import { err, ok, type Result } from "@cabane/core";
import { flagString, type ParsedArgs } from "../args";
import { type Command, type Ctx, resolveScope } from "../context";
import { failure, success } from "../output";

/**
 * The board's deps plus the copilot's teardown. The `Copilot` port is three
 * methods on purpose, so killing the harness process is the host's business:
 * `run` closes the handle when the board comes down.
 */
export type BoardWiring = BoardDeps & { copilot: BoardCopilot.Handle };

/**
 * Which harness the copilot talks to: `--copilot` for one run, else the config,
 * else Claude. The config holds a plain string so that no other command pays for
 * an ACP import, which makes this the place the name is checked.
 */
export const copilotHarness = (
	args: ParsedArgs,
	ctx: Ctx,
): Result<Harnesses.Id> => {
	const named =
		flagString(args, "copilot") ?? ctx.config.copilot?.harness ?? "claude";
	return Harnesses.isId(named)
		? ok(named)
		: err(
				new Error(
					`Unknown copilot harness "${named}"; one of ${Harnesses.IDS.join(", ")}`,
				),
			);
};

const copilotOverrides = (ctx: Ctx): Harnesses.Overrides | undefined => {
	const configured = ctx.config.copilot;
	if (configured?.command === undefined && configured?.args === undefined)
		return undefined;
	return {
		...(configured.command !== undefined
			? { command: configured.command }
			: {}),
		...(configured.args !== undefined ? { args: configured.args } : {}),
	};
};

/**
 * What the CLI hands the board: this device's home as the storage handle, the
 * activity and dispatcher ports at their no-op defaults (a host's business,
 * JCAB-14 is Jake's), the scope the CLI would have filtered on, and a copilot on
 * the chosen harness.
 *
 * The scope is resolved here rather than passed through as a resolver, because
 * the copilot needs the same answer the board shows: the project directory as
 * the harness cwd, and the URI for `cabane mcp --scope`, so a write lands in the
 * scope on screen instead of wherever the adapter happened to start the server.
 * `run` has already checked for a TTY, so a piped `cabane board` still detects
 * nothing.
 */
export const boardDeps = async (
	args: ParsedArgs,
	ctx: Ctx,
	harness: Harnesses.Id,
): Promise<BoardWiring> => {
	const scope = await resolveScope(args, ctx);
	const overrides = copilotOverrides(ctx);
	return {
		cwd: ctx.cwd,
		basePath: ctx.store,
		// The board wants a URI and a label; the project root is the copilot's business.
		resolveScope: async () =>
			scope ? { scopeUri: scope.scopeUri, label: scope.label } : null,
		copilot: BoardCopilot.create({
			harness,
			// The harness reads the project's own CLAUDE.md / AGENTS.md from its cwd. A
			// `--scope` URI names a scope without saying where it is checked out, so the
			// directory the board was opened from stands in for it.
			scopeDir: scope?.root ?? ctx.cwd,
			...(scope ? { scopeUri: scope.scopeUri } : {}),
			...(overrides ? { overrides } : {}),
		}),
	};
};

export const board: Command = {
	name: "board",
	summary: "Open the terminal kanban for this device",
	usage: "cabane board [--scope <uri>] [--copilot <harness>]",
	run: async (args, ctx) => {
		// The board owns a full-screen renderer; on a pipe it would block forever.
		if (!process.stdout.isTTY)
			return failure("cabane board needs a terminal; use `cabane list` here");
		const harness = copilotHarness(args, ctx);
		if (!harness.ok) return failure(harness.error.message);
		const deps = await boardDeps(args, ctx, harness.value);
		try {
			await startBoard(deps);
		} finally {
			// Nothing was spawned unless the human pressed `A`, and then this kills it.
			deps.copilot.close();
		}
		return success({ closed: true }, "");
	},
};
