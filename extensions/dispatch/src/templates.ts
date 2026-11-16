// What a project's copy of a shipped template records about where it came from. A filled dispatch
// skill carries `dispatch@<hash12>` in its frontmatter, so a later dispatch extension can tell that
// the template it was filled from has changed since.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Result } from "@cabane/core";
import { ok, trySync } from "./result";

export namespace Templates {
	// The guide the copilot reads while filling the template; it is never copied into a project, so
	// a change to it leaves every filled skill current.
	const EXCLUDED = new Set(["PLACEHOLDERS.md"]);

	// The extension's own templates/. The build flattens src/ into index.js beside it and rewrites
	// this URL to match (scripts/build.ts).
	const ROOT = new URL("../templates/", import.meta.url);

	/** The directory of the shipped template `name`, in this extension's directory. */
	export const dir = (name: "dispatch" | "grill"): string =>
		fileURLToPath(new URL(name, ROOT));

	/**
	 * sha256 over a template directory: its files sorted by relative path, each contributing that
	 * path and its bytes, `PLACEHOLDERS.md` excluded. The first 12 hex characters.
	 */
	export const hashDir = (root: string): Result<string> =>
		trySync(() => {
			const files = readdirSync(root, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) =>
					relative(root, join(entry.parentPath, entry.name))
						.split(sep)
						.join("/"),
				)
				.filter((path) => !EXCLUDED.has(path))
				.sort();
			const hash = createHash("sha256");
			// The path and the content are length-prefixed, so moving bytes between a file's name and its
			// content, or between two files, cannot produce the same digest.
			for (const path of files) {
				const bytes = readFileSync(join(root, path));
				hash.update(`${Buffer.byteLength(path)}:${path}\0${bytes.length}:`);
				hash.update(bytes);
			}
			return hash.digest("hex").slice(0, 12);
		});

	// A process's template never changes under it, so it is hashed at most once.
	let stamped: string | undefined;

	/** `dispatch@<hash12>`: what a filled dispatch skill records as its origin. */
	export const stamp = (): Result<string> => {
		if (stamped) return ok(stamped);
		const hashed = hashDir(dir("dispatch"));
		if (!hashed.ok) return hashed;
		stamped = `dispatch@${hashed.value}`;
		return ok(stamped);
	};
}
