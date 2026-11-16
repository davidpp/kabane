// The recipes extension: `kabane run` and `kabane runs`, its one setting, its doctor check, and on
// the board a card per run that names an issue and `a` offering the recipes that work on one.
import type { Extension, Host } from "@cabane/extension";
import { RecipeActivity } from "./activity";
import { RecipeDispatcher } from "./dispatcher";
import { Kabane, ok } from "./result";
import { runCommand, settingsSchema } from "./run-command";
import { runsCommand } from "./runs-command";
import { HcRuntime } from "./runtime-hc";

export const recipes = (host: Host): Extension => {
	Kabane.bind(host);
	const settings = settingsSchema(host.z);
	const runtime = HcRuntime.runtime(host.z);
	return {
		name: "recipes",
		settings,
		commands: [runCommand(host, settings, runtime), runsCommand(host, runtime)],
		// Ports for the board's project, the folder it was opened in.
		board: async (ctx) => {
			const project = () => host.scope.detect(ctx.cwd);
			return {
				activity: RecipeActivity.source({
					host,
					runtime,
					project,
					actor: ctx.actor,
				}),
				dispatcher: RecipeDispatcher.make({
					host,
					runtime,
					project,
					settings,
					ctx,
				}),
			};
		},
		doctor: async () => {
			const missing = runtime.missing();
			return ok(
				missing === undefined
					? []
					: [
							{
								id: "hc-missing",
								severity: "mention" as const,
								summary: missing,
							},
						],
			);
		},
	};
};
