import { ScopeUri } from "@cabane/core";
import { success } from "@cabane/extension";
import { type Command, detectProject } from "../context";

export const scope: Command = {
	name: "scope",
	summary: "Show the project scope resolved from the current directory",
	usage: "kabane scope [--json]",
	standalone: true,
	run: async (_args, ctx) => {
		const project = await detectProject(ctx.cwd, ctx.home);
		if (!project) return success({ scopeUri: null }, "No project scope");
		return success(
			{ ...project, baseUri: ScopeUri.fromScopeId(project.scopeId) },
			`${project.name} · ${project.scopeUri} · ${project.root}`,
		);
	},
};
