// What a run is configured with: the harness that implements, its budgets, when it counts as
// stalled, its gates, whether it works in a worktree and each subtask in one of its own, and the
// lenses that verify it. The settings port (`Extension.Ctx.settings`) resolves it through every
// layer: defaults, global (every project), the repo's shared `.kabane/loop.json`, local (this
// project, for you only), then what the caller passes (the trigger form or flags). A key the schema does not name is refused in every layer: a
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

	/**
	 * The capability tiers every run knows, with no model behind any of them until `tiers` maps it
	 * for a harness. A model changes with releases and quotas; a tier names how capable the work
	 * needs it to be.
	 */
	export const TIERS = ["frontier", "balanced", "fast"] as const;

	// A tier's name is a settings key and, later, a `tier:<name>` tag, so it is one lowercase word.
	const TierNameSchema = z
		.string()
		.regex(/^[a-z][a-z0-9-]*$/, "a tier name is one lowercase word");

	/** Where a subtask's claim works: a worktree of its own, or the run's one tree. */
	export const ISOLATION = ["worktree", "shared"] as const;

	/** How a completed run's branch lands. */
	export const LAND = ["none", "pr", "merge"] as const;

	/** Whether a run triages its lenses before they review (`Review`). */
	export const REVIEW_MODES = ["triage", "all"] as const;

	const ReviewSchema = z.object({
		mode: z
			.enum(REVIEW_MODES)
			.default("triage")
			.describe(
				"triage: with two lenses or more, one short read-only session reads the diff and decides which lenses run, grouped into shared sessions at a tier each, and which are skipped, never one whose frontmatter says always; all: every lens runs in a session of its own; defaults to triage.",
			),
		tier: TierNameSchema.default("fast").describe(
			"The tier the triage session runs at, resolved through loop.tiers like a subtask's tier: tag, so loop.review.tier triage with loop.tiers.claude.triage = haiku gives triage its own model; an unmapped tier runs on the run's model; defaults to fast.",
		),
	});

	/**
	 * How a run launches one harness instead of its pinned ACP adapter: a local adapter build, say.
	 * `args` replace the adapter's; a `command` with no `args` runs with none.
	 */
	const LaunchSchema = z.object({
		command: z
			.string()
			.min(1)
			.optional()
			.describe("Launch command overriding the pinned harness adapter."),
		args: z
			.array(z.string())
			.optional()
			.describe(
				"Arguments for the custom command, replacing the adapter's arguments.",
			),
	});

	const HARNESSES_DESCRIPTION =
		"How a run launches a harness instead of its pinned ACP adapter, such as a local adapter build: loop.harnesses.<harness>.command and .args, for every session of the run, lenses and the fixer included.";

	export const Schema = z.object({
		/** The harness every subtask runs on; a claim makes it the subtask's assignee. */
		implementer: z
			.enum(Harnesses.IDS)
			.default("claude")
			.describe("Harness every subtask runs on; defaults to claude."),
		/**
		 * The model every session asks its harness for: a tier name, resolved through `tiers` for the
		 * session's harness, or a literal model id the harness lists (`resolveModel`). Absent, the
		 * harness runs its own default.
		 */
		model: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Model every session asks for: a tier (frontier, balanced, fast, or one loop.tiers adds), resolved per harness through loop.tiers, or a model id the harness lists; absent, the harness's own default.",
			),
		/**
		 * What each tier means on each harness: harness id → tier name → a model id that harness
		 * lists. Its keys, with `TIERS`, are the tier names.
		 */
		tiers: z
			.record(
				z.enum(Harnesses.IDS),
				z.record(TierNameSchema, z.string().min(1)),
			)
			.default({})
			.describe(
				"The model each tier names on each harness, one key per pair (loop.tiers.claude.fast = sonnet); frontier, balanced and fast are tiers with no model until set here, and any other key is a tier too.",
			),
		/** Each harness's launch override, read by every session the run opens on it. */
		harnesses: z
			.record(z.enum(Harnesses.IDS), LaunchSchema)
			.default({})
			.describe(HARNESSES_DESCRIPTION),
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
		 * filing findings as tagged child issues of the parent. A lens is a prompt file in the
		 * project's dispatch skill, `.agents/skills/dispatch/references/lenses/<name>.md`, or one
		 * kabane ships (`functional`, `quality`). None: no verification, and the run completes on
		 * its gates.
		 */
		lenses: z
			.array(LensNameSchema)
			.default([])
			.describe(
				"Verifier lenses run once the gates are green: functional, quality, or the project's .agents/skills/dispatch/references/lenses/<name>.md.",
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
		/**
		 * How much review a run gets (`Review`): with `triage`, a run with two lenses or more first runs
		 * one read-only session that groups the lenses its diff needs, at a tier each, and skips the
		 * rest above the `always` floor; `all` runs every lens in a session of its own. `tier` is the
		 * tier that session runs at, so it can have a model of its own (`loop.tiers.<harness>.<tier>`).
		 */
		review: ReviewSchema.default({}).describe(
			"How much review a run gets; edit dotted keys (loop.review.mode, loop.review.tier).",
		),
		/** The harness every lens runs on; absent, the implementer. */
		verifier: z
			.enum(Harnesses.IDS)
			.optional()
			.describe("Harness every lens runs on; absent, the implementer."),
		/**
		 * What a completed run does with its worktree's branch: `none` leaves it there, `pr` pushes
		 * it and opens a pull request with the user's own git and gh, `merge` merges it into the
		 * base in the project's checkout and pushes nothing (`Land`). `kabane loop land` does the
		 * same for a completed run by hand, or again after a landing that failed.
		 */
		land: z
			.enum(LAND)
			.default("none")
			.describe(
				"What a completed run does with its branch: none leaves it in its worktree, pr rebases it onto its base, pushes it and opens a pull request with your git and gh, merge rebases it onto its base, merges it into the base in your checkout (--no-ff) and pushes nothing; defaults to none. kabane loop land <runId> lands a completed run by hand.",
			),
		/**
		 * The user's own command for after a landing: run in the project's checkout once a run's
		 * branch has landed, at the end of the run or by `kabane loop land`, told what landed through
		 * `KABANE_*` variables (`Landed`). A push, GitHub's auto-merge or `kabane loop prune` goes
		 * here. One that fails is a warning on the run's trace and changes nothing else.
		 */
		onLanded: z
			.string()
			.min(1)
			.optional()
			.describe(
				"A shell command run in your checkout once a run's branch lands, at the end of the run or by kabane loop land, with KABANE_RUN_ID, KABANE_PARENT, KABANE_LAND, KABANE_BRANCH, KABANE_BASE, KABANE_WORKTREE, KABANE_PR and KABANE_MERGED set, such as git push or kabane loop prune; one that fails is a warning on the run's trace.",
			),
	});

	export type Config = z.output<typeof Schema>;

	/** Launch overrides for every harness, as a caller driving the runner in process gives them. */
	export type Own = Readonly<Record<Harnesses.Id, Harnesses.Overrides>>;

	/**
	 * What a session on `harness` launches instead of its pinned adapter: the runner's `own`
	 * overrides when it was given them, else the run's `loop.harnesses`; neither, the adapter.
	 */
	export const launchOverrides = (
		config: Pick<Config, "harnesses">,
		harness: Harnesses.Id,
		own?: Own,
	): Harnesses.Overrides | undefined =>
		own?.[harness] ?? config.harnesses[harness];

	/** The command and arguments a session on `harness` runs, and the setting that names them. */
	export const launch = (
		config: Pick<Config, "harnesses">,
		harness: Harnesses.Id,
		own?: Own,
	): { command: string; args: string[]; from: string } => {
		const { command, args } = Harnesses.resolve(
			harness,
			launchOverrides(config, harness, own),
		);
		// An unset leaves `{}` behind, which replaces nothing.
		const set = config.harnesses[harness];
		const from =
			own !== undefined
				? "the runner's own overrides"
				: set?.command !== undefined || set?.args !== undefined
					? `loop.harnesses.${harness}`
					: "the pinned adapter";
		return { command, args, from };
	};

	/**
	 * Sessions running at once: what the budget says, else 2 when subtask claims are `isolated`
	 * (a worktree each) and 1 when they share one tree.
	 */
	export const concurrency = (config: Config, isolated: boolean): number =>
		config.budget.concurrency ?? (isolated ? 2 : 1);
	export type Input = z.input<typeof Schema>;
	/**
	 * The model a session asks for, and where it came from: `tier` when the reference is a tier
	 * mapped for this harness, `literal` for any other value, passed through as a model id, and
	 * `default` when nothing asks for one, or a tier maps no model here, so the harness runs its own.
	 * `note` says why a tier fell back.
	 */
	export type Model = {
		model?: string;
		source: "tier" | "literal" | "default";
		/** The tier a `tier` model was resolved from. */
		tier?: string;
		note?: string;
	};

	/** Every tier name: the built-in ones and any key a layer's `tiers` adds for some harness. */
	export const tierNames = (config: Pick<Config, "tiers">): string[] => [
		...new Set([
			...TIERS,
			...Object.values(config.tiers).flatMap((tiers) =>
				Object.keys(tiers ?? {}),
			),
		]),
	];

	/**
	 * Resolve a session's model on `harness`. `tier`, when given, wins over the run's `model`: a
	 * tier is always resolved as a tier, while `model` is one only when its value is a tier name.
	 */
	export const resolveModel = (
		config: Pick<Config, "model" | "tiers">,
		harness: Harnesses.Id,
		tier?: string,
	): Model => {
		const reference = tier ?? config.model;
		if (reference === undefined) return { source: "default" };
		const names = tierNames(config);
		if (tier === undefined && !names.includes(reference))
			return { model: reference, source: "literal" };
		const model = config.tiers[harness]?.[reference];
		if (model !== undefined) return { model, source: "tier", tier: reference };
		return {
			source: "default",
			note: names.includes(reference)
				? `tier ${reference} names no model for ${harness} (loop.tiers.${harness}.${reference}), so ${harness} runs its own default`
				: `${reference} is not a tier (${names.join(", ")}), so ${harness} runs its own default`,
		};
	};

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
		// A misspelt `comand` dropped would launch the real adapter the human meant to replace.
		harnesses: z
			.record(z.enum(Harnesses.IDS), LaunchSchema.strict())
			.default({})
			.describe(HARNESSES_DESCRIPTION),
		budget: z
			.preprocess(withoutTimer, BudgetSchema.strict())
			.default({})
			.describe("A run's limits; edit dotted keys."),
		review: ReviewSchema.strict()
			.default({})
			.describe(
				"How much review a run gets; edit dotted keys (loop.review.mode, loop.review.tier).",
			),
	})
		.strict()
		.describe(
			"The loop extension's settings for a run; edit dotted keys. Flags on kabane loop start and the board's run form override them.",
		);

	// A run written before `isolation` existed worked every claim in its one tree, and one written
	// before `review` ran every lens: resumed, it goes on that way rather than taking the defaults a
	// new run gets.
	const sharedWhenUnset = (config: unknown): unknown => {
		const parsed = z.record(z.unknown()).safeParse(config);
		if (!parsed.success) return config;
		return {
			...parsed.data,
			...(parsed.data.isolation === undefined ? { isolation: "shared" } : {}),
			...(parsed.data.review === undefined ? { review: { mode: "all" } } : {}),
		};
	};

	/** A run's config as run.json holds it. */
	export const RunSchema = z.preprocess(sharedWhenUnset, Schema);

	/**
	 * What a caller layers over the stored settings (flags, the board's trigger form), shaped like
	 * `Input`. A key set to undefined unsets what the layers below say.
	 */
	export type Overrides = Readonly<Record<string, unknown>>;
}
