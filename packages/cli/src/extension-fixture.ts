/**
 * A real extension with a data module, written into `$KABANE_HOME/extensions/notes/` for tests
 * and for a sandbox check: its modules entry declares one replicated `childOfTasks` table, and
 * its `notes` command writes and reads that table through `host.store`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The shape every entry shares: the table's name, and the host the modules entry received. */
const TABLE = `export const NOTES = "extension_notes";
export const seen: { host?: unknown } = {};
`;

const MODULES = `import type { Host, KabaneModule } from "kabane/extension";
import { NOTES, seen } from "./table.ts";

export default (host: Host): KabaneModule[] => {
	seen.host = host;
	return [
		{
			name: "notes",
			migrations: [
				{
					name: "create-extension-notes",
					up: (db) =>
						db.run(
							\`CREATE TABLE IF NOT EXISTS \${NOTES} (
							   id TEXT PRIMARY KEY,
							   task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
							   body TEXT NOT NULL,
							   updated_at TEXT NOT NULL,
							   updated_by TEXT,
							   version INTEGER NOT NULL DEFAULT 1,
							   visibility TEXT NOT NULL DEFAULT 'shared'
							 )\`,
						),
				},
			],
			syncTables: [
				{ table: NOTES, family: "row-lww", clock: "updated_at", childOfTasks: true },
			],
		},
	];
};
`;

const INDEX = `import type { Extension, Host } from "kabane/extension";
import { NOTES, seen } from "./table.ts";

export default (host: Host): Extension => ({
	name: "notes",
	commands: [
		{
			name: "notes",
			usage: "kabane notes add <task> <text> | kabane notes list <task> | kabane notes nest <task> | kabane notes defer <task>",
			summary: "Notes on a task, kept by the notes extension's data module",
			run: async (args, ctx) => {
				const [verb, id, ...words] = args.positionals;
				if (!id) return host.outcome.usage("a task id is required", "kabane notes add <task> <text>");
				const task = await host.record.get({ id });
				if (!task.ok) return host.outcome.failure(task.error);
				if (!task.value) return host.outcome.failure(new Error("No task found: " + id));
				if (verb === "add") {
					const noteId = \`\${Date.now().toString(36)}-\${crypto.randomUUID()}\`;
					const written = await host.store.write((tx) => {
						tx.db.run(
							\`INSERT INTO \${NOTES} (id, task_id, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)\`,
							[noteId, task.value.id, words.join(" "), new Date().toISOString(), ctx.actor],
						);
						const captured = tx.afterWrite(NOTES, "insert", noteId);
						return captured.ok ? host.result.ok(noteId) : captured;
					});
					return written.ok
						? host.outcome.success({ id: written.value, sameHost: seen.host === host }, \`noted \${written.value}\`)
						: host.outcome.failure(written.error);
				}
				if (verb === "defer") {
					// A write scheduled inside a write, as a debounce would: it runs once the outer one ends.
					let fire: (write: Promise<{ ok: boolean; error?: Error }>) => void = () => {};
					const fired = new Promise<Promise<{ ok: boolean; error?: Error }>>((resolve) => {
						fire = resolve;
					});
					const started = performance.now();
					const outer = await host.store.write(() => {
						setTimeout(() => {
							fire(
								host.store.write((tx) => {
									const noteId = \`\${Date.now().toString(36)}-\${crypto.randomUUID()}\`;
									tx.db.run(
										\`INSERT INTO \${NOTES} (id, task_id, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)\`,
										[noteId, task.value.id, "deferred", new Date().toISOString(), ctx.actor],
									);
									return tx.afterWrite(NOTES, "insert", noteId);
								}),
							);
						}, 50);
						return host.result.ok(undefined);
					});
					const result = await (await fired);
					const ms = Math.round(performance.now() - started);
					return host.outcome.success(
						{ outer: outer.ok, deferred: result.ok ? "ok" : result.error?.message, ms },
						\`outer: \${outer.ok ? "ok" : "err"}; deferred write: \${result.ok ? "ok" : result.error?.message} (\${ms} ms)\`,
					);
				}
				if (verb === "nest") {
					// What an extension must not do: write again inside its own write.
					const inside: Record<string, { ms: number; error?: string }> = {};
					const timed = async (label: string, call: () => Promise<{ ok: boolean; error?: Error }>) => {
						const start = performance.now();
						const result = await call();
						inside[label] = { ms: Math.round(performance.now() - start), ...(result.ok ? {} : { error: result.error?.message }) };
					};
					const outer = await host.store.write(async () => {
						await timed("store.write", () => host.store.write(() => host.result.ok(1)));
						await timed("record.comment", () => host.record.comment({ id: task.value.id, body: "from inside a write" }));
						return host.result.ok(undefined);
					});
					return host.outcome.success(
						{ outer: outer.ok, inside },
						Object.entries(inside).map(([label, { ms, error }]) => \`\${label}: \${ms} ms, \${error ?? "ok"}\`).join("\\n"),
					);
				}
				const read = await host.store.read((db) =>
					host.result.ok(
						db
							.query(\`SELECT body FROM \${NOTES} WHERE task_id = ? ORDER BY updated_at, id\`)
							.all(task.value.id)
							.map((row) => String((row as { body: unknown }).body)),
					),
				);
				return read.ok
					? host.outcome.success({ notes: read.value }, read.value.join("\\n"))
					: host.outcome.failure(read.error);
			},
		},
	],
});
`;

export namespace NotesExtension {
	export const NAME = "notes";
	export const TABLE_NAME = "extension_notes";

	/**
	 * Write the extension into `home`. `modules` replaces the modules entry's source, so a test
	 * can break it; `api` replaces the manifest's.
	 */
	export const install = (
		home: string,
		options: { modules?: string; api?: number } = {},
	): string => {
		const dir = join(home, "extensions", NAME);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				name: NAME,
				kabane: {
					extension: "./index.ts",
					api: options.api ?? 1,
					modules: "./modules.ts",
				},
			}),
		);
		writeFileSync(join(dir, "table.ts"), TABLE);
		writeFileSync(join(dir, "modules.ts"), options.modules ?? MODULES);
		writeFileSync(join(dir, "index.ts"), INDEX);
		return dir;
	};
}
