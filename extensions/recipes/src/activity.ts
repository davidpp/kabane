// The recipe runs as board activity: a run that names an issue is a card on that issue, its tab is
// the terminal's screen, and its one action stops it. Every listing reads this machine's
// unfinished runs from the runtime first, as `kabane runs` does. A run without a target is not on
// the board.
import { hostname } from "node:os";
import type {
	ActivityCard,
	ActivityEvent,
	ActivitySource,
	ActivityStatus,
	CardAction,
	Host,
	ProjectScope,
	Result,
	StopAction,
} from "@cabane/extension";
import { err, ok } from "./result";
import { Runs } from "./runs";
import { reconcile } from "./runs-command";
import type { Runtime } from "./runtime";

export namespace RecipeActivity {
	/** What the board's strip counts a run's card as. */
	const KIND = "runs";

	// As the loop's source: every run in flight, and the newest finished ones up to this many in all.
	const RECENT_RUNS = 10;

	// `waiting` is a harness stopped on the human: paused is the in-flight status the board draws
	// without a spinner. `idle` is a turn over with the terminal still there; the board draws both
	// it and `ended` as finished, and the detail says which.
	const STATUS: Readonly<Record<Runs.State, ActivityStatus>> = {
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

	/** Whether this machine can act on the run's terminal: its own, started, and still there. */
	const reachable = (run: Runs.Run, here: string): boolean =>
		run.machine === here &&
		run.session !== Runs.STARTING &&
		run.state !== "ended";

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
			hasEvents: true,
			tab: true,
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

	/**
	 * The lines `next` adds after `prev`: the screen scrolled, so the longest tail of `prev` that
	 * heads `next` is what it already showed. Null when no tail does: the screen was redrawn.
	 */
	const appended = (
		prev: readonly string[],
		next: readonly string[],
	): string[] | null => {
		if (prev.length === 0) return [...next];
		for (let k = Math.min(prev.length, next.length); k > 0; k--) {
			const tail = prev.slice(prev.length - k);
			if (tail.every((line, at) => line === next[at])) return next.slice(k);
		}
		return null;
	};

	/** The screen as lines, without the blank rows below its last text. */
	const lines = (screen: string): string[] => {
		const all = screen.split("\n").map((line) => line.trimEnd());
		while (all.length > 0 && all[all.length - 1] === "") all.pop();
		return all;
	};

	type Deps = {
		host: Host;
		runtime: Runtime;
		/** The board's project; null outside one, where there is nothing to list. */
		project: () => Promise<Result<ProjectScope | null>>;
		actor: string;
	};

	/** What the tab showed of a card last, so a poll adds only what changed. */
	type Shown = { seq: number; lines: string[]; noted: boolean };

	/**
	 * The tab's events for a run: the terminal's screen through the runtime's `read`, then on each
	 * poll only the lines it gained; one notice instead when this machine cannot read it.
	 */
	const tab = (runtime: Runtime) => {
		const shown = new Map<string, Shown>();

		/** One notice, the first time the tab asks, and nothing after. */
		const note = (id: string, afterSeq: number, text: string) => {
			const last = shown.get(id);
			if (afterSeq > 0 && last?.noted) return ok([]);
			const seq = (last?.seq ?? afterSeq) + 1;
			shown.set(id, { seq, lines: last?.lines ?? [], noted: true });
			return ok<ActivityEvent[]>([
				{
					seq,
					at: new Date().toISOString(),
					type: "notice",
					severity: "info",
					summary: text,
				},
			]);
		};

		const screen = async (
			run: Runs.Run,
			afterSeq: number,
		): Promise<Result<ActivityEvent[]>> => {
			const here = hostname();
			if (run.machine !== here)
				return note(
					run.id,
					afterSeq,
					`run ${run.id} is ${run.state} on ${run.machine}: read its terminal there, with kabane runs read ${run.id}`,
				);
			if (run.session === Runs.STARTING)
				return note(run.id, afterSeq, `run ${run.id} is starting`);
			if (run.runtime !== runtime.name || runtime.read === undefined)
				return note(
					run.id,
					afterSeq,
					`run ${run.id} is ${run.state} in ${run.runtime}, which has no terminal to read here`,
				);
			const read = await runtime.read(run.session);
			// A terminal that is gone leaves the run's last state.
			if (!read.ok)
				return note(
					run.id,
					afterSeq,
					`run ${run.id} is ${run.state}; its terminal is gone`,
				);
			const last = afterSeq === 0 ? undefined : shown.get(run.id);
			const next = lines(read.value);
			const added = appended(last?.lines ?? [], next);
			const fresh = added ?? next;
			let seq = last?.seq ?? afterSeq;
			const at = new Date().toISOString();
			const events: ActivityEvent[] = [
				...(added === null
					? [
							{
								seq: ++seq,
								at,
								type: "notice",
								severity: "info" as const,
								summary: "the screen was redrawn",
							},
						]
					: []),
				...fresh.map((line) => ({
					seq: ++seq,
					at,
					type: "output",
					summary: line,
				})),
			];
			shown.set(run.id, { seq, lines: next, noted: false });
			return ok(events);
		};

		return screen;
	};

	export const source = ({
		host,
		runtime,
		project,
		actor,
	}: Deps): ActivitySource => {
		const shortIds = new Map<string, string>();
		const screen = tab(runtime);

		const shortIdOf = async (id: string): Promise<string> => {
			const known = shortIds.get(id);
			if (known !== undefined) return known;
			const task = await host.record.get({ id });
			const shortId = task.ok && task.value ? (task.value.shortId ?? id) : id;
			shortIds.set(id, shortId);
			return shortId;
		};

		// Without the runtime nothing can be read, so the recorded states stand.
		const current = (runs: Runs.Run[]): Promise<Result<Runs.Run[]>> =>
			runtime.missing() === undefined
				? reconcile(host, runtime, runs, actor)
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
			shortId: run.target ? await shortIdOf(run.target.id) : run.id,
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
			events: async (id, afterSeq) => {
				const run = await one(id);
				if (!run.ok) return run;
				if (run.value === null) return ok([]);
				return screen(run.value, afterSeq);
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
								? `run ${id} is ${run.value.session === Runs.STARTING ? "still starting" : run.value.state}: nothing to stop`
								: `run ${id} runs on ${run.value.machine}: stop it there`,
						),
					);
				if (run.value.runtime !== runtime.name)
					return err(
						new Error(
							`run ${id} runs in ${run.value.runtime}, which this kabane does not have`,
						),
					);
				const stopped = await runtime.stop(run.value.session);
				if (!stopped.ok) return stopped;
				const now = await current([run.value]);
				if (!now.ok) return now;
				return ok(
					`stopped run ${id}; it is ${now.value[0]?.state ?? run.value.state}`,
				);
			},
		};
	};
}
