/**
 * A project's own directory under KABANE_HOME: what this device keeps for one checkout, outside
 * the repo, such as the settings that are yours for that project only.
 *
 * Keyed by the checkout's path, not its scope id: a scope id changes during a project's life (a
 * remote added, `kabane init --scope`), and a path keeps what is stored there through that. The
 * slug stays readable in a listing; the hash tells apart two paths that read the same.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

export namespace ProjectDirs {
	/** The directory under KABANE_HOME. */
	export const DIR = "projects";

	/** `root` with each run outside `[A-Za-z0-9]` as `-`, then `-` and 8 hex of its sha256. */
	export const slug = (root: string): string =>
		`${root.replace(/[^A-Za-z0-9]+/g, "-")}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;

	/** `KABANE_HOME/projects/<slug>/` for the checkout at `root`. */
	export const of = (home: string, root: string): string =>
		join(home, DIR, slug(root));
}
