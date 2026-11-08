// What a run is configured with: the harness that implements, its budgets, when it counts as
// stalled, its gates, whether it works in a worktree and each subtask in one of its own, and the
// lenses that verify it. The settings port (`Extension.Ctx.settings`) resolves it through every
// layer: defaults, the user's config, the repo's `.kabane/loop.json`, the user's settings for the
// repo's scope, then what the caller passes (the trigger form or flags). A key the schema does not name is refused in every layer: a
// typo (`workTree`) silently dropped would run the agents somewhere the human did not mean.
import { Harnesses } from "@cabane/acp";
import { z } from "zod";

export namespace LoopConfig {
	/** The settings namespace: the extension's name, `loop` in config.json, `.kabane/loop.json`. */
	export const NAMESPACE = "loop";

	export const BudgetSchema = z.object({
		/**
		 * Sessions running at once. Unset, it follows `isolation`: 2 when each subtask claim works in
		 * a worktree of its own, 1 when every claim works in the run's one tree, where a subtask's
		 * gates and checkpoint see what its siblings have half done (`LoopConfig.concurrency`).
		 */
		concurrency: z
			.number()
			.int()
			.min(1)
			.max(8)
			.optional()
			.describe(
				"Loop sessions running at once, 1 to 8. Unset, it follows isolation: 2 when each subtask works in its own worktree, 1 when they share the run's tree, where a subtask's gates and checkpoint see its siblings' half-done edits.",
			),
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

	/** Where a subtask's claim works: a worktree of its own, or the run's one tree. */
	export const ISOLATION = ["worktree", "shared"] as const;

	/** How a completed run's branch lands. */
	export const LAND = ["none", "pr"] as const;

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
		 * Work in a `git worktree` of the project, and commit a checkpoint there after every green
		 * gate, or after every finished subtask when no gates are configured: the parent's last
		 * run's worktree while its work is not merged (its pull request still open, or its branch
		 * not in the project's HEAD), else a fresh one of HEAD. A worktree whose work is merged is
		 * removed with its branch (`Prune`). A project that is not a git repository is worked in
		 * place. Off: sessions work in the project checkout itself and nothing is committed.
		 */
		worktree: z
			.boolean()
			.default(true)
			.describe(
				"Work in a git worktree of the project, committing a checkpoint after each green gate; defaults to true.",
			),
		/**
		 * Where each subtask's claim works, in a run with a worktree: `worktree` gives it a worktree
		 * and branch of its own, cut from the run's HEAD, where its session and gates run, and a green
		 * pass merges that branch into the run's (`ClaimTrees`). `shared` has every claim work in the
		 * run's one tree. A single issue, the lenses, the fixer and the rechecks always work in the
		 * run's tree, and a run with no worktree has only the one.
		 */
		isolation: z
			.enum(ISOLATION)
			.default("worktree")
			.describe(
				"Where each subtask's session and gates run: worktree, a git worktree and branch of its own merged into the run's branch once its gates pass, or shared, the run's one tree; defaults to worktree.",
			),
		/**
		 * The user's own command for a subtask's worktree, run in it once it is made or reset for a
		 * subtask and before its session starts: an install, say. Nothing else is installed. One that
		 * fails stops the run.
		 */
		setup: z
			.string()
			.min(1)
			.optional()
			.describe(
				"A shell command run in each subtask's worktree as it is made or reset for a subtask, before its session starts, such as bun install; one that fails stops the run.",
			),
		/**
		 * Keep a subtask's worktree once its work merges, for the next subtask, reset to the run's
		 * HEAD with what git ignores left in place, so build output stays warm. Off: it is removed.
		 */
		reuse: z
			.boolean()
			.default(true)
			.describe(
				"Keep a subtask's worktree once its work merges and reset it for the next subtask, leaving ignored build output (node_modules, target/) warm; off removes it; defaults to true.",
			),
		/** The subtask worktrees the run keeps at once, in use or kept for reuse; unset, its concurrency. */
		maxWorktrees: z
			.number()
			.int()
			.min(1)
			.max(8)
			.optional()
			.describe(
				"The most subtask worktrees a run keeps at once, in use or kept for reuse, 1 to 8; a subtask waits for one; unset, the run's concurrency.",
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
		/**
		 * Once the fixer has ended and the gates are green on its result, each lens with a finding
		 * the fixer closed reviews the fixer's diff once, on the verifier, and edits nothing: it
		 * confirms each fix or reopens the finding, and files only what the diff broke. No second
		 * fixer follows; what it reopens or files is left for a human. Off: the fixer's word and the
		 * gates close a finding.
		 */
		recheck: z
			.boolean()
			.default(true)
			.describe(
				"Once the fixer has ended and the gates pass, each lens whose findings it closed reviews its diff once, without editing, and reopens what is not fixed; defaults to true.",
			),
		/** The harness every lens runs on; absent, the implementer. */
		verifier: z
			.enum(Harnesses.IDS)
			.optional()
			.describe("Harness every lens runs on; absent, the implementer."),
		/**
		 * What a completed run does with its worktree's branch: `none` leaves it there, `pr` pushes
		 * it and opens a pull request with the user's own git and gh (`Land`). `kabane loop land`
		 * does the same for a completed run by hand, or again after a landing that failed.
		 */
		land: z
			.enum(LAND)
			.default("none")
			.describe(
				"What a completed run does with its branch: none leaves it in its worktree, pr rebases it onto its base, pushes it and opens a pull request with your git and gh; defaults to none. kabane loop land <runId> lands a completed run by hand.",
			),
	});

	export type Config = z.output<typeof Schema>;

	/**
	 * Sessions running at once: what the budget says, else 2 when subtask claims are `isolated`
	 * (a worktree each) and 1 when they share one tree.
	 */
	export const concurrency = (config: Config, isolated: boolean): number =>
		config.budget.concurrency ?? (isolated ? 2 : 1);
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

	// A run written before `isolation` existed worked every claim in its one tree: resumed, it
	// goes on that way rather than taking the default a new run gets.
	const sharedWhenUnset = (config: unknown): unknown => {
		const parsed = z.record(z.unknown()).safeParse(config);
		return parsed.success && parsed.data.isolation === undefined
			? { ...parsed.data, isolation: "shared" }
			: config;
	};

	/** A run's config as run.json holds it. */
	export const RunSchema = z.preprocess(sharedWhenUnset, Schema);

	/**
	 * What a caller layers over the stored settings (flags, the board's trigger form), shaped like
	 * `Input`. A key set to undefined unsets what the layers below say.
	 */
	export type Overrides = Readonly<Record<string, unknown>>;
}
