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
import {
	err,
	ok,
	Planner,
	Portable,
	type Result,
	toError,
	trySync,
	withDb,
} from "@kabane/core";
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

export const rebuild = async (
	dir: string,
	home: string,
): Promise<Result<Portable.Manifest>> => {
	const jsonl = trySync(() => readFileSync(join(dir, "record.jsonl"), "utf8"));
	if (!jsonl.ok) return jsonl;
	const initialized = await Planner.init(home);
	if (!initialized.ok) return initialized;
	const restored = await withDb(home, (db) => {
		const inserted = Portable.restore(db, jsonl.value);
		return inserted.ok ? Portable.snapshot(db) : inserted;
	});
	if (!restored.ok) return restored;
	if (!restored.value.ok) return restored.value;
	const snapshot = restored.value.value;
	if ("omitted" in snapshot)
		return err(new Error(omissionReport(snapshot.omitted)));
	return Portable.manifest(snapshot);
};

export const omissionReport = (
	omitted: { module: string; table: string; count: number }[],
) =>
	[
		...Array.from(
			new Set(omitted.map((item) => item.module)),
			(name) =>
				`Enable the extension providing module ${name} in the home's extensions config and retry.`,
		),
		...omitted.map(({ table, count }) => `${table} ${count} not exported`),
		"differ",
	].join("\n");

export const compareManifests = (
	source: Portable.Manifest,
	rebuilt: Portable.Manifest,
) => {
	const rows = Portable.compare(source, rebuilt);
	const match = rows.every((row) => row.match);
	const lines = rows.map(({ table, source: a, rebuilt: b, match: equal }) => {
		const expected = a ? `${a.count} ${a.digest}` : "missing";
		if (equal) return `${table} ${expected}`;
		const actual = b ? `${b.count} ${b.digest}` : "missing";
		return `${table} ${expected} rebuilt ${actual} differ`;
	});
	return {
		exitCode: match ? (0 as const) : (1 as const),
		json: { rows, match },
		text: [...lines, match ? "match" : "differ"].join("\n"),
	};
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
			const raw: unknown = JSON.parse(
				readFileSync(join(dir, "manifest.json"), "utf8"),
			);
			const expected = Portable.ManifestSchema.safeParse(raw);
			if (!expected.success) return failure("Invalid portable export manifest");
			mkdirSync(home, { recursive: true, mode: 0o700 });
			const stage = mkdtempSync(join(home, ".import-"));
			try {
				const actual = await rebuild(dir, stage);
				if (!actual.ok) return failure(actual.error);
				const comparison = compareManifests(expected.data, actual.value);
				if (!comparison.json.match) return comparison;
				// The provider can keep WAL connections open. Publish a complete single-file snapshot.
				const file = join(stage, "complete.db");
				const saved = await withDb(stage, (db) =>
					db.run("VACUUM INTO ?", [file]),
				);
				if (!saved.ok) return failure(saved.error);
				chmodSync(file, 0o600);
				linkSync(file, join(home, DB_NAME));
				return success(actual.value, "Imported portable record");
			} finally {
				rmSync(stage, { recursive: true, force: true });
			}
		} catch (e) {
			return failure(toError(e));
		}
	},
};
