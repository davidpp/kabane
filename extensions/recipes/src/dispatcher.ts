// Starting a recipe from the board: `a` on an issue offers each recipe of the board's project that
// works on an issue, with its inputs as the form's, and `enter` starts it through `startRun`, the
// function `kabane run` calls. A recipe file that does not parse is offered too, unsatisfiable,
// with its error, so a broken recipe is never silently missing. On a job, `a` offers `job:run`, which
// fires it now as `kabane job run` does, in its own scope's folder whatever the board's project.
import { basename, relative } from "node:path";
import type {
	Dispatcher,
	Extension,
	Host,
	ProjectScope,
	Result,
	TriggerDescriptor,
} from "@cabane/extension";
import { Inputs } from "./inputs";
import { runJob } from "./job-command";
import { Recipe } from "./recipe";
import { err, ok } from "./result";
import { type settingsSchema, startRun } from "./run-command";
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

	/** Why the board cannot start `recipe` with what its form holds, or undefined. */
	const unmet = (
		recipe: Recipe.Recipe,
		shortId: string,
	): string | undefined => {
		const missing = Object.entries(recipe.inputs)
			.filter(([, input]) => input.required && input.default === undefined)
			.map(([name]) => name);
		return missing.length === 0
			? undefined
			: `${recipe.name} needs ${missing.join(", ")}, which has no default: kabane run ${recipe.name} --target ${shortId} ${missing.map((name) => `--input ${name}=…`).join(" ")}`;
	};

	const descriptor = (
		recipe: Recipe.Recipe,
		shortId: string,
		blocked?: string,
	): TriggerDescriptor => {
		const hint = blocked ?? unmet(recipe, shortId);
		return {
			id: `${PREFIX}${recipe.name}`,
			label: recipe.name,
			...(recipe.description ? { description: recipe.description } : {}),
			source: "recipes",
			inputs: recipe.inputs,
			satisfiable: hint === undefined,
			...(hint === undefined ? {} : { hint }),
		};
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
			const shortId = task.value.shortId ?? task.value.id;
			const { recipes, errors } = Recipe.all(deps.host.z, project.value.root);
			const blocked = deps.runtime.missing();
			return ok([
				...recipes
					.filter((recipe) => recipe.target === "issue")
					.map((recipe) => descriptor(recipe, shortId, blocked)),
				...errors.map(broken),
			]);
		},
		dispatch: async (triggerId, target, inputs) => {
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
			const values = Inputs.resolve(host.z, recipe.value, {
				pairs: [],
				json: JSON.stringify(inputs ?? {}),
			});
			if (!values.ok) return values;
			const configured = await ctx.settings("recipes", deps.settings, {
				projectDir: root,
			});
			if (!configured.ok) return configured;
			const started = await startRun(host, deps.runtime, {
				scopeUri,
				root,
				dir: relative(root, ctx.cwd),
				recipe: recipe.value,
				target: {
					kind: "issue",
					id: target.id,
					shortId: target.shortId,
					title: target.title,
				},
				inputs: values.value,
				harness: configured.value.harness,
				actor: ctx.actor,
			});
			if (!started.ok) return started;
			const { run, warnings } = started.value;
			return ok(
				[
					`started run ${run.id} (${run.recipe.name} on ${target.shortId}) · kabane runs attach ${run.id}`,
					...warnings,
				].join(" · "),
			);
		},
	});
}
