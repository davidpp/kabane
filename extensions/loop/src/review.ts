// How much review a run gets. With `loop.review.mode: triage` and two lenses or more, one short
// read-only session reads the run's diff stat, the parent's brief and each lens's `applies` line,
// and answers with a review plan: which lenses review together in one session, at which tier, and
// which it skips, each with a reason. Only configured lens names and tiers are accepted, and
// each lens keeps its first place. A triage that fails, edits the tree or answers no plan
// leaves every lens its own group, as a run without triage has; the run never stops on it.
import { z } from "zod";
import { Brief } from "./brief";
import type { LoopConfig } from "./config";

export namespace Review {
	/** The lane the triage session runs in. */
	export const LANE = "triage";

	// The first line of every triage brief: what the scripted agent answers a plan to.
	export const OPENING = "You are the review triage of kabane loop run";

	const GroupSchema = z.object({
		lenses: z.array(z.string()).min(1),
		/** A tier name; absent, the group runs on the run's model. */
		tier: z.string().optional(),
		reason: z.string(),
	});
	export type Group = z.infer<typeof GroupSchema>;

	const SkipSchema = z.object({ lens: z.string(), reason: z.string() });

	/** The run's review plan, after normalization, as run.json keeps it. */
	export const PlanSchema = z.object({
		groups: z.array(GroupSchema),
		skipped: z.array(SkipSchema).default([]),
		/** Why the plan is every lens on its own rather than the triage's, when it is. */
		fallback: z.string().optional(),
	});
	type Plan = z.infer<typeof PlanSchema>;

	// What a session answers: reasons and skips may be missing, and normalization fills them in. A
	// model writes `"tier": null` for "the run's model" as readily as it leaves the key out.
	const AnswerSchema = z.object({
		groups: z
			.array(
				z.object({
					lenses: z.array(z.string()),
					tier: z.string().nullish(),
					reason: z.string().nullish(),
				}),
			)
			.default([]),
		skipped: z
			.array(z.object({ lens: z.string(), reason: z.string().nullish() }))
			.default([]),
	});
	type Answer = z.infer<typeof AnswerSchema>;

	/** One configured lens as triage sees it: its name and its frontmatter. */
	export type Lens = { name: string; applies?: string; always: boolean };

	/** What the run changed from its base, as triage reads it. */
	export type Diff = {
		base: string;
		/** `git diff --stat` from the base. */
		stat: string;
		/** Files git does not track yet, which the stat leaves out. */
		untracked: readonly string[];
		files: number;
		lines: number;
	};

	/** Whether a run with this config triages before its lenses. */
	export const wanted = (
		config: Pick<LoopConfig.Config, "lenses" | "review">,
	): boolean => config.review.mode === "triage" && config.lenses.length >= 2;

	/** Every lens on its own, as a run without triage has them, and why. */
	export const fallback = (lenses: readonly string[], why: string): Plan => ({
		groups: lenses.map((name) => ({ lenses: [name], reason: why })),
		skipped: [],
		fallback: why,
	});

	/** The lenses a run's review groups hold: the plan's, else every configured one. */
	export const reviewed = (
		config: Pick<LoopConfig.Config, "lenses">,
		plan: Plan | undefined,
	): string[] =>
		plan ? plan.groups.flatMap((g) => g.lenses) : [...config.lenses];

	/** The run's review sessions: the plan's groups, else every lens on its own. */
	export const groups = (
		config: Pick<LoopConfig.Config, "lenses">,
		plan: Plan | undefined,
	): Group[] =>
		plan
			? plan.groups
			: config.lenses.map((name) => ({ lenses: [name], reason: "" }));

	/**
	 * The diff from `numstat` (`git diff --numstat`) and the untracked files: how many files and
	 * changed lines. A binary file's `-` counts no lines; an untracked one counts as one file.
	 */
	export const diff = (
		base: string,
		stat: string,
		numstat: string,
		untracked: readonly string[],
	): Diff => {
		const rows = numstat.split("\n").filter((line) => line.trim() !== "");
		const lines = rows.reduce((sum, row) => {
			const [added = "", removed = ""] = row.split("\t");
			return sum + (Number(added) || 0) + (Number(removed) || 0);
		}, 0);
		return {
			base,
			stat,
			untracked,
			files: rows.length + untracked.length,
			lines,
		};
	};

	// The last fenced block in `text` that parses as a plan: a session may think aloud before it.
	const answerIn = (text: string): Answer | undefined => {
		const blocks = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)];
		for (const [, body] of blocks.reverse()) {
			let json: unknown;
			try {
				json = JSON.parse(body ?? "");
			} catch {
				continue;
			}
			const parsed = AnswerSchema.safeParse(json);
			if (parsed.success) return parsed.data;
		}
		return undefined;
	};

	/** A normalized plan and notes about dropped names or tiers for the trace. */
	export type Decided = { plan: Plan; notes: string[] };

	/**
	 * Keep only configured lenses, each in one place, and known tiers.
	 * Record omitted lenses as skipped so every configured lens appears on the trace.
	 */
	const bound = (
		answer: Answer,
		lenses: readonly Lens[],
		tiers: readonly string[],
	): Decided => {
		const notes: string[] = [];
		const known = new Map(lenses.map((l) => [l.name, l]));
		const placed = new Set<string>();
		const take = (name: string): boolean => {
			if (!known.has(name)) {
				notes.push(
					`triage named ${name}, which is not a lens of this run: dropped`,
				);
				return false;
			}
			if (placed.has(name)) return false;
			placed.add(name);
			return true;
		};
		const groups: Group[] = answer.groups.flatMap((g) => {
			const names = g.lenses.filter(take);
			if (names.length === 0) return [];
			const asked = g.tier ?? undefined;
			const tier =
				asked !== undefined && !tiers.includes(asked) ? undefined : asked;
			if (asked !== undefined && tier === undefined)
				notes.push(
					`triage asked for tier ${g.tier}, which is not a tier (${tiers.join(", ")}): ${names.join("+")} runs on the run's model`,
				);
			return [
				{
					lenses: names,
					...(tier ? { tier } : {}),
					reason: g.reason?.trim() || "no reason given",
				},
			];
		});
		const skipped: Plan["skipped"] = [];
		for (const s of answer.skipped) {
			if (!take(s.lens)) continue;
			skipped.push({
				lens: s.lens,
				reason: s.reason?.trim() || "no reason given",
			});
		}
		for (const { name } of lenses)
			if (!placed.has(name)) {
				placed.add(name);
				skipped.push({
					lens: name,
					reason: "the triage's plan did not place it",
				});
			}
		return { plan: { groups, skipped }, notes };
	};

	/**
	 * The plan a triage session's end gives: its normalized answer when it finished with
	 * one, every lens on its own otherwise, saying why.
	 */
	export const decide = (
		ended: { outcome: string; detail?: string; summary?: string },
		lenses: readonly Lens[],
		tiers: readonly string[],
	): Decided => {
		const names = lenses.map((l) => l.name);
		if (ended.outcome !== "done")
			return {
				plan: fallback(
					names,
					`triage ${ended.outcome}${ended.detail ? `: ${ended.detail}` : ""}`,
				),
				notes: [],
			};
		const answer = answerIn(ended.summary ?? "");
		return answer
			? bound(answer, lenses, tiers)
			: {
					plan: fallback(names, "triage answered no review plan"),
					notes: [],
				};
	};

	/** One trace line per group and per skip. */
	export const lines = (plan: Plan): string[] => [
		...plan.groups.map(
			(g) =>
				`${g.lenses.join("+")}${g.tier ? ` at tier ${g.tier}` : ""}: ${g.reason}`,
		),
		...plan.skipped.map((s) => `skipped ${s.lens}: ${s.reason}`),
	];

	const fence = (text: string): string => `\`\`\`\n${text.trimEnd()}\n\`\`\``;

	const describe = (lens: Lens): string =>
		`- \`${lens.name}\`${lens.always ? " (always runs: never skip it)" : ""}: ${lens.applies ?? "says nothing about when it applies, so judge from its name"}`;

	type Subject = {
		tree: Brief.Tree;
		runId: string;
		parent: { shortId?: string; id: string; title: string };
		lenses: readonly Lens[];
		diff: Diff;
		tiers: readonly string[];
	};

	const EXAMPLE = `{ "groups": [{ "lenses": ["functional", "docs"], "tier": "balanced", "reason": "..." }], "skipped": [{ "lens": "compat", "reason": "..." }] }`;

	/** The triage session's prompt: what to decide and how to answer, the diff, then the parent's brief. */
	export const brief = (subject: Subject, assembled: string): string => {
		const { tree, runId, parent, lenses, diff: d, tiers } = subject;
		const short = parent.shortId ?? parent.id;
		return [
			[
				`${OPENING} ${runId} on ${short} ("${parent.title}"). Its work is done and its gates pass. Before the verifier lenses review it, decide which of them this change needs, which can review together in one session, and how capable a model each session needs.`,
				"Do not write to the tracker: read the diff stat below, the brief after it, and the changed files themselves when the stat is not enough. Keep it short: this decision should cost a fraction of one review.",
				Brief.reviewing(tree),
				`The run's lenses, each with the changes it reviews:\n${lenses.map(describe).join("\n")}`,
				`Skip a lens only when the change touches nothing it reviews, and say why in a sentence that names what the diff does not touch. Group lenses whose reviews read the same files. Weigh the diff’s size: a group reads it once while splitting re-reads it per lens, but a very large diff in one session may exceed what it can hold. Give each group a tier (${tiers.join(", ")}) only when it needs other than the run's model: a tier on a trivial diff, a stronger one on a risky change. A lens marked always runs is never skipped.`,
				`End your turn with the review plan as one fenced JSON block and nothing after it, every lens in one group or skipped:\n\`\`\`json\n${EXAMPLE}\n\`\`\``,
			].join("\n\n"),
			[
				`What changed from the run's base, \`git diff --stat ${d.base}\`:`,
				d.stat.trim() === "" ? "(no tracked change)" : fence(d.stat),
				...(d.untracked.length > 0
					? [
							`Files new to git, not in the stat:\n${d.untracked.map((f) => `- ${f}`).join("\n")}`,
						]
					: []),
			].join("\n\n"),
			assembled,
		].join("\n\n---\n\n");
	};
}
