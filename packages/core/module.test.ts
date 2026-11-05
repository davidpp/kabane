import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDb } from "@cabane/sqlite";
import { tablePrefix } from "./db/tables";
import { CORE_TOOL_NAMES } from "./mcp/tool-names";
import { KABANE_TOOLS, type ToolDef } from "./mcp/tools";
import type { KabaneModule, ModuleContextSection } from "./module";
import { ok, type Result } from "./result";
import { Runtime, withDb } from "./runtime";
import { CONTEXT_SECTIONS } from "./schemas/assemble-context";
import { configureTestRuntime } from "./testing";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const section = (name: string): ModuleContextSection => ({
	name,
	after: "description",
	render: async () => ok(null),
});
const tool = (name: string): ToolDef => ({
	name,
	description: "Read module data",
	kind: "read",
	input: {},
	handler: async () => ok(null),
});
const kept: KabaneModule = {
	name: "kept",
	contextSections: [section("kept.summary")],
	tools: [tool("kept_read")],
	instructions: "Read the summary.",
};
let base: string;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "kabane-module-registration-"));
	unwrap(
		Runtime.configure({
			provider: SqliteDb.provider({ dbName: "kept.db" }),
			modules: [kept],
			tablePrefix: "kept_",
			actor: () => "kept",
			timezone: () => "UTC",
		}),
	);
	unwrap(
		await withDb(base, (db) =>
			db.exec(
				"CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('kept');",
			),
		),
	);
});
afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});

const refusals: { name: string; modules: KabaneModule[]; message: string }[] = [
	{
		name: "wrong section namespace",
		modules: [{ name: "alpha", contextSections: [section("other.summary")] }],
		message: 'must start with "alpha."',
	},
	...CONTEXT_SECTIONS.map((name) => ({
		name: `core section ${name}`,
		modules: [{ name: "alpha", contextSections: [section(name)] }],
		message: "already a core section",
	})),
	{
		name: "duplicate section within a module",
		modules: [
			{
				name: "alpha",
				contextSections: [section("alpha.summary"), section("alpha.summary")],
			},
		],
		message: 'already a section of module "alpha"',
	},
	{
		name: "section claimed by another module",
		modules: [
			{ name: "alpha", contextSections: [section("alpha.summary")] },
			{ name: "beta", contextSections: [section("alpha.summary")] },
		],
		message: 'already a section of module "alpha"',
	},
	...Object.values(CORE_TOOL_NAMES).map((name) => ({
		name: `core tool ${name}`,
		modules: [{ name: "alpha", tools: [tool(name)] }],
		message: "already a core tool",
	})),
	{
		name: "duplicate tool within a module",
		modules: [
			{ name: "alpha", tools: [tool("shared_read"), tool("shared_read")] },
		],
		message: 'already a tool of module "alpha"',
	},
	{
		name: "tool claimed by another module",
		modules: [
			{ name: "alpha", tools: [tool("shared_read")] },
			{ name: "beta", tools: [tool("shared_read")] },
		],
		message: 'already a tool of module "alpha"',
	},
];

for (const refusal of refusals)
	it(`refuses ${refusal.name} without changing any runtime state`, async () => {
		const ports = [
			Runtime.tracer(),
			Runtime.notifier(),
			Runtime.scopeResolver(),
			Runtime.syncSettings(),
		];
		const modules = Runtime.modules();
		const settings = await Runtime.syncSettings()();
		const configured = Runtime.configure({
			provider: SqliteDb.provider({ dbName: "rejected.db" }),
			modules: refusal.modules,
			tablePrefix: "rejected_",
			actor: () => "rejected",
			timezone: () => "Europe/Paris",
			tracer: (_name, fn) => fn,
			notifier: async () => {},
			scopeResolver: async () => "rejected",
			syncSettings: async () => settings,
		});
		expect(configured.ok).toBe(false);
		if (!configured.ok)
			expect(configured.error.message).toContain(refusal.message);
		expect(Runtime.modules()).toBe(modules);
		expect(Runtime.modules()).toEqual([kept]);
		expect(tablePrefix()).toBe("kept_");
		expect(Runtime.actor()).toBe("kept");
		expect(Runtime.timezone()).toBe("UTC");
		const after = [
			Runtime.tracer(),
			Runtime.notifier(),
			Runtime.scopeResolver(),
			Runtime.syncSettings(),
		];
		for (let i = 0; i < ports.length; i++) expect(after[i]).toBe(ports[i]);
		expect(
			unwrap(
				await withDb(base, (db) => db.query("SELECT value FROM proof").get()),
			),
		).toEqual({ value: "kept" });
	});

it("reserves exactly the tools served by core", () => {
	expect(KABANE_TOOLS.map((item) => item.name).sort()).toEqual(
		Object.values(CORE_TOOL_NAMES).sort(),
	);
});
