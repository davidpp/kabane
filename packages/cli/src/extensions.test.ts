import { afterAll, describe, expect, it, spyOn } from "bun:test";
import {
	cpSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "@cabane/extension";
import { z } from "zod";
import { configPath } from "./config";
import { ConfigSettings } from "./config-settings";
import { openContext } from "./context";
import { CopilotFiles } from "./copilot-files";
import { Extensions } from "./extensions";
import { hostFor } from "./host";
import { run } from "./main";

const homes: string[] = [];
const makeHome = (config?: Record<string, unknown>): string => {
	const home = join(tmpdir(), `kabane-extensions-${crypto.randomUUID()}`);
	homes.push(home);
	mkdirSync(home, { recursive: true });
	if (config)
		writeFileSync(
			configPath(home),
			JSON.stringify({
				actor: "cabane://actor/human/t",
				deviceId: "t",
				...config,
			}),
		);
	return home;
};

const installLoop = (home: string): void => {
	mkdirSync(join(home, "extensions"), { recursive: true });
	symlinkSync(
		join(import.meta.dir, "../../../extensions/loop"),
		join(home, "extensions/loop"),
	);
};

afterAll(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("Extensions.enabled", () => {
	it("retains configured names without inspecting or importing them", () => {
		const home = makeHome({ extensions: ["loop", "lop", "loop"] });
		expect(Extensions.enabled(home)).toEqual({
			ok: true,
			value: ["loop", "lop"],
		});
	});
});

describe("Extensions.namespaces", () => {
	it("has no settings without enabled directory extensions", async () => {
		const found = await Extensions.namespaces(makeHome());
		expect(found.ok && found.value.map((n) => n.name)).toEqual([]);
	});

	it("refuses a namespace that would take a device key or the scopes block", () => {
		const settings = z.object({}).strict();
		for (const name of ["sync", "db", "actor", "deviceId", "scopes"]) {
			const refused = Extensions.namespacesOf([{ name, settings }]);
			expect(!refused.ok && refused.error.message).toContain(
				`would take the device config key "${name}"`,
			);
		}
	});

	it("refuses a schema an empty layer does not satisfy", () => {
		const refused = Extensions.namespacesOf([
			{ name: "strict", settings: z.object({ needed: z.string() }) },
		]);
		expect(!refused.ok && refused.error.message).toContain(
			"need a default or optional for every key",
		);
	});
});

// A fresh process keeps earlier board tests from hiding an eager TUI import.
describe("extension board imports", () => {
	for (const argv of [
		["help"],
		[],
		["loop", "status"],
		["config", "get", "actor"],
		["unknown-command"],
	]) {
		it(`keeps OpenTUI out of ${argv.join(" ") || "bare non-TTY kabane"}`, async () => {
			const home = makeHome({ extensions: ["loop"] });
			installLoop(home);
			const source = `
				import { run } from ${JSON.stringify(join(import.meta.dir, "main.ts"))};
				const outcome = await run(${JSON.stringify(argv)});
				console.log(JSON.stringify({
					code: outcome.exitCode,
					opentui: Object.keys(require.cache).filter(path => path.includes("@opentui")),
				}));
			`;
			const proc = Bun.spawn([process.execPath, "-e", source], {
				cwd: home,
				env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, code] = await Promise.all([
				new Response(proc.stdout).text(),
				proc.exited,
			]);
			expect(code).toBe(0);
			expect(JSON.parse(out)).toEqual({
				code: argv.length === 0 || argv[0] === "unknown-command" ? 2 : 0,
				opentui: [],
			});
		});
	}
});

const install = (
	home: string,
	name: string,
	source: string,
	manifest: object = { extension: "./index.ts", api: 1 },
) => {
	const dir = join(home, "extensions", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ kabane: manifest }),
	);
	writeFileSync(join(dir, "index.ts"), source);
	return dir;
};

it("loads real directories and isolates import, API and factory name refusals before commands run", async () => {
	const home = makeHome({
		extensions: ["hello", "broken", "future", "wrong"],
	});
	const dir = install(
		home,
		"hello",
		`import { greeting } from "greeting";
 export default host => ({name: "hello", commands: [{name: "hello", summary: "Say hello", usage: "hello", standalone: true, run: async () => ({exitCode: 0, text: greeting, json: host})}]});`,
	);
	mkdirSync(join(dir, "node_modules/greeting"), { recursive: true });
	writeFileSync(
		join(dir, "node_modules/greeting/package.json"),
		JSON.stringify({ name: "greeting", main: "index.js" }),
	);
	writeFileSync(
		join(dir, "node_modules/greeting/index.js"),
		'export const greeting = "hello from dependency";',
	);
	install(home, "broken", 'throw new Error("broken import");');
	const never = `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(join(home, "ran"))}, "bad"); export default () => ({name: "future"});`;
	install(home, "future", never, { extension: "./index.ts", api: 2 });
	install(home, "wrong", 'export default () => ({name: "other"});');
	const all = await Extensions.loadAll(
		["hello", "broken", "future", "wrong"],
		home,
	);
	expect(all.loaded.map((e) => e.name)).toEqual(["hello"]);
	expect(all.refused.map((e) => e.name)).toEqual(["broken", "future", "wrong"]);
	expect(all.refused[1]?.reason).toContain("API 2; this kabane supports API 1");
	expect(all.directories).toEqual([
		{ name: "hello", directory: realpathSync(dir) },
	]);
	expect(await Bun.file(join(home, "ran")).exists()).toBe(false);
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	expect((await run(["--help"], env, home)).text).toContain("Say hello");
	const hello = await run(["hello"], env, home);
	expect(hello.text).toBe("hello from dependency");
	expect(hello.json).toMatchObject({
		api: 1,
		kabane: { version: expect.any(String), executable: expect.any(String) },
	});
});

it("does not import disabled code or load extensions on the core command path", async () => {
	const home = makeHome({ extensions: ["broken"] });
	install(
		home,
		"disabled",
		`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(join(home, "ran"))}, "bad");`,
	);
	install(home, "broken", 'throw new Error("must not run for list help");');
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	expect((await run(["list", "--help"], env, home)).exitCode).toBe(0);
	const unknown = await run(["unknown"], env, home);
	expect(unknown.exitCode).toBe(2);
	expect(unknown.text).toContain("disabled");
	expect(await Bun.file(join(home, "ran")).exists()).toBe(false);
});

it("contains a command rejection and invalid manifests, factories, and traversal names", async () => {
	const home = makeHome({ extensions: ["throws"] });
	install(
		home,
		"throws",
		`export default () => ({name: "throws", commands: [{name: "throws", usage: "throws", summary: "Throw", standalone: true, run: async () => {throw new Error("command failed");}}]});`,
	);
	expect((await run(["throws"], { KABANE_HOME: home }, home)).text).toContain(
		"Extension throws: command failed",
	);
	install(home, "invalid", "", { api: 1 });
	install(
		home,
		"factory",
		'export default () => {throw new Error("factory failed");};',
	);
	const all = await Extensions.loadAll(
		["invalid", "factory", "../outside", "missing"],
		home,
	);
	expect(all.loaded).toEqual([]);
	expect(all.refused).toHaveLength(4);
	expect(all.refused[1]?.reason).toContain(
		"the factory failed: factory failed; repair",
	);
	expect(all.refused[3]?.reason).toContain(join(home, "extensions/missing"));
});

it("discovers symlinks and directory settings only when enabled", async () => {
	const home = makeHome({ extensions: [] });
	const target = install(
		home,
		"actual",
		`import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))}; export default () => ({name: "linked", settings: z.object({word: z.string().default("hello")})});`,
	);
	symlinkSync(target, join(home, "extensions/linked"));
	install(home, "loop", 'throw new Error("disabled shadow must not run");');
	expect(Extensions.available(home)).toContain("linked");
	const disabled = await ConfigSettings.get(home, {}, "linked.word");
	expect(disabled.ok).toBe(false);
	if (disabled.ok) throw new Error("Expected disabled settings refusal");
	expect(disabled.error.message).toContain("unknown until it is enabled");
	const disabledNamespaces = await Extensions.namespaces(home);
	expect(disabledNamespaces.ok && disabledNamespaces.value).toEqual([]);
	const enabled = await ConfigSettings.set(
		home,
		{},
		"extensions",
		"linked",
		"global",
	);
	expect(enabled.ok).toBe(true);
	const word = await ConfigSettings.get(home, {}, "linked.word");
	expect(word.ok && word.value.value).toBe("hello");
	const options = await ConfigSettings.get(home, {}, "extensions");
	expect(options.ok && options.value.options).toContain("linked");
});

it("an installed extension's description comes from its package.json, read without importing it", async () => {
	const home = makeHome();
	install(
		home,
		"described",
		`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(join(home, "ran"))}, "bad"); export default () => ({name: "described"});`,
	);
	const dir = join(home, "extensions", "described");
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			description: "  Keeps notes\n beside issues. ",
			kabane: { extension: "./index.ts", api: 1 },
		}),
	);
	install(home, "plain", 'export default () => ({name: "plain"});');
	expect(await Extensions.description(home, "described")).toBe(
		"Keeps notes beside issues.",
	);
	expect(await Extensions.description(home, "plain")).toBeUndefined();
	expect(await Extensions.description(home, "absent")).toBeUndefined();
	expect(await Bun.file(join(home, "ran")).exists()).toBe(false);
	const loop = await Bun.file(
		join(import.meta.dir, "../../../extensions/loop/package.json"),
	).json();
	expect(await Extensions.description(home, "loop")).toBeUndefined();
	installLoop(home);
	expect(await Extensions.description(home, "loop")).toBe(loop.description);
	expect(loop.description).toContain("`a` on an issue opens its run form");
});

it("refuses an enabled loop without a directory and keeps other commands usable", async () => {
	const home = makeHome({ extensions: ["loop"] });
	const all = await Extensions.loadAll(["loop"], home);
	expect(all.loaded).toEqual([]);
	expect(all.directories).toEqual([]);
	expect(all.refused).toEqual([Extensions.missing("loop", home)]);
	expect(Extensions.available(home)).toEqual([]);
	const help = await run(
		["--help"],
		{ KABANE_HOME: home, KABANE_HARNESSES: "" },
		home,
	);
	expect(help.exitCode).toBe(0);
	expect(help.text).not.toMatch(/^\s+loop\s/m);
});

it("loads the real loop directory with its per-home host and copilot files", async () => {
	const home = makeHome({ extensions: ["loop"] });
	installLoop(home);
	const staged = hostFor(home, "loop");
	const other = hostFor(makeHome(), "loop");
	const all = await Extensions.loadAll(["loop"], home);
	expect(all.refused).toEqual([]);
	expect(all.loaded.map((extension) => extension.name)).toEqual(["loop"]);
	expect(all.directories).toEqual([
		{ name: "loop", directory: realpathSync(join(home, "extensions/loop")) },
	]);
	const copilot = CopilotFiles.read(all.directories);
	expect(copilot.refused).toEqual([]);
	expect(
		copilot.procedures
			.flatMap((entry) => entry.procedures)
			.map((procedure) => procedure.title),
	).toEqual(["SETTING UP A LOOP RUN", "STARTING A LOOP RUN"]);
	const disabled = await Extensions.loadAll([], home);
	expect(CopilotFiles.read(disabled.directories).procedures).toEqual([]);
	expect((await staged.host.record.list({})).ok).toBe(false);
	const context = await openContext(home, home, parseArgs([]));
	if (!context.ok) throw context.error;
	expect((await staged.host.record.list({})).ok).toBe(true);
	expect((await other.host.record.list({})).ok).toBe(false);
	const help = await run(
		["loop", "--help"],
		{ KABANE_HOME: home, KABANE_HARNESSES: "" },
		home,
	);
	expect(help.exitCode).toBe(0);
	expect(help.text).toContain("loop start");
});

it("a directory named loop has no special precedence or warning", async () => {
	const home = makeHome({ extensions: ["loop"] });
	install(home, "loop", 'export default () => ({name: "loop", commands: []});');
	const stderr = spyOn(console, "error").mockImplementation(() => {});
	try {
		const all = await Extensions.loadAll(["loop"], home);
		expect(all.refused).toEqual([]);
		expect(all.loaded[0]?.commands).toEqual([]);
		expect(stderr.mock.calls).toEqual([]);
	} finally {
		stderr.mockRestore();
	}
});

it("reports an enabled missing extension once even when config discovery and a write both name it", async () => {
	const home = makeHome({ extensions: ["missing"] });
	const stderr = spyOn(console, "error").mockImplementation(() => {});
	try {
		const result = await run(
			["config", "set", "extensions", "missing", "--layer", "global"],
			{ KABANE_HOME: home, KABANE_HARNESSES: "" },
			home,
		);
		expect(result.exitCode).toBe(0);
		expect(stderr).toHaveBeenCalledTimes(1);
		expect(stderr.mock.calls[0]?.[0]).toBe(
			Extensions.line(Extensions.missing("missing", home)),
		);
	} finally {
		stderr.mockRestore();
	}
});

for (const [name, fields] of [
	["badshape", 'commands: "nope"'],
	["badname", "commands: [{name: 42}]"],
	["badsettings", "settings: {}"],
	["badlooks", "looks: {word: {label: 42}}"],
	["badboard", "board: {}"],
	["badmcp", "mcp: []"],
	["baddoctor", "doctor: true"],
] as const) {
	it(`refuses malformed factory fields for ${name} before help and dispatch`, async () => {
		const home = makeHome({ extensions: [name] });
		install(home, name, `export default () => ({name: "${name}", ${fields}});`);
		const all = await Extensions.loadAll([name], home);
		expect(all.loaded).toEqual([]);
		expect(all.refused[0]?.reason).toContain(
			"the factory returned an invalid Extension",
		);
		const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
		expect((await run(["--help"], env, home)).exitCode).toBe(0);
		expect((await run(["unknown"], env, home)).exitCode).toBe(2);
	});
}

for (const mode of ["relative", "absolute", "symlink"]) {
	it(`refuses a ${mode} entry escape before importing it`, async () => {
		const home = makeHome();
		const outside = join(home, "outside.ts");
		const marker = join(home, "outside-ran");
		writeFileSync(
			outside,
			`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); export default () => ({name: "escape"});`,
		);
		const dir = install(home, "escape", "", {
			extension:
				mode === "absolute"
					? outside
					: mode === "relative"
						? "../../outside.ts"
						: "./index.ts",
			api: 1,
		});
		if (mode === "symlink") {
			rmSync(join(dir, "index.ts"));
			symlinkSync(outside, join(dir, "index.ts"));
		}
		const all = await Extensions.loadAll(["escape"], home);
		expect(all.loaded).toEqual([]);
		expect(all.refused[0]?.reason).toContain(
			"entry outside its extension directory",
		);
		expect(await Bun.file(marker).exists()).toBe(false);
	});
}

it("names malformed or missing manifests and a non-factory export with repair and disable advice", async () => {
	const home = makeHome();
	const missing = install(home, "missingfile", "");
	rmSync(join(missing, "package.json"));
	const invalid = install(home, "json", "");
	writeFileSync(join(invalid, "package.json"), "{");
	install(home, "manifest", "", {});
	install(home, "notfactory", "export default {}; ");
	const all = await Extensions.loadAll(
		["missingfile", "json", "manifest", "notfactory"],
		home,
	);
	expect(all.loaded).toEqual([]);
	expect(all.refused[0]?.reason).toContain(
		`${join(missing, "package.json")} is missing`,
	);
	expect(all.refused[1]?.reason).toContain(
		`${join(invalid, "package.json")} contains invalid JSON`,
	);
	expect(all.refused[2]?.reason).toContain(
		'has no valid "kabane" field; add "kabane": { "extension": "<entry>", "api": 1 }',
	);
	expect(all.refused[3]?.reason).toContain(
		"the entry's default export must be a factory (host) => Extension",
	);
	for (const { reason } of all.refused)
		expect(reason).toEndWith(Extensions.disabledAdvice);
});

it("keeps unlisted extension fields after validation", async () => {
	const home = makeHome();
	install(
		home,
		"futurefield",
		'export default () => ({name:"futurefield", futureField:{kept:true}});',
	);
	const all = await Extensions.loadAll(["futurefield"], home);
	expect(all.loaded[0]).toMatchObject({ futureField: { kept: true } });
});

it("reports the first invalid field and a real foreign zod schema", async () => {
	const home = makeHome();
	install(
		home,
		"shape",
		'export default () => ({name:"shape", commands:"nope"});',
	);
	const dir = install(
		home,
		"ownzod",
		'import {z} from "zod"; export default () => ({name:"ownzod", settings:z.object({})});',
	);
	cpSync(
		dirname(Bun.resolveSync("zod/package.json", import.meta.dir)),
		join(dir, "node_modules/zod"),
		{ recursive: true },
	);
	const all = await Extensions.loadAll(["shape", "ownzod"], home);
	expect(all.refused.map(({ reason }) => reason)).toEqual([
		`the factory returned an invalid Extension: commands must be an array; ${Extensions.disabledAdvice}`,
		`the factory returned an invalid Extension: settings must be built with host.z; ${Extensions.disabledAdvice}`,
	]);
});

it("keeps bounded first-line causes without engine call annotations", async () => {
	const home = makeHome();
	install(home, "broken", 'throw new Error("boom on import\\nsecond line");');
	install(home, "missingdep", 'import "not-there";');
	install(home, "syntax", "export default () => { const = ; };");
	const all = await Extensions.loadAll(
		["broken", "missingdep", "syntax"],
		home,
	);
	expect(all.refused[0]?.reason).toBe(
		`the entry could not be imported: boom on import; repair the entry and its dependencies; ${Extensions.disabledAdvice}`,
	);
	expect(all.refused[1]?.reason).toContain("Cannot find package 'not-there'");
	expect(all.refused[2]?.reason).toMatch(/could not be imported: .+; repair/);
	expect(Extensions.cause(new Error("x".repeat(500)))).toBe(
		`${"x".repeat(199)}…`,
	);
	expect(
		Extensions.cause(new Error("oops (In 'imported.default(host)', noise)")),
	).toBe("oops");
});

it("a directory with its own zod uses host.z for settings and a tool served by kabane mcp", async () => {
	const home = makeHome({ extensions: ["hostzod"] });
	const dir = install(
		home,
		"hostzod",
		`
 import type { Extension, Host } from "kabane/extension";
 import { z as ownZod } from "zod";
 export default (host: Host): Extension => ({
  name: "hostzod",
  settings: host.z.object({ word: host.z.string().default("hello") }),
  mcp: async () => ({ tools: [host.defineTool({
   name: "kabane_hostzod_echo", description: "Echo a word", kind: "read",
   input: { word: host.z.string().min(1) },
   handler: async ({ word }) => host.result.ok({ word, distinct: ownZod !== host.z }),
  })] }),
 });`,
	);
	cpSync(
		dirname(Bun.resolveSync("zod/package.json", import.meta.dir)),
		join(dir, "node_modules/zod"),
		{ recursive: true },
	);
	const loaded = await Extensions.loadAll(["hostzod"], home);
	expect(loaded.refused).toEqual([]);
	expect(loaded.loaded.map((extension) => extension.name)).toEqual(["hostzod"]);
	const config = await run(
		["config", "list"],
		{ KABANE_HOME: home, KABANE_HARNESSES: "" },
		home,
	);
	expect(config.exitCode).toBe(0);
	expect(config.text).toContain("hostzod.word");
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { StdioClientTransport } =
		await import("@modelcontextprotocol/sdk/client/stdio.js");
	const client = new Client({ name: "host-zod-test", version: "1" });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [join(import.meta.dir, "../index.ts"), "mcp"],
		cwd: home,
		env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" },
		stderr: "pipe",
	});
	try {
		await client.connect(transport);
		expect((await client.listTools()).tools).toContainEqual(
			expect.objectContaining({
				name: "kabane_hostzod_echo",
				inputSchema: expect.objectContaining({ required: ["word"] }),
			}),
		);
		const result = await client.callTool({
			name: "kabane_hostzod_echo",
			arguments: { word: "wire" },
		});
		expect(result).toMatchObject({
			content: [
				{
					type: "text",
					text: JSON.stringify({ word: "wire", distinct: true }, null, 2),
				},
			],
		});
		expect(
			await client.callTool({ name: "kabane_hostzod_echo", arguments: {} }),
		).toMatchObject({ isError: true });
	} finally {
		await client.close();
	}
});

for (const openFirst of [false, true]) {
	it(`keeps factory record calls staged with openContext ${openFirst ? "before" : "after"} loading`, async () => {
		const home = makeHome({ extensions: ["stages"] });
		install(
			home,
			"stages",
			`export default async host => {
			const during = await host.record.list({});
			return { name: "stages", doctor: async () => {
				const after = await host.record.list({});
				return host.result.ok([{ id: "stages", severity: "mention", summary: JSON.stringify({ during: during.ok ? "live" : during.error.message, after: after.ok }) }]);
			} };
		}`,
		);
		const open = async () => {
			const ctx = await openContext(home, home, parseArgs([]));
			if (!ctx.ok) throw ctx.error;
			return ctx.value;
		};
		const before = openFirst ? await open() : undefined;
		const all = await Extensions.loadAll(["stages"], home);
		expect(all.refused).toEqual([]);
		const ctx = before ?? (await open());
		const check = all.loaded[0]?.doctor;
		if (!check) throw new Error("Missing doctor check");
		const found = await check(ctx);
		if (!found.ok) throw found.error;
		expect(found.value[0]?.summary).toContain(
			"standalone commands do not open it automatically",
		);
		expect(found.value[0]?.summary).toContain('"after":true');
	});
}

it("gives standalone extension commands the host's cached harness mode", async () => {
	const home = makeHome({ extensions: ["mode"], harness: { mode: "default" } });
	install(
		home,
		"mode",
		`export default host => ({name: "mode", commands: [{name: "mode", summary: "Mode", usage: "mode", standalone: true, run: async (_args, ctx) => host.outcome.success({host: host.harnessMode, context: ctx.harnessMode})}]});`,
	);
	const outcome = await run(
		["mode"],
		{ KABANE_HOME: home, KABANE_HARNESSES: "" },
		home,
	);
	expect(outcome.json).toEqual({ host: "default", context: "default" });
});
