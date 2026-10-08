import { err, ok, PageOptionsSchema, ResponseFormatSchema } from "@cabane/core";
import { flagString, type ParsedArgs } from "./args";

export const responseFormat = (args: ParsedArgs) => {
	const raw =
		args.flags.format === undefined
			? undefined
			: (flagString(args, "format") ?? args.flags.format);
	const parsed = ResponseFormatSchema.optional().safeParse(raw);
	if (!parsed.success)
		return err(new Error("--format must be concise or full."));
	if (args.flags.cursor !== undefined && parsed.data !== "concise")
		return err(new Error("--cursor requires --format concise."));
	return ok(parsed.data);
};
export const pageOptions = (args: ParsedArgs) => {
	const limit = flagString(args, "limit");
	const cursor =
		args.flags.cursor === undefined
			? undefined
			: (flagString(args, "cursor") ?? args.flags.cursor);
	const parsed = PageOptionsSchema.safeParse({
		limit:
			args.flags.limit === undefined
				? undefined
				: limit === undefined
					? args.flags.limit
					: Number(limit),
		cursor,
	});
	return parsed.success
		? ok(parsed.data)
		: err(new Error(`Invalid concise pagination: ${parsed.error.message}`));
};
