import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import issues from "../core/testing/fixtures/issue-corpus/issues.json";
import manifest from "../core/testing/fixtures/issue-corpus/manifest.json";
import {
	CLI_BIN,
	createCorpusTracker,
	payloadMetrics,
} from "./issue-corpus-harness";
import {
	corpusSchema,
	HUGE_BODY,
	HUGE_COMMENT,
	FIXTURE_TIME,
} from "./issue-corpus-seed";

const taskSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		description: z.string().optional(),
		state: z.string(),
		version: z.number(),
		createdAt: z.string(),
	})
	.passthrough();
const textBlocks = z.object({
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
	isError: z.boolean().optional(),
});
const jsonRecord = (text: string) => taskSchema.safeParse(JSON.parse(text));

describe("retained issue corpus baseline", () => {
	it("pins the retained bytes and deterministic selection", () => {
		const parsed = corpusSchema.safeParse(issues);
		expect(parsed.success).toBe(true);
		expect(issues).toHaveLength(24);
		expect(manifest.normalizationVersion).toBe(2);
		expect(issues.map((issue) => issue.number)).toEqual(manifest.issueNumbers);
		const bytes = readFileSync(
			join(
				import.meta.dir,
				"../core/testing/fixtures/issue-corpus/issues.json",
			),
		);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(
			manifest.fixtureSha256,
		);
		expect(bytes.length).toBeLessThan(500 * 1024);
		for (const issue of issues) {
			const canonical = JSON.stringify({
				body: issue.body,
				comments: issue.comments,
				title: issue.title,
			});
			expect(createHash("sha256").update(canonical).digest("hex")).toBe(
				issue.contentSha256,
			);
		}
		for (const issue of issues) {
			const text = [issue.title, issue.body, ...issue.comments].join("\n");
			expect(text).not.toMatch(/[a-z]:\\users\\(?!\[user\])[^\\\s]+/i);
			expect(text).not.toMatch(/\/(?:home|Users)\/(?!\[user\])[^/\s]+/);
		}
		expect(issues.some((issue) => issue.body.includes("```"))).toBe(true);
		expect(issues.some((issue) => issue.comments.length === 0)).toBe(true);
		expect(issues.some((issue) => issue.comments.length >= 10)).toBe(true);
	});

	for (const prefixed of [false, true])
		for (const synthetic of [false, true]) {
			it(`reaches ${synthetic ? "public + synthetic" : "public"} rows through CLI and stdio (${prefixed ? "prefixed" : "fresh"})`, async () => {
				const seeded = await createCorpusTracker({ prefixed, synthetic });
				expect(seeded.ok).toBe(true);
				if (!seeded.ok) return;
				const tracker = seeded.value;
				const client = new Client({ name: "corpus-baseline", version: "1" });
				const transport = new StdioClientTransport({
					command: process.execPath,
					args: [CLI_BIN, "mcp"],
					cwd: tracker.cwd,
					env: tracker.env,
					stderr: "pipe",
				});
				try {
					expect(tracker.ids).toHaveLength(synthetic ? 131 : 24);
					const cliList = await tracker.run(
						"list",
						"--json",
						"--limit",
						"200",
						"--all",
					);
					expect(cliList.code).toBe(0);
					const cliRows = z
						.array(taskSchema)
						.safeParse(JSON.parse(cliList.out));
					expect(cliRows.success).toBe(true);
					if (!cliRows.success) return;
					expect(cliRows.data).toHaveLength(
						tracker.ids.length - (synthetic ? 1 : 0),
					);
					expect(
						cliRows.data.every((row) => row.createdAt === FIXTURE_TIME),
					).toBe(true);
					const humanList = await tracker.run(
						"list",
						"--limit",
						"200",
						"--all",
					);
					expect(humanList.code).toBe(0);
					expect(humanList.out).toContain(
						issues[0]?.title ?? "missing fixture",
					);
					await client.connect(transport);
					const discovery = await client.listTools();
					expect(discovery.tools).toHaveLength(17);
					let toolCalls = 0;
					const call = async (name: string, args: Record<string, unknown>) => {
						toolCalls++;
						const parsed = textBlocks.safeParse(
							await client.callTool({ name, arguments: args }),
						);
						expect(parsed.success).toBe(true);
						if (!parsed.success) return "";
						expect(parsed.data.isError).toBeFalsy();
						return parsed.data.content.map((block) => block.text).join("");
					};
					const rawList = await call("kabane_list", {
						limit: 200,
						includeClosed: true,
					});
					const mcpRows = z.array(taskSchema).safeParse(JSON.parse(rawList));
					expect(mcpRows.success).toBe(true);
					if (!mcpRows.success) return;
					expect(mcpRows.data).toHaveLength(tracker.ids.length);
					const legacyDefault = z
						.array(taskSchema)
						.safeParse(JSON.parse(await call("kabane_list", {})));
					expect(legacyDefault.success).toBe(true);
					if (legacyDefault.success)
						expect(legacyDefault.data).toHaveLength(synthetic ? 100 : 24);
					for (const [index, issue] of issues.entries()) {
						const task = mcpRows.data.find(
							(row) => row.id === tracker.ids[index],
						);
						expect(task?.title).toBe(issue.title);
						expect(task?.description ?? "").toBe(issue.body);
					}
					expect(
						mcpRows.data
							.filter((row) => row.scopeUri === "jake://scope/corpus")
							.map((row) => row.id)
							.sort(),
					).toEqual(cliRows.data.map((row) => row.id).sort());
					const id = tracker.ids[0];
					expect(id).toBeDefined();
					if (!id) return;
					const rawGet = await call("kabane_get", { id });
					const record = jsonRecord(rawGet);
					expect(record.success).toBe(true);
					if (record.success)
						expect(record.data.description).toBe(issues[0]?.body);
					const cliShow = await tracker.run("show", id, "--json");
					expect(cliShow.code).toBe(0);
					expect(
						z
							.object({
								task: taskSchema,
								comments: z.array(z.unknown()),
								links: z.array(z.unknown()),
								workLogs: z.array(z.unknown()),
							})
							.safeParse(JSON.parse(cliShow.out)).success,
					).toBe(true);
					const cliBrief = await tracker.run(
						"context",
						id,
						"--no-deref",
						"--no-subtasks",
					);
					const rawBrief = await call("kabane_context", {
						id,
						deref: false,
						includeSubtasks: false,
					});
					const brief = z
						.object({ markdown: z.string() })
						.safeParse(JSON.parse(rawBrief));
					expect(brief.success).toBe(true);
					if (!brief.success) return;
					expect(cliBrief.out.trim()).toBe(brief.data.markdown.trim());
					expect(brief.data.markdown).toContain(
						issues[0]?.body ?? "missing body",
					);
					for (const comment of issues[0]?.comments ?? [])
						expect(brief.data.markdown).toContain(comment);
					if (synthetic) {
						const giant = tracker.ids[24];
						if (!giant) return;
						const giantBrief = await tracker.run(
							"context",
							giant,
							"--no-deref",
							"--no-subtasks",
						);
						expect(giantBrief.code).toBe(0);
						expect(giantBrief.out).toContain(HUGE_BODY);
						expect(giantBrief.out).toContain(HUGE_COMMENT);
						expect(giantBrief.out).toContain("SYNTHETIC_EARLY_STEERING");
						expect(giantBrief.out).toContain("SYNTHETIC_LATE_STEERING");
						expect(giantBrief.out).toContain("Synthetic prior work");
						const giantMcp = z.object({ markdown: z.string() }).safeParse(
							JSON.parse(
								await call("kabane_context", {
									id: giant,
									deref: false,
									includeSubtasks: false,
								}),
							),
						);
						expect(giantMcp.success).toBe(true);
						if (giantMcp.success)
							expect(giantMcp.data.markdown.trim()).toBe(giantBrief.out.trim());
					}
					const receipt = await call("kabane_edit", {
						id,
						state: "in_progress",
					});
					expect(jsonRecord(receipt).success).toBe(true);
					const created = jsonRecord(
						await call("kabane_add", {
							title: "Synthetic receipt compatibility",
							description: "SYNTHETIC_RECEIPT_BODY",
							kind: "issue",
						}),
					);
					expect(created.success).toBe(true);
					if (created.success) {
						expect(created.data.description).toBe("SYNTHETIC_RECEIPT_BODY");
						const done = jsonRecord(
							await call("kabane_done", { id: created.data.id }),
						);
						expect(done.success).toBe(true);
						if (done.success) expect(done.data.state).toBe("done");
					}
					console.info(
						JSON.stringify({
							fixture: manifest.fixtureSha256,
							prefixed,
							synthetic,
							cliList: payloadMetrics(cliList.out),
							mcpList: payloadMetrics(rawList),
							mcpGet: payloadMetrics(rawGet),
							mcpBrief: payloadMetrics(rawBrief),
							toolCalls,
							discoveryCalls: 1,
						}),
					);
				} finally {
					await client.close();
					tracker.close();
					expect(existsSync(tracker.root)).toBe(false);
				}
			}, 30000);
		}
});
