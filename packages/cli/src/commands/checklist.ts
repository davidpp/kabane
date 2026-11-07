import {
	Checklist,
	changeReceipt,
	checklistMarkdown,
	editReceipt,
} from "@cabane/checklist";
import {
	failure,
	flagBool,
	flagString,
	type Outcome,
	type ParsedArgs,
	success,
	usage,
} from "@cabane/extension";
import type { Command, Ctx } from "../context";

const USAGE = [
	"kabane checklist <id> [--json]",
	"kabane checklist add <id> <text…> [--at <n>]",
	"kabane checklist tick <item…> [--undo]",
	"kabane checklist edit <item> [<text…>] [--at <n>] [--remove]",
].join("\n       ");

/** `--at <n>`: absent, a 1-based position, or the usage error to print. */
const position = (args: ParsedArgs): number | undefined | Outcome => {
	if (args.flags.at === undefined) return undefined;
	const at = flagString(args, "at");
	return at !== undefined && /^[1-9]\d*$/.test(at)
		? Number(at)
		: usage("--at takes a position: 1 for the first item", USAGE);
};

/** A boolean flag given a value swallowed the next argument, which was meant as an item or text. */
const valued = (args: ParsedArgs, flag: string): Outcome | undefined =>
	args.flags[flag] === undefined || args.flags[flag] === true
		? undefined
		: usage(`--${flag} takes no value; put it after the items`, USAGE);

const add = async (rest: string[], args: ParsedArgs, store: string) => {
	const [id, ...words] = rest;
	const text = words.join(" ").trim();
	if (!id || !text)
		return usage("An issue id and the item's text are required", USAGE);
	const at = position(args);
	if (typeof at === "object") return at;
	const change = await Checklist.add(store, {
		id,
		items: [text],
		position: at,
	});
	return change.ok
		? success(change.value, changeReceipt(change.value, "added"))
		: failure(change.error);
};

const tick = async (rest: string[], args: ParsedArgs, ctx: Ctx) => {
	const bad = valued(args, "undo");
	if (bad) return bad;
	if (!rest.length) return usage("Name the items to tick", USAGE);
	const done = !flagBool(args, "undo");
	const change = await Checklist.tick(
		ctx.store,
		{ items: rest, done },
		ctx.actor,
	);
	return change.ok
		? success(
				change.value,
				changeReceipt(change.value, done ? "ticked" : "unticked"),
			)
		: failure(change.error);
};

const edit = async (rest: string[], args: ParsedArgs, store: string) => {
	const bad = valued(args, "remove");
	if (bad) return bad;
	const [item, ...words] = rest;
	if (!item) return usage("Name the item to edit", USAGE);
	const at = position(args);
	if (typeof at === "object") return at;
	const text = words.join(" ").trim();
	const input = {
		item,
		text: text || undefined,
		position: at,
		remove: flagBool(args, "remove"),
	};
	const change = await Checklist.edit(store, input);
	return change.ok
		? success(change.value, editReceipt(change.value, input))
		: failure(change.error);
};

export const checklist: Command = {
	name: "checklist",
	summary: "Show an issue's checklist, or add, tick and edit its items",
	usage: USAGE,
	run: async (args, ctx) => {
		const [first, ...rest] = args.positionals;
		switch (first) {
			case undefined:
				return usage("Issue id required", USAGE);
			case "add":
				return add(rest, args, ctx.store);
			case "tick":
				return tick(rest, args, ctx);
			case "edit":
				return edit(rest, args, ctx.store);
		}
		const items = await Checklist.list(ctx.store, first);
		if (!items.ok) return failure(items.error);
		return success(
			{ items: items.value },
			checklistMarkdown(items.value) ?? `No checklist items on ${first}.`,
		);
	},
};
