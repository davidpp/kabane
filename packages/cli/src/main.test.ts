import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { loadConfig, saveConfig } from "./config";
import { run } from "./main";
import { describeVersion } from "./version";

describe("run", () => {
	it("prints the package version and, from a checkout, its commit", async () => {
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
			cwd: import.meta.dir,
		});
		const commit = head.stdout.toString().trim();
		for (const flag of ["--version", "-v"]) {
			const outcome = await run([flag], {}, "/");
			expect(outcome.exitCode).toBe(0);
			expect(outcome.json).toMatchObject({
				version,
				source: { commit: commit.slice(0, 7) },
			});
			expect(outcome.text).toStartWith(`${version} (source: `);
			expect(outcome.text).toContain(`@${commit.slice(0, 7)}`);
		}
	});

	it("prints the bare package version outside a git checkout", () => {
		expect(describeVersion(tmpdir())).toEqual({ version, text: version });
	});
});

describe("run, resolving a command name", () => {
	const home = join(tmpdir(), `kabane-main-${crypto.randomUUID()}`);
	const cwd = join(home, "project");
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	const setExtensions = (extensions: string[]): void => {
		const config = loadConfig(home);
		if (!config.ok) throw config.error;
		expect(saveConfig(home, { ...config.value, extensions }).ok).toBe(true);
	};

	beforeAll(async () => {
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(home, "extensions"));
		symlinkSync(
			join(import.meta.dir, "../../../extensions/loop"),
			join(home, "extensions/loop"),
		);
		const init = await run(
			["init", "--actor", "cabane://actor/human/t", "--device", "t"],
			env,
			cwd,
		);
		expect(init.exitCode).toBe(0);
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	it("is a usage error when nothing owns the name", async () => {
		const outcome = await run(["frobnicate"], env, cwd);
		expect(outcome.exitCode).toBe(2);
		expect(outcome.text).toContain("Unknown command: frobnicate");
	});

	it("says which extension to turn on for an off extension's command", async () => {
		setExtensions([]);
		const outcome = await run(["loop"], env, cwd);
		expect(outcome.exitCode).toBe(2);
		expect(outcome.text).toContain(`installed extensions not enabled: loop`);
	});

	// Its own process, so the module registry holds only what one command loaded: a built-in
	// resolves before any extension is looked at, so it wins any name and imports none of them.
	it("keeps built-ins and help free of the TUI and extensions, loading an extension for its command", async () => {
		setExtensions(["loop"]);
		const main = join(import.meta.dir, "main.ts");
		const loaded = async (argv: string[]): Promise<unknown> => {
			const script = `
				const { run } = await import(${JSON.stringify(main)});
				const outcome = await run(${JSON.stringify(argv)}, ${JSON.stringify(env)}, ${JSON.stringify(cwd)});
				const loop = Object.keys(require.cache).some((path) => path.includes("/extensions/loop/"));
				const tui = Object.keys(require.cache).filter((path) => (path.includes("/node_modules/@opentui/") || path.includes("/node_modules/react/")) || path.endsWith("/packages/board/index.ts"));
				console.log(JSON.stringify({ exitCode: outcome.exitCode, loop, tui }));
			`;
			const proc = Bun.spawn(["bun", "-e", script], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = await new Response(proc.stdout).text();
			await proc.exited;
			return JSON.parse(out.trim().split("\n").at(-1) ?? "null");
		};
		for (const argv of [
			["list", "--format", "concise"],
			["--version"],
			["board", "--help"],
			["open", "--help"],
			["mcp", "--help"],
		]) {
			expect(await loaded(argv)).toEqual({ exitCode: 0, loop: false, tui: [] });
		}
		expect(await loaded(["loop", "--help"])).toMatchObject({
			exitCode: 0,
			loop: true,
		});
	});
});

describe("directory commands through the real CLI", () => {
	const home = join(tmpdir(), `kabane-main-directory-${crypto.randomUUID()}`);
	beforeAll(() => {
		mkdirSync(join(home, "extensions"), { recursive: true });
		symlinkSync(
			join(import.meta.dir, "../../../extensions/loop"),
			join(home, "extensions/loop"),
		);
	});
	afterAll(() => rmSync(home, { recursive: true, force: true }));
	const invoke = async (...args: string[]) => {
		const proc = Bun.spawn(
			[process.execPath, join(import.meta.dir, "../index.ts"), ...args],
			{
				env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { out, err, code };
	};
	const install = (name: string, commands: string[]) => {
		const dir = join(home, "extensions", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ kabane: { extension: "./index.ts", api: 1 } }),
		);
		writeFileSync(
			join(dir, "index.ts"),
			`export default () => ({name:${JSON.stringify(name)},commands:[${commands.map((command) => `{name:${JSON.stringify(command)},usage:"usage",summary:"from ${name}",standalone:true,run:async()=>({exitCode:0,json:null,text:"${name}"})}`).join(",")}]});`,
		);
	};
	it("names the enabling command and init before a config exists", async () => {
		const result = await invoke("loop");
		expect(result.code).toBe(2);
		expect(result.err).toContain("Run `kabane init` first");
		expect(result.err).toContain(
			"kabane config set extensions <names> --layer global",
		);
	});
	it("refuses built-in and shared names, keeps other commands, and reports once on stderr", async () => {
		install("one", ["list", "shared", "first"]);
		install("two", ["shared", "second"]);
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				actor: "test",
				deviceId: "test",
				extensions: ["one", "two"],
			}),
		);
		const help = await invoke("--help");
		expect(help.code).toBe(0);
		expect(help.out.match(/^  list\s/gm)).toHaveLength(1);
		expect(help.out).not.toMatch(/^  shared\s/m);
		expect(help.out).toContain("first");
		expect(help.out).toContain("second");
		expect(help.out).not.toContain("Extension one:");
		expect(help.err.trim().split("\n")).toHaveLength(3);
		expect((await invoke("first")).out.trim()).toBe("one");
		expect((await invoke("second")).out.trim()).toBe("two");
		expect((await invoke("shared")).code).toBe(2);
		expect((await invoke("list", "--help")).code).toBe(0);
	});
});
