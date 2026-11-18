/** Where a path stands relative to a root, by its parts rather than by string prefix. */

import { isAbsolute, relative, sep } from "node:path";

export namespace Paths {
	/**
	 * `path` spelled from `root` when it is `root` (`""`) or below it; undefined otherwise. A child
	 * whose name starts with two dots, such as `..nested`, is below the root: only `..` as a whole
	 * part leaves it.
	 */
	export const inside = (root: string, path: string): string | undefined => {
		const from = relative(root, path);
		const leaves =
			from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from);
		return leaves ? undefined : from;
	};
}
