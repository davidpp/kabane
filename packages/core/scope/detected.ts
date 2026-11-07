/**
 * The scope ids detection resolved, kept in the user's own KABANE_HOME so that
 * nothing lands in a checkout the user may not own. Remembering the id is what
 * lets a repo keep its scope after its remote is renamed.
 *
 * One small file per repo, so concurrent kabane processes (MCP, the board, the
 * CLI) never read-modify-write a shared document: each write lands whole
 * through a rename, and two writers of the same repo only race to store the
 * same remote id.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export namespace DetectedScopes {
	/** The directory under KABANE_HOME. */
	export const DIR = "detected-scopes";

	/**
	 * What identifies a repo across a remote rename: its first commit, or its
	 * root path while it has no commit yet.
	 */
	export type Key = { firstCommit: string } | { root: string };

	const file = (home: string, key: Key): string =>
		join(
			home,
			DIR,
			"firstCommit" in key
				? `commit-${key.firstCommit}`
				: `path-${createHash("sha256").update(key.root).digest("hex")}`,
		);

	export const read = async (
		home: string,
		key: Key,
	): Promise<string | null> => {
		try {
			const value = (await readFile(file(home, key), "utf8")).trim();
			return value.length > 0 ? value : null;
		} catch {
			return null;
		}
	};

	/** Best-effort: a home that cannot be written still resolves, it just re-probes git. */
	export const write = async (
		home: string,
		key: Key,
		scopeId: string,
	): Promise<void> => {
		const target = file(home, key);
		const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await mkdir(join(home, DIR), { recursive: true });
			await writeFile(temp, `${scopeId}\n`);
			await rename(temp, target);
		} catch {
			await rm(temp, { force: true }).catch(() => undefined);
		}
	};
}
