// The board's "start loop" trigger against a real tracker and a real git checkout: when it is
// offered, when it is refused and why, and what its form and preview are built from. Starting a
// run spawns the runner, which is the sandbox check, not a unit test.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, Planner } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { detectScope } from "@cabane/core/scope";
import { Settings } from "@cabane/extension";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { LoopDispatcher } from "./dispatcher";
import { RunStore } from "./store";

let root = "";
let home = "";
let repo = "";

const deps = () => ({
	home,
	basePath: home,
	kabaneBin: "/nonexistent",
	cwd: repo,
	// No stored layers: the form's values over the defaults, through the real resolver.
	settings: Settings.port(async () => ok([])),
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
	it("offers nothing on a human task with no subtasks", async () => {
		const errand = await add("errand", { kind: "task" });
		expect(await LoopDispatcher.triggers(deps(), errand.id)).toEqual({
			ok: true,
			value: [],
		});
	});

	it("offers start loop on an issue with no subtasks, its one row as the plan", async () => {
		const scope = await detectScope(repo, { home, detectExtensions: false });
		const lone = await add("lone", { scopeUri: scope?.scopeUri });
		const offered = await LoopDispatcher.triggers(deps(), lone.id);
		const [start] = offered.ok ? offered.value : [];
		expect(start?.satisfiable).toBe(true);
		expect(start?.description).toBe(
			"drive this issue to done through a coding harness, in a detached runner",
		);
		expect(start?.inputs.implementer).toBeDefined();
		const preview = (start?.preview ?? []).map((line) =>
			line.map((p) => p.text).join(""),
		);
		expect(preview[0]).toBe("Plan  1 issue · 0 links · 1 ready");
		expect(preview.some((l) => l.includes(`${lone.shortId}  lone`))).toBe(true);
		expect(preview.some((l) => l.startsWith("Critical path"))).toBe(false);
	});

	it("offers start loop on a held single issue, unsatisfiable with the reason", async () => {
		const scope = await detectScope(repo, { home, detectExtensions: false });
		const held = await add("held", {
			scopeUri: scope?.scopeUri,
			state: "in_progress",
		});
		const offered = await LoopDispatcher.triggers(deps(), held.id);
		const [start] = offered.ok ? offered.value : [];
		expect(start?.satisfiable).toBe(false);
		expect(start?.hint).toContain("move it to next");
	});

	it("keeps a human-only plan visible, waiting and not ready", async () => {
		const parent = await add("parent");
		const human = await add("human setup", {
			kind: "task",
			parentTaskId: parent.id,
			assignee: "owner",
		});
		const offered = await LoopDispatcher.triggers(deps(), parent.id);
		const [start] = offered.ok ? offered.value : [];
		expect(start?.satisfiable).toBe(true);
		const preview = (start?.preview ?? []).map((line) =>
			line.map((p) => p.text).join(""),
		);
		expect(preview[0]).toBe("Plan  1 subtask · 0 links · 0 ready");
		expect(preview.some((line) => line.includes("human · next"))).toBe(true);
		expect(
			preview.some((line) => line.includes(`waiting on ${human.shortId}`)),
		).toBe(true);
	});

	it("offers start loop, unsatisfiable with start's own reason, from a folder that is not the scope", async () => {
		const parent = await add("parent", {
			scopeUri: "kabane://scope/elsewhere",
		});
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
		expect(start?.inputs["budget.concurrency"]).toMatchObject({
			default: "1",
			label: "sessions at once",
		});
		const preview = (start?.preview ?? []).map((line) =>
			line.map((p) => p.text).join(""),
		);
		expect(preview[0]).toBe("Plan  2 subtasks · 1 link · 1 ready");
		expect(
			preview.some((l) => l.includes(`← ${first.shortId ?? first.id}`)),
		).toBe(true);
	});
});

it("the real tracker form advises overlapping children and project gates", async () => {
	const scope = await detectScope(repo, { home, detectExtensions: false });
	const parent = await add("parent", { scopeUri: scope?.scopeUri });
	for (const title of ["first", "second"])
		await add(title, {
			parentTaskId: parent.id,
			description:
				"Both implementations edit src/shared.ts and must preserve existing behavior.",
		});
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({
			scripts: {
				check: "echo checked",
				typecheck: "echo typed",
				test: "echo tested",
			},
		}),
	);
	writeFileSync(join(repo, "bun.lock"), "");
	const offered = await LoopDispatcher.triggers(deps(), parent.id);
	const [start] = offered.ok ? offered.value : [];
	expect(start?.inputs["budget.concurrency"]?.default).toBe("1");
	expect(start?.inputs["budget.concurrency"]?.hint).toContain("src/shared.ts");
	const preview = start?.preview
		?.flatMap((l) => l.map((p) => p.text))
		.join(" ");
	expect(preview).toContain("Advised");
	expect(preview).toContain("Gates  advised from package.json");
	expect(preview).not.toContain("set with");
	expect(preview).toContain("bun run typecheck");
	expect(preview).toContain("bun install");
});

it.each([
	["shared", undefined, undefined],
	["worktree", undefined, "bun install"],
	["shared", "echo configured", "echo configured"],
] as const)(
	"submitted %s isolation preserves the right setup (%s)",
	async (isolation, setup, expected) => {
		const scope = await detectScope(repo, { home, detectExtensions: false });
		const parent = await add("parent", { scopeUri: scope?.scopeUri });
		writeFileSync(join(repo, "bun.lock"), "");
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ scripts: { test: "bun test" } }),
		);
		const dispatcher = LoopDispatcher.make({
			...deps(),
			settings: Settings.port(async () =>
				ok([{ layer: "shared", label: "project", value: { setup } }]),
			),
		});
		const offered = await dispatcher.triggers(parent.id);
		expect(offered.ok).toBe(true);
		// Exercise the real dispatch and persisted run configuration. The missing executable stops
		// at runner boot, before any harness or advised shell command can run.
		const started = await dispatcher.dispatch(
			"start",
			{
				id: parent.id,
				shortId: parent.shortId ?? parent.id,
				title: parent.title,
				brief: "",
			},
			{ isolation, worktree: false },
		);
		expect(started.ok).toBe(false);
		const runs = RunStore.list(home);
		if (!runs.ok) throw runs.error;
		expect(runs.value).toHaveLength(1);
		expect(runs.value[0]?.config).toMatchObject({
			isolation,
			gates: { test: "bun run test" },
		});
		expect(runs.value[0]?.config.setup).toBe(expected);
	},
);

it.each([
	[
		"a shared tree, the advised width untouched",
		{ isolation: "shared" },
		"3",
		[],
		undefined,
	],
	[
		"no run worktree, the advised width untouched",
		{ worktree: false },
		"3",
		[],
		undefined,
	],
	[
		"a shared tree, a width the human chose",
		{ isolation: "shared" },
		"2",
		["budget.concurrency"],
		2,
	],
	// Stepped 3 → 2 → 3: the advised value again, but the human's.
	[
		"a shared tree, the advised width chosen again",
		{ isolation: "shared" },
		"3",
		["budget.concurrency"],
		3,
	],
	["worktrees, the advised width", { isolation: "worktree" }, "3", [], 3],
] as const)(
	"submitted on %s: the run's sessions at once",
	async (_, where, sessions, edited, expected) => {
		const scope = await detectScope(repo, { home, detectExtensions: false });
		const parent = await add("parent", { scopeUri: scope?.scopeUri });
		for (const title of ["first", "second", "third"])
			await add(title, { parentTaskId: parent.id });
		const dispatcher = LoopDispatcher.make(deps());
		const offered = await dispatcher.triggers(parent.id);
		const [trigger] = offered.ok ? offered.value : [];
		expect(trigger?.inputs["budget.concurrency"]?.default).toBe("3");
		// The runner binary is missing: the run is written, then stops at boot.
		await dispatcher.dispatch(
			"start",
			{
				id: parent.id,
				shortId: parent.shortId ?? parent.id,
				title: parent.title,
				brief: "",
			},
			{ ...where, "budget.concurrency": sessions },
			edited,
		);
		const runs = RunStore.list(home);
		if (!runs.ok) throw runs.error;
		expect(runs.value[0]?.config.budget.concurrency).toBe(expected);
	},
);

it("advises stallAfter from this parent's stored reopen events, across past runs", async () => {
	const scope = await detectScope(repo, { home, detectExtensions: false });
	const parent = await add("parent", { scopeUri: scope?.scopeUri });
	const child = await add("child", { parentTaskId: parent.id });
	const other = await add("other", { scopeUri: scope?.scopeUri });
	const parsed = LoopConfig.Schema.safeParse({});
	if (!parsed.success) throw parsed.error;
	for (const id of ["first", "second"]) {
		expect(
			RunStore.create(home, {
				version: 1,
				id,
				parentId: parent.id,
				parentShortId: parent.shortId ?? parent.id,
				projectDir: repo,
				config: parsed.data,
				status: "stopped",
				createdAt: "2026-11-01T00:00:00.000Z",
				claims: [],
				usage: {},
				continuationsUsed: 0,
				inboxRead: 0,
				steering: { paused: false, skipped: [], next: [] },
				gateRuns: [],
			}).ok,
		).toBe(true);
		const log = RunStore.eventLog(home, id);
		if (!log.ok) throw log.error;
		expect(
			log.value.append({
				type: "reopened",
				task: child.shortId ?? child.id,
				summary: "gate failed",
			}).ok,
		).toBe(true);
		expect(
			log.value.append({
				type: "warning",
				task: child.shortId ?? child.id,
				summary: "not reopened",
			}).ok,
		).toBe(true);
		expect(log.value.append({ type: "reopened", summary: "no task" }).ok).toBe(
			true,
		);
	}
	const offered = await LoopDispatcher.triggers(
		deps(),
		parent.shortId ?? parent.id,
	);
	if (!offered.ok) throw offered.error;
	expect(offered.value[0]?.inputs.stallAfter).toMatchObject({
		default: "2",
		hint: expect.stringContaining("reopened 2 times"),
	});
	// `loop advise` reads the same advice inputs, so it cannot disagree with the form.
	const advised = await Loop.advise(deps(), { parent: parent.id });
	if (!advised.ok) throw advised.error;
	expect(advised.value.advice).toContainEqual({
		path: "stallAfter",
		value: 2,
		reason: expect.stringContaining("reopened 2 times"),
	});
	const unrelated = await LoopDispatcher.triggers(deps(), other.id);
	if (!unrelated.ok) throw unrelated.error;
	expect(unrelated.value[0]?.inputs.stallAfter?.hint).toBeUndefined();
});
