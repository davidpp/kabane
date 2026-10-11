// What a run is configured with: the harness that implements, its budgets, and when it counts as
// stalled. Layered: defaults, then the repo's `.kabane/loop.json`, then what the caller passes (the
// trigger form or flags). Keys a later package owns (gates, lenses) pass through the file untouched
// and are stripped here until a schema names them.
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
		/** The run halts once this much wall time has passed since it started. */
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

	export const Schema = z.object({
		/** The harness for a subtask whose assignee does not name one. */
		implementer: z.enum(Harnesses.IDS).default("claude"),
		/** Model override for every harness that reads one (Claude); absent keeps the pin. */
		model: z.string().min(1).optional(),
		budget: BudgetSchema.default({}),
		/** Session ends in a row with no progress before the run halts as stalled. */
		stallAfter: z.number().int().min(1).default(3),
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
