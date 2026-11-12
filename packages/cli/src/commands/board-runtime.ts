import { BoardCopilot, Harnesses } from "@cabane/acp";
import {
	Activity,
	type ActivitySource,
	type BoardDeps,
	type CardHeader,
	type Dispatcher,
	Dispatchers,
	Headers,
	type OpenRequests,
	type SettingsSource,
	startBoard,
} from "@cabane/board";
import { err, ok, Planner, type Result, type Task } from "@cabane/core";
import {
	type Extension,
	failure,
	flagString,
	type Outcome,
	type ParsedArgs,
	success,
} from "@cabane/extension";
import { configPath } from "../config";
import { ConfigSettings } from "../config-settings";
import {
	type Command,
	type Ctx,
	resolveScope,
	type ScopeSelection,
} from "../context";
import { Extensions } from "../extensions";
import { UpdateNotice } from "../update-notice";
import { BoardControl } from "./board-control";

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
	const flag = flagString(args, "copilot");
	const named = flag ?? ctx.config.copilot?.harness ?? "claude";
	if (Harnesses.isId(named)) return ok(named);
	const unknown = `Unknown copilot harness "${named}"; one of ${Harnesses.IDS.join(", ")}`;
	return err(
		new Error(
			flag === undefined
				? `${unknown}. Fix it with \`kabane config set copilot.harness <name>\`, \`kabane config unset copilot.harness\` for claude, or pass --copilot <name>.`
				: unknown,
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
 * The issue an id names in this device's tracker: a short id, a ULID or a ULID prefix, in any case.
 * `--issue` and the ids `--to` sends both go through it, so they accept the same ids and fail alike.
 */
const findIssue = async (
	store: string,
	input: string,
): Promise<Result<Task>> => {
	// ULIDs are upper case, and resolveTaskId returns a full one as typed.
	const id = await Planner.resolveTaskId(store, input.toUpperCase());
	const task = id.ok ? await Planner.getTask(store, id.value) : id;
	if (!task.ok) return task;
	return task.value
		? ok(task.value)
		: err(new Error(`No task found with ID: ${input}`));
};

/**
 * The issue `--issue` names, resolved before the renderer starts so an unknown one fails in one
 * line; undefined without the flag.
 */
export const boardIssue = async (
	args: ParsedArgs,
	ctx: Ctx,
): Promise<Result<Task | undefined>> => {
	if (args.flags.issue === undefined) return ok(undefined);
	const input = flagString(args, "issue");
	if (input === undefined)
		return err(new Error("--issue needs an issue id, e.g. --issue JCAB-12"));
	return findIssue(ctx.store, input);
};

/**
 * The scope the board opens on: `--scope`, else the issue's own scope when it named one (the
 * detected project when that is it, for its label and root), else the detected project. An issue
 * with no scope opens on all scopes, the only view that holds it.
 */
const boardScope = async (
	args: ParsedArgs,
	ctx: Ctx,
	issue: Task | undefined,
): Promise<ScopeSelection | undefined> => {
	const scope = await resolveScope(args, ctx);
	if (!issue || flagString(args, "scope") !== undefined) return scope;
	if (issue.scopeUri === undefined) return undefined;
	return scope?.scopeUri === issue.scopeUri
		? scope
		: { scopeUri: issue.scopeUri, label: issue.scopeUri };
};

/**
 * The enabled extensions' board ports, each merged under its extension's name
 * so ids route back to it. A port no extension fills stays absent, and the
 * board keeps its no-op default for it.
 */
const extensionPorts = async (
	extensions: readonly Extension[],
	ctx: Ctx,
): Promise<Pick<BoardDeps, "activity" | "dispatcher" | "headers">> => {
	const activity: Record<string, ActivitySource> = {};
	const dispatchers: Record<string, Dispatcher> = {};
	const headers: Record<string, Readonly<Record<string, CardHeader>>> = {};
	for (const extension of extensions) {
		const ports = await extension.board?.(ctx);
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

/** A value the board saves, as `kabane config set` reads it from the command line. */
const asInput = (value: string | number | boolean): string =>
	typeof value === "string" ? value : JSON.stringify(value);

/**
 * The `,` view's rows: `kabane config list` where the board was opened, for the scope `--scope`
 * names, and its saves: `kabane config set` there. Read each time the view opens, never at board
 * start: it imports every shipped extension.
 */
const settingsSource = (args: ParsedArgs, ctx: Ctx): SettingsSource => {
	const locate = () =>
		ConfigSettings.locate(ctx.home, ctx.cwd, flagString(args, "scope"));
	return {
		list: async () => {
			const where = await locate();
			return where.ok ? ConfigSettings.list(ctx.home, where.value) : where;
		},
		set: async (key, value, layer) => {
			const target = ConfigSettings.targetOf(layer);
			if (target === undefined)
				return err(new Error(`${layer} is no layer a setting is saved to`));
			const where = await locate();
			if (!where.ok) return where;
			return ConfigSettings.set(
				ctx.home,
				where.value,
				key,
				typeof value === "object" ? undefined : asInput(value),
				target,
			);
		},
	};
};

/**
 * What the CLI hands the board: this device's home as the storage handle, the
 * activity and dispatcher ports the enabled extensions contribute (no-op
 * defaults without any), the scope the CLI would have filtered on (the issue's,
 * with `--issue`), the issue to open on, a copilot on the chosen harness, the
 * settings the `,` view lists, and the release notice unless `updates.check`
 * is false.
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
	{
		extensions = [],
		issue,
		requests,
	}: {
		extensions?: readonly Extension[];
		issue?: Task;
		requests?: OpenRequests;
	} = {},
): Promise<BoardWiring> => {
	const scope = await boardScope(args, ctx, issue);
	const overrides = copilotOverrides(ctx);
	return {
		...(await extensionPorts(extensions, ctx)),
		...(ctx.config.updates?.check === false
			? {}
			: { announcer: UpdateNotice.announcer(ctx.home) }),
		...(issue ? { open: { taskId: issue.id } } : {}),
		settings: settingsSource(args, ctx),
		...(requests ? { requests } : {}),
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
			home: ctx.home,
			mode: ctx.harnessMode,
			setup: {
				configPath: configPath(ctx.home),
				extensions: Extensions.names,
			},
		}),
	};
};

/**
 * This board's control channel (BoardControl) and the port it feeds: an id sent with `--to` is
 * looked up in this device's tracker as `--issue` looks one up (findIssue) and handed to the board,
 * which subscribes once its first load is in. A board that cannot listen still runs, and `--to` then
 * finds no board, which is what it reports.
 */
export const listenForRequests = (
	ctx: Ctx,
	pid: number,
): { requests: OpenRequests; close: () => void } => {
	let open: ((task: Task) => void) | undefined;
	const requests: OpenRequests = {
		subscribe: (listener) => {
			open = listener;
			return () => {
				if (open === listener) open = undefined;
			};
		},
	};
	const listener = BoardControl.listen(
		BoardControl.socketPath(ctx.home, pid),
		async (input) => {
			if (!open)
				return err(new Error(`board pid ${pid} is still loading; try again`));
			const found = await findIssue(ctx.store, input);
			if (!found.ok) return found;
			open(found.value);
			return ok(found.value.shortId ?? found.value.id);
		},
	);
	return {
		requests,
		close: () => {
			if (listener.ok) listener.value.close();
		},
	};
};

/** `--issue <id> --to <pid>`: open the issue in the board running as that pid, with no TUI here. */
const openInRunningBoard = async (
	args: ParsedArgs,
	ctx: Ctx,
): Promise<Outcome> => {
	const to = flagString(args, "to");
	const pid = to !== undefined && /^\d+$/.test(to) ? Number(to) : 0;
	if (!Number.isSafeInteger(pid) || pid <= 0)
		return failure("--to needs a board's pid, e.g. --to 77516");
	const id = flagString(args, "issue");
	if (id === undefined)
		return failure("--to needs --issue <id>, the issue to open");
	const opened = await BoardControl.send(ctx.home, pid, id);
	if (!opened.ok) return failure(opened.error.message);
	return success(
		{ opened: opened.value, pid },
		`opened ${opened.value} in board pid ${pid}`,
	);
};

export const runBoard: Command["run"] = async (args, ctx) => {
	if (args.flags.to !== undefined) return openInRunningBoard(args, ctx);
	const issue = await boardIssue(args, ctx);
	if (!issue.ok) return failure(issue.error.message);
	// The board owns a full-screen renderer; on a pipe it would block forever.
	if (!process.stdout.isTTY)
		return failure("kabane board needs a terminal; use `kabane list` here");
	const harness = copilotHarness(args, ctx);
	if (!harness.ok) return failure(harness.error.message);
	const enabled = Extensions.enabled(ctx.home);
	if (!enabled.ok) return failure(enabled.error);
	const extensions = await Extensions.loadAll(enabled.value);
	if (!extensions.ok) return failure(extensions.error);
	const control = listenForRequests(ctx, process.pid);
	const deps = await boardDeps(args, ctx, harness.value, {
		extensions: extensions.value,
		issue: issue.value,
		requests: control.requests,
	});
	try {
		await startBoard(deps);
	} finally {
		// Nothing was spawned unless the human pressed `A`, and then this kills it.
		deps.copilot.close();
		control.close();
	}
	return success({ closed: true }, "");
};
