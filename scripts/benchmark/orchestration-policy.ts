import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { err, ok, trySync, type Result } from "../../packages/core/result";
import { copyTree, tree, writeJson } from "./files";

export const roles = ["plan", "domain", "ui", "integrate"] as const;
export type Role = (typeof roles)[number];
export const orchestrationSchema = z
	.object({
		turnCaps: z.tuple([
			z.number().int().min(1),
			z.number().int().min(1),
			z.number().int().min(1),
			z.number().int().min(1),
		]),
	})
	.strict();

// Runtime state never participates in code integration, even if both workers changed it.
const transportable = (name: string): boolean =>
	![
		"data",
		"dist",
		"evidence",
		".runtime",
		".benchmark",
		".agent-browser",
	].includes(name.split("/")[0] ?? "") &&
	!["AGENTS.md", "CLAUDE.md", "public/client.js"].includes(name) &&
	!/\.(?:sqlite|db)(?:-wal|-shm)?$/.test(name);

export const mergeWorkers = (
	base: string,
	workers: string[],
	target: string,
): Result<void> => {
	if (existsSync(target))
		return err(new Error(`Integration target already exists: ${target}`));
	const original = tree(base);
	if (!original.ok) return original;
	const copied = copyTree(base, target);
	if (!copied.ok) return copied;
	const changes = new Map<
		string,
		{ worker: string; digest: string | null }[]
	>();
	for (const worker of workers) {
		const current = tree(worker);
		if (!current.ok) return current;
		for (const name of new Set([
			...Object.keys(original.value),
			...Object.keys(current.value),
		])) {
			if (!transportable(name) || current.value[name] === original.value[name])
				continue;
			if (current.value[name] === "unsupported-non-file")
				return err(new Error(`Unsupported delivery: ${name}`));
			const entries = changes.get(name) ?? [];
			entries.push({ worker, digest: current.value[name] ?? null });
			changes.set(name, entries);
		}
	}
	const conflicts: {
		path: string;
		sources: { worker: string; digest: string | null }[];
	}[] = [];
	const applied = trySync(() => {
		for (const [name, entries] of changes) {
			const first = entries[0];
			if (!first) continue;
			if (entries.some((entry) => entry.digest !== first.digest)) {
				conflicts.push({ path: name, sources: entries });
				continue; // Keep base, and explicitly require the integrator to resolve the conflict.
			}
			const destination = join(target, name);
			if (first.digest === null) rmSync(destination, { force: true });
			else {
				mkdirSync(dirname(destination), { recursive: true });
				writeFileSync(destination, readFileSync(join(first.worker, name)), {
					mode:
						lstatSync(join(first.worker, name)).mode & 0o100 ? 0o700 : 0o600,
				});
			}
		}
	});
	if (!applied.ok) return applied;
	const saved = writeJson(join(target, ".benchmark/transport.json"), {
		changes: Object.fromEntries(changes),
		conflicts,
	});
	return saved.ok ? ok(undefined) : saved;
};
