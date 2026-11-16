// The loop's doctor: what a project or the user's settings still say that the loop has moved past.
// Lenses left in `.kabane/loop/lenses`, where they were kept before the dispatch skill held them,
// and lens names that more than one directory holds; models a run never gets because `loop.model`
// is unset or names a tier `loop.tiers` maps to nothing. No check guesses or validates a model id:
// that needs the harness's model list, so it would spawn a harness, and doctor stays instant.
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	mkdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Harnesses } from "@cabane/acp";
import { type Result, type Task } from "@cabane/core";
import type { Host, Doctor, Extension } from "@cabane/extension";
import { LoopConfig } from "./config";
import { Lenses } from "./lenses";
import { err, ok, tryCatch, trySync } from "./result";
import { Route } from "./route";

export namespace LoopDoctor {
	const MODEL_ROUTE =
		"propose loop.model (a tier is best) and the loop.tiers mapping it needs; the human picks the models; write it with kabane_configSet in the global layer unless they say this project only";

	const PAGE = 500;

	const markdownIn = (directory: string): string[] => {
		const files = trySync(() => readdirSync(directory));
		return (files.ok ? files.value : []).filter((file) => file.endsWith(".md"));
	};

	const conflictFor = (root: string, file: string): string | undefined => {
		const source = join(Lenses.loopDir(root), file);
		return Lenses.directories(root)
			.slice(0, -1)
			.map((directory) => join(directory, file))
			.find(
				(path) =>
					existsSync(path) && !readFileSync(source).equals(readFileSync(path)),
			);
	};

	/** Move each legacy lens into the skill's directory; refuse one the skill holds differently. */
	const moveLegacy = (root: string): Result<string> => {
		const from = Lenses.loopDir(root);
		const to = Lenses.dir(root);
		mkdirSync(to, { recursive: true });
		const moved: string[] = [];
		const refused: string[] = [];
		for (const file of markdownIn(from)) {
			const source = join(from, file);
			const target = join(to, file);
			const conflict = conflictFor(root, file);
			if (conflict) {
				refused.push(`${file} (${relative(root, conflict)})`);
				continue;
			}
			if (!existsSync(target)) {
				renameSync(source, target);
				moved.push(file);
			} else if (readFileSync(source).equals(readFileSync(target))) {
				unlinkSync(source);
				moved.push(file);
			} else refused.push(file);
		}
		const emptied = readdirSync(from).length === 0;
		if (emptied) rmdirSync(from);
		const done = [
			moved.length > 0
				? `Moved ${moved.join(", ")} to ${relative(root, to)}`
				: undefined,
			emptied ? `removed ${relative(root, from)}` : undefined,
		]
			.filter((part) => part !== undefined)
			.join("; ");
		if (refused.length === 0) return ok(done);
		return err(
			new Error(
				`${done ? `${done}; ` : ""}refused ${refused.join(", ")}: a higher-priority lens directory already has that name with other content; merge them by hand`,
			),
		);
	};

	const legacyLenses = (root: string): Doctor.Finding[] => {
		const legacy = Lenses.loopDir(root);
		const files = markdownIn(legacy);
		if (files.length === 0) return [];
		const shown = relative(root, legacy);
		// The `.agents` path is the skill every harness reads; a real `.claude/skills/dispatch` is
		// the dispatch extension's to route to /setup-dispatch, not a place to move lenses into.
		const skill = existsSync(
			join(root, ".agents", "skills", "dispatch", "SKILL.md"),
		);
		const target = relative(root, Lenses.dir(root));
		if (!skill)
			return [
				{
					id: "legacy-lens-dir",

					path: legacy,
					severity: "mention",
					summary: `${shown} holds ${files.join(", ")}, where lenses were kept before the dispatch skill. They still run from there. They belong in ${target}: move the files there by hand, and the loop reads them from it with or without a dispatch skill; or write a dispatch skill first with /setup-dispatch, which the dispatch extension adds, and kabane doctor --fix then moves them.`,
				},
			];
		const blocked = files.every(
			(file) => conflictFor(root, file) !== undefined,
		);
		return [
			{
				id: "legacy-lens-dir",

				path: legacy,
				severity: blocked ? "mention" : "auto",
				summary: blocked
					? `${shown} holds ${files.join(", ")}; each differs from a higher-priority skill copy. Merge them by hand and remove the obsolete copies.`
					: `${shown} holds ${files.join(", ")}, where lenses were kept before the dispatch skill. --fix moves them to ${target}, refusing a name the skill already holds with other content, and removes ${shown} once it is empty.`,
				fix: async () => {
					const moved = trySync(() => moveLegacy(root));
					return moved.ok ? moved.value : moved;
				},
			},
		];
	};

	/** Lens names held by more than one lookup directory, and the one each reads from. */
	const shadowedLenses = (root: string): Doctor.Finding[] => {
		// `.claude/skills/dispatch` is usually a symlink to the `.agents` skill: one directory.
		const seen = new Set<string>();
		const directories = Lenses.directories(root).filter((directory) => {
			const real = trySync(() => realpathSync(directory));
			if (!real.ok || seen.has(real.value)) return false;
			seen.add(real.value);
			return true;
		});
		const holders = new Map<string, string[]>();
		for (const directory of directories)
			for (const file of markdownIn(directory)) {
				const name = file.slice(0, -".md".length);
				if (!LoopConfig.LensNameSchema.safeParse(name).success) continue;
				holders.set(name, [
					...(holders.get(name) ?? []),
					relative(root, join(directory, file)),
				]);
			}
		const shadowed = [...holders].filter(([, paths]) => paths.length > 1);
		if (shadowed.length === 0) return [];
		return [
			{
				id: "lens-shadowed",

				severity: "mention",
				summary: shadowed
					.map(
						([name, [inForce, ...hidden]]) =>
							`lens ${name} is read from ${inForce}, which hides ${hidden.join(", ")}`,
					)
					.join("; "),
			},
		];
	};

	/** Every open issue in the scope, a page at a time. */
	const openIssues = async (
		record: Host.Record,
		scopeUri: string,
	): Promise<Result<Task[]>> => {
		const issues: Task[] = [];
		for (let offset = 0; ; offset += PAGE) {
			const page = await record.list({
				scopeUri,
				kind: "issue",
				includeDeferred: true,
				limit: PAGE,
				offset,
			});
			if (!page.ok) return page;
			issues.push(...page.value);
			if (page.value.length < PAGE) return ok(issues);
		}
	};

	const modelFindings = (
		config: LoopConfig.Config,
		issues: readonly Task[],
	): Doctor.Finding[] => {
		const findings: Doctor.Finding[] = [];
		const harness = config.implementer;
		if (config.model === undefined)
			findings.push({
				id: "model-unpinned",

				severity: "suggest",
				summary: `loop.model is unset, so every loop session runs on ${harness}'s own default model, which for Claude Code is whichever model was last picked interactively.`,
				route: MODEL_ROUTE,
			});
		// Each tier a harness has no model for, keyed `harness/tier`: whether loop.model asks for it,
		// and how many open issues' tags do.
		type Unmapped = {
			harness: Harnesses.Id;
			tier: string;
			model: boolean;
			issues: number;
		};
		const unmapped = new Map<string, Unmapped>();
		const ask = (on: Harnesses.Id, tier: string, model: boolean) => {
			if (config.tiers[on]?.[tier] !== undefined) return;
			const entry = unmapped.get(`${on}/${tier}`) ?? {
				harness: on,
				tier,
				model: false,
				issues: 0,
			};
			unmapped.set(`${on}/${tier}`, {
				...entry,
				model: entry.model || model,
				issues: entry.issues + (model ? 0 : 1),
			});
		};
		if (
			config.model !== undefined &&
			LoopConfig.tierNames(config).includes(config.model)
		)
			ask(harness, config.model, true);
		for (const issue of issues) {
			const route = Route.of(issue.tags, config);
			if (route.tier !== undefined) ask(route.harness, route.tier, false);
		}
		if (unmapped.size > 0)
			findings.push({
				id: "tier-unmapped",

				severity: "suggest",
				summary: [...unmapped]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, entry]) => entry)
					.map(({ harness: on, tier, model, issues }) => {
						const askers = [
							model ? "loop.model" : undefined,
							issues > 0
								? `${issues} open issue${issues === 1 ? "" : "s"} tagged for it`
								: undefined,
						]
							.filter((part) => part !== undefined)
							.join(" and ");
						const one = (model ? 1 : 0) + issues === 1;
						return `tier ${tier} names no model for ${on} (loop.tiers.${on}.${tier}); ${askers} ${one ? "asks" : "ask"} for it and ${one ? "gets" : "get"} ${on}'s own default`;
					})
					.join("; "),
				route: MODEL_ROUTE,
			});
		return findings;
	};

	export const doctor = async (
		host: Host,
		ctx: Extension.Ctx,
	): Promise<Result<Doctor.Finding[]>> => {
		const scope = await host.scope.detect(ctx.cwd);
		if (!scope.ok) return scope;
		const root = scope.value?.root;
		const config = await ctx.settings(
			LoopConfig.NAMESPACE,
			LoopConfig.schemas(host.z).SettingsSchema,
			{ projectDir: root ?? ctx.cwd },
		);
		const lenses =
			root === undefined
				? ok([])
				: trySync(() => [...legacyLenses(root), ...shadowedLenses(root)]);
		if (!lenses.ok) return lenses;
		// Settings that do not parse are the settings check's finding; no model check can run on them.
		if (!config.ok) return lenses;
		const scopeUri = scope.value?.scopeUri;
		const read: Result<Result<Task[]>> =
			scopeUri === undefined
				? ok(ok([]))
				: await tryCatch(() => openIssues(host.record, scopeUri));
		const issues: Result<Task[]> = read.ok ? read.value : read;
		// The store may be out of reach (a host that opened none): the other findings still stand.
		const unchecked: Doctor.Finding[] = issues.ok
			? []
			: [
					{
						id: "tier-tags-unchecked",

						severity: "mention",
						summary: `Open issues' tier: tags were not checked against loop.tiers: ${issues.error.message}`,
					},
				];
		return ok([
			...lenses.value,
			...modelFindings(config.value, issues.ok ? issues.value : []),
			...unchecked,
		]);
	};
}
