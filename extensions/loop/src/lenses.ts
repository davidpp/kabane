// Verifier lenses: a prompt file each, run as their own session once the plan is done and the gates
// are green. A lens is `references/lenses/<name>.md` in the project's dispatch skill, the same file
// the skill's own close review reads, so a lens reaches an agent whether the loop drives the
// session or a person dispatches from a plain one. `functional` and `quality` ship in kabane's
// dispatch template, so a project with no skill still has them. `.kabane/loop/lenses/<name>.md`,
// where 0.3.0 and 1.0.0-beta.0 kept a project's lenses, is still read, after the skill, so a lens
// written there keeps reviewing as it did. Once the fixer has ended, a lens whose findings it
// closed rechecks its diff. Which lenses a run has run and rechecked, and how they ended, is read
// off its claims, so a runner that resumes knows where it was.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CopilotInstructions } from "@cabane/acp";
import { err, ok, type Result, type Task, trySync } from "@cabane/core";
import { LoopConfig } from "./config";
import { Fixer } from "./fixer";
import { LoopPlan } from "./plan";
import type { RunStore } from "./store";

export namespace Lenses {
	const SHIPPED_DIR = join(
		CopilotInstructions.DISPATCH_TEMPLATE,
		"references",
		"lenses",
	);
	const SHIPPED = ["functional", "quality"] as const;

	/** Where a project keeps its own lenses: its dispatch skill's. */
	const dir = (projectDir: string): string =>
		join(projectDir, ".claude", "skills", "dispatch", "references", "lenses");

	/** Where a project's lenses were kept before they moved into the skill; read after it. */
	const legacyDir = (projectDir: string): string =>
		join(projectDir, ".kabane", "loop", "lenses");

	// The lens names among a directory's files. A prompt whose file name is no lens name
	// (`security_review.md`) is left out: a run would refuse it.
	const namesIn = (directory: string): string[] => {
		const files = trySync(() => readdirSync(directory));
		return (files.ok ? files.value : [])
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.slice(0, -".md".length))
			.filter((name) => LoopConfig.LensNameSchema.safeParse(name).success);
	};

	/** The lenses a run in `projectDir` can have: the shipped ones, then the project's own. */
	export const offered = (projectDir: string): string[] => [
		...new Set([
			...SHIPPED,
			...[
				...namesIn(dir(projectDir)),
				...namesIn(legacyDir(projectDir)),
			].sort(),
		]),
	];

	type Prompt = {
		text: string;
		/** The file it was read from, when that is the old directory's: one to move into the skill. */
		legacy?: string;
	};

	/** Lens `name`'s prompt: the skill's file, else the old directory's, else the shipped one. */
	export const prompt = (projectDir: string, name: string): Result<Prompt> => {
		const own = join(dir(projectDir), `${name}.md`);
		const legacy = join(legacyDir(projectDir), `${name}.md`);
		const shipped = SHIPPED.some((s) => s === name)
			? join(SHIPPED_DIR, `${name}.md`)
			: undefined;
		const path = [own, legacy].find((p) => existsSync(p)) ?? shipped;
		if (path === undefined)
			return err(
				new Error(
					`No lens ${name}: write ${own}, or use ${SHIPPED.join(" or ")}`,
				),
			);
		const text = trySync(() => readFileSync(path, "utf8"));
		if (!text.ok) return text;
		return ok(
			path === legacy ? { text: text.value, legacy } : { text: text.value },
		);
	};

	/**
	 * One line for each of `names` whose prompt comes from the old directory, naming the file and
	 * where to move it. Kabane moves nothing itself.
	 */
	export const moves = (
		projectDir: string,
		names: readonly string[],
	): string[] =>
		names.flatMap((name) => {
			const found = prompt(projectDir, name);
			return found.ok && found.value.legacy
				? [
						`lens ${name} is read from ${found.value.legacy}; move it to ${join(dir(projectDir), `${name}.md`)}`,
					]
				: [];
		});

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
