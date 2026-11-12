import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, copyTree, hash } from "./files";
import { cleanEnvironment, runProcess } from "./process";
import { recipeSchema } from "./schema";
import {
	inventoryProblems,
	normalizedInventory,
	summarizeTrace,
} from "./usage";

const temporary: string[] = [];
const directory = (): string => {
	const path = mkdtempSync(join(tmpdir(), "kabane-benchmark-policy-"));
	temporary.push(path);
	return path;
};
afterEach(() => {
	for (const path of temporary.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("benchmark measurement policy", () => {
	it("hashes semantic JSON without property-order artifacts", () => {
		expect(hash(canonical({ a: 1, nested: { z: 2, a: 3 } }))).toBe(
			hash(canonical({ nested: { a: 3, z: 2 }, a: 1 })),
		);
		expect(hash(canonical(["a", "b"]))).not.toBe(hash(canonical(["b", "a"])));
	});
	it("rejects recipe paths escaping the input directory", () => {
		const recipe = {
			version: 1,
			name: "example",
			models: { codex: "exact-id", claude: "exact-id" },
			maxSeconds: 30,
			common: "../private.md",
			rubric: "rubric.md",
			starter: "starter",
			rounds: [{ prompt: "round.md", harness: "codex" }],
		};
		expect(recipeSchema.safeParse(recipe).success).toBe(false);
		expect(
			recipeSchema.safeParse({ ...recipe, common: "common.md" }).success,
		).toBe(true);
	});
	it("keeps missing telemetry missing and does not infer success from empty output", () => {
		const trace = summarizeTrace("", "codex");
		expect(trace.usage.input).toBeNull();
		expect(trace.completed).toBe(false);
	});
	it("sums Codex turn usage without adding cached input a second time", () => {
		const source = [10, 20]
			.map((input) =>
				JSON.stringify({
					type: "turn.completed",
					usage: {
						input_tokens: input,
						cached_input_tokens: 5,
						output_tokens: 3,
					},
				}),
			)
			.join("\n");
		const trace = summarizeTrace(source, "codex");
		expect(trace.usage).toMatchObject({
			input: 30,
			cachedInput: 10,
			output: 6,
			cacheWrite: null,
		});
	});
	it("uses Claude's final usage once, preserving separate cache categories", () => {
		const trace = summarizeTrace(
			JSON.stringify({
				type: "result",
				subtype: "success",
				usage: {
					input_tokens: 5,
					output_tokens: 4,
					cache_read_input_tokens: 20,
					cache_creation_input_tokens: 8,
				},
				total_cost_usd: 99,
			}),
			"claude",
		);
		expect(trace.usage).toMatchObject({
			input: 5,
			cachedInput: 20,
			cacheWrite: 8,
			output: 4,
		});
		expect(trace.usage).not.toHaveProperty("total_cost_usd");
	});
	it("checks actual native inventory rather than rejecting builtin plugins", () => {
		const event = {
			type: "system",
			subtype: "init",
			model: "exact",
			apiKeySource: "none",
			tools: ["Bash"],
			skills: [],
			plugins: [
				{
					name: "cc-plugin-privacy",
					path: "builtin",
					source: "cc-plugin-privacy@builtin",
				},
			],
			mcp_servers: [],
		};
		const baseline = summarizeTrace(JSON.stringify(event), "claude");
		expect(inventoryProblems(baseline, "exact", false)).toEqual([]);
		expect(inventoryProblems(baseline, "another", false)).toHaveLength(1);
		const treatment = summarizeTrace(
			JSON.stringify({
				...event,
				tools: ["Bash", "mcp__kabane__kabane_context"],
				mcp_servers: [{ name: "kabane", status: "connected" }],
			}),
			"claude",
		);
		expect(inventoryProblems(treatment, "exact", true)).toEqual([]);
		expect(inventoryProblems(treatment, "exact", false).length).toBeGreaterThan(
			0,
		);
		if (!baseline.inventory || !treatment.inventory) return;
		expect(normalizedInventory(baseline.inventory)).toBe(
			normalizedInventory(treatment.inventory),
		);
	});
	it("does not forward ambient API credentials or provider switches", () => {
		const env = cleanEnvironment();
		for (const key of [
			"OPENAI_API_KEY",
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"CLAUDE_CODE_USE_BEDROCK",
			"ANTHROPIC_BASE_URL",
			"CODEX_HOME",
			"HOME",
		])
			expect(env[key]).toBeUndefined();
	});
	it("preserves executable starters and excludes credentials/dependency trees", () => {
		const root = directory();
		const source = join(root, "source");
		mkdirSync(source);
		writeFileSync(join(source, "launch.sh"), "#!/bin/sh\nexit 0\n", {
			mode: 0o700,
		});
		writeFileSync(join(source, ".env"), "PRIVATE=not-a-real-secret");
		const result = copyTree(source, join(root, "copy"));
		expect(result.ok).toBe(true);
		expect(statSync(join(root, "copy", "launch.sh")).mode & 0o100).toBe(0o100);
		expect(Bun.file(join(root, "copy", ".env")).size).toBe(0);
	});
	it("flushes the real child process trace before returning", async () => {
		const root = directory();
		const output = join(root, "stdout.log");
		const result = await runProcess({
			argv: [process.execPath, "-e", "console.log('actual-process-output')"],
			cwd: root,
			env: cleanEnvironment(),
			seconds: 5,
			stdout: output,
		});
		expect(result.ok).toBe(true);
		expect(readFileSync(output, "utf8")).toBe("actual-process-output\n");
	});
	it("terminates a real long-running process at its cap", async () => {
		const result = await runProcess({
			argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
			cwd: directory(),
			env: cleanEnvironment(),
			seconds: 0.05,
		});
		expect(result.ok && result.value.timedOut).toBe(true);
	});
});
