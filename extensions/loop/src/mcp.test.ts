import "@cabane/core/testing";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, Planner } from "@cabane/core";
import { Settings } from "@cabane/extension";
import { LoopAdvice } from "./advice";
import { loopMcp } from "./mcp";
import { RunStore } from "./store";

test("MCP advice resolves tagged subtasks using the real tracker and settings resolver without starting a run", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-loop-mcp-"));
	try {
		const initialized = await Planner.init(home);
		if (!initialized.ok) throw initialized.error;
		const parent = await Planner.addTask(home, {
			title: "MCP advice",
			kind: "issue",
			state: "next",
		});
		if (!parent.ok) throw parent.error;
		const child = await Planner.addTask(home, {
			title: "Tagged work",
			kind: "issue",
			state: "next",
			parentTaskId: parent.value.id,
			tags: ["tier:codex/fast"],
		});
		if (!child.ok) throw child.error;
		const surface = await loopMcp({
			home,
			store: home,
			cwd: home,
			actor: "test",
			harnessMode: "default",
			settings: Settings.port(async (namespace, projectDir) => {
				expect(namespace).toBe("loop");
				expect(projectDir).toBe(home);
				return ok([
					{
						layer: "shared",
						label: "Project settings",
						value: {
							worktree: false,
							tiers: { codex: { fast: "example-model" } },
						},
					},
				]);
			}),
		});
		expect(surface.instructions).toBe(LoopAdvice.INSTRUCTIONS);
		const tool = surface.tools?.[0];
		if (!tool) throw new Error("Missing loop advice tool");
		expect(tool.annotations).toBeUndefined();
		const result = await tool.handler(
			{ id: parent.value.id },
			{ basePath: home, actor: "test", scopeRequired: false },
		);
		if (!result.ok) throw result.error;
		expect(result.value).toMatchObject({
			subtasks: [
				{
					title: "Tagged work",
					harness: "codex",
					model: "example-model",
					modelSource: "tier",
				},
			],
		});
		expect(RunStore.list(home)).toEqual(ok([]));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
