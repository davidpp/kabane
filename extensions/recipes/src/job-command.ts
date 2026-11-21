// `kabane job`: a recipe on a schedule, in a project's folder. A job is an item of kind `job` (its
// title, its description as the standing request, its scope and its state) plus its row in
// `Jobs`. `tick`, which launchd or cron calls, fires every active job that is due; it has no
// project, so every `kabane job` run inside one records that project's folder for it.
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import type {
	Extension,
	Host,
	Outcome,
	ParsedArgs,
	ProjectScope,
	Result,
	Task,
} from "@kabane/extension";
import { Harness } from "./harness";
import { Inputs } from "./inputs";
import { Jobs } from "./jobs";
import { Recipe } from "./recipe";
import { err, ok } from "./result";
import {
	harnessOf,
	projectOf,
	promptOf,
	requestPromptOf,
	type settingsSchema,
	startRun,
} from "./run-command";
import { Runs } from "./runs";
import { pad } from "./runs-command";
import type { Runtime } from "./runtime";

const USAGE = [
	'kabane job add <recipe> --title <text> --schedule "<cron>" [--project <folder>] [--request <text>] [--input name=value]... [--inputs \'{"name": value}\'] [--harness a,b,c] [--session fresh|keep] [--check "<shell>"]',
	'kabane job add --title <text> --schedule "<cron>" --request <text> [--project <folder>] [--harness a,b,c] [--session fresh|keep] [--check "<shell>"]',
	'kabane job edit <id> [--title <text>] [--schedule "<cron>"] [--request <text>] [--input name=value]... [--inputs \'{"name": value}\'] [--harness a,b,c|none] [--session fresh|keep] [--check "<shell>"|none]',
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

/** What a run of a recipe-less job records as its recipe. */
const REQUEST = "request";

/** How a job with no recipe reads where a recipe's name would. */
export const NO_RECIPE = "the request";

/** What a fire runs: the job's recipe, or with none, its request as the item reads now. */
const sourceOf = (
	d: Deps,
	{ job, task }: Entry,
	root: string,
	target: Recipe.Target,
): Result<{
	recipe: Pick<Recipe.Recipe, "name" | "hash" | "harness">;
	inputs: Record<string, Recipe.Value>;
	prompt: (runId: string) => string;
}> => {
	if (job.recipe === undefined) {
		const request = task.description?.trim();
		if (!request)
			return err(
				new Error(
					`${shortOf(task)} has no recipe and no request: write the request in its description`,
				),
			);
		const hash = createHash("sha256")
			.update(request)
			.digest("hex")
			.slice(0, 12);
		return ok({
			recipe: { name: REQUEST, hash },
			inputs: {},
			prompt: (runId) => requestPromptOf(runId, target, request),
		});
	}
	const recipe = Recipe.load(d.host.z, root, job.recipe);
	if (!recipe.ok) return recipe;
	const inputs = Inputs.resolve(d.host.z, recipe.value, {
		pairs: [],
		json: JSON.stringify(job.inputs),
	});
	if (!inputs.ok) return inputs;
	return ok({
		recipe: recipe.value,
		inputs: inputs.value,
		prompt: (runId) => promptOf(runId, recipe.value, inputs.value, target),
	});
};

/** How a shell command failed: its exit code and its stderr's last line, when it wrote one. */
type Failure = { code: number; said?: string };

const sayingOf = ({ said }: Failure) => (said ? `: ${said}` : "");

/** Runs `command` with `sh -c` in `cwd`, with `env` over this process's: how it failed, if it did. */
const shell = async (
	command: string,
	cwd: string,
	env: Record<string, string>,
): Promise<Failure | undefined> => {
	const child = Bun.spawn(["sh", "-c", command], {
		cwd,
		env: { ...process.env, ...env },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	if (code === 0) return undefined;
	const said = stderr.trim().split("\n").at(-1);
	return said ? { code, said } : { code };
};

/** What the job's own commands, its check and the attention hook, are told of it. */
const jobEnv = ({ task }: Entry) => ({
	KABANE_JOB: shortOf(task),
	KABANE_JOB_TITLE: task.title,
});

/**
 * One fire of a job in `root`: the line that says what it did. With `checked`, a tick's due fire,
 * the job's check runs first, and a nonzero exit skips this slot's run.
 */
const fire = async (
	d: Deps,
	ctx: Pick<Extension.Ctx, "actor" | "settings">,
	found: Entry,
	{ root, now, checked }: { root: string; now: Date; checked: boolean },
): Promise<Result<string>> => {
	const { job, task } = found;
	const short = shortOf(task);
	const runs = await runsOf(d, found, ctx.actor);
	if (!runs.ok) return runs;
	const here = hostname();
	const decision = Jobs.decide(
		job.session,
		runs.value.filter((run) => run.machine === here),
	);
	if (decision.kind === "skip")
		return ok(
			`${short}: skipped, run ${decision.run.id} is still ${decision.run.state}`,
		);
	const fired = () =>
		Jobs.setFired(d.host, job.taskId, now.toISOString(), ctx.actor);
	if (checked && job.check !== undefined) {
		const failed = await shell(job.check, root, jobEnv(found));
		if (failed !== undefined) {
			// The slot is spent: a failing check runs once per scheduled time, not on every tick.
			const spent = await fired();
			return spent.ok
				? ok(
						`${short}: check exited ${failed.code}, skipped${sayingOf(failed)}`,
					)
				: spent;
		}
	}
	const target = {
		kind: "job",
		id: task.id,
		shortId: short,
		title: task.title,
	} as const;
	const source = sourceOf(d, found, root, target);
	if (!source.ok) return source;
	const { recipe, inputs, prompt } = source.value;
	let line: string;
	if (decision.kind === "wake") {
		const { run } = decision;
		if (d.runtime.send === undefined)
			return err(
				new Error(
					`${short}: the ${d.runtime.name} runtime cannot type into run ${run.id}'s terminal`,
				),
			);
		const sent = await d.runtime.send(run.session, prompt(run.id));
		if (!sent.ok) return sent;
		line = `${short}: woke run ${run.id} (${run.recipe.name}) in ${run.runtime} terminal ${run.session}`;
	} else {
		for (const run of decision.stop) {
			const stopped = await Runs.stop(d.host, d.runtime, run, ctx.actor);
			if (!stopped.ok) return stopped;
		}
		const harness = await harnessOf(ctx, d.settings, root, {
			job: job.harness,
			recipe,
		});
		if (!harness.ok) return harness;
		const started = await startRun(d.host, d.runtime, {
			scopeUri: task.scopeUri ?? "",
			root,
			dir: "",
			recipe,
			prompt,
			target,
			inputs,
			harness: harness.value.argv,
			actor: ctx.actor,
		});
		if (!started.ok) return started;
		const { run, warnings } = started.value;
		line = [
			`${short}: started run ${run.id} (${run.recipe.name}) in ${run.runtime} terminal ${run.session}`,
			...warnings,
		].join("\n");
	}
	const spent = await fired();
	return spent.ok ? ok(line) : spent;
};

/**
 * The harness the job's next fresh run would start, and where it comes from; with why not, when its
 * recipe does not load or this machine has no folder to read it from.
 */
const harnessFor = async (
	d: Deps,
	ctx: Pick<Extension.Ctx, "settings" | "cwd">,
	{ job }: Entry,
	root: string | undefined,
): Promise<Result<Harness.Chosen>> => {
	let recipe: Recipe.Recipe | undefined;
	if (job.harness === undefined && job.recipe !== undefined) {
		if (root === undefined)
			return err(
				new Error("unknown: no folder on this machine to read its recipe from"),
			);
		const loaded = Recipe.load(d.host.z, root, job.recipe);
		if (!loaded.ok) return loaded;
		recipe = loaded.value;
	}
	return harnessOf(ctx, d.settings, root ?? ctx.cwd, {
		job: job.harness,
		recipe,
	});
};

/** The recipe `job add` names and its inputs, checked now; none when it names none. */
const recipeFor = (
	d: Deps,
	args: ParsedArgs,
	root: string,
	name: string | undefined,
):
	| {
			ok: true;
			value: { recipe?: Recipe.Recipe; inputs: Record<string, Recipe.Value> };
	  }
	| { ok: false; outcome: Outcome } => {
	if (name === undefined) return { ok: true, value: { inputs: {} } };
	const fail = (outcome: Outcome) => ({ ok: false as const, outcome });
	const recipe = Recipe.load(d.host.z, root, name);
	if (!recipe.ok) return fail(d.host.outcome.failure(recipe.error));
	if (recipe.value.target === "issue")
		return fail(
			d.host.outcome.usage(
				`recipe "${name}" works on an issue; a job runs a recipe with "target: job" or none`,
				USAGE,
			),
		);
	const inputs = Inputs.resolve(d.host.z, recipe.value, {
		pairs: d.host.args.flagList(args, "input"),
		json: d.host.args.flagString(args, "inputs"),
	});
	return inputs.ok
		? { ok: true, value: { recipe: recipe.value, inputs: inputs.value } }
		: fail(d.host.outcome.usage(inputs.error.message, USAGE));
};

/** `folder` as a shell user means it: `~` is the home folder, a relative path is from `cwd`. */
const folderOf = (cwd: string, folder: string): string =>
	folder === "~"
		? homedir()
		: folder.startsWith("~/")
			? join(homedir(), folder.slice(2))
			: resolve(cwd, folder);

/** The project `job add` makes its job in: `--project`'s, recorded as `tick`'s folder for it, or the cwd's. */
const projectFor = async (
	d: Deps,
	args: ParsedArgs,
	cwd: string,
): Promise<
	{ ok: true; value: ProjectScope } | { ok: false; outcome: Outcome }
> => {
	const given = d.host.args.flagString(args, "project");
	if (given === undefined) return projectOf(d.host, cwd, "job add");
	const folder = folderOf(cwd, given);
	const fail = (outcome: Outcome) => ({ ok: false as const, outcome });
	const found = await d.host.scope.detect(folder);
	if (!found.ok) return fail(d.host.outcome.failure(found.error));
	if (found.value === null)
		return fail(
			d.host.outcome.failure(`--project ${folder} is in no kabane project`),
		);
	const saved = await Jobs.setRoot(
		d.host,
		found.value.scopeUri,
		found.value.root,
	);
	return saved.ok
		? { ok: true, value: found.value }
		: fail(d.host.outcome.failure(saved.error));
};

/** `--session`'s mode, `fallback` when not given, or the usage error that names what it takes. */
const sessionOf = (
	d: Deps,
	args: ParsedArgs,
	fallback: Jobs.Session | undefined,
):
	| { ok: true; value: Jobs.Session | undefined }
	| { ok: false; outcome: Outcome } => {
	const mode = d.host.args.flagString(args, "session");
	if (mode === undefined) return { ok: true, value: fallback };
	const session = Jobs.SESSIONS.find((one) => one === mode);
	return session === undefined
		? {
				ok: false,
				outcome: d.host.outcome.usage(
					`--session is fresh or keep, not "${mode}"`,
					USAGE,
				),
			}
		: { ok: true, value: session };
};

/** The harness and check `job add` gives the job's row, each only when its flag is given. */
const ownOf = (
	d: Deps,
	args: ParsedArgs,
): Pick<Jobs.Job, "harness" | "check"> => {
	const harness = d.host.args.flagCsv(args, "harness");
	const check = d.host.args.flagString(args, "check");
	return {
		...(harness === undefined ? {} : { harness }),
		...(check === undefined ? {} : { check }),
	};
};

const add = async (
	d: Deps,
	args: ParsedArgs,
	ctx: Extension.Ctx,
	name: string | undefined,
): Promise<Outcome> => {
	const project = await projectFor(d, args, ctx.cwd);
	if (!project.ok) return project.outcome;
	const title = d.host.args.flagString(args, "title");
	const schedule = d.host.args.flagString(args, "schedule");
	const request = d.host.args.flagString(args, "request");
	if (title === undefined || schedule === undefined)
		return d.host.outcome.usage("job add needs --title and --schedule", USAGE);
	if (name === undefined && !request?.trim())
		return d.host.outcome.usage(
			"job add needs a recipe or --request: with no recipe, the request is the prompt",
			USAGE,
		);
	const now = new Date();
	const valid = Jobs.nextAfter(schedule, now);
	if (!valid.ok) return d.host.outcome.usage(valid.error.message, USAGE);
	const chosen = recipeFor(d, args, project.value.root, name);
	if (!chosen.ok) return chosen.outcome;
	const { recipe, inputs } = chosen.value;
	const mode = sessionOf(d, args, "fresh");
	if (!mode.ok) return mode.outcome;
	const session = mode.value ?? "fresh";
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
	const own = ownOf(d, args);
	const stored = await Jobs.insert(
		d.host,
		{
			taskId: task.data.id,
			schedule,
			...(recipe === undefined ? {} : { recipe: recipe.name }),
			inputs,
			...own,
			session,
			createdAt: now.toISOString(),
		},
		ctx.actor,
	);
	if (!stored.ok) return d.host.outcome.failure(stored.error);
	const short = task.data.shortId ?? task.data.id;
	return d.host.outcome.success(
		{ job: task.data.id, shortId: short, next: valid.value.toISOString() },
		`Added job ${short} (${[
			recipe?.name ?? "no recipe",
			`"${schedule}"`,
			`${session} session`,
			...(own.check === undefined
				? []
				: [`only when \`${own.check}\` exits 0`]),
		].join(", ")}); it fires next at ${when(valid.value)}.`,
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
	const roots = await Jobs.roots(d.host);
	if (!roots.ok) return d.host.outcome.failure(roots.error);
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
		const harness = await harnessFor(
			d,
			ctx,
			one,
			roots.value.get(task.scopeUri ?? ""),
		);
		rows.push([
			shortOf(task),
			active,
			job.schedule,
			nextOf(job),
			job.recipe ?? "-",
			job.session,
			latest?.state ?? "-",
			task.title,
			harness.ok ? Harness.describe(harness.value) : harness.error.message,
		]);
		json.push({
			id: task.id,
			shortId: shortOf(task),
			title: task.title,
			scope: task.scopeUri,
			state: active,
			...job,
			...(harness.ok ? { starts: harness.value } : {}),
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
				"SESSION",
				"LAST RUN",
				"TITLE",
				"HARNESS",
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
	const roots = await Jobs.roots(d.host);
	if (!roots.ok) return d.host.outcome.failure(roots.error);
	const harness = await harnessFor(
		d,
		ctx,
		found.value,
		roots.value.get(task.scopeUri ?? ""),
	);
	const lines = [
		`${shortOf(task)}  ${task.title}`,
		`state     ${task.state === "next" ? "active" : task.state === "someday" ? "paused" : task.state}`,
		`schedule  ${job.schedule}  (next ${nextOf(job)})`,
		...(job.recipe === undefined
			? ["recipe    none: the request below is the prompt"]
			: [`recipe    ${job.recipe}`, `inputs    ${JSON.stringify(job.inputs)}`]),
		`harness   ${harness.ok ? Harness.describe(harness.value) : harness.error.message}`,
		`session   ${job.session === "keep" ? "keep: a fire types into the idle terminal" : "fresh: each fire starts a terminal"}`,
		`check     ${job.check === undefined ? "none" : `${job.check}  (a due fire runs only when it exits 0)`}`,
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
				...(harness.ok ? { starts: harness.value } : {}),
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

type Failed = { ok: false; outcome: Outcome };

/** What `job edit` was given: the item's fields, the row's change bar its inputs, the inputs as typed. */
type EditFlags = {
	title?: string;
	request?: string;
	change: Omit<Jobs.Change, "inputs">;
	json?: string;
	pairs: string[];
};

/** `job edit`'s flags, the schedule and session checked; a usage error when none names a field. */
const editFlagsOf = (
	d: Deps,
	args: ParsedArgs,
): { ok: true; value: EditFlags } | Failed => {
	const { args: a, outcome } = d.host;
	const fail = (message: string): Failed => ({
		ok: false,
		outcome: outcome.usage(message, USAGE),
	});
	const mode = sessionOf(d, args, undefined);
	if (!mode.ok) return mode;
	const schedule = a.flagString(args, "schedule");
	if (schedule !== undefined) {
		const valid = Jobs.nextAfter(schedule, new Date());
		if (!valid.ok) return fail(valid.error.message);
	}
	const harness = a.flagCsv(args, "harness");
	const check = a.flagString(args, "check");
	const change: EditFlags["change"] = {
		...(schedule === undefined ? {} : { schedule }),
		// `none` hands the choice back to the recipe and recipes.harness.
		...(harness === undefined
			? {}
			: { harness: harness.join(",") === "none" ? null : harness }),
		...(mode.value === undefined ? {} : { session: mode.value }),
		...(check === undefined ? {} : { check: check === "none" ? null : check }),
	};
	const flags: EditFlags = {
		title: a.flagString(args, "title"),
		request: a.flagString(args, "request"),
		change,
		json: a.flagString(args, "inputs"),
		pairs: a.flagList(args, "input"),
	};
	const given =
		flags.title !== undefined ||
		flags.request !== undefined ||
		flags.json !== undefined ||
		flags.pairs.length > 0 ||
		Object.keys(change).length > 0;
	return given
		? { ok: true, value: flags }
		: fail(
				"job edit needs a field to change: --title, --schedule, --request, --input, --inputs, --harness, --session or --check",
			);
};

/** The job's inputs after `--inputs` and `--input`, checked against its recipe; none when neither is given. */
const editedInputs = async (
	d: Deps,
	found: Entry,
	{ json, pairs }: EditFlags,
): Promise<
	{ ok: true; value: Record<string, Recipe.Value> | undefined } | Failed
> => {
	if (json === undefined && pairs.length === 0)
		return { ok: true, value: undefined };
	const { job, task } = found;
	const { outcome } = d.host;
	const fail = (failed: Outcome): Failed => ({ ok: false, outcome: failed });
	if (job.recipe === undefined)
		return fail(
			outcome.usage(`${shortOf(task)} has no recipe, so no inputs`, USAGE),
		);
	const roots = await Jobs.roots(d.host);
	if (!roots.ok) return fail(outcome.failure(roots.error));
	const root = roots.value.get(task.scopeUri ?? "");
	if (root === undefined) return fail(outcome.failure(noFolder(found)));
	const recipe = Recipe.load(d.host.z, root, job.recipe);
	if (!recipe.ok) return fail(outcome.failure(recipe.error));
	// --inputs replaces the set; each --input sets one over it, or over the job's own.
	const resolved = Inputs.resolve(d.host.z, recipe.value, {
		pairs,
		json: json ?? JSON.stringify(job.inputs),
	});
	return resolved.ok
		? { ok: true, value: resolved.value }
		: fail(outcome.usage(resolved.error.message, USAGE));
};

/** What `job edit` says it changed. */
const editedOf = (
	{ title, request, change }: EditFlags,
	inputs?: object,
): string =>
	[
		...(title === undefined ? [] : [`title "${title}"`]),
		...(request === undefined ? [] : ["request"]),
		...(change.schedule === undefined ? [] : [`schedule "${change.schedule}"`]),
		...(inputs === undefined ? [] : [`inputs ${JSON.stringify(inputs)}`]),
		...(change.harness === undefined
			? []
			: [
					change.harness === null
						? "harness from recipes.harness"
						: `harness ${change.harness.join(" ")}`,
				]),
		...(change.session === undefined ? [] : [`${change.session} session`]),
		...(change.check === undefined
			? []
			: [change.check === null ? "no check" : `check \`${change.check}\``]),
	].join(", ");

/** `job edit`: changes only the fields given, on the item (title, request) and on the row. */
const editJob = async (
	d: Deps,
	args: ParsedArgs,
	ctx: Extension.Ctx,
	key: string,
): Promise<Outcome> => {
	const { outcome } = d.host;
	const flags = editFlagsOf(d, args);
	if (!flags.ok) return flags.outcome;
	const { title, request } = flags.value;
	const found = await entry(d, key);
	if (!found.ok) return outcome.failure(found.error);
	const { job, task } = found.value;
	const short = shortOf(task);
	if (job.recipe === undefined && request?.trim() === "")
		return outcome.usage(
			`${short} has no recipe: its request is the prompt and cannot be empty`,
			USAGE,
		);
	const inputs = await editedInputs(d, found.value, flags.value);
	if (!inputs.ok) return inputs.outcome;
	if (title !== undefined || request !== undefined) {
		const edited = await d.host.record.edit({
			id: task.id,
			...(title === undefined ? {} : { title }),
			...(request === undefined ? {} : { description: request }),
		});
		if (!edited.ok) return outcome.failure(edited.error);
	}
	const change: Jobs.Change = {
		...flags.value.change,
		...(inputs.value === undefined ? {} : { inputs: inputs.value }),
	};
	const updated =
		Object.keys(change).length === 0
			? ok(job)
			: await Jobs.update(d.host, Jobs.edit(job, change), ctx.actor);
	if (!updated.ok) return outcome.failure(updated.error);
	const next = Jobs.next(updated.value);
	return outcome.success(
		{
			job: task.id,
			shortId: short,
			...(next.ok ? { next: next.value.toISOString() } : {}),
		},
		`Edited job ${short} (${editedOf(flags.value, inputs.value)}); it fires next at ${nextOf(updated.value)}.`,
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
	// The human asked for this run: the check is for the schedule's fires.
	return fire(d, ctx, found.value, {
		root,
		now: new Date(),
		checked: false,
	});
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

/** Runs `command` with the facts of what `run` of the job asks of the human: why it failed, or undefined. */
const runHook = async (
	command: string,
	one: Entry,
	run: Runs.Run,
	attention: Jobs.Attention,
): Promise<string | undefined> => {
	const failed = await shell(command, run.cwd, {
		...jobEnv(one),
		KABANE_RUN: run.id,
		KABANE_RUN_STATE: run.state,
		KABANE_ATTENTION: attention,
		KABANE_FOLDER: run.cwd,
		KABANE_ATTACH: `kabane runs attach ${run.id}`,
	});
	return failed && `exited ${failed.code}${sayingOf(failed)}`;
};

/**
 * Tells the human, through `recipes.onAttention`, when the newest run of a job on this machine has
 * just entered `waiting` or finished. What this machine last saw is recorded whether or not the
 * hook is set, so setting it later does not replay every past finish.
 */
const notify = async (
	d: Deps,
	ctx: Extension.Ctx,
	one: Entry,
	root: string | undefined,
): Promise<Result<string | undefined>> => {
	const runs = await runsOf(d, one, ctx.actor);
	if (!runs.ok) return runs;
	const here = hostname();
	const run = runs.value.find((r) => r.machine === here);
	if (run === undefined) return ok(undefined);
	const seen = await Jobs.seen(d.host, run.id);
	if (!seen.ok) return seen;
	if (seen.value === run.state) return ok(undefined);
	const attention = Jobs.attention(seen.value, run.state);
	const saved = await Jobs.setSeen(d.host, run.id, run.state);
	if (!saved.ok) return saved;
	if (attention === undefined) return ok(undefined);
	const configured = await ctx.settings("recipes", d.settings, {
		projectDir: root ?? ctx.cwd,
	});
	if (!configured.ok) return configured;
	const command = configured.value.onAttention;
	if (command === undefined) return ok(undefined);
	const failed = await runHook(command, one, run, attention);
	const short = shortOf(one.task);
	return ok(
		failed === undefined
			? `${short}: run ${run.id} is ${run.state}; recipes.onAttention ran`
			: `${short}: run ${run.id} is ${run.state}; recipes.onAttention ${failed}`,
	);
};

const tick = async (d: Deps, ctx: Extension.Ctx): Promise<Outcome> => {
	const now = new Date();
	const found = await entries(d);
	if (!found.ok) return d.host.outcome.failure(found.error);
	const roots = await Jobs.roots(d.host);
	if (!roots.ok) return d.host.outcome.failure(roots.error);
	const lines: string[] = [];
	// Paused jobs too: a run that waits on the human still does after its job is paused.
	for (const one of found.value) {
		const said = await notify(
			d,
			ctx,
			one,
			roots.value.get(one.task.scopeUri ?? ""),
		);
		if (!said.ok) lines.push(`${shortOf(one.task)}: ${said.error.message}`);
		else if (said.value !== undefined) lines.push(said.value);
	}
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
		const line = await fire(d, ctx, one, { root, now, checked: true });
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
			"Run a project recipe on a schedule; add, edit, list, pause, resume or fire jobs",
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
			if (!["show", "edit", "pause", "resume", "run"].includes(verb ?? ""))
				return d.host.outcome.usage(
					verb === undefined
						? "kabane job needs a subcommand"
						: `Unknown job subcommand: ${verb}`,
					USAGE,
				);
			if (key === undefined)
				return d.host.outcome.usage(`job ${verb} needs a job id`, USAGE);
			if (verb === "show") return show(d, ctx, key);
			if (verb === "edit") return editJob(d, args, ctx, key);
			if (verb === "run") return runNow(d, ctx, key);
			return setState(d, key, verb === "pause" ? "someday" : "next");
		},
	};
};
