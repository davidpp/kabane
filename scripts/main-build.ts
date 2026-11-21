#!/usr/bin/env bun
/**
 * Builds kabane from origin/main and installs it the way a release installs, stamped with the
 * commit it was built from (`kabane --version`), so `kabane update` can say when main has moved:
 *
 *   bun run main-build [--replace-links] [--bin <path>]
 *
 * It fetches origin and builds from a temporary worktree of origin/main, never from this
 * checkout's files, so uncommitted work cannot get in: the standalone binary, and each extension
 * of the repository the `extensions` setting enables, as the binary's archive ships it. Once every build has succeeded it copies the
 * tracker database to one backup file, then installs the binary at --bin (default
 * `$BUN_INSTALL/bin/kabane`, where Bun puts `kabane` on PATH) and the extensions into
 * `$KABANE_HOME/extensions/`. A symlink at any of those places is a contributor's own setup (`bun
 * link`, `bun run link-extensions`), replaced only with --replace-links. `kabane update` on a main
 * build runs this again from the clone it records, with --bin set to the running binary.
 */

import { Database } from "bun:sqlite";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	renameSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DB_NAME, loadConfig, resolveHome } from "../packages/cli/src/config";
import type { UpdateMain } from "../packages/cli/src/update-main";
import { checkoutExtensions } from "./link-extensions";

const ROOT = resolve(import.meta.dir, "..");

export const backupFile = (home: string): string =>
	join(home, "backups", "kabane-before-main-build.db");

/**
 * Copies `home`'s database into its one backup file through SQLite, so the copy is consistent
 * while other processes hold the database open in WAL mode. The previous backup stays until the
 * new copy is whole. Returns the backup's path, or null when `home` has no database.
 */
export const backupDatabase = (home: string): string | null => {
	const source = join(home, DB_NAME);
	if (!existsSync(source)) return null;
	const target = backupFile(home);
	mkdirSync(dirname(target), { recursive: true });
	// VACUUM INTO refuses a file that exists.
	const partial = `${target}.partial`;
	rmSync(partial, { force: true });
	const db = new Database(source, { readonly: true });
	try {
		db.run("VACUUM INTO ?", [partial]);
	} finally {
		db.close();
	}
	renameSync(partial, target);
	return target;
};

/** Where Bun puts global bins, so `kabane` there is the one on PATH. */
export const defaultBin = (env: NodeJS.ProcessEnv): string =>
	join(
		env.BUN_INSTALL_BIN ||
			join(env.BUN_INSTALL || join(env.HOME || homedir(), ".bun"), "bin"),
		"kabane",
	);

/** Each of `paths` that is a symlink, as `<path> -> <target>`. */
export const links = (paths: readonly string[]): string[] =>
	paths.flatMap((path) =>
		lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()
			? [`${path} -> ${readlinkSync(path)}`]
			: [],
	);

const staging = (target: string): string => `${target}.main-build-new`;

/**
 * What was at `target` (a directory, a file or a symlink, never followed) swapped for its staged
 * copy, and then removed.
 */
const swapIn = (target: string): void => {
	const previous = `${target}.main-build-old`;
	const there = lstatSync(target, { throwIfNoEntry: false });
	if (there) renameSync(target, previous);
	renameSync(staging(target), target);
	if (there?.isSymbolicLink()) unlinkSync(previous);
	else if (there) rmSync(previous, { recursive: true, force: true });
};

/**
 * Each `[source, target]` copied beside its target first, so a copy that fails (an unwritable
 * directory, a full disk) changes nothing and removes what was staged. Then each is renamed into
 * place in order: the binary goes last, so its stamp only moves once the extensions are in, and
 * an install that stops short leaves the old binary for the next update to retry.
 */
export const install = (
	pairs: readonly (readonly [string, string])[],
): void => {
	try {
		for (const [source, target] of pairs) {
			rmSync(staging(target), { recursive: true, force: true });
			mkdirSync(dirname(target), { recursive: true });
			cpSync(source, staging(target), { recursive: true });
		}
	} catch (error) {
		for (const [, target] of pairs)
			rmSync(staging(target), { recursive: true, force: true });
		throw error;
	}
	for (const [, target] of pairs) swapIn(target);
};

const run = (argv: string[], cwd: string, quiet = true): string => {
	const child = Bun.spawnSync(argv, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: quiet ? "pipe" : "inherit",
	});
	if (child.exitCode !== 0)
		throw new Error(
			`main-build: ${argv.join(" ")} failed in ${cwd}${child.stderr ? `: ${child.stderr.toString().trim().split("\n").slice(-3).join(" ")}` : ""}`,
		);
	return child.stdout.toString().trim();
};

type Options = { replaceLinks: boolean; bin: string };

const parse = (argv: string[], env: NodeJS.ProcessEnv): Options => {
	let replaceLinks = false;
	let bin = defaultBin(env);
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const next = argv[index + 1];
		if (arg === "--replace-links") replaceLinks = true;
		else if (arg === "--bin" && next) {
			bin = resolve(next);
			index++;
		} else
			throw new Error(
				"usage: bun run main-build [--replace-links] [--bin <path>]",
			);
	}
	return { replaceLinks, bin };
};

const mainBuild = (argv: string[], env: NodeJS.ProcessEnv): string[] => {
	const { replaceLinks, bin } = parse(argv, env);
	const home = resolveHome(env);
	const config = existsSync(join(home, "config.json"))
		? loadConfig(home)
		: undefined;
	if (config && !config.ok) throw config.error;
	const enabled = config?.value.extensions ?? [];
	run(["git", "fetch", "--quiet", "origin"], ROOT);
	const commit = run(["git", "rev-parse", "origin/main^{commit}"], ROOT);
	const stamp: UpdateMain.Stamp = {
		channel: "main",
		commit,
		date: run(["git", "show", "-s", "--format=%cI", commit], ROOT),
		source: {
			kind: "clone",
			clone: ROOT,
			remote: run(["git", "remote", "get-url", "origin"], ROOT),
		},
	};
	const target = `${process.platform}-${process.arch}`;
	const work = mkdtempSync(join(tmpdir(), "kabane-main-build-"));
	const source = join(work, "source");
	console.error(
		`main-build: building ${commit.slice(0, 9)} (origin/main) for ${target}`,
	);
	run(["git", "worktree", "add", "--quiet", "--detach", source, commit], ROOT);
	try {
		// The extensions origin/main has, not the ones this checkout's working tree has.
		const ours = new Set(checkoutExtensions(source));
		const names = enabled.filter((name) => ours.has(name));
		const linked = links([
			bin,
			...names.map((name) => join(home, "extensions", name)),
		]);
		if (linked.length && !replaceLinks)
			throw new Error(
				[
					"main-build: these are links, a contributor's own setup (bun link, bun run link-extensions); nothing was built:",
					...linked.map((line) => `  ${line}`),
					`To install the main build in their place, run in ${ROOT}: bun run main-build --replace-links`,
				].join("\n"),
			);
		// No lifecycle scripts: the repository's `prepare` would install git hooks into this clone.
		run(
			[process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
			source,
		);
		run(
			[
				process.execPath,
				"scripts/build-binary.ts",
				target,
				join(work, "binary"),
				JSON.stringify(stamp),
			],
			source,
			false,
		);
		const unpacked = join(work, "unpacked");
		mkdirSync(unpacked);
		run(
			["tar", "-xzf", join(work, "binary", `kabane-${target}.tar.gz`)],
			unpacked,
		);

		const backup = backupDatabase(home);
		install([
			...names.map(
				(name) =>
					[
						join(unpacked, "kabane/extensions", name),
						join(home, "extensions", name),
					] as const,
			),
			[join(unpacked, "kabane/kabane"), bin],
		]);
		const printed = run([bin, "--version"], work);
		if (!printed.includes(`main ${commit.slice(0, 7)}`))
			throw new Error(
				`main-build: ${bin} --version printed ${printed}, not commit ${commit}`,
			);
		return [
			`main-build: installed ${bin}: ${printed}`,
			names.length
				? `main-build: extensions ${names.join(", ")} in ${join(home, "extensions")}`
				: "main-build: no enabled extension of this repository to install",
			backup
				? `main-build: database copied to ${backup}`
				: `main-build: no database in ${home} to copy`,
			"Restart running board and MCP sessions.",
		];
	} finally {
		Bun.spawnSync(["git", "worktree", "remove", "--force", source], {
			cwd: ROOT,
		});
		rmSync(work, { recursive: true, force: true });
	}
};

if (import.meta.main) {
	try {
		for (const line of mainBuild(process.argv.slice(2), process.env))
			console.log(line);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
