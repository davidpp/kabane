// The recipe runs as board activity: a run that names an issue is a card on that issue with its
// state and the command that attaches to its terminal, and its one action stops it. The card has
// no tab: kabane does not render a terminal, `kabane runs attach` shows it in hc. Every listing
// reads this machine's unfinished runs from the runtime first, as `kabane runs` does. A run
// without a target is not on the board.
import { hostname } from "node:os";
import type {
	ActivityCard,
	ActivitySource,
	ActivityStatus,
	CardAction,
	Host,
	ProjectScope,
	Result,
	StopAction,
} from "@cabane/extension";
import { err, ok } from "./result";
import { shortIdOf } from "./run-command";
import { Runs } from "./runs";
import type { Runtime } from "./runtime";

export namespace RecipeActivity {
	/** What the board's strip counts a run's card as. */
	const KIND = "runs";

	// As the loop's source: every run in flight, and the newest finished ones up to this many in all.
	const RECENT_RUNS = 10;

	// `waiting` is a harness stopped on the human, and `live` a program that has reported nothing:
	// paused is the in-flight status the board draws without a spinner or a claim of work, and the
	// detail's first word says which. `idle` is a turn over with the terminal still there; the
	// board draws both it and `ended` as finished, and the detail says which.
	const STATUS: Readonly<Record<Runs.State, ActivityStatus>> = {
		live: "paused",
		running: "running",
		waiting: "paused",
		idle: "completed",
		ended: "completed",
	};

	const STOP_ACTION: StopAction = "stop";
	const STOP: CardAction = { id: STOP_ACTION, key: "x", label: "stop" };

	/** A run with a target, and the target's short id. */
	type Targeted = { run: Runs.Run; shortId: string };

	const attach = (id: string): string => `kabane runs attach ${id}`;

	/** Whether this machine may act on the run: its own, not yet ended. One with no terminal yet
	 * counts; the runtime answers a verb on it. */
	const reachable = (run: Runs.Run, here: string): boolean =>
		run.machine === here && run.state !== "ended";

	export const card = (
		{ run, shortId }: Targeted,
		here = hostname(),
	): ActivityCard => {
		const inputs = Object.entries(run.inputs)
			.map(([name, value]) => `${name}=${String(value)}`)
			.join(", ");
		return {
			id: run.id,
			kind: KIND,
			label: run.recipe.name,
			status: STATUS[run.state],
			...(run.target ? { taskId: run.target.id } : {}),
			taskShortId: shortId,
			startedAt: run.startedAt,
			...(run.endedAt ? { finishedAt: run.endedAt } : {}),
			detail: [
				run.state,
				...(inputs ? [inputs] : []),
				`on ${run.machine}`,
				attach(run.id),
			],
			...(reachable(run, here) ? { actions: [STOP] } : {}),
		};
	};

	/**
	 * The targeted runs the board lists: every one in flight, then the newest finished ones. A run
	 * counts as finished when the board draws it so: `idle` too, which a harness that stays open
	 * after its turn sits in until someone stops it.
	 */
	const listed = (runs: readonly Runs.Run[]): Runs.Run[] => {
		const targeted = runs.filter((run) => run.target !== undefined);
		const finished = (run: Runs.Run) => STATUS[run.state] === "completed";
		const inFlight = targeted.filter((run) => !finished(run)).length;
		const recent = new Set(
			targeted.filter(finished).slice(0, Math.max(0, RECENT_RUNS - inFlight)),
		);
		return targeted.filter((run) => !finished(run) || recent.has(run));
	};

	type Deps = {
		host: Host;
		runtime: Runtime;
		/** The board's project; null outside one, where there is nothing to list. */
		project: () => Promise<Result<ProjectScope | null>>;
		actor: string;
	};

	export const source = ({
		host,
		runtime,
		project,
		actor,
	}: Deps): ActivitySource => {
		const shortIds = new Map<string, string>();

		const shortId = async (id: string): Promise<string> => {
			const known = shortIds.get(id) ?? (await shortIdOf(host, id));
			shortIds.set(id, known);
			return known;
		};

		// Without the runtime nothing can be read, so the recorded states stand.
		const current = (runs: Runs.Run[]): Promise<Result<Runs.Run[]>> =>
			runtime.missing() === undefined
				? Runs.reconcile(host, runtime, runs, actor)
				: Promise.resolve(ok(runs));

		/** The run `id` of the board's project, as its runtime reports it now. */
		const one = async (id: string): Promise<Result<Runs.Run | null>> => {
			const scope = await project();
			if (!scope.ok) return scope;
			if (scope.value === null) return ok(null);
			const found = await Runs.find(host, scope.value.scopeUri, id);
			if (!found.ok) return found;
			const run = found.value.find((r) => r.id === id);
			if (run === undefined) return ok(null);
			const now = await current([run]);
			return now.ok ? ok(now.value[0] ?? run) : now;
		};

		const targeted = async (run: Runs.Run): Promise<Targeted> => ({
			run,
			shortId: run.target ? await shortId(run.target.id) : run.id,
		});

		return {
			load: async () => {
				const scope = await project();
				if (!scope.ok) return scope;
				if (scope.value === null) return ok([]);
				const stored = await Runs.list(host, scope.value.scopeUri);
				if (!stored.ok) return stored;
				const runs = await current(listed(stored.value));
				if (!runs.ok) return runs;
				const here = hostname();
				const cards: ActivityCard[] = [];
				for (const run of listed(runs.value))
					cards.push(card(await targeted(run), here));
				return ok(cards);
			},
			card: async (id) => {
				const run = await one(id);
				if (!run.ok) return run;
				if (run.value?.target === undefined) return ok(null);
				return ok(card(await targeted(run.value)));
			},
			act: async (id, actionId) => {
				if (actionId !== STOP_ACTION)
					return err(new Error(`Unknown run action: ${actionId}`));
				const run = await one(id);
				if (!run.ok) return run;
				if (run.value === null) return err(new Error(`No run ${id}`));
				if (!reachable(run.value, hostname()))
					return err(
						new Error(
							run.value.machine === hostname()
								? `run ${id} is ${run.value.state}: nothing to stop`
								: `run ${id} runs on ${run.value.machine}: stop it there`,
						),
					);
				if (run.value.runtime !== runtime.name)
					return err(
						new Error(
							`run ${id} runs in ${run.value.runtime}, which this kabane does not have`,
						),
					);
				const state = await Runs.stop(host, runtime, run.value, actor);
				return state.ok ? ok(`stopped run ${id}; it is ${state.value}`) : state;
			},
		};
	};
}
