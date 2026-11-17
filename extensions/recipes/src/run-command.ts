// `kabane run <recipe> [--target <issue>] [--input k=v]… [--inputs <JSON>]`: render a recipe's prompt,
// record the run, start the harness in a runtime terminal and return without waiting. With no
// recipe it lists the project's recipes.
import { hostname } from "node:os";
import { join, relative } from "node:path";
import type {
	Extension,
	Host,
	Outcome,
	ProjectScope,
	Result,
} from "@cabane/extension";
import { Inputs } from "./inputs";
import { Recipe } from "./recipe";
import { err, ok } from "./result";
import { Runs } from "./runs";
import type { Runtime } from "./runtime";

/** The `recipes` settings namespace. */
export const settingsSchema = (z: Host["z"]) =>
	z
		.object({
			harness: z
				.array(z.string().min(1))
				.min(1)
				.default(["claude"])
				.describe(
					"The command a recipe run starts, as a list; the prompt is added as its last argument. Kabane adds no flags of its own. Default: claude.",
				),
		})
		.strict();

const USAGE =
	"kabane run [<recipe>] [--target <issue>] [--input name=value]... [--inputs '{\"name\": value}']";

/** The project the command runs in, or the one line that says there is none. */
export const projectOf = async (
	host: Host,
	cwd: string,
	command: string,
): Promise<
	{ ok: true; value: ProjectScope } | { ok: false; outcome: Outcome }
> => {
	const here = await host.scope.detect(cwd);
	if (!here.ok) return { ok: false, outcome: host.outcome.failure(here.error) };
	if (here.value === null)
		return {
			ok: false,
			outcome: host.outcome.failure(
				`kabane ${command} works inside a project, and ${cwd} is in none; run it from the project's folder`,
			),
		};
	return { ok: true, value: here.value };
};

/** What the agent reads before the recipe's own prompt. */
const preamble = (
	runId: string,
	recipe: string,
	target: Recipe.Target | undefined,
): string => {
	const lines = [
		`[kabane run ${runId}, recipe "${recipe}"]`,
		"You were started in the background. Nobody is watching this terminal.",
	];
	if (target === undefined)
		lines.push(
			"When a decision belongs to the human, write the question as your last message and stop.",
			"Write your result as your last message.",
		);
	else
		lines.push(
			`When a decision belongs to the human, file it with kabane_ask on ${target.shortId} (the choices, your recommendation and why), then stop.`,
			`Write your result as a comment on ${target.shortId} with kabane_comment.`,
		);
	return lines.join("\n");
};

const describe = (recipe: Recipe.Recipe): string => {
	const head = `${recipe.name}${recipe.target === "issue" ? " --target <issue>" : ""}${recipe.description ? `  ${recipe.description}` : ""}`;
	const inputs = Object.entries(recipe.inputs).map(([name, input]) => {
		const kind = input.options ? input.options.join("|") : input.type;
		const extra = [
			input.required ? "required" : undefined,
			input.default !== undefined
				? `default ${String(input.default)}`
				: undefined,
		].filter(Boolean);
		return `    --input ${name}=<${kind}>${extra.length ? ` (${extra.join(", ")})` : ""}${input.hint ? `  ${input.hint}` : ""}`;
	});
	return [head, ...inputs].join("\n");
};

const list = (host: Host, project: ProjectScope): Outcome => {
	const { recipes, errors } = Recipe.all(host.z, project.root);
	const shown =
		recipes.length > 0
			? recipes.map(describe).join("\n")
			: `No recipes in ${Recipe.DIR}/ of ${project.root}.`;
	const broken = errors.map(({ error }) => `Error: ${error.message}`);
	return {
		exitCode: errors.length > 0 ? 1 : 0,
		json: {
			recipes: recipes.map(({ name, description, target, inputs, file }) => ({
				name,
				description,
				target,
				inputs,
				file,
			})),
			errors: errors.map(({ error }) => error.message),
		},
		text: [shown, ...broken].join("\n"),
	};
};

/** Bun's line prompt at a terminal; no prompts when either end is not one. */
const terminalAsk = (): Inputs.Ask | undefined =>
	process.stdin.isTTY && process.stdout.isTTY
		? (question) => prompt(question.replace(/\s+$/, ""))
		: undefined;

/** The issue a recipe works on, checked against what the recipe declares. */
const targetOf = async (
	host: Host,
	recipe: Recipe.Recipe,
	id: string | undefined,
): Promise<
	{ ok: true; value?: Recipe.Target } | { ok: false; outcome: Outcome }
> => {
	const fail = (outcome: Outcome) => ({ ok: false as const, outcome });
	if (recipe.target === "issue" && id === undefined)
		return fail(
			host.outcome.usage(
				`recipe "${recipe.name}" works on an issue: pass --target <issue>`,
				USAGE,
			),
		);
	if (recipe.target === "none" && id !== undefined)
		return fail(
			host.outcome.usage(
				`recipe "${recipe.name}" takes no target (its frontmatter has no "target: issue")`,
				USAGE,
			),
		);
	if (id === undefined) return { ok: true };
	const task = await host.record.get({ id });
	if (!task.ok) return fail(host.outcome.failure(task.error));
	if (task.value === null)
		return fail(host.outcome.failure(`No issue found: ${id}`));
	return {
		ok: true,
		value: {
			id: task.value.id,
			shortId: task.value.shortId ?? task.value.id,
			title: task.value.title,
		},
	};
};

/** The short id of task `id`, or `id` when it has none or cannot be read. */
export const shortIdOf = async (host: Host, id: string): Promise<string> => {
	const task = await host.record.get({ id });
	return task.ok && task.value ? (task.value.shortId ?? id) : id;
};

/** What starting a run takes: everything explicit, no cwd, no terminal, no settings read. */
export type Start = {
	scopeUri: string;
	/** The scope's root folder. */
	root: string;
	/** The folder the run starts in, relative to `root` ("" at the root). */
	dir: string;
	recipe: Recipe.Recipe;
	target?: Recipe.Target;
	/** The recipe's inputs, already resolved and validated. */
	inputs: Record<string, Recipe.Value>;
	/** The command the prompt is appended to: `recipes.harness`. */
	harness: readonly string[];
	actor: string;
};

/** A run that started, and what went wrong after it did. */
type Started = { run: Runs.Run; warnings: string[] };

/**
 * Record the run, start it in the runtime and log it on the target. `kabane run` calls it after
 * resolving its inputs from the cwd, its flags and its prompts; the board's dispatcher calls it
 * with the form's inputs.
 */
export const startRun = async (
	host: Host,
	runtime: Runtime,
	{ scopeUri, root, dir, recipe, target, inputs, harness, actor }: Start,
): Promise<Result<Started>> => {
	const blocked = runtime.missing();
	if (blocked !== undefined) return err(new Error(blocked));
	const { name } = recipe;
	const id = Runs.newId();
	const text = `${preamble(id, name, target)}\n\n${Recipe.render(recipe, inputs, target)}`;
	const cwd = join(root, dir);
	// Recorded before it starts, so a start that fails still leaves an ended run to see.
	const stored = await Runs.insert(
		host,
		{
			id,
			recipe: { name, hash: recipe.hash },
			...(target === undefined
				? {}
				: { target: { kind: "issue", id: target.id } }),
			scope: scopeUri,
			dir,
			machine: hostname(),
			cwd,
			runtime: runtime.name,
			session: Runs.STARTING,
			inputs,
			state: "live",
			startedAt: new Date().toISOString(),
		},
		actor,
	);
	if (!stored.ok) return stored;
	const started = await runtime.start({
		run: id,
		title: name,
		argv: [...harness, text],
		cwd,
		labels: {
			"kabane.run": id,
			...(target === undefined ? {} : { "kabane.issue": target.shortId }),
		},
	});
	if (!started.ok) {
		const ended = await Runs.setState(host, id, "ended", actor);
		return ended.ok
			? started
			: err(
					new Error(
						`${started.error.message}; the run row ${id} is still recorded as live: ${ended.error.message}`,
					),
				);
	}
	const session = await Runs.setSession(host, id, started.value, actor);
	if (!session.ok)
		return err(
			new Error(
				`${runtime.name} session ${started.value} started, and run ${id} does not record it: ${session.error.message}`,
			),
		);
	const run = { ...stored.value, session: started.value };
	const warnings: string[] = [];
	if (target !== undefined) {
		const logged = await host.record.log({
			id: target.id,
			refs: [{ uri: `run:${id}`, label: `kabane run ${name}` }],
		});
		if (!logged.ok)
			warnings.push(
				`Warning: the run: ref was not logged on ${target.shortId}: ${logged.error.message}`,
			);
	}
	return ok({ run, warnings });
};

export const runCommand = (
	host: Host,
	settings: ReturnType<typeof settingsSchema>,
	runtime: Runtime,
): Extension.Command => ({
	name: "run",
	summary: "Start a project recipe in a background terminal",
	usage: USAGE,
	run: async (args, ctx) => {
		const project = await projectOf(host, ctx.cwd, "run");
		if (!project.ok) return project.outcome;
		const [name, positional, ...extra] = args.positionals;
		if (name === undefined) return list(host, project.value);
		// The inputs object may also follow the recipe name bare, as a positional.
		if (
			extra.length > 0 ||
			(positional !== undefined && !positional.trim().startsWith("{"))
		)
			return host.outcome.usage(
				`Unexpected arguments: ${args.positionals.slice(1).join(" ")}`,
				USAGE,
			);
		const flagged = host.args.flagString(args, "inputs");
		if (flagged !== undefined && positional !== undefined)
			return host.outcome.usage(
				"Give the inputs JSON once: with --inputs or after the recipe name",
				USAGE,
			);
		const json = flagged ?? positional;
		const recipe = Recipe.load(host.z, project.value.root, name);
		if (!recipe.ok) return host.outcome.failure(recipe.error);
		const target = await targetOf(
			host,
			recipe.value,
			host.args.flagString(args, "target"),
		);
		if (!target.ok) return target.outcome;
		const inputs = Inputs.resolve(
			host.z,
			recipe.value,
			{ pairs: host.args.flagList(args, "input"), json },
			terminalAsk(),
		);
		if (!inputs.ok) return host.outcome.usage(inputs.error.message, USAGE);
		const configured = await ctx.settings("recipes", settings, {
			projectDir: project.value.root,
		});
		if (!configured.ok) return host.outcome.failure(configured.error);
		const started = await startRun(host, runtime, {
			scopeUri: project.value.scopeUri,
			root: project.value.root,
			dir: relative(project.value.root, ctx.cwd),
			recipe: recipe.value,
			...(target.value === undefined ? {} : { target: target.value }),
			inputs: inputs.value,
			harness: configured.value.harness,
			actor: ctx.actor,
		});
		if (!started.ok) return host.outcome.failure(started.error);
		const { run, warnings } = started.value;
		const on = target.value ? ` on ${target.value.shortId}` : "";
		return host.outcome.success(
			{
				run: run.id,
				session: run.session,
				attach: `kabane runs attach ${run.id}`,
				...(warnings.length ? { warnings } : {}),
			},
			[
				`Started run ${run.id} (${run.recipe.name}${on}) in ${run.runtime} terminal ${run.session}.`,
				`Attach: kabane runs attach ${run.id}`,
				...warnings,
			].join("\n"),
		);
	},
});
