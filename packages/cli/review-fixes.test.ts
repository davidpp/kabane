import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Runtime } from "@cabane/core";
import { SqliteDb } from "@cabane/sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { Oplog } from "../core/storage/oplog";
import { Apply } from "../core/sync/apply";
import { configureTestRuntime } from "../core/testing";
import { CLI_BIN, createCorpusTracker } from "./issue-corpus-harness";

const toolResult = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
const pageSchema = z.object({
	items: z.array(z.object({ id: z.string(), shortId: z.string().optional() })),
	nextCursor: z.string(),
});

describe("Astra review regressions", () => {
	for (const scope of ["new", "corpus"])
		for (const transport of ["cli", "stdio"] as const)
			it(`scope receipt rejection has no task/oplog/sequence writes (${scope}/${transport})`, async () => {
				const seeded = await createCorpusTracker();
				expect(seeded.ok).toBe(true);
				if (!seeded.ok) return;
				const tracker = seeded.value;
				const client = new Client({ name: "receipt-boundary", version: "1" });
				const db = new Database(join(tracker.home, "kabane.db"));
				try {
					const original = tracker.ids[0];
					if (!original) return;
					const id = "X".repeat(1904);
					db.run(
						"UPDATE tasks SET id = ?, short_id = NULL, title = 'Receipt boundary', version = 1 WHERE id = ?",
						[id, original],
					);
					const snapshot = () => ({
						task: db.query("SELECT * FROM tasks WHERE id = ?").get(id),
						ops: db.query("SELECT * FROM sync_oplog ORDER BY rowid").all(),
						sequences: db
							.query("SELECT * FROM sequences ORDER BY prefix")
							.all(),
					});
					const armed = await SqliteDb.provider().withDb(tracker.home, (db) =>
						Oplog.initDevice(db, "fixture"),
					);
					expect(armed.ok).toBe(true);
					if (armed.ok) expect(armed.value.ok).toBe(true);
					const before = snapshot();
					if (transport === "cli") {
						const result = await tracker.run(
							"edit",
							id,
							"--scope",
							scope,
							"--format",
							"concise",
						);
						expect(result.code).toBe(1);
						expect(result.stderr).toContain("no mutation occurred");
					} else {
						await client.connect(
							new StdioClientTransport({
								command: process.execPath,
								args: [CLI_BIN, "mcp"],
								cwd: tracker.cwd,
								env: tracker.env,
								stderr: "pipe",
							}),
						);
						const result = toolResult.safeParse(
							await client.callTool({
								name: "kabane_edit",
								arguments: { id, scopeUri: scope, responseFormat: "concise" },
							}),
						);
						expect(result.success).toBe(true);
						if (result.success) {
							expect(result.data.isError).toBe(true);
							expect(result.data.content[0]?.text).toContain(
								"no mutation occurred",
							);
						}
					}
					expect(snapshot()).toEqual(before);
					const full = await tracker.run(
						"edit",
						id,
						"--scope",
						scope,
						"--format",
						"full",
						"--json",
					);
					expect(full.code).toBe(0);
					const updated = z
						.object({
							id: z.string(),
							shortId: z.string(),
							scopeUri: z.string(),
							version: z.number(),
						})
						.safeParse(JSON.parse(full.out));
					expect(updated.success).toBe(true);
					if (updated.success)
						expect(updated.data).toMatchObject({
							id,
							shortId: scope === "new" ? "JNEW-1" : "JCOR-25",
							scopeUri: `jake://scope/${scope}`,
							version: 2,
						});
				} finally {
					await client.close();
					db.close();
					tracker.close();
				}
			}, 30000);
	it("actual Apply collision outside query scope stales CLI cursor without changing selected version/clocks", async () => {
		const seeded = await createCorpusTracker();
		expect(seeded.ok).toBe(true);
		if (!seeded.ok) return;
		const tracker = seeded.value;
		const db = new Database(join(tracker.home, "kabane.db"));
		try {
			const first = await tracker.run(
				"list",
				"--all",
				"--format",
				"concise",
				"--limit",
				"1",
			);
			const page = pageSchema.safeParse(JSON.parse(first.out));
			expect(page.success).toBe(true);
			if (!page.success || !page.data.items[0]) return;
			const local = page.data.items[0];
			const row = z
				.record(z.unknown())
				.safeParse(db.query("SELECT * FROM tasks WHERE id = ?").get(local.id));
			if (!row.success) return;
			const remoteId = "00000000000000000000000000";
			Runtime.configure({
				provider: SqliteDb.provider(),
				actor: () => "cabane://actor/human/fixture",
				timezone: () => "UTC",
			});
			const armed = await SqliteDb.provider().withDb(tracker.home, (db) =>
				Oplog.initDevice(db, "fixture"),
			);
			expect(armed.ok).toBe(true);
			if (armed.ok) expect(armed.value.ok).toBe(true);
			const applied = await Apply.applyBatch(tracker.home, {
				ops: [
					{
						opId: "collision-review",
						deviceId: "remote",
						tbl: "tasks",
						rowId: remoteId,
						op: "insert",
						rowUpdatedAt: "2025-01-01T00:00:00.000Z",
						capturedAt: "2025-01-01T00:00:00.000Z",
						serverSeq: 1,
						payload: {
							...row.data,
							id: remoteId,
							scope_uri: "jake://scope/other",
							title: "Remote label winner",
						},
					},
				],
				throughSeq: 1,
				hasMore: false,
			});
			expect(applied).toMatchObject({ ok: true });
			if (applied.ok) expect(applied.value.renamed).toBe(1);
			const after = z
				.record(z.unknown())
				.safeParse(db.query("SELECT * FROM tasks WHERE id = ?").get(local.id));
			if (!after.success) return;
			expect(after.data.short_id).not.toBe(local.shortId);
			expect(after.data.short_id).toBe("JCOR-25");
			for (const key of ["version", "updated_at", "updated_by"])
				expect(after.data[key]).toBe(row.data[key]);
			const continued = await tracker.run(
				"list",
				"--all",
				"--format",
				"concise",
				"--limit",
				"1",
				"--cursor",
				page.data.nextCursor,
			);
			expect(continued.code).toBe(1);
			expect(continued.stderr).toContain("Stale cursor");
		} finally {
			configureTestRuntime();
			db.close();
			tracker.close();
		}
	}, 30000);
});
