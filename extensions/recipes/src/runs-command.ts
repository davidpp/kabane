// `kabane runs [--all]` and `kabane runs attach|read|send|stop <id>`. A run's state is what its
// runtime says: every listing reads this machine's unfinished runs from the runtime first and
// writes back the ones that moved. A run started on another machine, or in a runtime this kabane
// does not have, shows what was last recorded.
import { hostname } from "node:os";
import type { Extension, Host, Outcome, Result } from "@cabane/extension";
import { ok } from "./result";
import { projectOf } from "./run-command";
import { Runs } from "./runs";
import type { Runtime } from "./runtime";

const USAGE =
	"kabane runs [--all] | kabane runs attach|read|stop <id> | kabane runs send <id> <text>";

/** "4m", "2h", "3d": how long ago `iso` was. */
const age = (iso: string, now = Date.now()): string => {
	const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
};

/** Each unfinished run of this machine, with the state its runtime reports now. */
export const reconcile = async (
	host: Host,
	runtime: Runtime,
	runs: Runs.Run[],
	actor: string,
): Promise<Result<Runs.Run[]>> => {
	const here = hostname();
	const current: Runs.Run[] = [];
	for (const recorded of runs) {
		if (
			recorded.machine !== here ||
			recorded.state === "ended" ||
			recorded.runtime !== runtime.name
		) {
			current.push(recorded);
			continue;
		}
		let run = recorded;
		// A run still starting may be one whose start was interrupted before its session was
		// written: the runtime finds that session, or holds none and the run never started.
		if (run.session === Runs.STARTING) {
			if (runtime.find === undefined) {
				current.push(run);
				continue;
			}
			const found = await runtime.find(run.id);
			if (!found.ok) return found;
			if (found.value === undefined) {
				const ended = await Runs.endStarting(host, run.id, actor);
				if (!ended.ok) return ended;
				current.push(
					ended.value
						? { ...run, state: "ended", endedAt: new Date().toISOString() }
						: run,
				);
				continue;
			}
			const written = await Runs.setSession(host, run.id, found.value, actor);
			if (!written.ok) return written;
			run = { ...run, session: found.value };
		}
		const seen = await runtime.get(run.session);
		if (!seen.ok) return seen;
		if (seen.value === run.state) {
			current.push(run);
			continue;
		}
		const written = await Runs.setState(host, run.id, seen.value, actor);
		if (!written.ok) return written;
		current.push({
			...run,
			state: seen.value,
			...(seen.value === "ended" ? { endedAt: new Date().toISOString() } : {}),
		});
	}
	return ok(current);
};

const pad = (rows: string[][]): string => {
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

/** The one run of this scope `key` names, on this machine. */
const resolve = async (
	host: Host,
	scope: string,
	key: string | undefined,
	verb: string,
): Promise<{ ok: true; value: Runs.Run } | { ok: false; outcome: Outcome }> => {
	const fail = (outcome: Outcome) => ({ ok: false as const, outcome });
	if (key === undefined)
		return fail(host.outcome.usage(`runs ${verb} needs a run id`, USAGE));
	const found = await Runs.find(host, scope, key);
	if (!found.ok) return fail(host.outcome.failure(found.error));
	const [run, other] = found.value;
	if (run === undefined)
		return fail(
			host.outcome.failure(
				`No run "${key}" in this project; kabane runs --all lists them`,
			),
		);
	if (other !== undefined)
		return fail(
			host.outcome.failure(
				`"${key}" names ${found.value.length} runs (${found.value.map((r) => r.id).join(", ")}); give more of the id`,
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

/** "read", "stop", "send to", "attach to": what a verb does to a run, in a sentence. */
const object = (verb: string): string =>
	verb === "send" || verb === "attach" ? `${verb} to` : verb;

/**
 * The run with the session a verb acts on. A run recorded as starting gets its session, or its
 * end, from the runtime first; one still without a session answers in place of any runtime call,
 * because an empty session would reach hc as no terminal at all and hc would pick one of its own.
 */
const settle = async (
	host: Host,
	runtime: Runtime,
	actor: string,
	recorded: Runs.Run,
	verb: string,
): Promise<{ ok: true; value: Runs.Run } | { ok: false; outcome: Outcome }> => {
	const answer = (outcome: Outcome) => ({ ok: false as const, outcome });
	if (recorded.session !== Runs.STARTING) return { ok: true, value: recorded };
	let run = recorded;
	if (runtime.missing() === undefined) {
		const now = await reconcile(host, runtime, [run], actor);
		if (!now.ok) return answer(host.outcome.failure(now.error));
		run = now.value[0] ?? run;
	}
	if (run.session !== Runs.STARTING) return { ok: true, value: run };
	if (run.state !== "ended")
		return answer(
			host.outcome.failure(
				`Run ${run.id} has no terminal yet: its start has not finished, so there is nothing to ${object(verb)}`,
			),
		);
	return answer(
		verb === "stop"
			? host.outcome.success(
					{ run: run.id, state: run.state },
					`Run ${run.id} never started in ${run.runtime}; it is ended.`,
				)
			: host.outcome.failure(
					`Run ${run.id} never started in ${run.runtime}: there is no terminal to ${object(verb)}`,
				),
	);
};

/** `attach`, `read`, `send` or `stop` on one run of this machine. */
type Operation = { run: Runs.Run; verb: string; words: string[] };

const operate = async (
	host: Host,
	runtime: Runtime,
	actor: string,
	{ run: resolved, verb, words }: Operation,
): Promise<Outcome> => {
	if (resolved.runtime !== runtime.name)
		return host.outcome.failure(
			`Run ${resolved.id} runs in ${resolved.runtime}, which this kabane does not have`,
		);
	const settled = await settle(host, runtime, actor, resolved, verb);
	if (!settled.ok) return settled.outcome;
	const run = settled.value;
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
		const stopped = await runtime.stop(run.session);
		if (!stopped.ok) return host.outcome.failure(stopped.error);
		const now = await reconcile(host, runtime, [run], actor);
		if (!now.ok) return host.outcome.failure(now.error);
		const state = now.value[0]?.state ?? run.state;
		return host.outcome.success(
			{ run: run.id, state },
			`Stopped ${run.session}; run ${run.id} is ${state}.`,
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
		scope: string,
		all: boolean,
	): Promise<Outcome> => {
		const stored = await Runs.list(host, scope);
		if (!stored.ok) return host.outcome.failure(stored.error);
		// Without the runtime nothing can be read, so the recorded states stand.
		const runs =
			runtime.missing() === undefined
				? await reconcile(host, runtime, stored.value, ctx.actor)
				: ok(stored.value);
		if (!runs.ok) return host.outcome.failure(runs.error);
		const shown = runs.value.filter((run) => all || run.state !== "ended");
		// An issue target shows its short id; any other kind shows its id.
		const targets = new Map<string, string>();
		for (const { target } of shown)
			if (target?.kind === "issue" && !targets.has(target.id)) {
				const task = await host.record.get({ id: target.id });
				targets.set(
					target.id,
					task.ok && task.value ? (task.value.shortId ?? target.id) : target.id,
				);
			}
		if (shown.length === 0)
			return host.outcome.success(
				{ runs: [] },
				all
					? "No runs in this project."
					: "No runs in flight in this project; --all shows ended ones.",
			);
		const here = hostname();
		const rows = shown.map((run) => [
			run.id,
			run.machine === here ? run.state : `${run.state} (on ${run.machine})`,
			run.recipe.name,
			run.target === undefined
				? "-"
				: (targets.get(run.target.id) ?? run.target.id),
			run.session,
			age(run.startedAt),
		]);
		return host.outcome.success(
			{ runs: shown },
			pad([["ID", "STATE", "RECIPE", "TARGET", "TERMINAL", "AGE"], ...rows]),
		);
	};

	return {
		name: "runs",
		summary: "List recipe runs; attach to, read, answer or stop one",
		usage: USAGE,
		run: async (args, ctx) => {
			const project = await projectOf(host, ctx.cwd, "runs");
			if (!project.ok) return project.outcome;
			const scope = project.value.scopeUri;
			const [verb, key, ...words] = args.positionals;
			if (verb === undefined)
				return listing(ctx, scope, host.args.flagBool(args, "all"));
			if (!["attach", "read", "send", "stop"].includes(verb))
				return host.outcome.usage(`Unknown runs subcommand: ${verb}`, USAGE);
			if (verb !== "send" && words.length > 0)
				return host.outcome.usage(
					`Unexpected arguments: ${words.join(" ")}`,
					USAGE,
				);
			const found = await resolve(host, scope, key, verb);
			if (!found.ok) return found.outcome;
			return operate(host, runtime, ctx.actor, {
				run: found.value,
				verb,
				words,
			});
		},
	};
};
