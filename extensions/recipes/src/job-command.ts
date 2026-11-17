// `kabane job`: a recipe on a schedule, in a project's folder. A job is an item of kind `job` (its
// title, its description as the standing request, its scope and its state) plus its row in
// `Jobs`. `tick`, which launchd or cron calls, fires every active job that is due; it has no
// project, so every `kabane job` run inside one records that project's folder for it.
import { hostname } from "node:os";
import type {
	Extension,
	Host,
	Outcome,
	ParsedArgs,
	Result,
	Task,
} from "@cabane/extension";
import { Inputs } from "./inputs";
import { Jobs } from "./jobs";
import { Recipe } from "./recipe";
import { err, ok } from "./result";
import { projectOf, type settingsSchema, startRun } from "./run-command";
import { Runs } from "./runs";
import { pad } from "./runs-command";
import type { Runtime } from "./runtime";

const USAGE = [
	'kabane job add <recipe> --title <text> --schedule "<cron>" [--request <text>] [--input name=value]... [--inputs \'{"name": value}\'] [--harness a,b,c]',
	"kabane job list [--all]",
	"kabane job show|pause|resume|run <id>",
	"kabane job tick",
].join("\n       ");

/** How many runs `job show` and the board list. */
export const SHOWN_RUNS = 5;

export type Entry = { job: Jobs.Job; task: Task };

const shortOf = (task: Task): string => task.shortId ?? task.id;

const noFolder = ({ task }: Entry): string =>
	`${shortOf(task)}: skipped, no folder on this machine for ${task.scopeUri}; run \`kabane job list\` inside it`;

/** "2026-11-16 09:00", in this machine's time zone, as the schedule is read. */
const when = (date: Date): string => {
	const two = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

export type Deps = {
	host: Host;
	settings: ReturnType<typeof settingsSchema>;
	runtime: Runtime;
};

/** Every open job, with its item. A closed job (`kabane done`) is gone from here. */
const entries = async (d: Deps): Promise<Result<Entry[]>> => {
	const jobs = await Jobs.all(d.host);
	if (!jobs.ok) return jobs;
	const found: Entry[] = [];
	for (const job of jobs.value) {
		const task = await d.host.record.get({ id: job.taskId });
		if (!task.ok) return task;
		if (task.value === null || ["done", "cancelled"].includes(task.value.state))
			continue;
		found.push({ job, task: task.value });
	}
	return ok(found);
};

/** The job `key` names, open or not. */
const entry = async (d: Deps, key: string): Promise<Result<Entry>> => {
	const task = await d.host.record.get({ id: key });
	if (!task.ok) return task;
	if (task.value === null) return err(new Error(`No job found: ${key}`));
	const jobs = await Jobs.all(d.host);
	if (!jobs.ok) return jobs;
	const job = jobs.value.find((j) => j.taskId === task.value?.id);
	return job
		? ok({ job, task: task.value })
		: err(new Error(`${shortOf(task.value)} is not a job`));
};

/** The job's runs, newest first, as their runtime reports them now. */
export const runsOf = async (
	d: Deps,
	{ task }: Entry,
	actor: string,
): Promise<Result<Runs.Run[]>> => {
	const stored = await Runs.list(d.host, task.scopeUri ?? "");
	if (!stored.ok) return stored;
	const mine = stored.value.filter(
		(run) => run.target?.kind === "job" && run.target.id === task.id,
	);
	return d.runtime.missing() === undefined
		? Runs.reconcile(d.host, d.runtime, mine, actor)
		: ok(mine);
};

const nextOf = (job: Jobs.Job): string => {
	const next = Jobs.next(job);
	return next.ok ? when(next.value) : next.error.message;
};

/** One fire of a job in `root`: the line that says what it did. */
const fire = async (
	d: Deps,
	ctx: Pick<Extension.Ctx, "actor" | "settings">,
	found: Entry,
	root: string,
	now: Date,
): Promise<Result<string>> => {
	const { job, task } = found;
	const short = shortOf(task);
	const runs = await runsOf(d, found, ctx.actor);
	if (!runs.ok) return runs;
	const here = hostname();
	const decision = Jobs.decide(
		runs.value.filter((run) => run.machine === here),
	);
	if (decision.kind === "skip")
		return ok(
			`${short}: skipped, run ${decision.run.id} is still ${decision.run.state}`,
		);
	for (const run of decision.stop) {
		const stopped = await Runs.stop(d.host, d.runtime, run, ctx.actor);
		if (!stopped.ok) return stopped;
	}
	const recipe = Recipe.load(d.host.z, root, job.recipe);
	if (!recipe.ok) return recipe;
	const inputs = Inputs.resolve(d.host.z, recipe.value, {
		pairs: [],
		json: JSON.stringify(job.inputs),
	});
	if (!inputs.ok) return inputs;
	let harness = job.harness;
	if (harness === undefined) {
		const configured = await ctx.settings("recipes", d.settings, {
			projectDir: root,
		});
		if (!configured.ok) return configured;
		harness = configured.value.harness;
	}
	const started = await startRun(d.host, d.runtime, {
		scopeUri: task.scopeUri ?? "",
		root,
		dir: "",
		recipe: recipe.value,
		target: { kind: "job", id: task.id, shortId: short, title: task.title },
		inputs: inputs.value,
		harness,
		actor: ctx.actor,
	});
	if (!started.ok) return started;
	const fired = await Jobs.setFired(
		d.host,
		job.taskId,
		now.toISOString(),
		ctx.actor,
	);
	if (!fired.ok) return fired;
	const { run, warnings } = started.value;
	return ok(
		[
			`${short}: started run ${run.id} (${run.recipe.name}) in ${run.runtime} terminal ${run.session}`,
			...warnings,
		].join("\n"),
	);
};

const add = async (
	d: Deps,
	args: ParsedArgs,
	ctx: Extension.Ctx,
	name: string | undefined,
): Promise<Outcome> => {
	const project = await projectOf(d.host, ctx.cwd, "job add");
	if (!project.ok) return project.outcome;
	const title = d.host.args.flagString(args, "title");
	const schedule = d.host.args.flagString(args, "schedule");
	if (name === undefined || title === undefined || schedule === undefined)
		return d.host.outcome.usage(
			"job add needs a recipe, --title and --schedule",
			USAGE,
		);
	const now = new Date();
	const valid = Jobs.nextAfter(schedule, now);
	if (!valid.ok) return d.host.outcome.usage(valid.error.message, USAGE);
	const recipe = Recipe.load(d.host.z, project.value.root, name);
	if (!recipe.ok) return d.host.outcome.failure(recipe.error);
	if (recipe.value.target === "issue")
		return d.host.outcome.usage(
			`recipe "${name}" works on an issue; a job runs a recipe with "target: job" or none`,
			USAGE,
		);
	const inputs = Inputs.resolve(d.host.z, recipe.value, {
		pairs: d.host.args.flagList(args, "input"),
		json: d.host.args.flagString(args, "inputs"),
	});
	if (!inputs.ok) return d.host.outcome.usage(inputs.error.message, USAGE);
	const request = d.host.args.flagString(args, "request");
	const created = await d.host.record.call("kabane_add", {
		title,
		kind: "job",
		state: "next",
		scopeUri: project.value.scopeUri,
		...(request === undefined ? {} : { description: request }),
	});
	if (!created.ok) return d.host.outcome.failure(created.error);
	const { z } = d.host;
	const task = z
		.object({ id: z.string(), shortId: z.string().optional() })
		.safeParse(created.value);
	if (!task.success)
		return d.host.outcome.failure(
			`kabane_add returned no task: ${task.error.message}`,
		);
	const harness = d.host.args.flagCsv(args, "harness");
	const stored = await Jobs.insert(
		d.host,
		{
			taskId: task.data.id,
			schedule,
			recipe: recipe.value.name,
			inputs: inputs.value,
			...(harness === undefined ? {} : { harness }),
			createdAt: now.toISOString(),
		},
		ctx.actor,
	);
	if (!stored.ok) return d.host.outcome.failure(stored.error);
	const short = task.data.shortId ?? task.data.id;
	return d.host.outcome.success(
		{ job: task.data.id, shortId: short, next: valid.value.toISOString() },
		`Added job ${short} (${recipe.value.name}, "${schedule}"); it fires next at ${when(valid.value)}.`,
	);
};

const list = async (
	d: Deps,
	ctx: Extension.Ctx,
	all: boolean,
): Promise<Outcome> => {
	let scope: string | undefined;
	if (!all) {
		const project = await projectOf(d.host, ctx.cwd, "job list");
		if (!project.ok) return project.outcome;
		scope = project.value.scopeUri;
	}
	const found = await entries(d);
	if (!found.ok) return d.host.outcome.failure(found.error);
	const shown = found.value.filter(
		({ task }) => scope === undefined || task.scopeUri === scope,
	);
	if (shown.length === 0)
		return d.host.outcome.success(
			{ jobs: [] },
			all ? "No jobs." : "No jobs in this project; --all lists every scope's.",
		);
	const rows: string[][] = [];
	const json: unknown[] = [];
	for (const one of shown) {
		const runs = await runsOf(d, one, ctx.actor);
		if (!runs.ok) return d.host.outcome.failure(runs.error);
		const latest = runs.value[0];
		const { job, task } = one;
		const active = task.state === "next" ? "active" : "paused";
		rows.push([
			shortOf(task),
			active,
			job.schedule,
			nextOf(job),
			job.recipe,
			job.harness?.join(",") ?? "-",
			latest?.state ?? "-",
			task.title,
		]);
		json.push({
			id: task.id,
			shortId: shortOf(task),
			title: task.title,
			scope: task.scopeUri,
			state: active,
			...job,
			...(latest ? { latestRun: { id: latest.id, state: latest.state } } : {}),
		});
	}
	return d.host.outcome.success(
		{ jobs: json },
		pad([
			[
				"ID",
				"STATE",
				"SCHEDULE",
				"NEXT",
				"RECIPE",
				"HARNESS",
				"LAST RUN",
				"TITLE",
			],
			...rows,
		]),
	);
};

const show = async (
	d: Deps,
	ctx: Extension.Ctx,
	key: string,
): Promise<Outcome> => {
	const found = await entry(d, key);
	if (!found.ok) return d.host.outcome.failure(found.error);
	const runs = await runsOf(d, found.value, ctx.actor);
	if (!runs.ok) return d.host.outcome.failure(runs.error);
	const { job, task } = found.value;
	const recent = runs.value.slice(0, SHOWN_RUNS);
	const lines = [
		`${shortOf(task)}  ${task.title}`,
		`state     ${task.state === "next" ? "active" : task.state === "someday" ? "paused" : task.state}`,
		`schedule  ${job.schedule}  (next ${nextOf(job)})`,
		`recipe    ${job.recipe}`,
		`inputs    ${JSON.stringify(job.inputs)}`,
		`harness   ${job.harness?.join(",") ?? "recipes.harness"}`,
		`last fire ${job.lastFiredAt ? when(new Date(job.lastFiredAt)) : "never"}`,
		"",
		task.description?.trim() || "(no request)",
		"",
		recent.length > 0
			? pad([
					["RUN", "STATE", "STARTED", "ATTACH"],
					...recent.map((run) => [
						run.id,
						run.state,
						when(new Date(run.startedAt)),
						`kabane runs attach ${run.id}`,
					]),
				])
			: "No runs yet.",
	];
	return d.host.outcome.success(
		{
			job: {
				id: task.id,
				title: task.title,
				request: task.description,
				...job,
			},
			runs: recent,
		},
		lines.join("\n"),
	);
};

const setState = async (
	d: Deps,
	key: string,
	state: "next" | "someday",
): Promise<Outcome> => {
	const found = await entry(d, key);
	if (!found.ok) return d.host.outcome.failure(found.error);
	const edited = await d.host.record.edit({ id: found.value.task.id, state });
	if (!edited.ok) return d.host.outcome.failure(edited.error);
	const short = shortOf(found.value.task);
	return d.host.outcome.success(
		{ job: found.value.task.id, state },
		state === "next" ? `Resumed ${short}.` : `Paused ${short}.`,
	);
};

/** Fire the job `key` names now, in its scope's folder on this machine: the line that says what it did. */
export const runJob = async (
	d: Deps,
	ctx: Pick<Extension.Ctx, "actor" | "settings">,
	key: string,
): Promise<Result<string>> => {
	const found = await entry(d, key);
	if (!found.ok) return found;
	const roots = await Jobs.roots(d.host);
	if (!roots.ok) return roots;
	const root = roots.value.get(found.value.task.scopeUri ?? "");
	if (root === undefined) return err(new Error(noFolder(found.value)));
	return fire(d, ctx, found.value, root, new Date());
};

const runNow = async (
	d: Deps,
	ctx: Extension.Ctx,
	key: string,
): Promise<Outcome> => {
	const line = await runJob(d, ctx, key);
	return line.ok
		? d.host.outcome.success({ line: line.value }, line.value)
		: d.host.outcome.failure(line.error);
};

const tick = async (d: Deps, ctx: Extension.Ctx): Promise<Outcome> => {
	const now = new Date();
	const found = await entries(d);
	if (!found.ok) return d.host.outcome.failure(found.error);
	const roots = await Jobs.roots(d.host);
	if (!roots.ok) return d.host.outcome.failure(roots.error);
	const lines: string[] = [];
	for (const one of found.value) {
		if (one.task.state !== "next") continue;
		const short = shortOf(one.task);
		const due = Jobs.due(one.job, now);
		if (!due.ok) {
			lines.push(`${short}: ${due.error.message}`);
			continue;
		}
		if (!due.value) continue;
		const root = roots.value.get(one.task.scopeUri ?? "");
		if (root === undefined) {
			lines.push(noFolder(one));
			continue;
		}
		const line = await fire(d, ctx, one, root, now);
		lines.push(line.ok ? line.value : `${short}: ${line.error.message}`);
	}
	return d.host.outcome.success({ lines }, lines.join("\n"));
};

export const jobCommand = (
	host: Host,
	settings: ReturnType<typeof settingsSchema>,
	runtime: Runtime,
): Extension.Command => {
	const d: Deps = { host, settings, runtime };
	return {
		name: "job",
		summary:
			"Run a project recipe on a schedule; list, pause, resume or fire jobs",
		usage: USAGE,
		run: async (args, ctx) => {
			// Every job command inside a project records its folder, which `tick` starts runs in.
			const here = await d.host.scope.detect(ctx.cwd);
			if (!here.ok) return d.host.outcome.failure(here.error);
			if (here.value !== null) {
				const saved = await Jobs.setRoot(
					d.host,
					here.value.scopeUri,
					here.value.root,
				);
				if (!saved.ok) return d.host.outcome.failure(saved.error);
			}
			const [verb, key, ...extra] = args.positionals;
			if (extra.length > 0)
				return d.host.outcome.usage(
					`Unexpected arguments: ${extra.join(" ")}`,
					USAGE,
				);
			if (verb === "add") return add(d, args, ctx, key);
			if (verb === "list")
				return list(d, ctx, d.host.args.flagBool(args, "all"));
			if (verb === "tick") return tick(d, ctx);
			if (!["show", "pause", "resume", "run"].includes(verb ?? ""))
				return d.host.outcome.usage(
					verb === undefined
						? "kabane job needs a subcommand"
						: `Unknown job subcommand: ${verb}`,
					USAGE,
				);
			if (key === undefined)
				return d.host.outcome.usage(`job ${verb} needs a job id`, USAGE);
			if (verb === "show") return show(d, ctx, key);
			if (verb === "run") return runNow(d, ctx, key);
			return setState(d, key, verb === "pause" ? "someday" : "next");
		},
	};
};
