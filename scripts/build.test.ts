import { expect, it } from "bun:test";
import {
	existsSync,
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { DIST } from "./build";

it("publishes self-contained extension types that compile with only the built package installed", async () => {
	// In its own process, so a bundler failure fails only this test.
	const built = Bun.spawnSync([
		process.execPath,
		join(import.meta.dir, "build.ts"),
	]);
	expect(built.stderr.toString()).toBe(`build: ${DIST}\n`);
	expect(built.exitCode).toBe(0);
	const metafile = JSON.parse(
		readFileSync(join(DIST, "metafile.json"), "utf8"),
	);
	expect(
		Object.keys(metafile.inputs).filter((file) =>
			/(^|\/)extensions\//.test(file),
		),
	).toEqual([]);
	const declaration = readFileSync(join(DIST, "types/extension.d.ts"), "utf8");
	expect(declaration).not.toContain("@kabane/");
	expect(declaration).not.toMatch(/^import\s/m);
	expect(declaration).not.toMatch(
		/export declare (?:const|function|namespace|class)\b/,
	);
	expect(declaration).not.toContain("createHostRecord");
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
		expect(manifest.files).toEqual(["bin", "types"]);
		// No template ships with kabane: the dispatch and grill skills are the dispatch extension's.
		expect(existsSync(join(DIST, "templates"))).toBe(false);
		const source = join(work, "index.ts");
		writeFileSync(
			source,
			`
import type {
 Extension, Host, Task, TaskEntry, TaskWorkLog, TaskLink, UpstreamLink,
 Result, ToolDef, ProjectScope, ParsedArgs, Outcome, Settings, Doctor,
 ActivitySource, Dispatcher, Header,
} from "kabane/extension";
export type NamedContract = {
 task: Task; entry: TaskEntry; log: TaskWorkLog; link: TaskLink; upstream: UpstreamLink;
 result: Result<Task>; tool: ToolDef; scope: ProjectScope; args: ParsedArgs; outcome: Outcome;
 settings: Settings.Port; finding: Doctor.Finding; command: Extension.Command;
 ctx: Extension.Ctx; board: Extension.BoardPorts; input: Host.ListInput;
 activity: ActivitySource; dispatcher: Dispatcher; header: Header;
};
export default (host: Host): Extension => ({
 name: "sample",
 settings: host.z.object({ word: host.z.string().default("hello") }),
 commands: [{ name: "sample", summary: "Read", usage: "sample <id>", run: async (args, ctx) => {
  const id = args.positionals[0] ?? "missing";
  const task = await host.record.get({ id });
  if (!task.ok) return host.outcome.failure(task.error);
  if (task.value === null) return host.outcome.failure(new Error("No task " + id));
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
		writeFileSync(
			source,
			`
import { success, Settings, Doctor } from "kabane/extension";
success({}, "ok");
Settings.fields;
Doctor.run;
`,
		);
		const invalid = ts.getPreEmitDiagnostics(
			ts.createProgram([source], program.getCompilerOptions()),
		);
		expect(
			invalid.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
		).toEqual([
			"Module '\"kabane/extension\"' declares 'success' locally, but it is not exported.",
			"'Settings' cannot be used as a value because it was exported using 'export type'.",
			"'Doctor' cannot be used as a value because it was exported using 'export type'.",
		]);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}, 60000);
