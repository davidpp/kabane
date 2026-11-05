// The fixer phase on the real runner and a disposable tracker. A scripted ACP subprocess stands in
// for the model: it reads the finding ids off the fixer's prompt and closes each one, or parks the
// ones the test marks as left, through the real kabane tools.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, Planner, type Task, type TaskDraft } from "@cabane/core";
import { Settings } from "@cabane/extension";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { Fixer } from "./fixer";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";

let home = "";
beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-fixer-"));
	await Planner.init(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const add = async (
	draft: Partial<TaskDraft> & { title: string },
): Promise<Task> => {
	const created = await Planner.addTask(home, {
		kind: "issue",
		state: "next",
		...draft,
	});
	if (!created.ok) throw created.error;
	return created.value;
};

const label = (task: Task): string => task.shortId ?? task.id;

const claim = (
	extra: Partial<RunStore.Claim> & Pick<RunStore.Claim, "lane">,
): RunStore.Claim => ({
	taskId: "parent",
	shortId: "K-1",
	harness: "gemini",
	sessionId: `s-${extra.lane}`,
	startedAt: "2026-11-04T00:00:00.000Z",
	continuations: 0,
	...extra,
});

const LENS_DONE = claim({
	lane: "functional-lens",
	lens: "functional",
	endedAt: "2026-11-04T00:01:00.000Z",
	outcome: "done",
});

const createRun = (
	parent: Task,
	extra: Partial<RunStore.Run> = {},
): RunStore.Run => {
	const config = LoopConfig.Schema.safeParse({
		implementer: "gemini",
		gates: { ok: "true" },
		lenses: ["functional"],
		budget: { continuations: 0 },
	});
	if (!config.success) throw config.error;
	const run: RunStore.Run = {
		version: 1,
		id: "run-1",
		parentId: parent.id,
		parentShortId: label(parent),
		projectDir: home,
		config: config.data,
		status: "pending",
		createdAt: new Date().toISOString(),
		claims: [LENS_DONE],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		steering: Steering.INITIAL,
		gateRuns: [],
		...extra,
	};
	const saved = RunStore.create(home, run);
	if (!saved.ok) throw saved.error;
	return run;
};

// No model or MCP server is reached: the finding ids come from the prompt's list.
const AGENT = `
import { createInterface } from "node:readline";
import { existsSync, appendFileSync } from "node:fs";
import ${JSON.stringify(import.meta.resolve("@cabane/core/testing"))};
import { KABANE_TOOLS } from ${JSON.stringify(import.meta.resolve("@cabane/core"))};
const tool = async (name, args) => {
 const definition = KABANE_TOOLS.find(t => t.name === name);
 const result = await definition.handler(args, {
  basePath: process.cwd(), actor: "cabane://actor/agent/gemini", scopeRequired: false
 });
 if (!result.ok) throw result.error;
};
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
createInterface({ input: process.stdin }).on("line", async line => {
 const message = JSON.parse(line);
 if (message.method === "initialize") reply(message.id, { protocolVersion: message.params.protocolVersion, agentCapabilities: {} });
 if (message.method === "session/new") reply(message.id, { sessionId: "fixture" });
 if (message.method === "session/prompt") {
  const text = message.params.prompt.filter(p => p.type === "text").map(p => p.text).join("\\n");
  appendFileSync("fixer.prompts", JSON.stringify(text) + "\\n");
  for (const [, id] of text.matchAll(/^- (\\S+) · /gm)) {
   if (existsSync(id + ".leave")) {
    await tool("kabane_comment", { id, body: "Out of scope for this parent." });
    await tool("kabane_edit", { id, state: "waiting" });
   } else await tool("kabane_done", { id });
  }
  reply(message.id, { stopReason: "end_turn" });
 }
});
`;

const run = async (): Promise<RunStore.Run> => {
	const agent = join(home, "agent.mjs");
	writeFileSync(agent, AGENT);
	const ended = await Runner.run("run-1", {
		home,
		basePath: home,
		kabaneBin: "/nonexistent/kabane",
		pid: process.pid,
		overrides: { gemini: { command: process.execPath, args: [agent] } },
		tree: async () => "tree",
		tickMs: 5,
	});
	if (!ended.ok) throw ended.error;
	return ended.value;
};

const prompts = (): string[] =>
	readFileSync(join(home, "fixer.prompts"), "utf8")
		.trim()
		.split("\n")
		.map((line) => String(JSON.parse(line)));

const state = async (task: Task): Promise<string | undefined> => {
	const read = await Planner.getTask(home, task.id);
	return read.ok ? read.value?.state : undefined;
};

// Mixed severities, filed out of order: the fixer must see p1 → p2 → p3.
const findings = async (parent: Task) => {
	const nit = await add({
		title: "nit",
		parentTaskId: parent.id,
		tags: ["finding", "p3", "quality"],
	});
	const edge = await add({
		title: "edge",
		parentTaskId: parent.id,
		tags: ["finding", "p2", "functional"],
	});
	const broken = await add({
		title: "broken",
		parentTaskId: parent.id,
		tags: ["finding", "p1", "functional"],
	});
	return { nit, edge, broken };
};

describe("Fixer.status", () => {
	it("reads the last fixer claim: an interrupted one is to be run again", () => {
		const fixer = (extra: Partial<RunStore.Claim>) =>
			claim({ lane: "fixer", fixer: true, ...extra });
		const ended = { endedAt: "2026-11-04T00:02:00.000Z" };
		expect(Fixer.status([LENS_DONE]).kind).toBe("unstarted");
		expect(
			Fixer.status([fixer({ ...ended, outcome: "interrupted" })]).kind,
		).toBe("unstarted");
		expect(Fixer.status([fixer({})]).kind).toBe("running");
		expect(
			Fixer.status([fixer({ ...ended, outcome: "incomplete" })]).kind,
		).toBe("ended");
		expect(
			Fixer.status([fixer({ ...ended, outcome: "error", detail: "no cli" })]),
		).toEqual({ kind: "failed", detail: "error: no cli" });
	});
});

describe("Runner fixer", () => {
	it("hands every finding to one fixer session after the lenses, then gates and completes", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "subtask", parentTaskId: parent.id, state: "done" });
		const { nit, edge, broken } = await findings(parent);
		writeFileSync(join(home, `${label(nit)}.leave`), "");
		createRun(parent);

		const ended = await run();

		expect([ended.status, ended.exit?.reason, ended.exit?.detail]).toEqual([
			"completed",
			"plan-done",
			"1 finding left open for a human",
		]);
		expect(
			ended.claims.map((c) => [c.lane, c.taskId, c.fixer, c.outcome]),
		).toEqual([
			["functional-lens", "parent", undefined, "done"],
			["fixer", parent.id, true, "done"],
		]);
		const [prompt, ...more] = prompts();
		expect(more).toEqual([]);
		const order = [broken, edge, nit].map((f) =>
			prompt?.indexOf(`- ${label(f)} · `),
		);
		expect(order.every((at) => at !== undefined && at >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)));
		expect(prompt).toContain(`- ${label(broken)} · p1 · functional · broken`);
		expect([await state(broken), await state(edge), await state(nit)]).toEqual([
			"done",
			"done",
			"waiting",
		]);
		// The fixer's result is gated before the run completes.
		const events = RunStore.readEvents(home, "run-1");
		const types = events.ok ? events.value.map((e) => e.type) : [];
		expect(types.lastIndexOf("gate_passed")).toBeGreaterThan(
			types.lastIndexOf("session_end"),
		);
		// The run took the parent and leaves it for the human to close.
		expect(await state(parent)).toBe("in_progress");
	});

	it("completes without a fixer when the lenses found nothing", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "subtask", parentTaskId: parent.id, state: "done" });
		createRun(parent);
		const ended = await run();
		expect([ended.status, ended.exit?.detail]).toEqual([
			"completed",
			undefined,
		]);
		expect(ended.claims.filter((c) => c.fixer)).toEqual([]);
	});

	it("resumes the fixer phase on what is still open after its runner died", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "subtask", parentTaskId: parent.id, state: "done" });
		const { nit, edge, broken } = await findings(parent);
		const fixed = await Planner.updateTask(home, broken.id, { state: "done" });
		if (!fixed.ok) throw fixed.error;
		createRun(parent, {
			status: "failed",
			exit: { reason: "runner-died" },
			startedAt: "2026-11-04T00:00:00.000Z",
			claims: [
				LENS_DONE,
				claim({ lane: "fixer", taskId: parent.id, fixer: true }),
			],
		});

		const ended = await run();

		expect(ended.status).toBe("completed");
		expect(ended.claims.map((c) => [c.lane, c.outcome])).toEqual([
			["functional-lens", "done"],
			["fixer", "interrupted"],
			["fixer#2", "done"],
		]);
		const [prompt] = prompts();
		expect(prompt).not.toContain(`- ${label(broken)} · `);
		expect(prompt).toContain(`- ${label(edge)} · p2`);
		expect(prompt).toContain(`- ${label(nit)} · p3`);
		expect([await state(edge), await state(nit)]).toEqual(["done", "done"]);
		// The run took the parent; the fixer never releases it, on recovery or at its end.
		expect(await state(parent)).toBe("in_progress");
	});

	// A parent an earlier run left with every subtask closed and its lenses' findings open: a
	// plain `kabane loop start` on it is a run whose fixer takes them, with no lens configured to
	// review again first.
	it("starts a new run on a done parent with open findings, straight to the fixer", async () => {
		const parent = await add({ title: "parent" });
		const subtask = await add({
			title: "subtask",
			parentTaskId: parent.id,
			state: "done",
		});
		const deps = {
			home,
			basePath: home,
			cwd: home,
			settings: Settings.port(async () => ok([])),
		};
		const input = { parent: label(parent), dir: "." };
		const nothing = await Loop.prepare(deps, input);
		expect(!nothing.ok && nothing.error.message).toContain(
			"no finding under it is open",
		);
		const { edge, broken } = await findings(parent);
		const prepared = await Loop.prepare(deps, {
			...input,
			config: { implementer: "gemini" },
		});
		if (!prepared.ok) throw prepared.error;
		expect(prepared.value.config.lenses).toEqual([]);
		createRun(parent, { config: prepared.value.config, claims: [] });

		const ended = await run();

		expect(ended.status).toBe("completed");
		expect(ended.claims.map((c) => [c.lane, c.outcome])).toEqual([
			["fixer", "done"],
		]);
		expect([await state(broken), await state(edge)]).toEqual(["done", "done"]);
		expect(await state(subtask)).toBe("done");
	});
});
