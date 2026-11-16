#!/usr/bin/env bun
/**
 * Installs the checkout's extensions into a contributor's KABANE_HOME by symlink, because kabane
 * runs from the checkout through Bun there and needs no build or copy:
 *
 *   bun run link-extensions             every extension under extensions/
 *   bun run link-extensions loop        only the named ones
 *
 * It installs and never enables: the `extensions` setting stays the contributor's. It never
 * replaces what is already installed (a directory, or a link that resolves elsewhere); a link
 * that resolves nowhere holds no extension and is replaced. The sandbox links its own home
 * through `linkExtensions` too.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { resolveHome } from "../packages/cli/src/config";

const ROOT = resolve(import.meta.dir, "..");

type Outcome =
	| { name: string; status: "linked" }
	| { name: string; status: "already" }
	| { name: string; status: "skipped"; reason: string };

/** The extension directories in a checkout, by name. */
export const checkoutExtensions = (root: string): string[] =>
	readdirSync(join(root, "extensions"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.toSorted();

const linkOne = (source: string, target: string, name: string): Outcome => {
	const there = lstatSync(target, { throwIfNoEntry: false });
	if (there?.isSymbolicLink() && !existsSync(target)) rmSync(target);
	else if (there?.isSymbolicLink()) {
		if (realpathSync(target) === realpathSync(source))
			return { name, status: "already" };
		return {
			name,
			status: "skipped",
			reason: `${target} is a link to ${readlinkSync(target)}`,
		};
	} else if (there)
		return {
			name,
			status: "skipped",
			reason: `${target} is ${there.isDirectory() ? "an installed directory" : "a file"}`,
		};
	symlinkSync(source, target);
	return { name, status: "linked" };
};

/** Links each named extension of `root` into `home`'s extensions directory, creating it. */
export const linkExtensions = (
	root: string,
	home: string,
	names: string[],
): Outcome[] => {
	const directory = join(home, "extensions");
	mkdirSync(directory, { recursive: true });
	const available = new Set(checkoutExtensions(root));
	return names.map((name) =>
		available.has(name)
			? linkOne(join(root, "extensions", name), join(directory, name), name)
			: {
					name,
					status: "skipped",
					reason: `no extensions/${name} in ${root}`,
				},
	);
};

const describe = (outcome: Outcome): string => {
	switch (outcome.status) {
		case "linked":
			return `${outcome.name}: linked`;
		case "already":
			return `${outcome.name}: already linked here`;
		case "skipped":
			return `${outcome.name}: skipped, ${outcome.reason}`;
	}
};

if (import.meta.main) {
	const home = resolveHome();
	const named = process.argv.slice(2);
	const names = named.length > 0 ? named : checkoutExtensions(ROOT);
	console.log(`Linking into ${join(home, "extensions")}:`);
	for (const outcome of linkExtensions(ROOT, home, names))
		console.log(describe(outcome));
	console.log(
		"Installed, not enabled. `kabane config get extensions` shows what is on; " +
			"`kabane config set extensions <every name you want on> --layer global` replaces that list.",
	);
}
