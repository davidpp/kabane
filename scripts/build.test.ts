import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { build, copyTemplates, DIST } from "./build";

describe("copyTemplates", () => {
	const work = mkdtempSync(join(tmpdir(), "kabane-build-test-"));
	const root = (name: string, templates: readonly string[]): string => {
		const dir = join(work, name);
		for (const template of templates) {
			mkdirSync(join(dir, template), { recursive: true });
			writeFileSync(join(dir, template, "prompt.md"), `${name}/${template}`);
		}
		return dir;
	};

	afterEach(() => rmSync(work, { recursive: true, force: true }));

	it("puts every root's templates side by side under one directory", () => {
		const into = join(work, "dist");
		const copied = copyTemplates(
			[root("acp", ["dispatch"]), root("ext", ["prompts"])],
			into,
		);
		expect(copied.ok && copied.value).toEqual(["dispatch", "prompts"]);
		expect(readFileSync(join(into, "prompts/prompt.md"), "utf8")).toBe(
			"ext/prompts",
		);
	});

	it("fails on a name two roots both ship, before copying either", () => {
		const into = join(work, "dist");
		const copied = copyTemplates(
			[root("acp", ["dispatch"]), root("ext", ["dispatch"])],
			into,
		);
		expect(copied.ok).toBe(false);
		if (!copied.ok)
			expect(copied.error.message).toContain("templates/dispatch");
		expect(existsSync(into)).toBe(false);
	});
});

it("publishes self-contained extension types that compile with only the built package installed", async () => {
	await build();
	const declaration = readFileSync(join(DIST, "types/extension.d.ts"), "utf8");
	expect(declaration).not.toContain("@cabane/");
	expect(declaration).not.toMatch(/^import\s/m);
	const work = mkdtempSync(join(tmpdir(), "kabane-type-consumer-"));
	try {
		const installed = join(work, "node_modules/kabane");
		cpSync(DIST, installed, { recursive: true });
		const manifest = JSON.parse(
			readFileSync(join(installed, "package.json"), "utf8"),
		);
		expect(manifest.exports).toEqual({
			"./extension": { types: "./types/extension.d.ts" },
		});
		expect(manifest.files).toContain("types");
		const source = join(work, "index.ts");
		writeFileSync(
			source,
			`
import type { Extension, Host } from "kabane/extension";
export default (host: Host): Extension => ({
 name: "sample",
 settings: host.z.object({ word: host.z.string().default("hello") }),
 commands: [{ name: "sample", summary: "Read", usage: "sample <id>", run: async (args, ctx) => {
  const id = args.positionals[0] ?? "missing";
  const task = await host.record.get({ id });
  if (!task.ok) return host.outcome.failure(task.error);
  const title: string = task.value.title;
  const mode: "auto" | "default" = host.harnessMode;
  return host.outcome.success({ title, mode, actor: ctx.actor }, title);
 } }],
 mcp: async () => ({ tools: [host.defineTool({
  name: "kabane_sample_echo", description: "Echo", kind: "read",
  input: { word: host.z.string() },
  handler: async ({ word }) => host.result.ok(word.toUpperCase()),
 })] }),
});
`,
		);
		const program = ts.createProgram([source], {
			strict: true,
			noEmit: true,
			skipLibCheck: false,
			types: [],
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
		});
		const diagnostics = ts.getPreEmitDiagnostics(program);
		expect(
			diagnostics.map((d) =>
				ts.flattenDiagnosticMessageText(d.messageText, "\n"),
			),
		).toEqual([]);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}, 60000);
