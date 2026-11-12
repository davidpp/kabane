import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDb } from "@cabane/sqlite";
import { CORE_TOOL_NAMES } from "./mcp/tool-names";
import { KABANE_TOOLS, type ToolDef } from "./mcp/tools";
import type { KabaneModule, ModuleContextSection } from "./module";
import { ok, type Result } from "./result";
import { Runtime, withDb } from "./runtime";
import { CONTEXT_SECTIONS } from "./schemas/assemble-context";
import { type EntryKind, EntryKindSchema } from "./schemas/comment";
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
const kind = (
	name: string,
	projection: EntryKind["projection"] = "discussion",
	over: Partial<EntryKind> = {},
): EntryKind => ({ name, title: "Verdict", template: "", projection, ...over });
const latest: EntryKind["projection"] = {
	latest: { after: "description", framing: "The newest verdict." },
};
const kept: KabaneModule = {
	name: "kept",
	contextSections: [section("kept.summary")],
	kinds: [kind("kept.verdict", latest)],
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
		name: "malformed kind name",
		modules: [{ name: "alpha", kinds: [kind("alpha.Verdict")] }],
		message: 'module "alpha" kind "alpha.Verdict": name must be lowercase',
	},
	{
		name: "kind name with a newline",
		modules: [{ name: "alpha", kinds: [kind("alpha.x\nInjected line")] }],
		message:
			'module "alpha" kind "alpha.x\\nInjected line": name must be lowercase',
	},
	{
		name: "kind name with a carriage return",
		modules: [{ name: "alpha", kinds: [kind("alpha\r")] }],
		message: 'module "alpha" kind "alpha\\r": name must be lowercase',
	},
	{
		name: "module name with a newline",
		modules: [{ name: "alpha\nbeta" }],
		message: 'module name "alpha\\nbeta" must be lowercase',
	},
	{
		name: "kind outside its module's namespace",
		modules: [{ name: "alpha", kinds: [kind("beta.verdict")] }],
		message: 'must be "alpha" or start with "alpha."',
	},
	{
		name: "the reserved comment kind",
		modules: [{ name: "comment", kinds: [kind("comment")] }],
		message: '"comment" is core\'s own kind',
	},
	{
		name: "duplicate kind within a module",
		modules: [{ name: "alpha", kinds: [kind("alpha"), kind("alpha")] }],
		message: 'already a kind of module "alpha"',
	},
	{
		name: "latest kind whose section a module section holds",
		modules: [
			{
				name: "alpha",
				contextSections: [section("alpha.latest")],
				kinds: [kind("alpha", latest)],
			},
		],
		message:
			'its section "alpha.latest" is already a section of module "alpha"',
	},
	{
		name: "kind title on two lines",
		modules: [
			{
				name: "alpha",
				kinds: [kind("alpha", "discussion", { title: "a\nb" })],
			},
		],
		message: "title must be one non-blank line",
	},
	{
		name: "latest kind with a blank framing",
		modules: [
			{
				name: "alpha",
				kinds: [
					kind("alpha", { latest: { after: "description", framing: " " } }),
				],
			},
		],
		message: "projection.latest.framing must be one non-blank line",
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
			actor: () => "rejected",
			timezone: () => "Europe/Paris",
			tracer: (_name, fn) => fn,
			notifier: async () => {},
			scopeResolver: async () => "rejected",
			syncSettings: async () => settings,
		});
		expect(configured.ok).toBe(false);
		if (!configured.ok) {
			expect(configured.error.message).toContain(refusal.message);
			expect(configured.error.message).not.toMatch(/[\r\n]/);
		}
		expect(Runtime.modules()).toBe(modules);
		expect(Runtime.modules()).toEqual([kept]);
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

it("finds a registered kind by name, and nothing for one no module declares", () => {
	expect(Runtime.entryKind("kept.verdict")).toEqual(kept.kinds?.[0]);
	expect(Runtime.entryKind("review")).toBeUndefined();
	expect(Runtime.entryKind("comment")).toBeUndefined();
});

it("reads a kind as data only, anchored after a core section", () => {
	const declared = { ...kind("alpha", latest) };
	expect(EntryKindSchema.safeParse(declared).success).toBe(true);
	expect(
		EntryKindSchema.safeParse({
			...declared,
			projection: { latest: { after: "nowhere", framing: "x" } },
		}).success,
	).toBe(false);
	expect(
		EntryKindSchema.safeParse({ ...declared, render: () => "code" }).success,
	).toBe(false);
});
