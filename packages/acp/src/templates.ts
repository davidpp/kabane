// What a project's copy of a shipped template records about where it came from. A filled dispatch
// skill carries `dispatch@<hash12>` in its frontmatter, so a later kabane can tell that the template
// it was filled from has changed since. Free of the ACP SDK, so the CLI imports it through the
// `./templates` subpath without loading a harness client.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Self } from "@cabane/core/self";

export namespace Templates {
	// The guide the copilot reads while filling the template; it is never copied into a project, so
	// a change to it leaves every filled skill current.
	const EXCLUDED = new Set(["PLACEHOLDERS.md"]);

	/** The directory of the shipped template `name`, beside this package or a compiled binary. */
	export const dir = (name: string): string =>
		Self.templates(name, import.meta.url);

	/**
	 * sha256 over a template directory: its files sorted by relative path, each contributing that
	 * path and its bytes, `PLACEHOLDERS.md` excluded. The first 12 hex characters.
	 */
	export const hashDir = (root: string): string => {
		const files = readdirSync(root, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) =>
				relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"),
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
	};

	/** The content hash of the shipped template `name`. */
	export const hash = (name: string): string => hashDir(dir(name));

	// A process's templates never change under it, so each is hashed at most once.
	const stamps = new Map<string, string>();

	/** `<name>@<hash12>`: what a project's copy of the template records as its origin. */
	export const stamp = (name: string): string => {
		const known = stamps.get(name);
		if (known) return known;
		const computed = `${name}@${hash(name)}`;
		stamps.set(name, computed);
		return computed;
	};
}
