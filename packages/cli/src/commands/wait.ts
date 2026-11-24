import { map, Planner, TaskStateSchema, type Result } from "@kabane/core";
import { conciseSuccess, usage, type Outcome } from "@kabane/extension";
import { Questions } from "@kabane/questions";
import type { Command } from "../context";

const USAGE =
	"kabane wait (answered <question> | state <thread> <state>... | ready <thread>) [--timeout <duration>]";

const problem = (error: Error): Outcome => ({
	exitCode: 2,
	json: { error: error.message },
	text: `Error: ${error.message}`,
});

const poll = async (
	read: () => Promise<Result<object | null>>,
	timeout: number,
): Promise<Outcome> => {
	const deadline = performance.now() + timeout;
	for (;;) {
		const result = await read();
		if (!result.ok) return problem(result.error);
		if (result.value) return conciseSuccess(result.value);
		const remaining = deadline - performance.now();
		if (remaining <= 0)
			return { exitCode: 1, json: { timeout: true }, text: "Wait timed out" };
		await Bun.sleep(Math.min(1000, remaining));
	}
};

const units = { s: 1000, m: 60000, h: 3600000 } as const;
const duration = (value: unknown): number => {
	if (value === undefined) return Infinity;
	if (typeof value !== "string" || !/^\d+[smh]$/.test(value)) return NaN;
	const unit = value.slice(-1) as keyof typeof units;
	const ms = Number(value.slice(0, -1)) * units[unit];
	return Number.isSafeInteger(ms) ? ms : NaN;
};

export const wait: Command = {
	name: "wait",
	contextErrorExitCode: 2,
	summary:
		"Wait for a question to close, a task state, or every blocker to close",
	usage: USAGE,
	run: async (args, ctx) => {
		const [condition, input, ...states] = args.positionals;
		const unknown = Object.keys(args.flags).find(
			(key) => key !== "timeout" && key !== "as",
		);
		if (unknown) return usage(`Unknown wait flag: --${unknown}`, USAGE);
		const timeout = duration(args.flags.timeout);
		if (Number.isNaN(timeout))
			return usage("Give a timeout such as 30s, 10m or 2h", USAGE);
		if (!input) return usage("An id is required", USAGE);
		if (condition !== "state" && states.length)
			return usage("Expected one id", USAGE);
		if (condition === "answered") {
			const id = await Questions.resolve(ctx.store, input);
			if (!id.ok) return problem(id.error);
			return poll(
				async () =>
					map(await Questions.status(ctx.store, id.value), (row) =>
						row.status === "open"
							? null
							: { condition, questionId: id.value, ...row },
					),
				timeout,
			);
		}
		if (condition !== "state" && condition !== "ready")
			return usage("Unknown condition", USAGE);
		const parsed = TaskStateSchema.array().safeParse(states);
		if (!parsed.success || (condition === "state" && !states.length))
			return usage(
				`Choose at least one state from ${TaskStateSchema.options.join(", ")}`,
				USAGE,
			);
		const id = await Planner.resolveTaskId(ctx.store, input);
		if (!id.ok) return problem(id.error);
		const taskId = id.value;
		if (condition === "ready")
			return poll(
				async () =>
					map(await Planner.isReady(ctx.store, taskId), (ready) =>
						ready ? { condition, taskId } : null,
					),
				timeout,
			);
		return poll(
			async () =>
				map(
					await Planner.matchingState(ctx.store, taskId, parsed.data),
					(state) => (state ? { condition, taskId, state } : null),
				),
			timeout,
		);
	},
};
