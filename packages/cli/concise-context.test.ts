import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { ContextPageSchema } from "@cabane/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
	CLI_BIN,
	createCorpusTracker,
	payloadMetrics,
} from "./issue-corpus-harness";

const toolResult = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
const fullContext = z.object({ markdown: z.string() });

describe("bounded context through actual CLI/stdio", () => {
	for (const prefixed of [false, true])
		it(`recovers retained steering and full briefs with identical compact chunks (${prefixed})`, async () => {
			const seeded = await createCorpusTracker({ prefixed, synthetic: true });
			expect(seeded.ok).toBe(true);
			if (!seeded.ok) return;
			const tracker = seeded.value;
			const client = new Client({
				name: "bounded-context-regression",
				version: "1",
			});
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
				const tools = await client.listTools();
				expect(tools.tools).toHaveLength(17);
				for (const field of ["responseFormat", "sections", "cursor"])
					expect(
						tools.tools.find((tool) => tool.name === "kabane_context")
							?.inputSchema.properties,
					).toHaveProperty(field);
				const call = async (args: Record<string, unknown>, error = false) => {
					const result = toolResult.safeParse(
						await client.callTool({ name: "kabane_context", arguments: args }),
					);
					expect(result.success).toBe(true);
					if (!result.success) return "";
					expect(Boolean(result.data.isError)).toBe(error);
					return result.data.content.map((block) => block.text).join("");
				};
				for (const id of [tracker.ids[0], tracker.ids[24]]) {
					if (!id) return;
					const fullArgs = { id, deref: false, includeSubtasks: true };
					const legacy = await call(fullArgs);
					expect(await call({ ...fullArgs, responseFormat: "full" })).toBe(
						legacy,
					);
					const full = fullContext.safeParse(JSON.parse(legacy));
					if (!full.success) return;
					const cliLegacy = await tracker.run(
						"context",
						id,
						"--no-deref",
						"--json",
					);
					expect(cliLegacy.code).toBe(0);
					expect(
						await tracker.run(
							"context",
							id,
							"--no-deref",
							"--format",
							"full",
							"--json",
						),
					).toEqual(cliLegacy);
					const legacyCli = fullContext.safeParse(JSON.parse(cliLegacy.out));
					if (legacyCli.success)
						expect(legacyCli.data.markdown).toBe(full.data.markdown);
					let markdown = "";
					let cursor: string | undefined;
					let totalBytes = 0;
					let totalCharacters = 0;
					let calls = 0;
					do {
						const text = await call({
							...fullArgs,
							responseFormat: "concise",
							cursor,
						});
						const cliArgs = [
							"context",
							id,
							"--no-deref",
							"--format",
							"concise",
							...(cursor ? ["--cursor", cursor] : []),
						];
						const cli = await tracker.run(...cliArgs);
						expect(cli.code).toBe(0);
						expect(cli.stderr).toBe("");
						expect(cli.out).toBe(text);
						if (calls === 0)
							expect((await tracker.run(...cliArgs, "--json")).out).toBe(text);
						const measured = payloadMetrics(text);
						expect(measured.bytes).toBeLessThanOrEqual(16384);
						totalBytes += measured.bytes;
						totalCharacters += measured.characters;
						calls++;
						const page = ContextPageSchema.safeParse(JSON.parse(text));
						expect(page.success).toBe(true);
						if (!page.success) return;
						expect(page.data.offset).toBe(markdown.length);
						expect(page.data.taskId).toBe(id);
						expect(page.data.markdown).not.toMatch(/[\ud800-\udbff]$/u);
						expect(page.data.markdown).not.toMatch(/^[\udc00-\udfff]/u);
						expect(page.data.completeness.selectedComplete).toBe(
							page.data.nextCursor === undefined,
						);
						if (id === tracker.ids[24] && calls === 1) {
							expect(page.data.completeness.descriptionComplete).toBe(false);
							expect(page.data.completeness.humanSteeringComplete).toBe(false);
						}
						markdown += page.data.markdown;
						cursor = page.data.nextCursor;
						expect(calls).toBeLessThan(100);
					} while (cursor);
					expect(markdown).toBe(full.data.markdown);
					if (id === tracker.ids[24]) {
						expect(markdown).toContain("SYNTHETIC_EARLY_STEERING");
						expect(markdown).toContain("SYNTHETIC_LATE_STEERING");
						expect(markdown).toContain("Subtasks (106)");
					}
					console.info(
						JSON.stringify({
							contextPayload:
								id === tracker.ids[24] ? "synthetic" : "public-first",
							prefixed,
							full: payloadMetrics(legacy),
							concise: {
								bytes: totalBytes,
								characters: totalCharacters,
								calls,
							},
						}),
					);
				}
				const id = tracker.ids[24];
				if (!id) return;
				const emptyText = await call({
					id,
					responseFormat: "concise",
					sections: [],
				});
				expect(
					(
						await tracker.run(
							"context",
							id,
							"--format",
							"concise",
							"--sections",
							"",
						)
					).out,
				).toBe(emptyText);
				const empty = ContextPageSchema.safeParse(JSON.parse(emptyText));
				expect(empty.success).toBe(true);
				if (empty.success) {
					expect(empty.data.markdown).toBe("");
					expect(empty.data.completeness).toMatchObject({
						selectedComplete: true,
						descriptionComplete: false,
						humanSteeringComplete: false,
					});
				}
				const selectedText = await call({
					id,
					responseFormat: "concise",
					sections: ["discussion", "description", "discussion"],
					deref: false,
					includeSubtasks: false,
				});
				const selectedCli = await tracker.run(
					"context",
					id,
					"--format",
					"concise",
					"--sections",
					"description,discussion",
					"--no-deref",
					"--no-subtasks",
				);
				expect(selectedCli.out).toBe(selectedText);
				const selected = ContextPageSchema.safeParse(JSON.parse(selectedText));
				if (!selected.success || !selected.data.nextCursor) return;
				expect(selected.data.completeness.omittedSections).toContain(
					"position",
				);
				expect(selected.data.markdown.startsWith("## Description")).toBe(true);
				const cursor = selected.data.nextCursor;
				for (const invalid of ["{", cursor]) {
					const text = await call(
						{ id, responseFormat: "concise", cursor: invalid, deref: false },
						true,
					);
					expect(text).toContain("cursor");
					const cli = await tracker.run(
						"context",
						id,
						"--format",
						"concise",
						"--cursor",
						invalid,
						"--no-deref",
					);
					expect(cli.code).toBe(1);
					expect(cli.stderr).toContain("cursor");
				}
				expect(
					await call(
						{ id, responseFormat: "full", sections: ["description"] },
						true,
					),
				).toContain("require responseFormat: concise");
				expect(
					(await tracker.run("context", id, "--sections", "description")).code,
				).toBe(2);
				expect(
					(
						await tracker.run(
							"context",
							id,
							"--format",
							"concise",
							"--sections",
							"unknown",
						)
					).code,
				).toBe(2);
				expect(
					await call(
						{ id, responseFormat: "concise", sections: ["unknown"] },
						true,
					),
				).toContain("Invalid");
				// External comment writes don't bump task.version, but must stale discussion.
				const db = new Database(join(tracker.home, "kabane.db"));
				try {
					db.run(
						`UPDATE ${prefixed ? "fixture_" : ""}task_comments SET content = content || ' CHANGED' WHERE task_id = ?`,
						[id],
					);
				} finally {
					db.close();
				}
				const staleArgs = {
					id,
					responseFormat: "concise",
					sections: ["description", "discussion"],
					deref: false,
					includeSubtasks: false,
					cursor,
				};
				expect(await call(staleArgs, true)).toContain("Stale context cursor");
				const cliStale = await tracker.run(
					"context",
					id,
					"--format",
					"concise",
					"--sections",
					"description,discussion",
					"--no-deref",
					"--no-subtasks",
					"--cursor",
					cursor,
				);
				expect(cliStale.code).toBe(1);
				expect(cliStale.stderr).toContain("Stale context cursor");
				const help = await tracker.run("context", "--help");
				expect(help.out).toContain("--sections");
				const broken = new Database(join(tracker.home, "kabane.db"));
				try {
					broken.exec(`DROP TABLE ${prefixed ? "fixture_" : ""}task_comments`);
				} finally {
					broken.close();
				}
				expect(
					await call(
						{ id, responseFormat: "concise", sections: ["discussion"] },
						true,
					),
				).toContain("Cannot read context discussion comments");
				const failedSource = await tracker.run(
					"context",
					id,
					"--format",
					"concise",
					"--sections",
					"discussion",
				);
				expect(failedSource.code).toBe(1);
				expect(failedSource.stderr).toContain(
					"Cannot read context discussion comments",
				);
				expect(
					(
						await tracker.run(
							"context",
							id,
							"--format",
							"concise",
							"--sections",
							"description",
						)
					).code,
				).toBe(0);
			} finally {
				await client.close();
				tracker.close();
			}
		}, 120000);
});
