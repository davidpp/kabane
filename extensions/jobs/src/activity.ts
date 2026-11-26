// The recipe runs as board activity: a run that names an issue is a card on that issue with its
// state and the command that attaches to its terminal, and its one action stops it. The card has
// no tab: kabane does not render a terminal, `kabane runs attach` shows it in hc. Every listing
// reads this device's unfinished runs from the runtime first, as `kabane runs` does. A run
// without a target, or whose target is a job, is not on the board.
import type {
	ActivityCard,
	ActivitySource,
	ActivityStatus,
	CardAction,
	ProjectScope,
	Result,
	StopAction,
} from "@kabane/extension";
import type { JobsHost } from "./jobs-host";
import { err, ok } from "./result";
import { shortIdOf } from "./run-command";
import { Runs } from "./runs";
import type { Runtime } from "./runtime";

export namespace RecipeActivity {
	/** What the board's strip counts a run's card as. */
	const KIND = "runs";

	// As the loop's source: every run in flight, and the newest finished ones up to this many in all.
	const RECENT_RUNS = 10;

	// `waiting` is a harness stopped on the human: paused. `live` is a program that has reported
	// nothing, which may well be working (a harness that does not speak OSC 7501): unreported, drawn
	// in flight without a spinner and without a pause (JCAB-534). `idle` is a turn over with the
	// terminal still there; the board draws both it and `ended` as finished, and the detail says which.
	const STATUS: Readonly<Record<Runs.State, ActivityStatus>> = {
		live: "unreported",
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

	/** Whether this device may act on the run: its own, not yet ended. One with no terminal yet
	 * counts; the runtime answers a verb on it. */
	const reachable = (run: Runs.Run, device: string): boolean =>
		run.machine === device && run.state !== "ended";

	/** The run's card; `device` is this device's id, which may stop its own runs. */
	export const card = (
		{ run, shortId }: Targeted,
		device: string,
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
			...(reachable(run, device) ? { actions: [STOP] } : {}),
		};
	};

	/**
	 * The targeted runs the board lists: every one in flight, then the newest finished ones. A run
	 * counts as finished when the board draws it so: `idle` too, which a harness that stays open
	 * after its turn sits in until someone stops it.
	 */
	const listed = (runs: readonly Runs.Run[]): Runs.Run[] => {
		const targeted = runs.filter((run) => run.target?.kind === "issue");
		const finished = (run: Runs.Run) => STATUS[run.state] === "completed";
		const inFlight = targeted.filter((run) => !finished(run)).length;
		const recent = new Set(
			targeted.filter(finished).slice(0, Math.max(0, RECENT_RUNS - inFlight)),
		);
		return targeted.filter((run) => !finished(run) || recent.has(run));
	};

	type Deps = {
		host: JobsHost;
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
				const cards: ActivityCard[] = [];
				for (const run of listed(runs.value))
					cards.push(card(await targeted(run), host.device));
				return ok(cards);
			},
			card: async (id) => {
				const run = await one(id);
				if (!run.ok) return run;
				if (run.value?.target?.kind !== "issue") return ok(null);
				return ok(card(await targeted(run.value), host.device));
			},
			act: async (id, actionId) => {
				if (actionId !== STOP_ACTION)
					return err(new Error(`Unknown run action: ${actionId}`));
				const run = await one(id);
				if (!run.ok) return run;
				if (run.value === null) return err(new Error(`No run ${id}`));
				if (!reachable(run.value, host.device))
					return err(
						new Error(
							run.value.machine === host.device
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
