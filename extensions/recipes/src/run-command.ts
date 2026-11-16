// `kabane run <recipe> [--target <issue>] [--input k=v]… [<inputs JSON>]`: render a recipe's prompt,
// record the run, start the harness in a runtime terminal and return without waiting. With no
// recipe it lists the project's recipes.
import { hostname } from "node:os";
import { relative } from "node:path";
import type { Extension, Host, Outcome, ProjectScope } from "@cabane/extension";
import type { z } from "zod";
import { Inputs } from "./inputs";
import { Recipe } from "./recipe";
import { Runs } from "./runs";
import type { HcRuntime } from "./runtime-hc";

const USAGE =
	"kabane run [<recipe>] [--target <issue>] [--input name=value]... [--json '{\"name\": value}']";

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
	const broken = errors.map((error) => `Error: ${error.message}`);
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
			errors: errors.map((error) => error.message),
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

type Launch = {
	project: ProjectScope;
	recipe: Recipe.Recipe;
	target?: Recipe.Target;
	inputs: Record<string, Recipe.Value>;
	harness: readonly string[];
};

/** Record the run, start its terminal and log it on the target: the steps after every check. */
const launch = async (
	host: Host,
	runtime: HcRuntime.Runtime,
	ctx: Extension.Ctx,
	{ project, recipe, target, inputs, harness }: Launch,
): Promise<Outcome> => {
	const { name } = recipe;
	const id = Runs.newId();
	const terminal = `${name.slice(0, 22)}-${id.slice(-6).toLowerCase()}`;
	const text = `${preamble(id, name, target)}\n\n${Recipe.render(recipe, inputs, target)}`;
	const stored = await Runs.insert(
		host,
		{
			id,
			recipe: { name, hash: recipe.hash },
			...(target === undefined ? {} : { target: target.id }),
			scope: project.scopeUri,
			dir: relative(project.root, ctx.cwd),
			machine: hostname(),
			cwd: ctx.cwd,
			runtime: "hc",
			terminal,
			inputs,
			state: "running",
			startedAt: new Date().toISOString(),
		},
		ctx.actor,
	);
	if (!stored.ok) return host.outcome.failure(stored.error);
	const started = await runtime.start({
		argv: [...harness, text],
		cwd: ctx.cwd,
		name: terminal,
		labels: {
			"kabane.run": id,
			...(target === undefined ? {} : { "kabane.issue": target.shortId }),
		},
	});
	if (!started.ok) {
		await Runs.setState(host, id, "ended", ctx.actor);
		return host.outcome.failure(started.error);
	}
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
	return host.outcome.success(
		{
			run: id,
			terminal,
			attach: `kabane runs attach ${id}`,
			...(warnings.length ? { warnings } : {}),
		},
		[
			`Started run ${id} (${name}${target ? ` on ${target.shortId}` : ""}) in hc terminal ${terminal}.`,
			`Attach: kabane runs attach ${id}`,
			...warnings,
		].join("\n"),
	);
};

export const runCommand = (
	host: Host,
	settings: z.ZodTypeAny,
	runtime: HcRuntime.Runtime,
): Extension.Command => ({
	name: "run",
	summary: "Start a project recipe in a background terminal",
	usage: USAGE,
	run: async (args, ctx) => {
		const project = await projectOf(host, ctx.cwd, "run");
		if (!project.ok) return project.outcome;
		const [name, json, ...extra] = args.positionals;
		if (name === undefined) return list(host, project.value);
		// The CLI takes every `--json` as its own output flag, so the object arrives as a positional.
		if (
			extra.length > 0 ||
			(json !== undefined && !json.trim().startsWith("{"))
		)
			return host.outcome.usage(
				`Unexpected arguments: ${args.positionals.slice(1).join(" ")}`,
				USAGE,
			);
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
		const missing = runtime.missing();
		if (missing !== undefined) return host.outcome.failure(missing);
		return launch(host, runtime, ctx, {
			project: project.value,
			recipe: recipe.value,
			...(target.value === undefined ? {} : { target: target.value }),
			inputs: inputs.value,
			harness: (configured.value as { harness: string[] }).harness,
		});
	},
});
