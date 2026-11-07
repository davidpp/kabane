// Verifier lenses: a prompt file each, run as their own session once the plan is done and the gates
// are green. `functional` and `quality` ship with the extension; a repository adds a lens, or
// replaces a shipped one, with `.kabane/loop/lenses/<name>.md`. Once the fixer has ended, a lens
// whose findings it closed rechecks its diff. Which lenses a run has run and rechecked, and how
// they ended, is read off its claims, so a runner that resumes knows where it was.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, type Result, type Task, trySync } from "@cabane/core";
import { Self } from "@cabane/core/self";
import { LoopConfig } from "./config";
import { Fixer } from "./fixer";
import { LoopPlan } from "./plan";
import type { RunStore } from "./store";

export namespace Lenses {
	// The extension's own `templates/lenses` in the workspace, and `templates/lenses` beside `bin/`
	// in the published package or beside a compiled binary, where the builds copy it.
	const SHIPPED_DIR = Self.templates("lenses", import.meta.url);
	const SHIPPED = ["functional", "quality"] as const;

	/** Where a repository keeps its own lenses. */
	export const dir = (projectDir: string): string =>
		join(projectDir, ".kabane", "loop", "lenses");

	/**
	 * The lenses a run in `projectDir` can have: the shipped ones, then the repository's own. A
	 * prompt whose file name is no lens name (`security_review.md`) is not offered: a run would
	 * refuse it.
	 */
	export const offered = (projectDir: string): string[] => {
		const own = trySync(() => readdirSync(dir(projectDir)));
		const names = (own.ok ? own.value : [])
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.slice(0, -".md".length))
			.filter((name) => LoopConfig.LensNameSchema.safeParse(name).success)
			.sort();
		return [...new Set([...SHIPPED, ...names])];
	};

	/** Lens `name`'s prompt: the repository's own file first, else the shipped one. */
	export const prompt = (projectDir: string, name: string): Result<string> => {
		const own = join(dir(projectDir), `${name}.md`);
		if (existsSync(own)) return trySync(() => readFileSync(own, "utf8"));
		if (!SHIPPED.some((shipped) => shipped === name))
			return err(
				new Error(
					`No lens ${name}: write ${own}, or use ${SHIPPED.join(" or ")}`,
				),
			);
		return trySync(() => readFileSync(join(SHIPPED_DIR, `${name}.md`), "utf8"));
	};

	export type Status = {
		/** Lenses with no session yet, or whose last one was interrupted: to be run. */
		pending: string[];
		running: string[];
		done: string[];
		/** Lenses whose last session ended without finishing its review, and why. */
		failed: { name: string; detail: string }[];
	};

	/**
	 * Where each of `lenses` stands, from the run's claims: a lens's latest claim decides, its
	 * review's or, with `of` reading `recheck`, its recheck's.
	 */
	export const status = (
		lenses: readonly string[],
		claims: readonly RunStore.Claim[],
		of: (claim: RunStore.Claim) => string | undefined = (c) => c.lens,
	): Status => {
		const status: Status = { pending: [], running: [], done: [], failed: [] };
		for (const name of lenses) {
			const last = claims.findLast((c) => of(c) === name);
			if (!last || last.outcome === "interrupted") status.pending.push(name);
			else if (last.endedAt === undefined) status.running.push(name);
			else if (last.outcome === "done") status.done.push(name);
			else
				status.failed.push({
					name,
					detail: `${last.outcome ?? "ended"}${last.detail ? `: ${last.detail}` : ""}`,
				});
		}
		return status;
	};

	/** Whether every lens has finished its review. */
	export const finished = (s: Status): boolean =>
		s.pending.length === 0 && s.running.length === 0 && s.failed.length === 0;

	/** The commit the run's first fixer started from: what its rechecks diff against. */
	export const fixerBase = (
		claims: readonly RunStore.Claim[],
	): string | undefined => claims.find((c) => c.fixer === true)?.head;

	/**
	 * Each configured lens's findings that the fixer closed: what its recheck confirms or reopens.
	 * None until the fixer's pass is over, with the recheck off, or without a base to diff against
	 * (a session directory that is not a git repository).
	 */
	const closedByFixer = (
		config: Pick<LoopConfig.Config, "lenses" | "recheck">,
		claims: readonly RunStore.Claim[],
		plan: LoopPlan.Plan,
	): Map<string, Task[]> => {
		const closed = new Map<string, Task[]>();
		if (
			!config.recheck ||
			Fixer.status(claims).kind !== "ended" ||
			fixerBase(claims) === undefined
		)
			return closed;
		const given = new Set(
			claims.flatMap((c) => (c.fixer === true ? (c.findings ?? []) : [])),
		);
		for (const { task } of plan.nodes) {
			const lens = LoopPlan.lensOf(task)?.toLowerCase();
			if (!given.has(task.id) || task.state !== "done" || lens === undefined)
				continue;
			if (!config.lenses.includes(lens)) continue;
			closed.set(lens, [...(closed.get(lens) ?? []), task]);
		}
		return closed;
	};

	/**
	 * Each lens's recheck and the findings it rechecks: the ones its first recheck claim was given,
	 * whatever state they are in now (an interrupted one may have reopened them all), else those the
	 * fixer closed.
	 */
	export const rechecking = (
		config: Pick<LoopConfig.Config, "lenses" | "recheck">,
		claims: readonly RunStore.Claim[],
		plan: LoopPlan.Plan,
	): Map<string, Task[]> => {
		const due = closedByFixer(config, claims, plan);
		const byId = new Map(plan.nodes.map((n) => [n.task.id, n.task]));
		for (const name of config.lenses) {
			const first = claims.find((c) => c.recheck === name);
			if (first)
				due.set(
					name,
					(first.findings ?? []).flatMap((id) => byId.get(id) ?? []),
				);
		}
		return due;
	};

	/**
	 * Where each lens's recheck stands: one is due for a lens with a finding the fixer closed, and
	 * once claimed it stays the lens's, done whatever it reopened, or to run again when interrupted.
	 * Every recheck finished, or none due, is `finished`.
	 */
	export const rechecks = (
		config: Pick<LoopConfig.Config, "lenses" | "recheck">,
		claims: readonly RunStore.Claim[],
		plan: LoopPlan.Plan,
	): Status => {
		const due = rechecking(config, claims, plan);
		return status(
			config.lenses.filter((name) => due.has(name)),
			claims,
			(c) => c.recheck,
		);
	};
}
