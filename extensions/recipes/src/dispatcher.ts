// Starting a recipe from the board: `a` on an issue offers each recipe of the board's project that
// works on an issue, and `enter` opens its form: the harness first, as the command line it will
// start and where that comes from, then every input with its default, each one the human can
// change. `enter` on the form starts it through `startRun`, the function `kabane run` calls, with
// what the form shows; beside its settings, the form names the skill the run will use. A recipe
// file that does not parse is offered too, unsatisfiable, with its error, so a broken recipe is
// never silently missing. On a job, `a` offers `job:run`, which fires it now as `kabane job run`
// does, in its own scope's folder whatever the board's project.
import { basename, relative } from "node:path";
import type {
	Dispatcher,
	Extension,
	Host,
	ProjectScope,
	Result,
	TriggerDescriptor,
} from "@cabane/extension";
import { Harness } from "./harness";
import { Inputs } from "./inputs";
import { runJob } from "./job-command";
import { Recipe } from "./recipe";
import { err, ok } from "./result";
import {
	harnessOf,
	promptOf,
	type settingsSchema,
	startRun,
} from "./run-command";
import type { Runtime } from "./runtime";

export namespace RecipeDispatcher {
	const PREFIX = "recipe:";
	const RUN_JOB = "job:run";

	type Deps = {
		host: Host;
		runtime: Runtime;
		project: () => Promise<Result<ProjectScope | null>>;
		settings: ReturnType<typeof settingsSchema>;
		ctx: Pick<Extension.Ctx, "cwd" | "actor" | "settings">;
	};

	/** The form's harness row; no input can take its name, since input names start with a letter or `_`. */
	const HARNESS = "@harness";

	const descriptor = (
		recipe: Recipe.Recipe,
		harness: Harness.Chosen,
		blocked?: string,
	): TriggerDescriptor => ({
		id: `${PREFIX}${recipe.name}`,
		label: recipe.name,
		...(recipe.description ? { description: recipe.description } : {}),
		source: "recipes",
		inputs: {
			[HARNESS]: {
				type: "string",
				required: true,
				default: Harness.line(harness.argv),
				label: "harness",
				hint: `${Harness.from(harness.source)}; the prompt is added as its last word`,
			},
			...recipe.inputs,
		},
		satisfiable: blocked === undefined,
		...(blocked === undefined ? {} : { hint: blocked }),
		preview: [
			[
				{ text: "Uses the ", tone: "muted" },
				{ text: recipe.skill, bold: true },
				{ text: " skill", tone: "muted" },
			],
			[{ text: recipe.skillFile, tone: "muted" }],
		],
	});

	/**
	 * The form's values as `Inputs.resolve` takes them: text as typed, which it converts to the
	 * input's type as it does `--input`, an empty one left out, and the rest as JSON.
	 */
	const given = (values: Readonly<Record<string, unknown>>): Inputs.Given => {
		const pairs: string[] = [];
		const json: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(values)) {
			if (name === HARNESS || value === "" || value === undefined) continue;
			if (typeof value === "string") pairs.push(`${name}=${value}`);
			else json[name] = value;
		}
		return { pairs, json: JSON.stringify(json) };
	};

	/** A recipe file that failed to parse, named after its file. */
	const broken = ({ file, error }: Recipe.Broken): TriggerDescriptor => {
		const name = basename(file, ".md");
		return {
			id: `${PREFIX}${name}`,
			label: name,
			source: "recipes",
			inputs: {},
			satisfiable: false,
			hint: error.message,
		};
	};

	/** `a` on a job: fire it now. Blocked only when the runtime is missing. */
	const runNow = (blocked: string | undefined): TriggerDescriptor => ({
		id: RUN_JOB,
		label: "run now",
		description: "fire this job now, as kabane job run does",
		source: "recipes",
		inputs: {},
		satisfiable: blocked === undefined,
		...(blocked === undefined ? {} : { hint: blocked }),
	});

	export const make = (deps: Deps): Dispatcher => ({
		triggers: async (taskId) => {
			const task = await deps.host.record.get({ id: taskId });
			if (!task.ok) return task;
			if (task.value?.kind === "job")
				return ok([runNow(deps.runtime.missing())]);
			if (task.value === null || task.value.kind !== "issue") return ok([]);
			const project = await deps.project();
			if (!project.ok) return project;
			if (project.value === null) return ok([]);
			const { root } = project.value;
			const { recipes, errors } = Recipe.all(deps.host.z, root);
			const blocked = deps.runtime.missing();
			const offered: TriggerDescriptor[] = [];
			for (const recipe of recipes) {
				if (recipe.target !== "issue") continue;
				const harness = await harnessOf(deps.ctx, deps.settings, root, {
					recipe,
				});
				if (!harness.ok) return harness;
				offered.push(descriptor(recipe, harness.value, blocked));
			}
			return ok([...offered, ...errors.map(broken)]);
		},
		dispatch: async (triggerId, target, inputs, edited) => {
			if (triggerId === RUN_JOB) return runJob(deps, deps.ctx, target.id);
			if (!triggerId.startsWith(PREFIX))
				return err(new Error(`Unknown recipe trigger: ${triggerId}`));
			const project = await deps.project();
			if (!project.ok) return project;
			if (project.value === null)
				return err(
					new Error(`${deps.ctx.cwd} is in no project: no recipe to start`),
				);
			const { host, ctx } = deps;
			const { root, scopeUri } = project.value;
			const recipe = Recipe.load(host.z, root, triggerId.slice(PREFIX.length));
			if (!recipe.ok) return recipe;
			if (recipe.value.target !== "issue")
				return err(new Error(`recipe "${recipe.value.name}" takes no target`));
			const values = Inputs.resolve(host.z, recipe.value, given(inputs ?? {}));
			if (!values.ok) return values;
			// An edited harness row is set at launch; one left as shown is the precedence's own.
			const typed = inputs?.[HARNESS];
			const launch =
				typeof typed === "string" && edited?.includes(HARNESS)
					? Harness.split(typed)
					: undefined;
			if (launch !== undefined && !launch.ok) return launch;
			const harness = await harnessOf(ctx, deps.settings, root, {
				launch: launch?.value,
				recipe: recipe.value,
			});
			if (!harness.ok) return harness;
			const on = {
				kind: "issue",
				id: target.id,
				shortId: target.shortId,
				title: target.title,
			} as const;
			const started = await startRun(host, deps.runtime, {
				scopeUri,
				root,
				dir: relative(root, ctx.cwd),
				recipe: recipe.value,
				prompt: (id) => promptOf(id, recipe.value, values.value, on),
				target: on,
				inputs: values.value,
				harness: harness.value.argv,
				actor: ctx.actor,
			});
			if (!started.ok) return started;
			const { run, warnings } = started.value;
			return ok(
				[
					`started run ${run.id} (${run.recipe.name} on ${target.shortId}) with ${Harness.describe(harness.value)} · kabane runs attach ${run.id}`,
					...warnings,
				].join(" · "),
			);
		},
	});
}
