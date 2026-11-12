// Deterministic run advice. The host supplies project files and resolved settings; no I/O here.
import { RiskAnalyzer, type Risk } from "@cabane/core";
import type { LoopConfig } from "./config";
import { LoopPlan } from "./plan";

export namespace LoopAdvice {
	export type Recommendation =
		| {
				path: "budget.concurrency" | "stallAfter";
				value: number;
				reason: string;
		  }
		| { path: "isolation"; value: "worktree"; reason: string }
		| { path: "setup"; value: string; reason: string }
		| { path: "gates"; value: Record<string, string>; reason: string };

	export const LOCKFILES = [
		"bun.lock",
		"bun.lockb",
		"pnpm-lock.yaml",
		"package-lock.json",
		"npm-shrinkwrap.json",
		"yarn.lock",
	] as const;
	export type Project = {
		config: LoopConfig.Config;
		scripts: Readonly<Record<string, string>>;
		lockfiles: readonly string[];
	};

	const installer = (
		project: Project,
	): { manager: string; command: string } | undefined => {
		const lock = LOCKFILES.find((name) => project.lockfiles.includes(name));
		if (!lock) return undefined;
		if (lock.startsWith("bun."))
			return { manager: "bun", command: "bun install" };
		if (lock === "pnpm-lock.yaml")
			return { manager: "pnpm", command: "pnpm install" };
		if (lock === "yarn.lock")
			return { manager: "yarn", command: "yarn install" };
		return { manager: "npm", command: "npm ci" };
	};

	// Reachability includes human and finding nodes: a dependency through either still orders work.
	const ancestors = (plan: LoopPlan.Plan, id: string): Set<string> => {
		const nodes = new Map(plan.nodes.map((node) => [node.task.id, node]));
		const found = new Set<string>();
		const visit = (at: string): void => {
			for (const blocker of nodes.get(at)?.blockedBy ?? []) {
				if (found.has(blocker)) continue;
				found.add(blocker);
				visit(blocker);
			}
		};
		visit(id);
		return found;
	};

	const checkConcurrency = (
		plan: LoopPlan.Plan,
		risks: readonly Risk[],
	): Recommendation => {
		const nodes = plan.nodes.filter(
			(n) =>
				LoopPlan.isWork(n) &&
				n.task.kind === "issue" &&
				!LoopPlan.isClosed(n.task),
		);
		if (nodes.length <= 1 || LoopPlan.single(plan))
			return {
				path: "budget.concurrency",
				value: 1,
				reason: "one issue at a time",
			};
		if (LoopPlan.cycle(plan))
			return {
				path: "budget.concurrency",
				value: 1,
				reason: "resolve the blocker cycle before running work",
			};
		const before = new Map(
			nodes.map((n) => [n.task.id, ancestors(plan, n.task.id)]),
		);
		if (risks.some((r) => r.type === "file_overlap")) {
			for (const [i, a] of nodes.entries()) {
				for (const b of nodes.slice(i + 1)) {
					if (
						before.get(a.task.id)?.has(b.task.id) ||
						before.get(b.task.id)?.has(a.task.id)
					)
						continue;
					const [overlap] = RiskAnalyzer.checkFileOverlap([a.task, b.task]);
					if (overlap)
						return {
							path: "budget.concurrency",
							value: 1,
							reason: overlap.message,
						};
				}
			}
		}
		// Dilworth: maximum antichain = nodes minus a maximum matching of the transitive DAG.
		const matched = new Map<string, string>();
		const augment = (id: string, seen: Set<string>): boolean => {
			for (const other of nodes) {
				const next = other.task.id;
				if (!before.get(next)?.has(id) || seen.has(next)) continue;
				seen.add(next);
				const previous = matched.get(next);
				if (previous === undefined || augment(previous, seen)) {
					matched.set(next, id);
					return true;
				}
			}
			return false;
		};
		for (const node of nodes) augment(node.task.id, new Set());
		const width = nodes.length - matched.size;
		return {
			path: "budget.concurrency",
			value: Math.min(8, Math.max(1, width)),
			reason: `up to ${width} independent issues in the blocker DAG${width > 8 ? "; capped at 8" : ""}`,
		};
	};

	const checkIsolation = (
		risks: readonly Risk[],
		concurrency: number,
	): Recommendation[] =>
		risks.some((r) => r.type === "file_overlap") && concurrency > 1
			? [
					{
						path: "isolation",
						value: "worktree",
						reason: "file overlap in a plan with parallel work",
					},
				]
			: [];

	const checkGates = (project: Project): Recommendation[] => {
		const install = installer(project);
		if (!install || Object.keys(project.config.gates).length > 0) return [];
		const gates = Object.fromEntries(
			["check", "typecheck", "test"]
				.filter((name) => project.scripts[name]?.trim())
				.map((name) => [name, `${install.manager} run ${name}`]),
		);
		return Object.keys(gates).length > 0
			? [
					{
						path: "gates",
						value: gates,
						reason: `package.json scripts, using ${install.manager} from the lockfile`,
					},
				]
			: [];
	};

	const checkSetup = (
		project: Project,
		isolation: string,
	): Recommendation[] => {
		const install = installer(project);
		return isolation === "worktree" && install
			? [
					{
						path: "setup",
						value: install.command,
						reason:
							"install dependencies in each worktree using the project's lockfile",
					},
				]
			: [];
	};

	const checkStall = (risks: readonly Risk[]): Recommendation[] => {
		const thrash = risks.find((r) => r.type === "past_thrash");
		return thrash
			? [{ path: "stallAfter", value: 2, reason: thrash.message }]
			: [];
	};

	export const of = (
		plan: LoopPlan.Plan,
		risks: readonly Risk[],
		project: Project,
	): Recommendation[] => {
		const concurrency = checkConcurrency(plan, risks);
		const isolation = checkIsolation(risks, Number(concurrency.value));
		return [
			concurrency,
			...isolation,
			...checkGates(project),
			...checkSetup(
				project,
				isolation.length > 0 ? "worktree" : project.config.isolation,
			),
			...checkStall(risks),
		];
	};
}
