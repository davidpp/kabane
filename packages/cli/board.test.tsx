/** @jsxImportSource @opentui/react */
/**
 * The board wiring, headless: seed a CABANE_HOME the way the commands do,
 * hand `boardDeps` to the board's App, and read the task back off a frame.
 * `startBoard` itself needs a TTY (it owns a CliRenderer), so the render goes
 * through OpenTUI's test renderer instead; the deps are the same object.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, noActivity } from "@cabane/board";
import { Planner } from "@cabane/core";
import { testRender } from "@opentui/react/test-utils";
import { parseArgs } from "./src/args";
import { boardDeps } from "./src/commands/board";
import { saveConfig } from "./src/config";
import { type Ctx, openContext } from "./src/context";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

describe("cabane board", () => {
	const home = join(tmpdir(), `cabane-board-${crypto.randomUUID()}`);
	const cwd = join(home, "project");
	let ctx: Ctx;

	beforeAll(async () => {
		mkdirSync(join(cwd, ".cabane"), { recursive: true });
		writeFileSync(join(cwd, ".cabane", "scope"), "demo\n");
		const saved = saveConfig(home, {
			actor: "cabane://actor/human/tester",
			deviceId: "t1",
			sync: { enabled: false, batchBytes: 262144 },
		});
		if (!saved.ok) throw saved.error;
		const opened = await openContext(home, cwd, parseArgs([]));
		if (!opened.ok) throw opened.error;
		ctx = opened.value;
		const added = await Planner.addTask(home, {
			title: "Render me on the board",
			kind: "issue",
			state: "next",
			scopeUri: "demo",
		});
		if (!added.ok) throw added.error;
	});

	afterAll(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("scopes the board the way list does", async () => {
		const deps = boardDeps(parseArgs([]), ctx);
		expect(deps.basePath).toBe(home);
		expect(deps.cwd).toBe(cwd);
		// The pin resolves to a canonical URI, and the board labels it with the
		// scope's friendly name rather than the raw URI.
		expect(await deps.resolveScope?.(cwd)).toEqual({
			scopeUri: "jake://scope/demo",
			label: "demo",
		});

		const explicit = boardDeps(parseArgs(["--scope", "other"]), ctx);
		expect(await explicit.resolveScope?.(cwd)).toEqual({
			scopeUri: "other",
			label: "other",
		});
	});

	// The pin lives at the project root; a command run from a package below it
	// has to land on the same scope, not fall out of the project entirely.
	it("finds the pin from a nested directory", async () => {
		const nested = join(cwd, "packages", "core");
		mkdirSync(nested, { recursive: true });
		const opened = await openContext(home, nested, parseArgs([]));
		if (!opened.ok) throw opened.error;

		expect(
			await boardDeps(parseArgs([]), opened.value).resolveScope?.(nested),
		).toEqual({ scopeUri: "jake://scope/demo", label: "demo" });
	});

	it("renders this device's tasks with the no-op ports", async () => {
		const deps = boardDeps(parseArgs([]), ctx);
		const setup = await testRender(
			<App
				cwd={deps.cwd}
				basePath={deps.basePath}
				activity={deps.activity ?? noActivity}
				dispatcher={deps.dispatcher}
				resolveScope={deps.resolveScope}
			/>,
			{ width: 100, height: 30 },
		);
		try {
			let frame = "";
			for (let pass = 0; pass < 50; pass++) {
				await setup.renderOnce();
				frame = setup.captureCharFrame();
				if (frame.includes("Render me on the board")) break;
				await sleep(20);
			}
			expect(frame).toContain("Render me on the board");
			// Header shows the CLI's scope; footer still offers `a`, which the
			// no-op dispatcher answers with its flash rather than a picker.
			expect(frame).toContain("cabane · demo");
			expect(frame).toContain("a dispatch");
		} finally {
			setup.renderer.destroy();
		}
	});
});
