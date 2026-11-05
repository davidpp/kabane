// What a run is configured with: the harness that implements, its budgets, when it counts as
// stalled, its gates, whether it works in a worktree, and the lenses that verify it. The settings
// port (`Extension.Ctx.settings`) resolves it through every layer: defaults, the user's config,
// the repo's `.kabane/loop.json`, the user's settings for the repo's scope, then what the caller
// passes (the trigger form or flags). A key the schema does not name is refused in every layer: a
// typo (`workTree`) silently dropped would run the agents somewhere the human did not mean.
import { Harnesses } from "@cabane/acp";
import { z } from "zod";

export namespace LoopConfig {
	/** The settings namespace: the extension's name, `loop` in config.json, `.kabane/loop.json`. */
	export const NAMESPACE = "loop";

	export const BudgetSchema = z.object({
		/** Sessions running at once. */
		concurrency: z
			.number()
			.int()
			.min(1)
			.max(8)
			.default(2)
			.describe("Loop sessions running at once, 1 to 8; defaults to 2."),
		/** Automatic nudges across the run for turns ending with active-owned issue work. */
		continuations: z
			.number()
			.int()
			.min(0)
			.default(3)
			.describe(
				"Automatic nudges across a run for turns that end with work still owned; defaults to 3.",
			),
		/**
		 * The run halts once the reported spend reaches this. Only harnesses that send
		 * `usage_update.cost` are counted, so it is a floor on the real spend, not a cap on it.
		 */
		spend: z
			.number()
			.positive()
			.optional()
			.describe(
				"A run halts once its reported spend reaches this; only harnesses that report cost count.",
			),
		/** The currency `spend` is in; costs reported in another currency are not counted. */
		currency: z
			.string()
			.min(1)
			.default("USD")
			.describe(
				"The currency of spend; costs in another currency are not counted.",
			),
	});

	// A gate's name is the `gate:<name>` ref on a work log, so it is one word.
	const GateNameSchema = z
		.string()
		.regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, "a gate name is one word");

	// A lens's name is its prompt's file name and a tag on its findings.
	export const LensNameSchema = z
		.string()
		.regex(/^[a-z][a-z0-9-]*$/, "a lens name is one lowercase word");

	export const Schema = z.object({
		/** The harness every subtask runs on; a claim makes it the subtask's assignee. */
		implementer: z
			.enum(Harnesses.IDS)
			.default("claude")
			.describe("Harness every subtask runs on; defaults to claude."),
		/** Model override for every harness that reads one (Claude); absent keeps the pin. */
		model: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Model for harnesses that read one (Claude); absent keeps the pin.",
			),
		budget: BudgetSchema.default({}).describe(
			"A run's limits; edit dotted keys.",
		),
		/** Automatic attempts in a row without progress; parked/handoff session ends do not count. */
		stallAfter: z
			.number()
			.int()
			.min(1)
			.default(3)
			.describe(
				"Automatic attempts in a row without progress before a subtask stalls; defaults to 3.",
			),
		/**
		 * Named shell commands, run in this order in the session's directory when an implementing
		 * session ends with its subtask done, and once more before the run completes. The first
		 * that fails reopens the subtask. None configured: nothing runs and nothing is reopened.
		 */
		gates: z
			.record(GateNameSchema, z.string().min(1))
			.default({})
			.describe(
				"Named shell commands run in order after each finished subtask and before a run completes; one gate is its own key (loop.gates.test).",
			),
		/**
		 * Work in a `git worktree` of the project, never removed by the loop, and commit a
		 * checkpoint there after every green gate, or after every finished subtask when no gates
		 * are configured: the parent's last run's worktree when its branch is not merged into the
		 * project's HEAD, else a fresh one of HEAD. A project that is not a git repository is
		 * worked in place. Off: sessions work in the project checkout itself and nothing is
		 * committed.
		 */
		worktree: z
			.boolean()
			.default(true)
			.describe(
				"Work in a git worktree of the project, committing a checkpoint after each green gate; defaults to true.",
			),
		/**
		 * Verifier lenses, each its own session once the plan is done and the gates are green,
		 * filing findings as tagged child issues of the parent. A lens is a prompt file: shipped
		 * (`functional`, `quality`) or the repo's `.kabane/loop/lenses/<name>.md`. None: no
		 * verification, and the run completes on its gates.
		 */
		lenses: z
			.array(LensNameSchema)
			.default([])
			.describe(
				"Verifier lenses run once the gates are green: functional, quality, or the repo's .kabane/loop/lenses/<name>.md.",
			),
		/** The harness every lens runs on; absent, the implementer. */
		verifier: z
			.enum(Harnesses.IDS)
			.optional()
			.describe("Harness every lens runs on; absent, the implementer."),
	});

	export type Config = z.output<typeof Schema>;
	export type Input = z.input<typeof Schema>;

	// Existing files may still hold the retired timer; it is not a runtime setting, so it is dropped
	// before the strict schema sees it, and no listing of the settings shows it.
	const withoutTimer = (budget: unknown): unknown => {
		const parsed = z.record(z.unknown()).safeParse(budget);
		if (!parsed.success) return budget;
		const { wallMinutes: _wallMinutes, ...rest } = parsed.data;
		return rest;
	};

	// What a human writes, in any layer, refused when it names a key no setting has. Run files keep
	// `Schema`, so a run written by a newer kabane still reads.
	export const SettingsSchema = Schema.extend({
		budget: z
			.preprocess(withoutTimer, BudgetSchema.strict())
			.default({})
			.describe("A run's limits; edit dotted keys."),
	})
		.strict()
		.describe(
			"The loop extension's settings for a run; edit dotted keys. Flags on kabane loop start and the board's run form override them.",
		);

	/**
	 * What a caller layers over the stored settings (flags, the board's trigger form), shaped like
	 * `Input`. A key set to undefined unsets what the layers below say.
	 */
	export type Overrides = Readonly<Record<string, unknown>>;
}
