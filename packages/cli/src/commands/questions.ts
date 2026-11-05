import {
	flagBool,
	flagString,
	failure,
	success,
	usage,
} from "@cabane/extension";
import { questionPage, Questions } from "@cabane/questions";
import { type Command, resolveScopeUri } from "../context";
import { pageOptions } from "../response-format";

export const questions: Command = {
	name: "questions",
	summary: "List open questions on this scope's issues, or on one issue",
	usage:
		"kabane questions [<id>] [--all] [--scope <uri>] [--limit <n>] [--cursor <cursor>] [--json]",
	run: async (args, ctx) => {
		const options = pageOptions(args);
		if (!options.ok) return usage(options.error.message, questions.usage);
		const id = args.positionals[0];
		// One issue is its own boundary; without one, the directory's scope is, as for `list`.
		const scopeUri =
			id === undefined
				? await resolveScopeUri(args, ctx)
				: flagString(args, "scope");
		const status = flagBool(args, "all") ? "all" : "open";

		// The text is the MCP tool's bounded page. --json carries the rows, capped by an explicit
		// --limit as `list --json` is; the page's cursor is opaque markdown state, text only.
		const [page, rows] = await Promise.all([
			questionPage(ctx.store, { id, scopeUri, status, ...options.value }),
			Questions.list(ctx.store, { id, scopeUri, status }),
		]);
		if (!page.ok) return failure(page.error);
		if (!rows.ok) return failure(rows.error);
		const capped =
			args.flags.limit === undefined
				? rows.value
				: rows.value.slice(0, options.value.limit);
		return success(capped, page.value);
	},
};
