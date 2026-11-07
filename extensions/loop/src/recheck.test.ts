// The recheck after the fixer, on the real runner, a disposable tracker and a real git repository.
// A scripted ACP subprocess stands in for the model, through the real kabane tools: as the fixer
// it closes every finding it is given and edits a tracked file, and as a lens's recheck it reopens
// the findings the test marks.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task, type TaskDraft } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { LoopConfig } from "./config";
import { Lenses } from "./lenses";
import { LoopPlan } from "./plan";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";

let home = "";
let first = "";
beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-recheck-"));
	await Planner.init(home);
	writeFileSync(join(home, "code.txt"), "before\n");
	GitFixture.run(home, ["init", "-q"]);
	GitFixture.run(home, ["add", "code.txt"]);
	GitFixture.run(home, ["commit", "-q", "-m", "first"]);
	first = GitFixture.run(home, ["rev-parse", "HEAD"]).trim();
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

const ENDED = { endedAt: "2026-11-04T00:01:00.000Z", outcome: "done" as const };
const LENS_DONE = claim({
	lane: "functional-lens",
	lens: "functional",
	...ENDED,
});

const createRun = (
	parent: Task,
	extra: Partial<RunStore.Run> = {},
	input: LoopConfig.Input = {},
): RunStore.Run => {
	const config = LoopConfig.Schema.safeParse({
		implementer: "gemini",
		gates: { ok: "true" },
		lenses: ["functional"],
		budget: { continuations: 0 },
		...input,
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
  const recheck = text.includes("rechecking the fixer");
  appendFileSync(recheck ? "recheck.prompts" : "fixer.prompts", JSON.stringify(text) + "\\n");
  const ids = [...text.matchAll(/^- (\\S+) · /gm)].map(([, id]) => id);
  if (recheck) {
   if (existsSync("recheck.edits")) appendFileSync("code.txt", "edited by the recheck\\n");
   for (const id of ids.filter(id => existsSync(id + ".reopen"))) {
    await tool("kabane_edit", { id, state: "next" });
    await tool("kabane_comment", { id, body: "The diff does not cover the empty input." });
   }
  } else {
   for (const id of ids) {
    appendFileSync("code.txt", "fixed " + id + "\\n");
    await tool("kabane_done", { id });
   }
  }
  reply(message.id, { stopReason: "end_turn" });
 }
});
`;

// The tree's fingerprint: constant by default, so the tracker and the agent's own notes in the
// directory never count as an edit.
const run = async (
	tree: () => Promise<string> = async () => "tree",
): Promise<RunStore.Run> => {
	const agent = join(home, "agent.mjs");
	writeFileSync(agent, AGENT);
	const ended = await Runner.run("run-1", {
		home,
		basePath: home,
		kabaneBin: "/nonexistent/kabane",
		pid: process.pid,
		overrides: { gemini: { command: process.execPath, args: [agent] } },
		tree,
		tickMs: 5,
	});
	if (!ended.ok) throw ended.error;
	return ended.value;
};

const prompts = (file: string): string[] =>
	existsSync(join(home, file))
		? readFileSync(join(home, file), "utf8")
				.trim()
				.split("\n")
				.map((line) => String(JSON.parse(line)))
		: [];

const state = async (task: Task): Promise<string | undefined> => {
	const read = await Planner.getTask(home, task.id);
	return read.ok ? read.value?.state : undefined;
};

const findings = async (parent: Task) => ({
	broken: await add({
		title: "broken",
		parentTaskId: parent.id,
		tags: ["finding", "p1", "functional"],
	}),
	edge: await add({
		title: "edge",
		parentTaskId: parent.id,
		tags: ["finding", "p2", "functional"],
	}),
	// Filed by a lens this run does not have: nothing rechecks it.
	nit: await add({
		title: "nit",
		parentTaskId: parent.id,
		tags: ["finding", "p3", "quality"],
	}),
});

describe("Runner recheck", () => {
	it("after the fixer, the lens whose findings it closed rechecks its diff and reopens one, with no second fixer", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "subtask", parentTaskId: parent.id, state: "done" });
		const { broken, edge, nit } = await findings(parent);
		writeFileSync(join(home, `${label(broken)}.reopen`), "");
		createRun(parent);

		const ended = await run();

		expect([ended.status, ended.exit?.reason, ended.exit?.detail]).toEqual([
			"completed",
			"plan-done",
			"1 finding left open for a human",
		]);
		expect(ended.claims.map((c) => [c.lane, c.recheck, c.outcome])).toEqual([
			["functional-lens", undefined, "done"],
			["fixer", undefined, "done"],
			["functional-recheck", "functional", "done"],
		]);
		const fixer = ended.claims.find((c) => c.fixer === true);
		expect(fixer?.head).toBe(first);
		expect(fixer?.findings?.toSorted()).toEqual(
			[broken.id, edge.id, nit.id].toSorted(),
		);
		expect(prompts("fixer.prompts")).toHaveLength(1);
		const [prompt, ...more] = prompts("recheck.prompts");
		expect(more).toEqual([]);
		// The closed findings of its own, and the fixer's diff from where it started.
		expect(prompt).toContain(`- ${label(broken)} · p1 · functional · broken`);
		expect(prompt).toContain(`- ${label(edge)} · p2 · functional · edge`);
		expect(prompt).not.toContain(`- ${label(nit)} · `);
		expect(prompt).toContain(`\`git diff ${first}\``);
		expect(prompt).toContain(`+fixed ${label(broken)}`);
		expect(prompt).toContain("Do not change files");
		expect(prompt).toStartWith("You are the `functional` verifier");
		// Reopened for a human; the rest stays closed.
		expect([await state(broken), await state(edge), await state(nit)]).toEqual([
			"next",
			"done",
			"done",
		]);
		// The recheck came after the fixer's result was gated.
		const events = RunStore.readEvents(home, "run-1");
		const trace = events.ok ? events.value : [];
		const passed = trace.findLastIndex((e) => e.type === "gate_passed");
		const rechecked = trace.findIndex(
			(e) => e.type === "claim" && e.lane === "functional-recheck",
		);
		expect(passed).toBeGreaterThanOrEqual(0);
		expect(rechecked).toBeGreaterThan(passed);
	});

	it("stops the run when the recheck edits files, and leaves its edits in place", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "subtask", parentTaskId: parent.id, state: "done" });
		await findings(parent);
		writeFileSync(join(home, "recheck.edits"), "");
		createRun(parent);

		const ended = await run(async () =>
			readFileSync(join(home, "code.txt"), "utf8"),
		);

		expect([ended.status, ended.exit?.reason]).toEqual([
			"stopped",
			"recheck-failed",
		]);
		expect(ended.exit?.detail).toStartWith(
			"functional: error: the recheck changed the working tree",
		);
		expect(ended.claims.map((c) => [c.lane, c.outcome])).toEqual([
			["functional-lens", "done"],
			["fixer", "done"],
			["functional-recheck", "error"],
		]);
		expect(readFileSync(join(home, "code.txt"), "utf8")).toEndWith(
			"edited by the recheck\n",
		);
		// No pass ran on the recheck's edits.
		const events = RunStore.readEvents(home, "run-1");
		const trace = events.ok ? events.value : [];
		const rechecked = trace.findIndex(
			(e) => e.type === "claim" && e.lane === "functional-recheck",
		);
		expect(rechecked).toBeGreaterThanOrEqual(0);
		expect(trace.slice(rechecked).some((e) => e.type === "gate_passed")).toBe(
			false,
		);
	});

	it("skips the phase when the setting is off, and when the fixer closed none of a lens's findings", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "subtask", parentTaskId: parent.id, state: "done" });
		await findings(parent);
		createRun(parent, {}, { recheck: false });
		const off = await run();
		expect(off.status).toBe("completed");
		expect(off.claims.map((c) => c.lane)).toEqual(["functional-lens", "fixer"]);

		// The fixer closed only a quality finding, and the run's one lens is functional.
		rmSync(join(home, "loops"), { recursive: true, force: true });
		const other = await add({ title: "other" });
		await add({ title: "subtask", parentTaskId: other.id, state: "done" });
		await add({
			title: "nit",
			parentTaskId: other.id,
			tags: ["finding", "p3", "quality"],
		});
		createRun(other);
		const none = await run();
		expect(none.status).toBe("completed");
		expect(none.claims.map((c) => c.lane)).toEqual([
			"functional-lens",
			"fixer",
		]);
	});

	it("resumes a recheck its runner died in, against the base the first fixer recorded", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "subtask", parentTaskId: parent.id, state: "done" });
		const { broken, edge, nit } = await findings(parent);
		for (const finding of [broken, edge, nit]) {
			const closed = await Planner.updateTask(home, finding.id, {
				state: "done",
			});
			if (!closed.ok) throw closed.error;
		}
		appendFileSync(join(home, "code.txt"), "fixed by hand\n");
		createRun(parent, {
			status: "failed",
			exit: { reason: "runner-died" },
			startedAt: "2026-11-04T00:00:00.000Z",
			gateRuns: [
				{
					at: "2026-11-04T00:02:00.000Z",
					taskId: parent.id,
					tree: "tree",
					ok: true,
					results: [],
				},
			],
			claims: [
				LENS_DONE,
				claim({
					lane: "fixer",
					taskId: parent.id,
					fixer: true,
					head: first,
					findings: [broken.id, edge.id, nit.id],
					...ENDED,
				}),
				claim({
					lane: "functional-recheck",
					taskId: parent.id,
					recheck: "functional",
				}),
			],
		});

		const ended = await run();

		expect(ended.status).toBe("completed");
		expect(ended.claims.map((c) => [c.lane, c.outcome])).toEqual([
			["functional-lens", "done"],
			["fixer", "done"],
			["functional-recheck", "interrupted"],
			["functional-recheck#2", "done"],
		]);
		const [prompt] = prompts("recheck.prompts");
		expect(prompt).toContain("attempt functional-recheck");
		expect(prompt).toContain("+fixed by hand");
		expect(prompts("fixer.prompts")).toEqual([]);
	});

	it("stops on resume, before any gate, when the recheck its runner died in had edited files", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "subtask", parentTaskId: parent.id, state: "done" });
		const { broken, edge } = await findings(parent);
		const tree = async () => readFileSync(join(home, "code.txt"), "utf8");
		const before = await tree();
		// What the cut-short recheck did to the tree before its runner died.
		appendFileSync(join(home, "code.txt"), "edited by the recheck\n");
		createRun(parent, {
			status: "failed",
			exit: { reason: "runner-died" },
			startedAt: "2026-11-04T00:00:00.000Z",
			gateRuns: [
				{
					at: "2026-11-04T00:02:00.000Z",
					taskId: parent.id,
					tree: before,
					ok: true,
					results: [],
				},
			],
			claims: [
				LENS_DONE,
				claim({
					lane: "fixer",
					taskId: parent.id,
					fixer: true,
					head: first,
					findings: [broken.id, edge.id],
					...ENDED,
				}),
				claim({
					lane: "functional-recheck",
					taskId: parent.id,
					recheck: "functional",
					findings: [broken.id, edge.id],
					tree: before,
				}),
			],
		});

		const ended = await run(tree);

		expect([ended.status, ended.exit?.reason]).toEqual([
			"stopped",
			"recheck-failed",
		]);
		expect(ended.exit?.detail).toStartWith(
			"functional: error: the recheck changed the working tree",
		);
		expect(ended.claims.map((c) => [c.lane, c.outcome])).toEqual([
			["functional-lens", "done"],
			["fixer", "done"],
			["functional-recheck", "error"],
		]);
		// No gate ran on the edit, so nothing committed it: it is still in the tree, uncommitted.
		const events = RunStore.readEvents(home, "run-1");
		const types = events.ok ? events.value.map((e) => e.type) : [];
		expect(types.filter((t) => t.startsWith("gate_"))).toEqual([]);
		expect(GitFixture.run(home, ["status", "--porcelain", "code.txt"])).toBe(
			" M code.txt\n",
		);
		expect(prompts("recheck.prompts")).toEqual([]);
	});

	it("resumes a recheck that reopened every finding before its runner died, on the findings it was given", async () => {
		const parent = await add({ title: "parent" });
		await add({ title: "subtask", parentTaskId: parent.id, state: "done" });
		const { broken, edge } = await findings(parent);
		// Both still `next`: the fixer closed them, then the cut-short recheck reopened them.
		createRun(parent, {
			status: "failed",
			exit: { reason: "runner-died" },
			startedAt: "2026-11-04T00:00:00.000Z",
			claims: [
				LENS_DONE,
				claim({
					lane: "fixer",
					taskId: parent.id,
					fixer: true,
					head: first,
					findings: [broken.id, edge.id],
					...ENDED,
				}),
				claim({
					lane: "functional-recheck",
					taskId: parent.id,
					recheck: "functional",
					findings: [broken.id, edge.id],
				}),
			],
		});

		const ended = await run();

		expect([ended.status, ended.exit?.detail]).toEqual([
			"completed",
			"3 findings left open for a human",
		]);
		expect(ended.claims.map((c) => [c.lane, c.outcome, c.findings])).toEqual([
			["functional-lens", "done", undefined],
			["fixer", "done", [broken.id, edge.id]],
			["functional-recheck", "interrupted", [broken.id, edge.id]],
			["functional-recheck#2", "done", [broken.id, edge.id]],
		]);
		const [prompt, ...more] = prompts("recheck.prompts");
		expect(more).toEqual([]);
		expect(prompt).toContain(`- ${label(broken)} · p1 · functional · broken`);
		expect(prompt).toContain(`- ${label(edge)} · p2 · functional · edge`);
		expect(prompts("fixer.prompts")).toEqual([]);
	});
});

describe("Lenses.rechecks", () => {
	it("is due for a lens with a finding the fixer closed, once its pass is over and it has a base", async () => {
		const parent = await add({ title: "parent" });
		const { broken, nit } = await findings(parent);
		for (const finding of [broken, nit]) {
			const closed = await Planner.updateTask(home, finding.id, {
				state: "done",
			});
			if (!closed.ok) throw closed.error;
		}
		const loaded = await LoopPlan.load(home, parent.id);
		if (!loaded.ok) throw loaded.error;
		const plan = loaded.value;
		const config = { lenses: ["functional", "quality"], recheck: true };
		const fixer = (extra: Partial<RunStore.Claim>) =>
			claim({
				lane: "fixer",
				fixer: true,
				findings: [broken.id, nit.id],
				...extra,
			});
		const due = (claims: RunStore.Claim[], c = config) =>
			Lenses.rechecks(c, claims, plan);

		expect(due([fixer({ head: first })]).pending).toEqual([]);
		expect(due([fixer({ head: first, ...ENDED })]).pending).toEqual([
			"functional",
			"quality",
		]);
		expect(due([fixer({ ...ENDED })]).pending).toEqual([]);
		expect(
			due([fixer({ head: first, ...ENDED })], { ...config, recheck: false })
				.pending,
		).toEqual([]);
		const rechecked = due([
			fixer({ head: first, ...ENDED }),
			claim({ lane: "functional-recheck", recheck: "functional", ...ENDED }),
			claim({
				lane: "quality-recheck",
				recheck: "quality",
				endedAt: ENDED.endedAt,
				outcome: "incomplete",
			}),
		]);
		expect(rechecked.done).toEqual(["functional"]);
		expect(rechecked.failed).toEqual([
			{ name: "quality", detail: "incomplete" },
		]);
		expect(Lenses.finished(rechecked)).toBe(false);
	});
});
