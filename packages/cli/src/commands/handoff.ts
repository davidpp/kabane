import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	ok,
	Planner,
	quoted,
	type Result,
	type TaskEntry,
	toError,
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

/** Why a read failed, on one line: its errno code when it has one. */
const readFailure = (e: unknown): string =>
	e instanceof Error && "code" in e && typeof e.code === "string"
		? e.code
		: quoted(toError(e).message);

/** The markdown body `--from` names, `-` for stdin. */
const readBody = (from: string, cwd: string): Promise<Result<string>> =>
	tryCatch(
		async () =>
			from === "-"
				? await Bun.stdin.text()
				: await readFile(resolve(cwd, from), "utf8"),
		(e) =>
			new Error(
				from === "-"
					? `Cannot read the handoff from stdin (${readFailure(e)}): pipe the markdown in, or name its file with --from <file>.`
					: `Cannot read the handoff file ${quoted(from)} (${readFailure(e)}): give the path of a markdown file, or - to read stdin.`,
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

const show = async (id: string, all: boolean, store: string) => {
	const task = await findIssue(store, id);
	if (!task.ok) return failure(task.error);
	const entries = await Planner.getEntries(store, task.value.id, {
		kind: HANDOFF_KIND,
	});
	if (!entries.ok) return failure(entries.error);
	const latest = entries.value.at(-1);
	if (!latest)
		return success(
			{ handoffs: [] },
			`No handoff on ${task.value.shortId ?? task.value.id}.`,
		);
	if (all)
		return success(
			{ handoffs: entries.value },
			entries.value.map(entryMarkdown).join("\n\n"),
		);
	const section = await latestSection(store, task.value.id);
	return section.ok
		? success({ handoffs: [latest] }, section.value)
		: failure(section.error);
};

/** The documented forms, one per usage line. */
type Form =
	| { mode: "show"; id: string; all: boolean }
	| { mode: "record"; id: string; from: string }
	| { mode: "template" };

/** The one form the arguments make, or the usage error to print before doing anything. */
const formOf = (args: ParsedArgs): Form | Outcome => {
	const bad = valued(args, "all") ?? valued(args, "template");
	if (bad) return bad;
	const given = (flag: string) => args.flags[flag] !== undefined;
	const [id, extra] = args.positionals;
	if (given("template"))
		return id === undefined && !given("from") && !given("all")
			? { mode: "template" }
			: usage("--template takes no issue and no other flag", USAGE);
	if (!id) return usage("Issue id required", USAGE);
	if (extra !== undefined)
		return usage(
			`Unexpected ${quoted(extra)} after the issue: handoff takes one issue`,
			USAGE,
		);
	if (!given("from")) return { mode: "show", id, all: flagBool(args, "all") };
	if (given("all"))
		return usage(
			"--from records a handoff and --all lists them: use one",
			USAGE,
		);
	const from = flagString(args, "from");
	return from && !Array.isArray(args.flags.from)
		? { mode: "record", id, from }
		: usage("--from takes one file, or - for stdin", USAGE);
};

export const handoff: Command = {
	name: "handoff",
	summary:
		"Show an issue's latest handoff, record one from markdown, or print the template",
	usage: USAGE,
	run: async (args, ctx) => {
		const form = formOf(args);
		if ("exitCode" in form) return form;
		switch (form.mode) {
			case "template":
				return success({ template: HANDOFF_TEMPLATE }, HANDOFF_TEMPLATE);
			case "record":
				return record(form.id, form.from, ctx);
			case "show":
				return show(form.id, form.all, ctx.store);
		}
	},
};
