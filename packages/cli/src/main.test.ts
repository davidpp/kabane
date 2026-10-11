import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { configPath, loadConfig, saveConfig } from "./config";
import { run } from "./main";

describe("run", () => {
	it("prints the package version for --version and -v", async () => {
		for (const flag of ["--version", "-v"]) {
			const outcome = await run([flag], {}, "/");
			expect(outcome).toEqual({
				exitCode: 0,
				json: { version },
				text: version,
			});
		}
	});
});

describe("run, resolving a command name", () => {
	const home = join(tmpdir(), `kabane-main-${crypto.randomUUID()}`);
	const cwd = join(home, "project");
	const env = { KABANE_HOME: home };
	const setExtensions = (extensions: string[]): void => {
		const config = loadConfig(home);
		if (!config.ok) throw config.error;
		expect(saveConfig(home, { ...config.value, extensions }).ok).toBe(true);
	};

	beforeAll(async () => {
		mkdirSync(cwd, { recursive: true });
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
		expect(outcome.exitCode).toBe(1);
		expect(outcome.text).toContain(
			`comes with the loop extension, which is off; add "loop" to "extensions" in ${configPath(home)}`,
		);
	});

	// Its own process, so the module registry holds only what one command loaded: a built-in
	// resolves before any extension is looked at, so it wins any name and imports none of them.
	it("runs a built-in without importing an enabled extension, which its own command does", async () => {
		setExtensions(["loop"]);
		const main = join(import.meta.dir, "main.ts");
		const loaded = async (argv: string[]): Promise<unknown> => {
			const script = `
				const { run } = await import(${JSON.stringify(main)});
				const outcome = await run(${JSON.stringify(argv)}, ${JSON.stringify(env)}, ${JSON.stringify(cwd)});
				const loop = Object.keys(require.cache).some((path) => path.includes("/extensions/loop/"));
				console.log(JSON.stringify({ exitCode: outcome.exitCode, loop }));
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
		expect(await loaded(["list"])).toEqual({ exitCode: 0, loop: false });
		expect(await loaded(["loop", "--help"])).toEqual({
			exitCode: 0,
			loop: true,
		});
	});
});
