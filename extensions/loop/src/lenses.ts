// Verifier lenses: a prompt file each, run as their own session once the plan is done and the gates
// are green. A lens is `references/lenses/<name>.md` in the project's dispatch skill, the same file
// the skill's own close review reads, so a lens reaches an agent whether the loop drives the
// session or a person dispatches from a plain one. `functional` and `quality` ship with the loop, so a project with no skill still has them. The skill lives under
// `.agents/skills/dispatch/`; one still at `.claude/skills/dispatch/`, where kabane wrote it before,
// is read after it. `.kabane/loop/lenses/<name>.md`, where 0.3.0 and 1.0.0-beta.0 kept a project's
// lenses, is read after both, so a lens written there keeps reviewing as it did. Once the fixer
// has ended, a lens whose findings it closed rechecks its diff. Which lenses a run has run and
// rechecked, and how they ended, is read off its claims, so a runner that resumes knows where it
// was.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Result, type Task } from "@cabane/core";
import { z } from "zod";
import { LoopConfig } from "./config";
import { Fixer } from "./fixer";
import { LoopPlan } from "./plan";
import { err, ok, trySync } from "./result";
import type { RunStore } from "./store";

export namespace Lenses {
	const SHIPPED_DIR = fileURLToPath(new URL("../lenses/", import.meta.url));
	const SHIPPED = ["functional", "quality"] as const;

	/** Where a project keeps its own lenses: its dispatch skill's. */
	export const dir = (projectDir: string): string =>
		join(projectDir, ".agents", "skills", "dispatch", "references", "lenses");

	/** The loop's own lens directory from before the dispatch skill held them. */
	export const loopDir = (projectDir: string): string =>
		join(projectDir, ".kabane", "loop", "lenses");

	/**
	 * The dispatch skill's lenses where kabane wrote the skill before `.agents/skills/`; read after
	 * it, with no notice, since a Claude Code link to the new home resolves to the same files.
	 */
	const claudeDir = (projectDir: string): string =>
		join(projectDir, ".claude", "skills", "dispatch", "references", "lenses");

	/** Every directory a project's lenses are read from, first in force first. */
	export const directories = (projectDir: string): string[] => [
		dir(projectDir),
		claudeDir(projectDir),
		loopDir(projectDir),
	];

	// The lens names among a directory's files. A prompt whose file name is no lens name
	// (`security_review.md`) is left out: a run would refuse it.
	const namesIn = (directory: string): string[] => {
		const files = trySync(() => readdirSync(directory));
		return (files.ok ? files.value : [])
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.slice(0, -".md".length))
			.filter((name) => LoopConfig.LensNameSchema.safeParse(name).success);
	};

	/**
	 * The lenses a run in `projectDir` can have: the shipped ones, then the project's own. With no
	 * project, the shipped ones.
	 */
	export const offered = (projectDir?: string): string[] => [
		...new Set([
			...SHIPPED,
			...(projectDir === undefined
				? []
				: directories(projectDir).flatMap(namesIn).sort()),
		]),
	];

	/**
	 * A lens's frontmatter: which changes it reviews, written for a model deciding from a diff stat
	 * and the brief, and whether the prompt tells triage never to skip it (not enforced by code). A file without
	 * frontmatter has no `applies` and is not `always`.
	 */
	const FrontmatterSchema = z
		.object({
			applies: z.string().min(1).optional(),
			always: z.boolean().default(false),
		})
		.strict();
	type Frontmatter = z.infer<typeof FrontmatterSchema>;

	// The YAML between a lens file's opening `---` and the next, read the way an agent definition's
	// is (`Harnesses`), but strictly: an unknown key or YAML that does not parse is an error naming
	// the file, since a lens that says when it applies and is misread would be skipped or run
	// wrongly. The text comes back without it, so no session sees it.
	const parse = (
		path: string,
		raw: string,
	): Result<Frontmatter & { text: string }> => {
		const [first, ...rest] = raw.split("\n");
		if (first?.trimEnd() !== "---") return ok({ text: raw, always: false });
		const end = rest.findIndex((line) => line.trimEnd() === "---");
		if (end === -1)
			return err(new Error(`${path}: its frontmatter has no closing ---`));
		const yaml = trySync(() => Bun.YAML.parse(rest.slice(0, end).join("\n")));
		if (!yaml.ok)
			return err(
				new Error(
					`${path}: its frontmatter is not YAML: ${yaml.error.message}`,
				),
			);
		const fields = FrontmatterSchema.safeParse(yaml.value ?? {});
		if (!fields.success) {
			const issues = fields.error.issues
				.map((issue) =>
					issue.path.length > 0
						? `${issue.path.join(".")}: ${issue.message}`
						: issue.message,
				)
				.join("; ");
			return err(
				new Error(
					`${path}: ${issues} (a lens's frontmatter takes applies, a line of prose, and always, true or false)`,
				),
			);
		}
		const text = rest
			.slice(end + 1)
			.join("\n")
			.replace(/^(?:[ \t]*\r?\n)+/, "");
		return ok({ text, ...fields.data });
	};

	type Prompt = Frontmatter & {
		/** The prompt a session gets: the file without its frontmatter. */
		text: string;
		/** The file it was read from, when that is the old directory's: one to move into the skill. */
		legacy?: string;
	};

	/**
	 * Lens `name`'s prompt: the skill's file under `.agents/`, else under `.claude/`, else the old
	 * directory's, else the shipped one.
	 */
	export const prompt = (projectDir: string, name: string): Result<Prompt> => {
		const own = join(dir(projectDir), `${name}.md`);
		const claude = join(claudeDir(projectDir), `${name}.md`);
		const legacy = join(loopDir(projectDir), `${name}.md`);
		const shipped = SHIPPED.some((s) => s === name)
			? join(SHIPPED_DIR, `${name}.md`)
			: undefined;
		const path = [own, claude, legacy].find((p) => existsSync(p)) ?? shipped;
		if (path === undefined)
			return err(
				new Error(
					`No lens ${name}: write ${own}, or use ${SHIPPED.join(" or ")}`,
				),
			);
		const raw = trySync(() => readFileSync(path, "utf8"));
		if (!raw.ok) return raw;
		const parsed = parse(path, raw.value);
		if (!parsed.ok) return parsed;
		return ok(path === legacy ? { ...parsed.value, legacy } : parsed.value);
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
	 * Where each of `lenses` stands, from the run's claims: a lens's latest claim decides, the
	 * latest review whose group holds it or, with `of` reading `recheck`, its latest recheck. A
	 * group's outcome is each of its lenses'.
	 */
	export const status = (
		lenses: readonly string[],
		claims: readonly RunStore.Claim[],
		of: (claim: RunStore.Claim) => readonly string[] = (c) => c.lenses ?? [],
	): Status => {
		const status: Status = { pending: [], running: [], done: [], failed: [] };
		for (const name of lenses) {
			const last = claims.findLast((c) => of(c).includes(name));
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
			(c) => (c.recheck === undefined ? [] : [c.recheck]),
		);
	};
}
