import { afterAll, describe, expect, it, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@cabane/core";
import { parseArgs } from "@cabane/extension";
import { configPath } from "../config";
import { openContext } from "../context";
import { boardDeps, listenForRequests } from "./board-runtime";

const HOME = join(tmpdir(), `kabane-board-runtime-${crypto.randomUUID()}`);
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("the board gets the release notice unless updates.check is false", async () => {
	mkdirSync(HOME, { recursive: true });
	writeFileSync(
		configPath(HOME),
		JSON.stringify({ actor: "cabane://actor/human/ada", deviceId: "mbp" }),
	);
	const args = parseArgs([]);
	const ctx = await openContext(HOME, HOME, args);
	if (!ctx.ok) throw ctx.error;
	const wired = await boardDeps(args, ctx.value, "claude");
	wired.copilot.close();
	expect(wired.announcer).toBeDefined();
	const quiet = await boardDeps(
		args,
		{
			...ctx.value,
			config: { ...ctx.value.config, updates: { check: false } },
		},
		"claude",
	);
	quiet.copilot.close();
	expect(quiet.announcer).toBeUndefined();
});

// `--to` through the real entry point, against a board's channel listening in this process: the
// host's line on success, and each error in one line, with no TUI started.
describe("kabane board --issue <id> --to <pid>", () => {
	const kabane = async (...args: string[]) => {
		const proc = Bun.spawn(
			[process.execPath, join(import.meta.dir, "../../index.ts"), ...args],
			{
				cwd: HOME,
				env: { ...process.env, KABANE_HOME: HOME },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { out: `${out}${err}`.trim(), code };
	};

	it("opens the issue in the board at that pid, and says why when it cannot", async () => {
		mkdirSync(HOME, { recursive: true });
		writeFileSync(
			configPath(HOME),
			JSON.stringify({ actor: "cabane://actor/human/ada", deviceId: "mbp" }),
		);
		const ctx = await openContext(HOME, HOME, parseArgs([]));
		if (!ctx.ok) throw ctx.error;
		const added = await Planner.addTask(HOME, {
			title: "Open me from elsewhere",
			kind: "issue",
			state: "done",
		});
		if (!added.ok) throw added.error;
		const shortId = added.value.shortId ?? "";
		const pid = 900_100;
		const control = listenForRequests(ctx.value, pid);
		try {
			expect(
				await kabane("board", "--issue", shortId, "--to", `${pid}`),
			).toEqual({
				out: `Error: board pid ${pid} is still loading; try again`,
				code: 1,
			});
			const opened: string[] = [];
			const unsubscribe = control.requests.subscribe((task) =>
				opened.push(task.id),
			);
			const sent = await kabane(
				"board",
				"--issue",
				shortId.toLowerCase(),
				"--to",
				`${pid}`,
				"--json",
			);
			expect(sent.code).toBe(0);
			expect(JSON.parse(sent.out)).toEqual({ opened: shortId, pid });
			expect(opened).toEqual([added.value.id]);
			const prefix = added.value.id.slice(0, 20).toLowerCase();
			expect(
				await kabane("board", "--issue", prefix, "--to", `${pid}`),
			).toEqual({ out: `opened ${shortId} in board pid ${pid}`, code: 0 });
			expect(opened).toEqual([added.value.id, added.value.id]);
			expect(
				await kabane("board", "--issue", "JRET-99", "--to", `${pid}`),
			).toEqual({
				out: "Error: No task found with ID: JRET-99",
				code: 1,
			});
			unsubscribe();
		} finally {
			control.close();
		}
		expect(await kabane("board", "--issue", shortId, "--to", `${pid}`)).toEqual(
			{
				out: `Error: no board running as pid ${pid}`,
				code: 1,
			},
		);
		expect(await kabane("board", "--issue", shortId, "--to", "me")).toEqual({
			out: "Error: --to needs a board's pid, e.g. --to 77516",
			code: 1,
		});
		expect(await kabane("board", "--to", `${pid}`)).toEqual({
			out: "Error: --to needs --issue <id>, the issue to open",
			code: 1,
		});
	});
});
