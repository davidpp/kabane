import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
	CLI_BIN,
	createCorpusTracker,
	payloadMetrics,
} from "./issue-corpus-harness";

const summarySchema = z
	.object({
		id: z.string(),
		shortId: z.string().optional(),
		title: z.string(),
		state: z.string(),
		kind: z.string(),
		priority: z.string(),
		assignee: z.string().optional(),
		scopeUri: z.string().optional(),
		truncatedFields: z.array(z.string()).optional(),
	})
	.strict();
const pageSchema = z
	.object({
		items: z.array(summarySchema),
		hasMore: z.boolean(),
		nextCursor: z.string().optional(),
		omittedFields: z.array(z.string()),
		fullRead: z.string(),
	})
	.strict();
const receiptSchema = z
	.object({
		id: z.string(),
		shortId: z.string().optional(),
		title: z.string(),
		state: z.string(),
		version: z.number(),
		truncatedFields: z.array(z.string()).optional(),
		fullRead: z.string(),
	})
	.strict();
const toolResultSchema = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

describe("concise actual entry points", () => {
	for (const prefixed of [false, true])
		for (const synthetic of [false, true])
			it(`CLI/stdio parity, lossless pages and legacy compatibility (${prefixed}/${synthetic})`, async () => {
				const seeded = await createCorpusTracker({ prefixed, synthetic });
				expect(seeded.ok).toBe(true);
				if (!seeded.ok) return;
				const tracker = seeded.value;
				const client = new Client({ name: "concise-regression", version: "1" });
				try {
					await client.connect(
						new StdioClientTransport({
							command: process.execPath,
							args: [CLI_BIN, "mcp"],
							cwd: tracker.cwd,
							env: tracker.env,
							stderr: "pipe",
						}),
					);
					const discovery = await client.listTools();
					expect(discovery.tools).toHaveLength(17);
					for (const name of [
						"kabane_list",
						"kabane_search",
						"kabane_today",
						"kabane_add",
						"kabane_edit",
						"kabane_done",
					])
						expect(
							discovery.tools.find((tool) => tool.name === name)?.inputSchema
								.properties,
						).toHaveProperty("responseFormat");
					const call = async (
						name: string,
						args: Record<string, unknown>,
						error = false,
					) => {
						const parsed = toolResultSchema.safeParse(
							await client.callTool({ name, arguments: args }),
						);
						expect(parsed.success).toBe(true);
						if (!parsed.success) return "";
						expect(Boolean(parsed.data.isError)).toBe(error);
						return parsed.data.content.map((block) => block.text).join("");
					};
					const fullArgs = {
						scopeUri: "jake://scope/corpus",
						includeClosed: true,
						limit: 200,
					};
					const raw = await call("kabane_list", fullArgs);
					expect(
						await call("kabane_list", { ...fullArgs, responseFormat: "full" }),
					).toBe(raw);
					const fullIds = z
						.array(
							z.object({ id: z.string(), description: z.string().optional() }),
						)
						.safeParse(JSON.parse(raw));
					expect(fullIds.success).toBe(true);
					if (!fullIds.success) return;
					const cliRaw = await tracker.run(
						"list",
						"--all",
						"--limit",
						"200",
						"--json",
					);
					const cliFull = await tracker.run(
						"list",
						"--all",
						"--limit",
						"200",
						"--format",
						"full",
						"--json",
					);
					expect(cliFull).toEqual(cliRaw);
					const seen: string[] = [];
					let cursor: string | undefined;
					let aggregateBytes = 0;
					let aggregateChars = 0;
					let calls = 0;
					do {
						const text = await call("kabane_list", {
							...fullArgs,
							limit: 20,
							responseFormat: "concise",
							cursor,
						});
						expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
						expect(text).not.toContain("Synthetic body");
						expect(text).not.toContain("discoveredAt");
						const page = pageSchema.safeParse(JSON.parse(text));
						expect(page.success).toBe(true);
						if (!page.success) return;
						const cli = await tracker.run(
							"list",
							"--all",
							"--format",
							"concise",
							...(cursor ? ["--cursor", cursor] : []),
						);
						const cliJson = await tracker.run(
							"list",
							"--all",
							"--format",
							"concise",
							"--json",
							...(cursor ? ["--cursor", cursor] : []),
						);
						expect(cli.code).toBe(0);
						expect(cliJson.code).toBe(0);
						expect(Buffer.byteLength(cliJson.out.trim())).toBeLessThanOrEqual(
							16384,
						);
						if (cursor)
							expect(JSON.parse(cli.out)).toEqual(JSON.parse(cliJson.out));
						const cliJsonPage = pageSchema.safeParse(JSON.parse(cliJson.out));
						expect(cliJsonPage.success).toBe(true);
						if (cliJsonPage.success)
							expect(cliJsonPage.data.items).toEqual(page.data.items);
						// First calls have independent asOf timestamps. Items/completeness are equal;
						// thereafter send the MCP cursor to both transports and compare the full page.
						const cliPage = pageSchema.safeParse(JSON.parse(cli.out));
						expect(cliPage.success).toBe(true);
						if (!cliPage.success) return;
						expect(cliPage.data.items).toEqual(page.data.items);
						expect(cliPage.data.hasMore).toBe(page.data.hasMore);
						if (cursor) expect(JSON.parse(cli.out)).toEqual(JSON.parse(text));
						const metrics = payloadMetrics(text);
						aggregateBytes += metrics.bytes;
						aggregateChars += metrics.characters;
						calls++;
						seen.push(...page.data.items.map((item) => item.id));
						cursor = page.data.nextCursor;
					} while (cursor && calls < 50);
					expect(new Set(seen).size).toBe(fullIds.data.length);
					expect(seen.sort()).toEqual(
						fullIds.data.map((task) => task.id).sort(),
					);
					expect(aggregateBytes).toBeLessThan(Buffer.byteLength(raw));
					console.info(
						JSON.stringify({
							prefixed,
							synthetic,
							full: payloadMetrics(raw),
							concise: {
								bytes: aggregateBytes,
								characters: aggregateChars,
								calls,
							},
						}),
					);
					const first = pageSchema.safeParse(
						JSON.parse(
							await call("kabane_list", {
								...fullArgs,
								limit: 1,
								responseFormat: "concise",
							}),
						),
					);
					if (!first.success) return;
					const continuation = first.data.nextCursor;
					expect(continuation).toBeDefined();
					await call("kabane_add", {
						title: "Unrelated scope write",
						scopeUri: "elsewhere",
						responseFormat: "concise",
					});
					await call("kabane_list", {
						...fullArgs,
						limit: 1,
						responseFormat: "concise",
						cursor: continuation,
					});
					await call("kabane_edit", {
						id: tracker.ids[0],
						description: "relevant write",
						responseFormat: "concise",
					});
					expect(
						await call(
							"kabane_list",
							{
								...fullArgs,
								responseFormat: "concise",
								limit: 20,
								cursor: continuation,
							},
							true,
						),
					).toContain("Stale cursor");
					for (const args of [
						{ limit: 101 },
						{ limit: 0 },
						{ cursor: "malformed" },
						{ cursor: "x".repeat(701) },
						{ responseFormat: "bad" },
					])
						await call(
							"kabane_list",
							{ responseFormat: "concise", ...args },
							true,
						);
					const enumError = await call(
						"kabane_list",
						{ responseFormat: "concise", state: "漢".repeat(5000) },
						true,
					);
					expect(Buffer.byteLength(enumError)).toBeLessThanOrEqual(2048);
					const cliEnumError = await tracker.run(
						"list",
						"--format",
						"concise",
						"--state",
						"漢".repeat(5000),
					);
					expect(cliEnumError.code).toBe(1);
					expect(Buffer.byteLength(cliEnumError.stderr)).toBeLessThanOrEqual(
						16384,
					);
					const contextArgs = {
						id: tracker.ids[0],
						deref: false,
						includeSubtasks: false,
					};
					expect(
						await call("kabane_context", {
							...contextArgs,
							responseFormat: "full",
						}),
					).toBe(await call("kabane_context", contextArgs));
					for (const argv of [
						["--format", "bad"],
						["--format", "concise", "--limit", "101"],
						["--format"],
						["--cursor", "bad"],
					])
						expect((await tracker.run("list", ...argv)).code).toBe(2);
					expect(
						(
							await tracker.run(
								"list",
								"--format",
								"concise",
								"--cursor",
								"bad",
							)
						).code,
					).toBe(1);
					expect((await tracker.run("list", "--help")).out).toContain(
						"--format concise|full",
					);
					const searchQuery = synthetic ? "Synthetic" : "dataset";
					const searchText = await call("kabane_search", {
						query: searchQuery,
						scopeUri: "jake://scope/corpus",
						responseFormat: "concise",
					});
					const search = pageSchema.safeParse(JSON.parse(searchText));
					expect(search.success).toBe(true);
					if (!search.success) return;
					const cliSearch = await tracker.run(
						"search",
						searchQuery,
						"--format",
						"concise",
					);
					expect(cliSearch.code).toBe(0);
					const cliSearchPage = pageSchema.safeParse(JSON.parse(cliSearch.out));
					expect(cliSearchPage.success).toBe(true);
					if (cliSearchPage.success)
						expect(cliSearchPage.data.items).toEqual(search.data.items);
					const rawSearchArgs = {
						query: searchQuery,
						scopeUri: "jake://scope/corpus",
					};
					const searchIds = search.data.items.map((item) => item.id);
					let searchCursor = search.data.nextCursor;
					while (searchCursor) {
						const text = await call("kabane_search", {
							...rawSearchArgs,
							responseFormat: "concise",
							cursor: searchCursor,
						});
						expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
						const page = pageSchema.safeParse(JSON.parse(text));
						expect(page.success).toBe(true);
						if (!page.success) return;
						const cli = await tracker.run(
							"search",
							searchQuery,
							"--format",
							"concise",
							"--cursor",
							searchCursor,
						);
						expect(cli.code).toBe(0);
						expect(JSON.parse(cli.out)).toEqual(JSON.parse(text));
						searchIds.push(...page.data.items.map((item) => item.id));
						searchCursor = page.data.nextCursor;
					}
					const fullSearch = z.array(z.object({ id: z.string() })).safeParse(
						JSON.parse(
							await call("kabane_search", {
								...rawSearchArgs,
								limit: 200,
								responseFormat: "full",
							}),
						),
					);
					expect(fullSearch.success).toBe(true);
					if (fullSearch.success)
						expect(searchIds.sort()).toEqual(
							fullSearch.data.map((task) => task.id).sort(),
						);
					expect(
						await call("kabane_search", {
							...rawSearchArgs,
							responseFormat: "full",
						}),
					).toBe(await call("kabane_search", rawSearchArgs));
					const cliAdded = await tracker.run(
						"add",
						"Synthetic CLI receipt",
						"--description",
						"DO_NOT_ECHO_BODY",
						"--format",
						"concise",
						"--json",
					);
					expect(cliAdded.code).toBe(0);
					expect(cliAdded.out).not.toContain("DO_NOT_ECHO_BODY");
					expect(Buffer.byteLength(cliAdded.out.trim())).toBeLessThanOrEqual(
						2048,
					);
					const added = receiptSchema.safeParse(JSON.parse(cliAdded.out));
					expect(added.success).toBe(true);
					if (!added.success) return;
					for (const action of ["edit", "done"] as const) {
						const text = await call(`kabane_${action}`, {
							id: added.data.id,
							...(action === "edit" ? { state: "in_progress" } : {}),
							responseFormat: "concise",
						});
						expect(receiptSchema.safeParse(JSON.parse(text)).success).toBe(
							true,
						);
						expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
						expect(text).not.toContain("DO_NOT_ECHO_BODY");
					}
					const cliDone = await tracker.run(
						"done",
						added.data.id,
						"--format",
						"concise",
						"--json",
					);
					expect(cliDone.code).toBe(0);
					expect(receiptSchema.safeParse(JSON.parse(cliDone.out)).success).toBe(
						true,
					);
					expect(Buffer.byteLength(cliDone.out)).toBeLessThanOrEqual(2048);
					expect(cliDone.out).not.toContain("DO_NOT_ECHO_BODY");
					const fullAdd = await call("kabane_add", {
						title: "Full compatibility",
						description: "FULL_ADD_BODY",
						responseFormat: "full",
					});
					expect(
						z
							.object({
								id: z.string(),
								version: z.number(),
								description: z.literal("FULL_ADD_BODY"),
							})
							.safeParse(JSON.parse(fullAdd)).success,
					).toBe(true);
					const cliFullAdd = await tracker.run(
						"add",
						"Full CLI compatibility",
						"--description",
						"FULL_ADD_BODY",
						"--format",
						"full",
						"--json",
					);
					expect(cliFullAdd.code).toBe(0);
					expect(
						z
							.object({
								id: z.string(),
								version: z.number(),
								description: z.literal("FULL_ADD_BODY"),
							})
							.safeParse(JSON.parse(cliFullAdd.out)).success,
					).toBe(true);
					const fullGet = await call("kabane_get", { id: added.data.id });
					expect(fullGet).toContain("DO_NOT_ECHO_BODY");
					const fullEdit = await call("kabane_edit", {
						id: added.data.id,
						state: "next",
						responseFormat: "full",
					});
					expect(fullEdit).toContain("DO_NOT_ECHO_BODY");
					const legacyEdit = await call("kabane_edit", {
						id: added.data.id,
						state: "next",
					});
					expect(legacyEdit).toContain("DO_NOT_ECHO_BODY");
					expect(
						(
							await tracker.run(
								"edit",
								added.data.id,
								"--state",
								"next",
								"--format",
								"concise",
							)
						).out,
					).not.toContain("DO_NOT_ECHO_BODY");
					expect(
						(
							await tracker.run(
								"done",
								added.data.id,
								"--format",
								"full",
								"--json",
							)
						).out,
					).toContain("DO_NOT_ECHO_BODY");
					const todayText = await call("kabane_today", {
						responseFormat: "concise",
						scopeUri: "jake://scope/corpus",
						limit: 100,
					});
					expect(Buffer.byteLength(todayText)).toBeLessThanOrEqual(16384);
					expect(
						z
							.object({
								overdue: pageSchema,
								dueToday: pageSchema,
								next: pageSchema,
							})
							.safeParse(JSON.parse(todayText)).success,
					).toBe(true);
					const rawToday = await call("kabane_today", {
						scopeUri: "jake://scope/corpus",
					});
					expect(
						await call("kabane_today", {
							scopeUri: "jake://scope/corpus",
							responseFormat: "full",
						}),
					).toBe(rawToday);
					// Imported giant short label still resolves by ULID. Reject before mutation.
					const db = new Database(join(tracker.home, "kabane.db"));
					try {
						db.run(
							`UPDATE ${prefixed ? "fixture_" : ""}tasks SET short_id = ? WHERE id = ?`,
							["J".repeat(10000), added.data.id],
						);
					} finally {
						db.close();
					}
					const before = await call("kabane_get", { id: added.data.id });
					for (const action of ["edit", "done"] as const) {
						const error = await call(
							`kabane_${action}`,
							{
								id: added.data.id,
								...(action === "edit" ? { state: "in_progress" } : {}),
								responseFormat: "concise",
							},
							true,
						);
						expect(error.length).toBeLessThan(200);
						expect(error).toContain("no mutation occurred");
					}
					const rejected = await tracker.run(
						"done",
						added.data.id,
						"--format",
						"concise",
					);
					expect(rejected.code).toBe(1);
					expect(rejected.stderr.length).toBeLessThan(200);
					expect(await call("kabane_get", { id: added.data.id })).toBe(before);
					expect(
						await call("kabane_done", {
							id: added.data.id,
							responseFormat: "full",
						}),
					).toContain("DO_NOT_ECHO_BODY");
				} finally {
					await client.close();
					tracker.close();
				}
			}, 30000);
});
