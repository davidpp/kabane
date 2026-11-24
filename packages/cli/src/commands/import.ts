import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ok, Planner, Portable, toError, withDb } from "@kabane/core";
import { failure, flagString, success, usage } from "@kabane/extension";
import { configPath, loadConfig, DB_NAME } from "../config";
import { registerModules, type Ctx, type Command } from "../context";

// A database copy may travel without a device config. A configured home also
// contributes its enabled extensions, without opening its database for import.
export const portableRuntime = async (ctx: Ctx) => {
	const config = existsSync(configPath(ctx.home))
		? loadConfig(ctx.home)
		: ok(ctx.config);
	if (!config.ok) return config;
	return registerModules(ctx.home, config.value, config.value.actor);
};

export const rebuild = async (dir: string, home: string) => {
	const jsonl = readFileSync(join(dir, "record.jsonl"), "utf8");
	const initialized = await Planner.init(home);
	if (!initialized.ok) throw initialized.error;
	const restored = await withDb(home, (db) => {
		Portable.restore(db, jsonl);
		return Portable.snapshot(db);
	});
	if (!restored.ok) throw restored.error;
	return Portable.manifest(restored.value);
};

export const importCommand: Command = {
	name: "import",
	standalone: true,
	summary: "Rebuild a fresh database from a portable export",
	usage: "kabane import <dir> --into <home>",
	run: async (args, ctx) => {
		const into = flagString(args, "into");
		const [directory] = args.positionals;
		if (!directory || args.positionals.length !== 1 || !into)
			return usage(
				"Supply an export directory and destination home",
				importCommand.usage,
			);
		const dir = resolve(ctx.cwd, directory);
		const home = resolve(ctx.cwd, into);
		try {
			if (existsSync(join(home, DB_NAME)))
				return failure("Destination already contains a database");
			const registered = await portableRuntime(ctx);
			if (!registered.ok) return failure(registered.error);
			const expected = JSON.parse(
				readFileSync(join(dir, "manifest.json"), "utf8"),
			);
			mkdirSync(home, { recursive: true, mode: 0o700 });
			const stage = mkdtempSync(join(home, ".import-"));
			try {
				const actual = await rebuild(dir, stage);
				if (!Portable.compare(expected, actual).every((row) => row.match))
					return failure("Rebuilt database differs from the export manifest");
				// The provider can keep WAL connections open. Publish a complete single-file snapshot.
				const file = join(stage, "complete.db");
				const saved = await withDb(stage, (db) =>
					db.run("VACUUM INTO ?", [file]),
				);
				if (!saved.ok) throw saved.error;
				chmodSync(file, 0o600);
				linkSync(file, join(home, DB_NAME));
				return success(actual, "Imported portable record");
			} finally {
				rmSync(stage, { recursive: true, force: true });
			}
		} catch (e) {
			return failure(toError(e));
		}
	},
};
