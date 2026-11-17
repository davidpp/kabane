#!/usr/bin/env bun
/**
 * Keeps a second worktree of this clone on origin/main, so the kabane a person runs from a clone
 * never runs the tree agents edit:
 *
 *   bun run live        from any checkout of the repository, by hand or on a schedule
 *
 * The live worktree is `../<clone folder>-live` beside the main checkout, or KABANE_LIVE. It sits
 * detached at origin/main, because the main checkout holds `main`. Each run fetches origin and,
 * when origin/main moved, copies the tracker database to one backup file, checks the new commit
 * out and installs its dependencies. Pointing this machine's kabane at the worktree is left to the
 * person: the first run prints the two commands and runs neither.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DB_NAME, resolveHome } from "../packages/cli/src/config";

const ROOT = resolve(import.meta.dir, "..");
const TARGET = "origin/main";

/** The live worktree's path: KABANE_LIVE, else beside the main checkout `main`. */
export const livePath = (main: string, env: NodeJS.ProcessEnv): string =>
	env.KABANE_LIVE || join(dirname(main), `${basename(main)}-live`);

/** What a run does once it knows where the live worktree is and where origin/main is. */
export const decide = (live: string, target: string): "up-to-date" | "move" =>
	live === target ? "up-to-date" : "move";

export const backupFile = (home: string): string =>
	join(home, "backups", "kabane-before-live-update.db");

/**
 * Copies `home`'s database into its one backup file, overwritten, through SQLite so the copy is
 * consistent while other processes hold the database open in WAL mode. Returns the backup's path,
 * or null when `home` has no database.
 */
export const backupDatabase = (home: string): string | null => {
	const source = join(home, DB_NAME);
	if (!existsSync(source)) return null;
	const target = backupFile(home);
	mkdirSync(dirname(target), { recursive: true });
	// VACUUM INTO refuses a file that exists.
	rmSync(target, { force: true });
	const db = new Database(source, { readonly: true });
	try {
		db.run("VACUUM INTO ?", [target]);
	} finally {
		db.close();
	}
	return target;
};

const run = (argv: string[], cwd: string): string => {
	const child = Bun.spawnSync(argv, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.exitCode !== 0)
		throw new Error(
			`live: ${argv.join(" ")} failed in ${cwd}: ${child.stderr.toString().trim().split("\n")[0]}`,
		);
	return child.stdout.toString().trim();
};

const install = (live: string) =>
	run(["bun", "install", "--frozen-lockfile"], live);

const update = (env: NodeJS.ProcessEnv): string[] => {
	const main = dirname(
		run(
			["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
			ROOT,
		),
	);
	const live = livePath(main, env);
	run(["git", "fetch", "origin"], main);
	if (!existsSync(live)) {
		run(["git", "worktree", "add", "--detach", live, TARGET], main);
		install(live);
		return [
			`live: created ${live} at ${run(["git", "rev-parse", "--short", "HEAD"], live)}`,
			"To run this machine's kabane from it:",
			`  cd ${join(live, "packages/cli")} && bun link`,
			`  cd ${live} && bun run link-extensions`,
		];
	}
	const old = run(["git", "rev-parse", "HEAD"], live);
	const target = run(["git", "rev-parse", TARGET], live);
	if (decide(old, target) === "up-to-date") return ["live: up to date"];
	const home = resolveHome(env);
	let backup: string | null;
	try {
		backup = backupDatabase(home);
	} catch (error) {
		throw new Error(
			`live: copying ${join(home, DB_NAME)} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	run(["git", "checkout", "--detach", TARGET], live);
	try {
		install(live);
	} catch (error) {
		// Back where it was, so the next run sees origin/main ahead and tries again.
		run(["git", "checkout", "--detach", old], live);
		throw error;
	}
	const moved = run(["git", "rev-list", "--count", `${old}..${target}`], live);
	return [
		`live: ${old.slice(0, 9)} -> ${target.slice(0, 9)}, ${moved} commits${backup ? `, database copied to ${backup}` : ""}`,
	];
};

if (import.meta.main) {
	try {
		for (const line of update(process.env)) console.log(line);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
