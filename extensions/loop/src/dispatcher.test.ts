// The board's "start loop" trigger against a real tracker and a real git checkout: when it is
// offered, when it is refused and why, and what its form and preview are built from. Starting a
// run spawns the runner, which is the sandbox check, not a unit test.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { detectScope } from "@cabane/core/scope";
import { LoopDispatcher } from "./dispatcher";

let root = "";
let home = "";
let repo = "";

const deps = () => ({
	home,
	basePath: home,
	kabaneBin: "/nonexistent",
	cwd: repo,
});

const add = async (title: string, extra: Record<string, unknown> = {}) => {
	const created = await Planner.addTask(home, {
		title,
		kind: "issue",
		state: "next",
		...extra,
	});
	if (!created.ok) throw created.error;
	return created.value;
};

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "loop-dispatcher-"));
	home = join(root, "home");
	repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	GitFixture.run(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
	await Planner.init(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("LoopDispatcher.triggers", () => {
	it("offers nothing on an issue with no subtasks", async () => {
		const lone = await add("lone");
		expect(await LoopDispatcher.triggers(deps(), lone.id)).toEqual({
			ok: true,
			value: [],
		});
	});

	it("offers start loop, unsatisfiable with start's own reason, from a folder that is not the scope", async () => {
		const parent = await add("parent", { scopeUri: "jake://scope/elsewhere" });
		await add("child", { parentTaskId: parent.id });
		const offered = await LoopDispatcher.triggers(deps(), parent.id);
		const [start] = offered.ok ? offered.value : [];
		expect(start?.satisfiable).toBe(false);
		expect(start?.hint).toContain("--dir");
	});

	it("in the parent's checkout: the run's settings as a form and the plan as its preview", async () => {
		const scope = await detectScope(repo, { home, detectExtensions: false });
		const parent = await add("parent", { scopeUri: scope?.scopeUri });
		const first = await add("first", { parentTaskId: parent.id });
		const second = await add("second", { parentTaskId: parent.id });
		const linked = await Planner.addLink(home, {
			sourceId: first.id,
			targetId: second.id,
			type: "blocks",
		});
		expect(linked.ok).toBe(true);
		const offered = await LoopDispatcher.triggers(deps(), parent.id);
		const [start] = offered.ok ? offered.value : [];
		expect(start?.satisfiable).toBe(true);
		expect(start?.inputs["budget.concurrency"]?.default).toBe("2");
		const preview = (start?.preview ?? []).map((line) =>
			line.map((p) => p.text).join(""),
		);
		expect(preview[0]).toBe("Plan  2 subtasks · 1 link · 1 ready");
		expect(
			preview.some((l) => l.includes(`← ${first.shortId ?? first.id}`)),
		).toBe(true);
	});
});
