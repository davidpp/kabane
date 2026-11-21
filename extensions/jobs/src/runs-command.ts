// `kabane runs [--all] [--ended]` and `kabane runs attach|read|send|stop <id>`. A run's state is what its
// runtime says: every listing reads this machine's unfinished runs from the runtime first and
// writes back the ones that moved. A run started on another machine, or in a runtime this kabane
// does not have, shows what was last recorded.
import { hostname } from "node:os";
import { basename } from "node:path";
import type { Extension, Host, Outcome } from "@kabane/extension";
import { Harness } from "./harness";
import { ok } from "./result";
import { projectOf, shortIdOf } from "./run-command";
import { Runs } from "./runs";
import type { Runtime } from "./runtime";

const USAGE =
	"kabane runs [--all] [--ended] | kabane runs attach|read|stop <id> | kabane runs send <id> <text>";

/** "4m", "2h", "3d": how long ago `iso` was. */
const age = (iso: string, now = Date.now()): string => {
	const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
};

export const pad = (rows: string[][]): string => {
	const widths = rows[0]?.map((_, column) =>
		Math.max(...rows.map((row) => row[column]?.length ?? 0)),
	);
	return rows
		.map((row) =>
			row
				.map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
};

/**
 * A scope's name as a reader knows it: its id, the folder's name when the id is a path (a
 * repository's scope), or the URI when it has none.
 */
const projectName = (host: Host, uri: string): string => {
	const id = host.scope.idOf(uri);
	return id.ok ? basename(id.value) : uri;
};

/**
 * The one run `key` names, its whole id or the end of it, on this machine: looked for in the
 * project of `cwd` first, then in every scope, so a command printed in one folder works in any.
 */
const resolve = async (
	host: Host,
	cwd: string,
	key: string | undefined,
	verb: string,
): Promise<{ ok: true; value: Runs.Run } | { ok: false; outcome: Outcome }> => {
	const fail = (outcome: Outcome) => ({ ok: false as const, outcome });
	if (key === undefined)
		return fail(host.outcome.usage(`runs ${verb} needs a run id`, USAGE));
	const here = await host.scope.detect(cwd);
	if (!here.ok) return fail(host.outcome.failure(here.error));
	let found: Runs.Run[] = [];
	if (here.value !== null) {
		const inProject = await Runs.find(host, here.value.scopeUri, key);
		if (!inProject.ok) return fail(host.outcome.failure(inProject.error));
		found = inProject.value;
	}
	if (found.length === 0) {
		const anywhere = await Runs.find(host, undefined, key);
		if (!anywhere.ok) return fail(host.outcome.failure(anywhere.error));
		found = anywhere.value;
	}
	const [run, other] = found;
	if (run === undefined)
		return fail(
			host.outcome.failure(
				`No run "${key}" in any project; kabane runs --all --ended lists them all`,
			),
		);
	if (other !== undefined)
		return fail(
			host.outcome.failure(
				`"${key}" names ${found.length} runs (${found.map((r) => `${r.id} in ${projectName(host, r.scope)}`).join(", ")}); give more of the id`,
			),
		);
	if (run.machine !== hostname())
		return fail(
			host.outcome.failure(
				`Run ${run.id} runs on ${run.machine}, not on this machine (${hostname()}); ${verb} it there`,
			),
		);
	return { ok: true, value: run };
};

/** `attach`, `read`, `send` or `stop` on one run of this machine. */
type Operation = { run: Runs.Run; verb: string; words: string[] };

const operate = async (
	host: Host,
	runtime: Runtime,
	actor: string,
	{ run, verb, words }: Operation,
): Promise<Outcome> => {
	if (run.runtime !== runtime.name)
		return host.outcome.failure(
			`Run ${run.id} runs in ${run.runtime}, which this kabane does not have`,
		);
	const lacks = (operation: string) =>
		host.outcome.failure(
			`Run ${run.id} runs in ${run.runtime}, which has no terminal to ${operation}`,
		);
	if (verb === "read") {
		if (runtime.read === undefined) return lacks("read");
		const screen = await runtime.read(run.session);
		return screen.ok
			? host.outcome.success(
					{ run: run.id, screen: screen.value },
					screen.value.trimEnd(),
				)
			: host.outcome.failure(screen.error);
	}
	if (verb === "send") {
		if (words.length === 0)
			return host.outcome.usage("runs send needs the text to type", USAGE);
		if (runtime.send === undefined) return lacks("send to");
		const text = words.join(" ");
		const sent = await runtime.send(run.session, text);
		return sent.ok
			? host.outcome.success(
					{ run: run.id, sent: text },
					`Sent to ${run.session}.`,
				)
			: host.outcome.failure(sent.error);
	}
	if (verb === "stop") {
		const state = await Runs.stop(host, runtime, run, actor);
		if (!state.ok) return host.outcome.failure(state.error);
		return host.outcome.success(
			{ run: run.id, state: state.value },
			`Stopped ${run.session}; run ${run.id} is ${state.value}.`,
		);
	}
	if (runtime.attach === undefined) return lacks("attach to");
	const attached = await runtime.attach(run.session);
	if (!attached.ok) return host.outcome.failure(attached.error);
	return attached.value === 0
		? host.outcome.success({ run: run.id }, "")
		: host.outcome.failure(
				`${run.runtime} attach exited with ${attached.value}`,
			);
};

export const runsCommand = (
	host: Host,
	runtime: Runtime,
): Extension.Command => {
	const listing = async (
		ctx: Extension.Ctx,
		/** One project's scope, or none for every project's runs. */
		scope: string | undefined,
		ended: boolean,
	): Promise<Outcome> => {
		const stored = await Runs.list(host, scope);
		if (!stored.ok) return host.outcome.failure(stored.error);
		// Without the runtime nothing can be read, so the recorded states stand.
		const runs =
			runtime.missing() === undefined
				? await Runs.reconcile(host, runtime, stored.value, ctx.actor)
				: ok(stored.value);
		if (!runs.ok) return host.outcome.failure(runs.error);
		const shown = runs.value.filter((run) => ended || run.state !== "ended");
		// A target, an issue or a job, shows its short id.
		const targets = new Map<string, string>();
		for (const { target } of shown)
			if (target && !targets.has(target.id))
				targets.set(target.id, await shortIdOf(host, target.id));
		if (shown.length === 0) {
			const where = scope === undefined ? "" : " in this project";
			const more = [
				ended ? undefined : "--ended shows ended ones",
				scope === undefined ? undefined : "--all shows every project's",
			].filter(Boolean);
			return host.outcome.success(
				{ runs: [] },
				`No runs${ended ? "" : " in flight"}${where}${more.length > 0 ? `; ${more.join(", ")}` : ""}.`,
			);
		}
		const here = hostname();
		const rows = shown.map((run) => [
			run.id,
			...(scope === undefined ? [projectName(host, run.scope)] : []),
			run.machine === here ? run.state : `${run.state} (on ${run.machine})`,
			run.recipe.name,
			run.target === undefined
				? "-"
				: (targets.get(run.target.id) ?? run.target.id),
			run.session,
			age(run.startedAt),
			run.harness === undefined ? "-" : Harness.line(run.harness),
		]);
		return host.outcome.success(
			{ runs: shown },
			pad([
				[
					"ID",
					...(scope === undefined ? ["PROJECT"] : []),
					"STATE",
					"RECIPE",
					"TARGET",
					"TERMINAL",
					"AGE",
					"HARNESS",
				],
				...rows,
			]),
		);
	};

	return {
		name: "runs",
		summary: "List recipe runs; attach to, read, send to or stop one",
		usage: USAGE,
		run: async (args, ctx) => {
			const [verb, key, ...words] = args.positionals;
			if (verb === undefined) {
				const ended = host.args.flagBool(args, "ended");
				if (host.args.flagBool(args, "all"))
					return listing(ctx, undefined, ended);
				const project = await projectOf(host, ctx.cwd, "runs");
				if (!project.ok) return project.outcome;
				return listing(ctx, project.value.scopeUri, ended);
			}
			if (!["attach", "read", "send", "stop"].includes(verb))
				return host.outcome.usage(`Unknown runs subcommand: ${verb}`, USAGE);
			if (verb !== "send" && words.length > 0)
				return host.outcome.usage(
					`Unexpected arguments: ${words.join(" ")}`,
					USAGE,
				);
			const found = await resolve(host, ctx.cwd, key, verb);
			if (!found.ok) return found.outcome;
			return operate(host, runtime, ctx.actor, {
				run: found.value,
				verb,
				words,
			});
		},
	};
};
