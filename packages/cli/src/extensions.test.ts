import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { configPath } from "./config";
import { ConfigSettings } from "./config-settings";
import { Extensions } from "./extensions";
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
	it("is every shipped extension's settings, enabled or not", async () => {
		const found = await Extensions.namespaces(makeHome());
		expect(found.ok && found.value.map((n) => n.name)).toEqual(["loop"]);
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

it("loads real directories and isolates import, API, factory name, and modules refusals before commands run", async () => {
	const home = makeHome({
		extensions: ["hello", "broken", "future", "wrong", "modules"],
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
	install(home, "modules", never, {
		extension: "./index.ts",
		api: 1,
		modules: "./modules.ts",
	});
	install(home, "wrong", 'export default () => ({name: "other"});');
	const all = await Extensions.loadAll(
		["hello", "broken", "future", "wrong", "modules"],
		home,
	);
	expect(all.loaded.map((e) => e.name)).toEqual(["hello"]);
	expect(all.refused.map((e) => e.name)).toEqual([
		"broken",
		"future",
		"wrong",
		"modules",
	]);
	expect(all.refused[1]?.reason).toContain("API 2; this kabane supports API 1");
	expect(all.refused[3]?.reason).toContain("does not load data modules yet");
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
	expect(all.refused[1]?.reason).toContain("the factory failed; repair");
	expect(all.refused[3]?.reason).toContain(join(home, "extensions/missing"));
});

it("discovers symlinks and directory settings only when enabled, preserving bundled defaults", async () => {
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
	const bundled = await Extensions.namespaces(home);
	expect(bundled.ok && bundled.value.map((n) => n.name)).toEqual(["loop"]);
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

it("an enabled directory wins over the bundled extension", async () => {
	const home = makeHome({ extensions: ["loop"] });
	install(home, "loop", 'export default () => ({name: "loop", commands: []});');
	const stderr = spyOn(console, "error").mockImplementation(() => {});
	try {
		const all = await Extensions.loadAll(["loop"], home);
		expect(all.refused).toEqual([]);
		expect(all.loaded[0]?.commands).toEqual([]);
		expect(stderr.mock.calls).toEqual([
			[
				`Extension loop: directory ${join(home, "extensions/loop")}/ overrides bundled loop`,
			],
		]);
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
		'needs "kabane": { "extension": "<entry>", "api": 1 }',
	);
	expect(all.refused[3]?.reason).toContain(
		"the entry's default export must be a factory (host) => Extension",
	);
	for (const { reason } of all.refused)
		expect(reason).toEndWith(Extensions.disabledAdvice);
});
