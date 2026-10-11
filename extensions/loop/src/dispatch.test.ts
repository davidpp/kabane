// One claim's handle on a real tracker. The harness command points nowhere, so the session ends
// before any harness runs, and nothing reaches a paid one.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, Planner } from "@cabane/core";
import { Dispatch } from "./dispatch";
import type { RunStore } from "./store";

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
				work: { kind: "implement" },
			},
			{
				basePath: home,
				home,
				kabaneBin: "/nonexistent/kabane",
				cwd: home,
				runId: "run-1",
				overrides: { command: "/nonexistent/harness" },
			},
			{
				event: (e) => events.push(e),
				usage: () => {},
				continueTurn: () => false,
				permission: async () => err(new Error("no harness runs in this test")),
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
