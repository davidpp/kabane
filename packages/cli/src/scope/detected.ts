/**
 * The scope ids detection resolved, kept in the user's own KABANE_HOME so that
 * nothing lands in a checkout the user may not own. Remembering the id is what
 * lets a checkout keep its scope after its remote is renamed.
 *
 * One small file per checkout, keyed by its root path, so concurrent kabane
 * processes (MCP, the board, the CLI) never read-modify-write a shared
 * document: each write lands whole through a rename. Two clones never share an
 * entry, even with the same history, so each resolves by its own remote.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export namespace DetectedScopes {
	/** The directory under KABANE_HOME. */
	export const DIR = "detected-scopes";

	/**
	 * `firstCommit` tells the repo that resolved `scopeId` apart from another
	 * one cloned at the same path later. Absent while the repo had no commit.
	 */
	const EntrySchema = z.object({
		scopeId: z.string().min(1),
		firstCommit: z.string().min(1).optional(),
	});
	type Entry = z.infer<typeof EntrySchema>;

	const file = (home: string, root: string): string =>
		join(home, DIR, createHash("sha256").update(root).digest("hex"));

	export const read = async (
		home: string,
		root: string,
	): Promise<Entry | null> => {
		try {
			const raw: unknown = JSON.parse(await readFile(file(home, root), "utf8"));
			const parsed = EntrySchema.safeParse(raw);
			return parsed.success ? parsed.data : null;
		} catch {
			return null;
		}
	};

	/** Best-effort: a home that cannot be written still resolves, it just re-probes git. */
	export const write = async (
		home: string,
		root: string,
		entry: Entry,
	): Promise<void> => {
		const target = file(home, root);
		const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await mkdir(join(home, DIR), { recursive: true });
			await writeFile(temp, `${JSON.stringify(entry)}\n`);
			await rename(temp, target);
		} catch {
			await rm(temp, { force: true }).catch(() => undefined);
		}
	};
}
