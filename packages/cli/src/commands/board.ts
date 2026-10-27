import { BoardCopilot, Harnesses } from "@cabane/acp";
import {
	Activity,
	type ActivitySource,
	type BoardDeps,
	type CardHeader,
	type Dispatcher,
	Dispatchers,
	Headers,
	startBoard,
} from "@cabane/board";
import { err, ok, type Result } from "@cabane/core";
import {
	type Extension,
	failure,
	flagString,
	type ParsedArgs,
	success,
} from "@cabane/extension";
import { configPath } from "../config";
import { type Command, type Ctx, resolveScope } from "../context";
import { Extensions } from "../extensions";

/**
 * The board's deps plus the copilot's teardown. The `Copilot` port carries no
 * `close` on purpose, so killing the harness process is the host's business:
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
	if (
		configured?.command === undefined &&
		configured?.args === undefined &&
		configured?.model === undefined
	)
		return undefined;
	return {
		...(configured.command !== undefined
			? { command: configured.command }
			: {}),
		...(configured.args !== undefined ? { args: configured.args } : {}),
		...(configured.model !== undefined ? { model: configured.model } : {}),
	};
};

/**
 * The enabled extensions' board ports, each merged under its extension's name
 * so ids route back to it. A port no extension fills stays absent, and the
 * board keeps its no-op default for it.
 */
const extensionPorts = (
	extensions: readonly Extension[],
	ctx: Ctx,
): Pick<BoardDeps, "activity" | "dispatcher" | "headers"> => {
	const activity: Record<string, ActivitySource> = {};
	const dispatchers: Record<string, Dispatcher> = {};
	const headers: Record<string, Readonly<Record<string, CardHeader>>> = {};
	for (const extension of extensions) {
		const ports = extension.board?.(ctx);
		if (ports?.activity) activity[extension.name] = ports.activity;
		if (ports?.dispatcher) dispatchers[extension.name] = ports.dispatcher;
		if (ports?.headers) headers[extension.name] = ports.headers;
	}
	return {
		...(Object.keys(activity).length > 0
			? { activity: Activity.merge(activity) }
			: {}),
		...(Object.keys(dispatchers).length > 0
			? { dispatcher: Dispatchers.merge(dispatchers) }
			: {}),
		...(Object.keys(headers).length > 0
			? { headers: Headers.merge(headers) }
			: {}),
	};
};

/**
 * What the CLI hands the board: this device's home as the storage handle, the
 * activity and dispatcher ports the enabled extensions contribute (no-op
 * defaults without any), the scope the CLI would have filtered on, and a
 * copilot on the chosen harness.
 *
 * The scope is resolved here rather than passed through as a resolver, because
 * the copilot needs the same answer the board shows: the project directory as
 * the harness cwd, and the URI for `kabane mcp --scope`, so a write lands in the
 * scope on screen instead of wherever the adapter happened to start the server.
 * `run` has already checked for a TTY, so a piped `kabane board` still detects
 * nothing.
 */
export const boardDeps = async (
	args: ParsedArgs,
	ctx: Ctx,
	harness: Harnesses.Id,
	extensions: readonly Extension[] = [],
): Promise<BoardWiring> => {
	const scope = await resolveScope(args, ctx);
	const overrides = copilotOverrides(ctx);
	return {
		...extensionPorts(extensions, ctx),
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
			setup: {
				configPath: configPath(ctx.home),
				extensions: Extensions.names,
			},
		}),
	};
};

export const board: Command = {
	name: "board",
	summary: "Open the terminal kanban for this device",
	usage: "kabane board [--scope <uri>] [--copilot <harness>]",
	run: async (args, ctx) => {
		// The board owns a full-screen renderer; on a pipe it would block forever.
		if (!process.stdout.isTTY)
			return failure("kabane board needs a terminal; use `kabane list` here");
		const harness = copilotHarness(args, ctx);
		if (!harness.ok) return failure(harness.error.message);
		const enabled = Extensions.enabled(ctx.home);
		if (!enabled.ok) return failure(enabled.error);
		const extensions = await Extensions.loadAll(enabled.value);
		if (!extensions.ok) return failure(extensions.error);
		const deps = await boardDeps(args, ctx, harness.value, extensions.value);
		try {
			await startBoard(deps);
		} finally {
			// Nothing was spawned unless the human pressed `A`, and then this kills it.
			deps.copilot.close();
		}
		return success({ closed: true }, "");
	},
};
