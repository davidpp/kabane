import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// One claim's handle on a real tracker. The harness command points nowhere, so the session ends
// before any harness runs, and nothing reaches a paid one.
import "@kabane/core/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, Planner } from "@kabane/core";
import { Dispatch } from "./dispatch";
import { RunStore } from "./store";
import { TestHarnesses } from "./test-harnesses";
import { testHost } from "./test-host";
import { TestSessions } from "./test-sessions";

let home = "";

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-dispatch-"));
	await Planner.init(home);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("Dispatch.Handle.inject", () => {
	it("an inject after the session ended says it was dropped instead of queueing it", async () => {
		const created = await Planner.addTask(home, {
			title: "child",
			kind: "issue",
			state: "next",
		});
		if (!created.ok) throw created.error;
		const task = created.value;
		const events: RunStore.EventDraft[] = [];
		const handle = Dispatch.begin(
			{
				parent: task,
				task,
				harness: "claude",
				sessionId: "s1",
				lane: "claude:K-1",
				work: { kind: "implement", gates: [], concurrent: false },
			},
			{
				basePath: home,
				host: testHost(home),
				home,
				kabaneBin: "/nonexistent/kabane",
				cwd: home,
				tree: {
					worktree: false,
					isolation: "shared",
					land: "none",
					dir: home,
					branch: "",
					runBranch: "",
				},
				runId: "run-1",
				overrides: { command: "/nonexistent/harness" },
			},
			{
				event: (e) => events.push(e),
				opened: () => {},
				usage: () => {},
				continueTurn: () => false,
				permission: async () => err(new Error("no harness runs in this test")),
				elicitation: async () => err(new Error("no harness runs in this test")),
			},
		);
		const outcome = await handle.done;
		expect(outcome.outcome).toBe("error");

		// The claim still holds the session while its gates run; text sent meanwhile has no turn.
		await handle.inject("one more thing");

		expect(events.map((e) => e.type)).not.toContain("inject_queued");
		expect(events.at(-1)).toMatchObject({
			type: "warning",
			lane: "claude:K-1",
			summary: "inject for claude:K-1 dropped: its session has ended",
		});
	});
});

it("keeps consecutive tool calls in the on-disk stream without duplicate progress events", async () => {
	const host = testHost(home);
	const created = await Planner.addTask(home, {
		title: "tools",
		kind: "issue",
	});
	if (!created.ok) throw created.error;
	const task = created.value;
	const opened = await TestSessions.open(home, {
		taskId: task.id,
		agent: "claude",
	});
	if (!opened.ok) throw opened.error;
	const run = TestSessions.owner(home, opened.value.id);
	const log = RunStore.eventLog(home, run.id);
	if (!log.ok) throw log.error;
	const handle = Dispatch.begin(
		{
			parent: task,
			task,
			harness: "claude",
			sessionId: opened.value.id,
			lane: "claude:tools",
			work: {
				kind: "lens",
				lenses: [{ name: "tools", prompt: "tools" }],
				gates: [],
			},
		},
		{
			basePath: home,
			host,
			home,
			kabaneBin: "/nonexistent/kabane",
			cwd: home,
			tree: {
				worktree: false,
				isolation: "shared",
				land: "none",
				dir: home,
				branch: "",
				runBranch: "",
			},
			runId: run.id,
			overrides: TestHarnesses.overrides({
				claude: {
					command: process.execPath,
					args: [
						join(
							import.meta.dir,
							"../../../packages/acp/scripts/scripted-agent.ts",
						),
					],
				},
			}).claude,
		},
		{
			event: (event) => {
				const written = log.value.append(event);
				if (!written.ok) throw written.error;
			},
			opened: () => {},
			usage: () => {},
			continueTurn: () => false,
			permission: async () =>
				err(new Error("tools script requests no permission")),
			elicitation: async () => err(new Error("tools script requests no form")),
		},
	);
	await handle.inject("tools");
	const outcome = await handle.done;
	expect(outcome.outcome).toBe("done");
	const events = RunStore.readEvents(home, run.id);
	if (!events.ok) throw events.error;
	const calls = events.value.filter((event) => event.type === "tool_call");
	expect(calls.map((event) => event.summary)).toEqual([
		"kabane_list",
		"kabane_context JREP-1",
		"bun test",
	]);
	expect(
		events.value
			.filter((event) =>
				["tool_call", "tool_completed", "progress"].includes(event.type),
			)
			.map((event) => event.type),
	).toEqual([
		"tool_call",
		"tool_completed",
		"tool_call",
		"tool_completed",
		"tool_call",
		"tool_completed",
	]);
	expect(events.value.some((event) => event.type === "progress")).toBe(false);
});
