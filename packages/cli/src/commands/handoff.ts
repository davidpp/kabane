import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	ok,
	Planner,
	type Result,
	type TaskEntry,
	tryCatch,
} from "@cabane/core";
import {
	failure,
	flagBool,
	flagString,
	type Outcome,
	type ParsedArgs,
	success,
	usage,
} from "@cabane/extension";
import {
	findIssue,
	HANDOFF_KIND,
	HANDOFF_TEMPLATE,
	handOff,
	handoffReceipt,
} from "@cabane/handoff";
import type { Command, Ctx } from "../context";

const USAGE = [
	"kabane handoff <id> [--all] [--json]",
	"kabane handoff <id> --from <file|->",
	"kabane handoff --template",
].join("\n       ");

/** A boolean flag given a value swallowed the next argument, which was meant as the issue. */
const valued = (args: ParsedArgs, flag: string): Outcome | undefined =>
	args.flags[flag] === undefined || args.flags[flag] === true
		? undefined
		: usage(`--${flag} takes no value; put it after the issue`, USAGE);

/** The markdown body `--from` names, `-` for stdin. */
const readBody = (from: string, cwd: string): Promise<Result<string>> =>
	tryCatch(
		async () =>
			from === "-"
				? await Bun.stdin.text()
				: await readFile(resolve(cwd, from), "utf8"),
		(e) =>
			new Error(
				`Cannot read a handoff from ${from === "-" ? "stdin" : from}: ${e instanceof Error ? e.message : String(e)}`,
			),
	);

const record = async (id: string, from: string, ctx: Ctx) => {
	const body = await readBody(from, ctx.cwd);
	if (!body.ok) return failure(body.error);
	const handed = await handOff(ctx.store, { id, body: body.value }, ctx.actor);
	return handed.ok
		? success(handed.value, handoffReceipt(handed.value))
		: failure(handed.error);
};

/** The latest handoff exactly as the brief prints it: core's `handoff.latest` section, every chunk. */
const latestSection = async (
	store: string,
	taskId: string,
): Promise<Result<string>> => {
	let markdown = "";
	let cursor: string | undefined;
	do {
		const page = await Planner.getContextPage(store, taskId, {
			sections: [`${HANDOFF_KIND}.latest`],
			cursor,
		});
		if (!page.ok) return page;
		markdown += page.value.markdown;
		cursor = page.value.nextCursor;
	} while (cursor !== undefined);
	return ok(markdown);
};

const entryMarkdown = (entry: TaskEntry): string =>
	`## Handoff from ${entry.author} · ${entry.createdAt}\n\n${entry.content}`;

const show = async (id: string, args: ParsedArgs, store: string) => {
	const task = await findIssue(store, id);
	if (!task.ok) return failure(task.error);
	const all = await Planner.getEntries(store, task.value.id, {
		kind: HANDOFF_KIND,
	});
	if (!all.ok) return failure(all.error);
	const latest = all.value.at(-1);
	if (!latest) return success({ handoffs: [] }, `No handoff on ${id}.`);
	if (flagBool(args, "all"))
		return success(
			{ handoffs: all.value },
			all.value.map(entryMarkdown).join("\n\n"),
		);
	const section = await latestSection(store, task.value.id);
	return section.ok
		? success({ handoffs: [latest] }, section.value)
		: failure(section.error);
};

export const handoff: Command = {
	name: "handoff",
	summary:
		"Show an issue's latest handoff, record one from markdown, or print the template",
	usage: USAGE,
	run: async (args, ctx) => {
		const bad = valued(args, "all") ?? valued(args, "template");
		if (bad) return bad;
		if (flagBool(args, "template"))
			return success({ template: HANDOFF_TEMPLATE }, HANDOFF_TEMPLATE);
		const [id] = args.positionals;
		if (!id) return usage("Issue id required", USAGE);
		if (args.flags.from === undefined) return show(id, args, ctx.store);
		const from = flagString(args, "from");
		return from
			? record(id, from, ctx)
			: usage("--from takes a file, or - for stdin", USAGE);
	},
};
