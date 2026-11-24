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
import { Planner, Portable, toError, trySync, withDb } from "@kabane/core";
import { failure, flagBool, success, usage } from "@kabane/extension";
import { DB_NAME } from "../config";
import type { Command } from "../context";
import {
	compareManifests,
	omissionReport,
	portableRuntime,
	rebuild,
} from "./import";

const writeBackup = (dir: string, jsonl: string, manifest: Portable.Manifest) =>
	trySync(() => {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const stage = mkdtempSync(join(dir, ".export-"));
		const record = join(dir, "record.jsonl");
		let rollbackRecord = false;
		try {
			writeFileSync(join(stage, "record.jsonl"), jsonl, { mode: 0o600 });
			writeFileSync(
				join(stage, "manifest.json"),
				JSON.stringify(manifest, null, 2) + "\n",
				{ mode: 0o600 },
			);
			linkSync(join(stage, "record.jsonl"), record);
			rollbackRecord = true;
			linkSync(join(stage, "manifest.json"), join(dir, "manifest.json"));
			rollbackRecord = false;
		} finally {
			if (rollbackRecord) rmSync(record);
			rmSync(stage, { recursive: true, force: true });
		}
	});

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
		if (
			["record.jsonl", "manifest.json"].some((name) =>
				existsSync(join(dir, name)),
			)
		)
			return failure(`${dir} already holds an export`);
		if (!existsSync(join(ctx.store, DB_NAME)))
			return failure("No source database to export");
		const registered = await portableRuntime(ctx);
		if (!registered.ok) return failure(registered.error);
		const migrated = await Planner.init(ctx.store);
		if (!migrated.ok) return failure(migrated.error);
		const read = await withDb(ctx.store, Portable.snapshot);
		if (!read.ok) return failure(read.error);
		if (!read.value.ok) return failure(read.value.error);
		const snapshot = read.value.value;
		if ("omitted" in snapshot) return failure(omissionReport(snapshot.omitted));
		try {
			const source = await Portable.manifest(snapshot);
			if (!source.ok) return failure(source.error);
			const written = writeBackup(dir, Portable.encode(snapshot), source.value);
			if (!written.ok) {
				const error = written.error;
				return failure(
					"code" in error && error.code === "EEXIST"
						? `${dir} already holds an export`
						: error,
				);
			}
			if (!flagBool(args, "check"))
				return success(source.value, `Exported to ${dir}`);
			const home = mkdtempSync(join(tmpdir(), "kabane-rebuild-"));
			try {
				const actual = await rebuild(dir, home);
				return actual.ok
					? compareManifests(source.value, actual.value)
					: failure(actual.error);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		} catch (e) {
			return failure(toError(e));
		}
	},
};
