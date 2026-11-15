/**
 * The first capture group of every match of `pattern` in `text`.
 * A match whose group took no part is skipped.
 *
 * Matches on a global copy: `matchAll` throws on a non-global pattern, and a
 * `lastIndex` left behind by the caller's own `exec` or `test` on a shared
 * pattern would skip the start of `text`.
 */
export const firstGroups = (text: string, pattern: RegExp): string[] =>
	[
		...text.matchAll(
			new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`),
		),
	].flatMap(([, group]) => (group === undefined ? [] : [group]));
