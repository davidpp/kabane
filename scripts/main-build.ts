#!/usr/bin/env bun
/**
 * Builds kabane from origin/main and installs it the way a release installs, stamped with the
 * commit it was built from (`kabane --version`), so `kabane update` can say when main has moved:
 *
 *   bun run main-build [--replace-links] [--bin <path>]
 *
 * It fetches origin and builds from a temporary worktree of origin/main, never from this
 * checkout's files, so uncommitted work cannot get in: the standalone binary, and each extension
 * of the repository the `extensions` setting enables. Once every build has succeeded it copies the
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

/**
 * `source` copied to `target`, a file or a directory: staged beside it, then renamed into place,
 * with what was there (a directory, a file or a symlink, never followed) removed after.
 */
export const replace = (source: string, target: string): void => {
	const staged = `${target}.main-build-new`;
	const previous = `${target}.main-build-old`;
	rmSync(staged, { recursive: true, force: true });
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, staged, { recursive: true });
	const there = lstatSync(target, { throwIfNoEntry: false });
	if (there) renameSync(target, previous);
	renameSync(staged, target);
	if (there?.isSymbolicLink()) unlinkSync(previous);
	else if (there) rmSync(previous, { recursive: true, force: true });
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
	const ours = new Set(checkoutExtensions(ROOT));
	const names = enabled.filter((name) => ours.has(name));
	const targets = names.map((name) => join(home, "extensions", name));
	const linked = links([bin, ...targets]);
	if (linked.length && !replaceLinks)
		throw new Error(
			[
				"main-build: these are links, a contributor's own setup (bun link, bun run link-extensions); nothing was built:",
				...linked.map((line) => `  ${line}`),
				"Run it again with --replace-links to install the main build in their place.",
			].join("\n"),
		);

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
		for (const name of names)
			run([process.execPath, "run", "build"], join(source, "extensions", name));

		const backup = backupDatabase(home);
		replace(join(unpacked, "kabane/kabane"), bin);
		for (const name of names)
			replace(
				join(source, "extensions", name, "dist"),
				join(home, "extensions", name),
			);
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
