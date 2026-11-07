/** @jsxImportSource @opentui/react */
/**
 * The board wiring, headless: seed a KABANE_HOME the way the commands do,
 * hand `boardDeps` to the board's App, and read the task back off a frame.
 * `startBoard` itself needs a TTY (it owns a CliRenderer), so the render goes
 * through OpenTUI's test renderer instead; the deps are the same object.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, noActivity } from "@cabane/board";
import { Planner, type Task } from "@cabane/core";
import { parseArgs } from "@cabane/extension";
import { loop } from "@cabane/loop";
import { testRender } from "@opentui/react/test-utils";
import {
	type BoardWiring,
	boardDeps,
	boardIssue,
	copilotHarness,
} from "./src/commands/board-runtime";
import { saveConfig } from "./src/config";
import { type Ctx, openContext, resolveScope } from "./src/context";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

describe("kabane board", () => {
	const home = join(tmpdir(), `cabane-board-${crypto.randomUUID()}`);
	const cwd = join(home, "project");
	let ctx: Ctx;

	beforeAll(async () => {
		mkdirSync(join(cwd, ".kabane"), { recursive: true });
		writeFileSync(join(cwd, ".kabane", "scope"), "demo\n");
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

	it("awaits the loop's board ports before merging them", async () => {
		const deps = await boardDeps(parseArgs([]), ctx, "claude", {
			extensions: [loop],
		});
		try {
			expect(deps.activity).toBeDefined();
			expect(deps.dispatcher).toBeDefined();
			expect(deps.headers?.loops).toBeFunction();
		} finally {
			deps.copilot.close();
		}
	});

	it("scopes the board the way list does", async () => {
		const deps = await boardDeps(parseArgs([]), ctx, "claude");
		expect(deps.basePath).toBe(home);
		expect(deps.cwd).toBe(cwd);
		// The pin resolves to a canonical URI, and the board labels it with the
		// scope's friendly name rather than the raw URI.
		expect(await deps.resolveScope?.(cwd)).toEqual({
			scopeUri: "jake://scope/demo",
			label: "demo",
		});

		const explicit = await boardDeps(
			parseArgs(["--scope", "other"]),
			ctx,
			"claude",
		);
		expect(await explicit.resolveScope?.(cwd)).toEqual({
			scopeUri: "other",
			label: "other",
		});
	});

	// The board only wants a URI and a label; the copilot also needs the project
	// directory, since that is the cwd its harness reads the repo's rules from.
	it("carries the project root for the copilot's cwd, but not for a --scope URI", async () => {
		expect(await resolveScope(parseArgs([]), ctx)).toEqual({
			scopeUri: "jake://scope/demo",
			label: "demo",
			root: realpathSync(cwd),
		});
		// A URI on the command line says where to file, not where the project is.
		expect(await resolveScope(parseArgs(["--scope", "other"]), ctx)).toEqual({
			scopeUri: "other",
			label: "other",
		});
	});

	// The copilot is the one dep the CLI builds rather than defaults away, and it
	// has to be there with no `copilot` block in the config at all.
	it("gives the board a copilot with no config for it", async () => {
		expect(copilotHarness(parseArgs([]), ctx)).toEqual({
			ok: true,
			value: "claude",
		});

		const deps = await boardDeps(parseArgs([]), ctx, "claude");
		expect(deps.copilot.shortcuts().length).toBeGreaterThan(0);
		// Creating it starts no process: `close` on an unused copilot is a no-op.
		expect(() => deps.copilot.close()).not.toThrow();
	});

	it("takes the harness from the flag, then the config, then Claude", () => {
		const configured: Ctx = {
			...ctx,
			config: { ...ctx.config, copilot: { harness: "codex" } },
		};
		expect(copilotHarness(parseArgs([]), configured)).toEqual({
			ok: true,
			value: "codex",
		});
		expect(
			copilotHarness(parseArgs(["--copilot", "gemini"]), configured),
		).toEqual({ ok: true, value: "gemini" });

		const unknown = copilotHarness(parseArgs(["--copilot", "hermes"]), ctx);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok)
			expect(unknown.error.message).toBe(
				'Unknown copilot harness "hermes"; one of claude, codex, gemini',
			);
		const stored = copilotHarness(parseArgs([]), {
			...ctx,
			config: { ...ctx.config, copilot: { harness: "hermes" } },
		});
		expect(stored.ok).toBe(false);
		if (!stored.ok)
			expect(stored.error.message).toContain(
				"kabane config unset copilot.harness",
			);
	});

	// The pin lives at the project root; a command run from a package below it
	// has to land on the same scope, not fall out of the project entirely.
	it("finds the pin from a nested directory", async () => {
		const nested = join(cwd, "packages", "core");
		mkdirSync(nested, { recursive: true });
		const opened = await openContext(home, nested, parseArgs([]));
		if (!opened.ok) throw opened.error;

		const deps = await boardDeps(parseArgs([]), opened.value, "claude");
		expect(await deps.resolveScope?.(nested)).toMatchObject({
			scopeUri: "jake://scope/demo",
			label: "demo",
		});
	});

	it("renders this device's tasks with the no-op ports", async () => {
		const deps = await boardDeps(parseArgs([]), ctx, "claude");
		const setup = await testRender(
			<App
				cwd={deps.cwd}
				basePath={deps.basePath}
				activity={deps.activity ?? noActivity}
				dispatcher={deps.dispatcher}
				copilot={deps.copilot}
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
			// Header shows the CLI's scope; the footer carries the board's everyday keys and
			// `? help`. `a` is on the `?` sheet, not the footer: with the no-op dispatcher it
			// only flashes that there is none.
			expect(frame).toContain("kabane · demo");
			expect(frame).toContain("/ search · d done");
			expect(frame).toContain("? help");
			expect(frame).not.toContain("a dispatch");
		} finally {
			setup.renderer.destroy();
			deps.copilot.close();
		}
	});

	// `--issue` lands on the issue: its own scope unless `--scope` says otherwise, and its
	// detail over the board, the done one and the subtask included.
	describe("--issue", () => {
		const add = async (
			input: Parameters<typeof Planner.addTask>[1],
		): Promise<Task> => {
			const added = await Planner.addTask(home, input);
			if (!added.ok) throw added.error;
			return added.value;
		};
		const issue = async (args: string[]): Promise<Task> => {
			const found = await boardIssue(parseArgs(args), ctx);
			if (!found.ok) throw found.error;
			if (!found.value) throw new Error("no issue");
			return found.value;
		};
		// The frame once it shows `text`, or the last one tried.
		const frameWith = async (deps: BoardWiring, text: string) => {
			const setup = await testRender(
				<App
					cwd={deps.cwd}
					basePath={deps.basePath}
					activity={deps.activity ?? noActivity}
					resolveScope={deps.resolveScope}
					open={deps.open}
				/>,
				{ width: 100, height: 30 },
			);
			try {
				let frame = "";
				for (let pass = 0; pass < 50; pass++) {
					await setup.renderOnce();
					frame = setup.captureCharFrame();
					if (frame.includes(text)) break;
					await sleep(20);
				}
				return frame;
			} finally {
				setup.renderer.destroy();
			}
		};

		it("resolves a short id or a ULID, and fails in one line on an unknown one", async () => {
			const elsewhere = await add({
				title: "Filed in another scope",
				kind: "issue",
				state: "next",
				scopeUri: "jake://scope/elsewhere",
			});
			expect((await issue(["--issue", elsewhere.id])).id).toBe(elsewhere.id);
			const short = elsewhere.shortId ?? "";
			expect((await issue(["--issue", short.toLowerCase()])).id).toBe(
				elsewhere.id,
			);
			expect(await boardIssue(parseArgs([]), ctx)).toEqual({
				ok: true,
				value: undefined,
			});
			for (const args of [
				["--issue", "NOPE-404"],
				["--issue", "01H000000000000000000000ZZ"],
			]) {
				const unknown = await boardIssue(parseArgs(args), ctx);
				expect(unknown.ok).toBe(false);
				if (!unknown.ok)
					expect(unknown.error.message).toMatch(/^No task found with ID: /);
			}
			const bare = await boardIssue(parseArgs(["--issue"]), ctx);
			expect(bare.ok).toBe(false);
		});

		it("opens on the issue's own scope unless --scope says otherwise", async () => {
			const elsewhere = await add({
				title: "Scoped elsewhere",
				kind: "issue",
				state: "next",
				scopeUri: "jake://scope/elsewhere",
			});
			const deps = await boardDeps(parseArgs([]), ctx, "claude", {
				issue: elsewhere,
			});
			deps.copilot.close();
			expect(deps.open).toEqual({ taskId: elsewhere.id });
			expect(await deps.resolveScope?.(cwd)).toEqual({
				scopeUri: "jake://scope/elsewhere",
				label: "jake://scope/elsewhere",
			});

			const local = await add({
				title: "Scoped here",
				kind: "issue",
				state: "next",
				scopeUri: "jake://scope/demo",
			});
			const here = await boardDeps(parseArgs([]), ctx, "claude", {
				issue: local,
			});
			here.copilot.close();
			expect(await here.resolveScope?.(cwd)).toEqual({
				scopeUri: "jake://scope/demo",
				label: "demo",
			});

			const unscoped = await add({
				title: "No scope at all",
				kind: "issue",
				state: "next",
			});
			const all = await boardDeps(parseArgs([]), ctx, "claude", {
				issue: unscoped,
			});
			all.copilot.close();
			expect(await all.resolveScope?.(cwd)).toBeNull();

			const pinned = await boardDeps(
				parseArgs(["--scope", "other"]),
				ctx,
				"claude",
				{ issue: elsewhere },
			);
			pinned.copilot.close();
			expect(await pinned.resolveScope?.(cwd)).toEqual({
				scopeUri: "other",
				label: "other",
			});
		});

		it("draws the detail of a done issue and of a subtask", async () => {
			const done = await add({
				title: "Shipped last week",
				kind: "issue",
				state: "done",
				scopeUri: "jake://scope/demo",
			});
			const parent = await add({
				title: "The parent issue",
				kind: "issue",
				state: "in_progress",
				scopeUri: "jake://scope/demo",
			});
			const child = await add({
				title: "A subtask of it",
				kind: "issue",
				state: "next",
				scopeUri: "jake://scope/demo",
				parentTaskId: parent.id,
			});
			for (const target of [done, child]) {
				const deps = await boardDeps(parseArgs([]), ctx, "claude", {
					issue: target,
				});
				deps.copilot.close();
				const header = `${target.shortId} · ${target.title}`;
				expect(await frameWith(deps, header)).toContain(header);
			}
		});
	});
});
