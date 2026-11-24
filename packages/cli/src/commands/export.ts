import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Planner, Portable, toError, withDb } from "@kabane/core";
import { failure, flagBool, success, usage } from "@kabane/extension";
import { DB_NAME } from "../config";
import type { Command } from "../context";
import { portableRuntime, rebuild } from "./import";

const writeBackup = (
	dir: string,
	jsonl: string,
	manifest: Portable.Manifest,
) => {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stage = mkdtempSync(join(dir, ".export-"));
	const record = join(dir, "record.jsonl");
	try {
		writeFileSync(join(stage, "record.jsonl"), jsonl, { mode: 0o600 });
		writeFileSync(
			join(stage, "manifest.json"),
			JSON.stringify(manifest, null, 2) + "\n",
			{ mode: 0o600 },
		);
		linkSync(join(stage, "record.jsonl"), record);
		try {
			linkSync(join(stage, "manifest.json"), join(dir, "manifest.json"));
		} catch (error) {
			rmSync(record);
			throw error;
		}
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
};

export const exportCommand: Command = {
	name: "export",
	standalone: true,
	summary: "Write the portable record and optionally check a rebuild",
	usage: "kabane export <dir> [--check]",
	run: async (args, ctx) => {
		const [directory] = args.positionals;
		if (!directory || args.positionals.length !== 1)
			return usage("Supply an export directory", exportCommand.usage);
		const dir = resolve(ctx.cwd, directory);
		if (!existsSync(join(ctx.store, DB_NAME)))
			return failure("No source database to export");
		const registered = await portableRuntime(ctx);
		if (!registered.ok) return failure(registered.error);
		const migrated = await Planner.init(ctx.store);
		if (!migrated.ok) return failure(migrated.error);
		const read = await withDb(ctx.store, Portable.snapshot);
		if (!read.ok) return failure(read.error);
		try {
			const source = await Portable.manifest(read.value);
			writeBackup(dir, Portable.encode(read.value), source);
			if (!flagBool(args, "check"))
				return success(source, `Exported to ${dir}`);
			const home = mkdtempSync(join(tmpdir(), "kabane-rebuild-"));
			try {
				const actual = await rebuild(dir, home);
				const rows = Portable.compare(source, actual);
				const match = rows.every((row) => row.match);
				const lines = rows.map(
					({ table, source: a, rebuilt: b, match: equal }) =>
						`${table} ${a?.count} ${a?.digest}${equal ? "" : ` rebuilt ${b?.count} ${b?.digest} differ`}`,
				);
				return {
					exitCode: match ? 0 : 1,
					json: { rows, match },
					text: [...lines, match ? "match" : "differ"].join("\n"),
				};
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		} catch (e) {
			return failure(toError(e));
		}
	},
};
