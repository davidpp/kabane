// What a run is configured with: the harness that implements, its budgets, when it counts as
// stalled, its gates, whether it works in a worktree, and the lenses that verify it. Layered:
// defaults, then the repo's `.kabane/loop.json`, then what the caller passes (the trigger form or
// flags); budgets and gates merge key by key. Keys no schema names yet pass through the file untouched and are stripped here.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Harnesses } from "@cabane/acp";
import { err, ok, type Result, trySync } from "@cabane/core";
import { z } from "zod";

export namespace LoopConfig {
	export const FILE = join(".kabane", "loop.json");

	export const BudgetSchema = z.object({
		/** Sessions running at once. */
		concurrency: z.number().int().min(1).max(8).default(2),
		/**
		 * The run halts once a runner has driven it for this much wall time, paused time included;
		 * the time between a runner dying and the run's resume does not count.
		 */
		wallMinutes: z.number().positive().default(120),
		/** Nudges, across the whole run, for a turn that ends with its subtask still open. */
		continuations: z.number().int().min(0).default(3),
		/**
		 * The run halts once the reported spend reaches this. Only harnesses that send
		 * `usage_update.cost` are counted, so it is a floor on the real spend, not a cap on it.
		 */
		spend: z.number().positive().optional(),
		/** The currency `spend` is in; costs reported in another currency are not counted. */
		currency: z.string().min(1).default("USD"),
	});

	// A gate's name is the `gate:<name>` ref on a work log, so it is one word.
	const GateNameSchema = z
		.string()
		.regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, "a gate name is one word");

	// A lens's name is its prompt's file name and a tag on its findings.
	const LensNameSchema = z
		.string()
		.regex(/^[a-z][a-z0-9-]*$/, "a lens name is one lowercase word");

	export const Schema = z.object({
		/** The harness for a subtask whose assignee does not name one. */
		implementer: z.enum(Harnesses.IDS).default("claude"),
		/** Model override for every harness that reads one (Claude); absent keeps the pin. */
		model: z.string().min(1).optional(),
		budget: BudgetSchema.default({}),
		/** Session ends in a row with no progress before the run halts as stalled. */
		stallAfter: z.number().int().min(1).default(3),
		/**
		 * Named shell commands, run in this order in the session's directory when an implementing
		 * session ends with its subtask done, and once more before the run completes. The first
		 * that fails reopens the subtask. None configured: nothing runs and nothing is reopened.
		 */
		gates: z.record(GateNameSchema, z.string().min(1)).default({}),
		/**
		 * Work in a `git worktree` of the project made for the run, never removed by it, and
		 * commit a checkpoint there after every green gate. Off: sessions work in the project
		 * checkout itself and nothing is committed.
		 */
		worktree: z.boolean().default(false),
		/**
		 * Verifier lenses, each its own session once the plan is done and the gates are green,
		 * filing findings as tagged child issues of the parent. A lens is a prompt file: shipped
		 * (`functional`, `quality`) or the repo's `.kabane/loop/lenses/<name>.md`. None: no
		 * verification, and the run completes on its gates.
		 */
		lenses: z.array(LensNameSchema).default([]),
		/** The harness every lens runs on; absent, the implementer. */
		verifier: z.enum(Harnesses.IDS).optional(),
	});

	export type Config = z.output<typeof Schema>;
	export type Input = z.input<typeof Schema>;

	const ObjectSchema = z.record(z.unknown());

	const asObject = (value: unknown): Record<string, unknown> => {
		const parsed = ObjectSchema.safeParse(value);
		return parsed.success ? parsed.data : {};
	};

	const readFile = (repoDir: string): Result<Record<string, unknown>> => {
		const path = join(repoDir, FILE);
		if (!existsSync(path)) return ok({});
		const text = trySync(() => readFileSync(path, "utf8"));
		if (!text.ok) return text;
		const json = trySync((): unknown => JSON.parse(text.value));
		if (!json.ok) return err(new Error(`${path}: ${json.error.message}`));
		const object = ObjectSchema.safeParse(json.value);
		return object.success
			? ok(object.data)
			: err(new Error(`${path}: expected a JSON object`));
	};

	/**
	 * What a caller layers over the repo file (flags, the board's trigger form), shaped like `Input`
	 * and validated with the file. A key set to undefined unsets what the file says.
	 */
	export type Overrides = Readonly<Record<string, unknown>>;

	/** Defaults, then `<repoDir>/.kabane/loop.json`, then `overrides`, validated once. */
	export const resolve = (
		repoDir: string,
		overrides: Overrides = {},
	): Result<Config> => {
		const file = readFile(repoDir);
		if (!file.ok) return file;
		const merged = {
			...file.value,
			...overrides,
			budget: { ...asObject(file.value.budget), ...asObject(overrides.budget) },
			gates: { ...asObject(file.value.gates), ...asObject(overrides.gates) },
		};
		const parsed = Schema.safeParse(merged);
		if (parsed.success) return ok(parsed.data);
		const where = existsSync(join(repoDir, FILE))
			? `${join(repoDir, FILE)} with the given overrides`
			: "the given overrides";
		return err(
			new Error(`Invalid loop config in ${where}: ${parsed.error.message}`),
		);
	};
}
