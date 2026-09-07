/**
 * Argument parsing — pure, no I/O.
 *
 * `--flag value`, `--flag=value`, bare `--flag` (boolean), and a repeated flag
 * collects into an array. Anything else is a positional. `--` ends flag parsing.
 */

export type FlagValue = string | boolean | string[];

export type ParsedArgs = {
	positionals: string[];
	flags: Record<string, FlagValue>;
};

const append = (
	flags: Record<string, FlagValue>,
	key: string,
	value: string | boolean,
): void => {
	const existing = flags[key];
	if (existing === undefined) {
		flags[key] = value;
		return;
	}
	if (typeof value === "boolean") return;
	if (Array.isArray(existing)) {
		existing.push(value);
		return;
	}
	flags[key] = typeof existing === "string" ? [existing, value] : [value];
};

export const parseArgs = (argv: string[]): ParsedArgs => {
	const positionals: string[] = [];
	const flags: Record<string, FlagValue> = {};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const body = arg.slice(2);
		const eq = body.indexOf("=");
		if (eq !== -1) {
			append(flags, body.slice(0, eq), body.slice(eq + 1));
			continue;
		}
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			append(flags, body, next);
			i++;
		} else {
			append(flags, body, true);
		}
	}

	return { positionals, flags };
};

/** A flag as a single string, or undefined. Arrays yield the last value. */
export const flagString = (
	args: ParsedArgs,
	key: string,
): string | undefined => {
	const value = args.flags[key];
	if (value === undefined || typeof value === "boolean") return undefined;
	return Array.isArray(value) ? value.at(-1) : value;
};

/** A flag as every string given for it. */
export const flagList = (args: ParsedArgs, key: string): string[] => {
	const value = args.flags[key];
	if (value === undefined || typeof value === "boolean") return [];
	return Array.isArray(value) ? value : [value];
};

export const flagBool = (args: ParsedArgs, key: string): boolean =>
	args.flags[key] === true;

/** Comma-separated flag into trimmed, non-empty items. */
export const flagCsv = (
	args: ParsedArgs,
	key: string,
): string[] | undefined => {
	const raw = flagString(args, key);
	if (raw === undefined) return undefined;
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
};
