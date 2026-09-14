import { Planner, type UpstreamLink } from "@cabane/core";
import { flagString } from "../args";
import type { Command, Ctx } from "../context";
import { failure, type Outcome, success, usage } from "../output";

/**
 * Deriving the provider from the URL means the common call is two arguments.
 * A `--provider` flag overrides it for anything self-hosted, where the host
 * name says nothing useful about which tracker is answering.
 */
export const providerOf = (url: string): string | null => {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
	if (host === "linear.app" || host.endsWith(".linear.app")) return "linear";
	if (host === "github.com" || host.endsWith(".github.com")) return "github";
	return null;
};

/**
 * The provider's own key for the issue, read off the URL: `ENG-123` from a
 * Linear path, `owner/repo#42` from a GitHub one. Null when the shape is
 * unfamiliar, which is what `--id` is for.
 */
export const identifierOf = (provider: string, url: string): string | null => {
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		return null;
	}
	if (provider === "linear") {
		return /\/issue\/([^/]+)/.exec(path)?.[1] ?? null;
	}
	if (provider === "github") {
		const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(path);
		return match ? `${match[1]}/${match[2]}#${match[3]}` : null;
	}
	return null;
};

const describe = (link: UpstreamLink): string =>
	`${link.provider} · ${link.identifier ?? link.externalId} — ${link.title}`;

const runLink = async (
	ctx: Ctx,
	positionals: string[],
	args: Parameters<Command["run"]>[0],
): Promise<Outcome> => {
	const [input, url] = positionals;
	if (!input || !url)
		return usage("Task ID and issue URL required", upstream.usage);

	const provider = flagString(args, "provider") ?? providerOf(url);
	if (!provider)
		return usage(
			`Could not tell which tracker ${url} belongs to; pass --provider`,
			upstream.usage,
		);

	const identifier =
		flagString(args, "id") ?? identifierOf(provider, url) ?? undefined;
	// The external id is the provider's stable handle. Without one from the caller the identifier
	// serves: it is what the URL actually carries, and the pair is unique per task either way.
	const externalId = flagString(args, "external-id") ?? identifier;
	if (!externalId)
		return usage(
			`Could not read an issue id out of ${url}; pass --id`,
			upstream.usage,
		);

	const taskId = await Planner.resolveTaskId(ctx.store, input);
	if (!taskId.ok) return failure(taskId.error);

	const title = flagString(args, "title") ?? identifier ?? url;
	const linked = await Planner.upsertUpstreamLink(ctx.store, {
		taskId: taskId.value,
		provider,
		externalId,
		identifier,
		url,
		title,
	});
	if (!linked.ok) return failure(linked.error);

	return success(linked.value, `✓ ${input} → ${describe(linked.value)}`);
};

const runUnlink = async (ctx: Ctx, positionals: string[]): Promise<Outcome> => {
	const [input, which] = positionals;
	if (!input) return usage("Task ID required", upstream.usage);

	const taskId = await Planner.resolveTaskId(ctx.store, input);
	if (!taskId.ok) return failure(taskId.error);

	const links = await Planner.getUpstreamLinksForTask(ctx.store, taskId.value);
	if (!links.ok) return failure(links.error);
	if (links.value.length === 0) return failure(`${input} has no linked issue`);

	// One link needs no naming. Several must be named, rather than have one picked for them.
	const matches = which
		? links.value.filter(
				(link) => link.identifier === which || link.externalId === which,
			)
		: links.value;
	if (matches.length === 0)
		return failure(`${input} has no linked issue ${which}`);
	if (matches.length > 1)
		return usage(
			`${input} has ${matches.length} linked issues; name one: ${matches
				.map((link) => link.identifier ?? link.externalId)
				.join(", ")}`,
			upstream.usage,
		);

	const target = matches[0];
	if (!target) return failure(`${input} has no linked issue`);
	const removed = await Planner.deleteUpstreamLink(ctx.store, target.id);
	if (!removed.ok) return failure(removed.error);

	return success({ unlinked: target }, `✓ ${input} ✕ ${describe(target)}`);
};

/**
 * Named for the storage and the MCP tools it fronts (`cabane_upstream_link`),
 * not for the prose: one vocabulary means a human and an agent reach for the
 * same word. `cabane link` is the task-to-task DAG edge and stays that;
 * discriminating it by a `--url` flag would make one command two.
 */
export const upstream: Command = {
	name: "upstream",
	summary: "Link a task to an external issue, or drop the link",
	usage:
		"cabane upstream <link <task-id> <url> [--title <t>] [--provider <p>] [--id <key>] | unlink <task-id> [issue-key]>",
	run: async (args, ctx) => {
		const [sub, ...rest] = args.positionals;
		if (sub === "link") return runLink(ctx, rest, args);
		if (sub === "unlink") return runUnlink(ctx, rest);
		return usage(
			`Unknown upstream subcommand: ${sub ?? "(none)"}`,
			upstream.usage,
		);
	},
};
