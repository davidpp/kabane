import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gates } from "./gates";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "loop-gates-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const never = new AbortController().signal;

describe("Gates.run", () => {
	it("runs in order in the directory and stops at the first red gate", async () => {
		const results = await Gates.run(
			{
				here: "pwd",
				broken: "echo 'expected 2, got 3' >&2; exit 3",
				never: "echo unreachable",
			},
			dir,
			{},
			never,
		);
		expect(results.map((r) => [r.name, r.ok, r.exit])).toEqual([
			["here", true, 0],
			["broken", false, 3],
		]);
		expect(results[0]?.tail).toEndWith(dir.split("/").at(-1) ?? "");
		// stderr reads into the tail like a terminal would show it.
		expect(results[1]?.tail).toBe("expected 2, got 3");
		expect(Gates.passed({ here: "", broken: "", never: "" }, results)).toBe(
			false,
		);
	});

	it("keeps the end of long output", async () => {
		const [result] = await Gates.run({ noisy: "seq 1 500" }, dir, {}, never);
		const lines = result?.tail.split("\n") ?? [];
		expect(lines).toHaveLength(40);
		expect(lines.at(-1)).toBe("500");
	});

	it("a stopping run kills the gate, which counts as not passed", async () => {
		const stopping = new AbortController();
		const running = Gates.run({ slow: "sleep 30" }, dir, {}, stopping.signal);
		setTimeout(() => stopping.abort(), 50);
		const started = Date.now();
		const [result] = await running;
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(result).toMatchObject({ name: "slow", ok: false, exit: null });
	});

	it("a stopping run kills everything a compound gate started, not only its shell", async () => {
		const stopping = new AbortController();
		const marker = join(dir, "outlived");
		const running = Gates.run(
			{ compound: `sleep 1.5; touch ${marker}` },
			dir,
			{},
			stopping.signal,
		);
		setTimeout(() => stopping.abort(), 100);
		const started = Date.now();
		const [result] = await running;
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(result).toMatchObject({ ok: false, exit: null });
		await Bun.sleep(2_000);
		expect(existsSync(marker)).toBe(false);
	});

	it("a gate that finishes despite the stop keeps its real exit", async () => {
		const stopping = new AbortController();
		// It ignores SIGTERM and ends green well inside the grace before SIGKILL.
		const running = Gates.run(
			{ stubborn: "trap '' TERM; sleep 0.3; echo green" },
			dir,
			{},
			stopping.signal,
		);
		setTimeout(() => stopping.abort(), 50);
		const [result] = await running;
		expect(result).toMatchObject({ ok: true, exit: 0, tail: "green" });
	});
});

describe("Gates.green and lastFailure", () => {
	const GATES = { test: "bun test" };
	const pass = (ok: boolean, tree: string, taskId?: string): Gates.Run => ({
		at: "2026-10-11T00:00:00.000Z",
		...(taskId ? { taskId } : {}),
		results: [
			{
				name: "test",
				command: "bun test",
				ok,
				exit: ok ? 0 : 1,
				ms: 5,
				tail: "t",
			},
		],
		ok,
		tree,
	});

	it("is green with no gates, or a last green pass on the tree as it is", () => {
		expect(Gates.green({}, [], "t1")).toBe(true);
		expect(Gates.green(GATES, [], "t1")).toBe(false);
		expect(Gates.green(GATES, [pass(true, "t1")], "t1")).toBe(true);
		expect(Gates.green(GATES, [pass(true, "t1")], "t2")).toBe(false);
		expect(
			Gates.green(GATES, [pass(true, "t1"), pass(false, "t1")], "t1"),
		).toBe(false);
	});

	it("the failure a subtask's next brief quotes is its latest pass, when that was red", () => {
		const runs = [pass(false, "t1", "a"), pass(true, "t2", "b")];
		expect(Gates.lastFailure(runs, "a")?.name).toBe("test");
		expect(Gates.lastFailure(runs, "b")).toBeUndefined();
		expect(
			Gates.lastFailure([...runs, pass(true, "t3", "a")], "a"),
		).toBeUndefined();
	});
});
