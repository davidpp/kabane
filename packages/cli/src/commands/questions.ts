import {
	failure,
	flagBool,
	flagString,
	success,
	usage,
} from "@cabane/extension";
import { questionPageMarkdown, questionRowPage } from "@cabane/questions";
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

		// One page for both outputs: the text is what kabane_questions prints, and --json pages
		// the same rows in the envelope `list --format concise --json` uses.
		const page = await questionRowPage(ctx.store, {
			id,
			scopeUri,
			status,
			...options.value,
		});
		if (!page.ok) return failure(page.error);
		const { rows, nextCursor } = page.value;
		return success(
			{
				items: rows,
				hasMore: nextCursor !== undefined,
				...(nextCursor === undefined ? {} : { nextCursor }),
			},
			questionPageMarkdown(page.value),
		);
	},
};
