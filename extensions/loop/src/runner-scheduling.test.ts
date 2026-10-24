// Exercise the runner's claim path on disposable trackers. Missing harnesses test the first
// scheduling batch; the scripted ACP subprocess holds turns open while gates are exercised.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LinkType,
	Planner,
	type Task,
	type TaskUpdate,
} from "@cabane/core";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";

let home = "";
beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-scheduling-"));
	await Planner.init(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const add = async (title: string, parentTaskId?: string): Promise<Task> => {
	const created = await Planner.addTask(home, {
		title,
		kind: "issue",
		state: "next",
		...(parentTaskId ? { parentTaskId } : {}),
	});
	if (!created.ok) throw created.error;
	return created.value;
};

const createRun = (parent: Task, input: LoopConfig.Input): RunStore.Run => {
	const config = LoopConfig.Schema.safeParse(input);
	if (!config.success) throw config.error;
	const run: RunStore.Run = {
		version: 1,
		id: "run-1",
		parentId: parent.id,
		parentShortId: parent.shortId ?? parent.id,
		projectDir: home,
		config: config.data,
		status: "pending",
		createdAt: new Date().toISOString(),
		claims: [],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		steering: Steering.INITIAL,
		gateRuns: [],
	};
	const saved = RunStore.create(home, run);
	if (!saved.ok) throw saved.error;
	return run;
};

const deps = () => ({
	home,
	basePath: home,
	kabaneBin: "/nonexistent/kabane",
	pid: process.pid,
	overrides: { gemini: { command: "/nonexistent/harness" } },
	tree: async () => "tree",
	tickMs: 5,
});

const readRun = (): RunStore.Run => {
	const read = RunStore.readRaw(home, "run-1");
	if (!read.ok) throw read.error;
	return read.value;
};

const until = async (predicate: () => boolean): Promise<void> => {
	const deadline = Date.now() + 3_000;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
	expect(predicate()).toBe(true);
};

const link = async (a: Task, b: Task, type: LinkType): Promise<void> => {
	const linked = await Planner.addLink(
		home,
		type === "blocks"
			? { sourceId: a.id, targetId: b.id, type }
			: { sourceId: b.id, targetId: a.id, type },
	);
	if (!linked.ok) throw linked.error;
};

// No model or MCP server is reached. Marker files let the test drive each ACP turn's end.
const AGENT = `
import { createInterface } from "node:readline";
import { existsSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import ${JSON.stringify(import.meta.resolve("@cabane/core/testing"))};
import { KABANE_TOOLS } from ${JSON.stringify(import.meta.resolve("@cabane/core"))};
let cancelled = false;
let task;
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
 if (message.method === "session/cancel") cancelled = true;
 if (message.method === "session/prompt") {
  const text = message.params.prompt.filter(p => p.type === "text").map(p => p.text).join("\\n");
  task ??= /Your subtask is ([^.]+)\\./.exec(text)?.[1];
  if (!task) process.exit(1);
  writeFileSync(task + ".prompt", text);
  appendFileSync(task + ".prompts", JSON.stringify(text) + "\\n");
  while (!cancelled && !existsSync(task + ".release")) await Bun.sleep(5);
  if (!cancelled && existsSync(task + ".change.json")) {
   const change = JSON.parse(readFileSync(task + ".change.json", "utf8"));
   if (change.state === "waiting") {
    if (!text.includes("kabane_edit") || !text.includes("waiting")) process.exit(2);
    await tool("kabane_comment", { id: task, body: "Blocked on human input; explicitly set next when ready." });
   }
   await tool("kabane_edit", { id: task, ...change });
  }
  reply(message.id, { stopReason: cancelled ? "cancelled" : "end_turn" });
 }
});
`;

describe("Runner scheduling", () => {
	it("prepares a human-only plan, waits unchanged, then claims a newly unblocked issue", async () => {
		const parent = await add("parent");
		const human = await Planner.addTask(home, {
			title: "human setup",
			kind: "task",
			state: "next",
			assignee: "owner",
			parentTaskId: parent.id,
		});
		if (!human.ok) throw human.error;
		const prepared = await Loop.prepare(
			{ ...deps(), cwd: home },
			{
				parent: parent.id,
				config: { implementer: "gemini", budget: { continuations: 0 } },
			},
		);
		if (!prepared.ok) throw prepared.error;
		expect(prepared.value.plan.nodes.map((n) => n.task.id)).toEqual([
			human.value.id,
		]);
		const run = createRun(parent, prepared.value.config);
		const controller = new AbortController();
		const agent = join(home, "agent.mjs");
		writeFileSync(agent, AGENT);
		const running = Runner.run(run.id, {
			...deps(),
			signal: controller.signal,
			overrides: { gemini: { command: process.execPath, args: [agent] } },
		});
		try {
			await until(() => {
				const events = RunStore.readEvents(home, run.id);
				return (
					events.ok &&
					events.value.some(
						(e) =>
							e.type === "waiting" &&
							e.summary.includes(human.value.shortId ?? human.value.id),
					)
				);
			});
			expect(readRun().claims).toEqual([]);
			const unchanged = await Planner.getTask(home, human.value.id);
			expect(unchanged.ok && unchanged.value).toEqual(human.value);
			const sessions = await Planner.querySessions(home, {
				taskId: human.value.id,
			});
			expect(sessions.ok && sessions.value).toEqual([]);
			const dependent = await add("dependent", parent.id);
			await link(human.value, dependent, "blocks");
			const independent = await add("independent checklist issue", parent.id);
			const checklist = await Planner.updateTask(home, independent.id, {
				description: "- [ ] implement\n- [ ] verify",
			});
			if (!checklist.ok) throw checklist.error;
			// A fresh tick has run, yet only the independent ISSUE was claimed.
			await until(() =>
				existsSync(join(home, `${independent.shortId}.prompt`)),
			);
			expect(readRun().claims.map((c) => c.taskId)).toEqual([independent.id]);
			const parked = await Planner.updateTask(home, independent.id, {
				state: "waiting",
			});
			if (!parked.ok) throw parked.error;
			const closed = await Planner.updateTask(home, human.value.id, {
				state: "done",
			});
			if (!closed.ok) throw closed.error;
			const addedHuman = await Planner.addTask(home, {
				title: "new human work",
				kind: "task",
				state: "next",
				parentTaskId: parent.id,
			});
			if (!addedHuman.ok) throw addedHuman.error;
			await until(() => existsSync(join(home, `${dependent.shortId}.prompt`)));
			expect(readRun().claims.map((c) => c.taskId)).toEqual([
				independent.id,
				dependent.id,
			]);
		} finally {
			controller.abort();
			const ended = await running;
			expect(ended.ok).toBe(true);
		}
	});

	for (const change of [
		{ state: "waiting" },
		{ state: "someday" },
		{ kind: "task" },
		{ assignee: "owner" },
	] satisfies TaskUpdate[]) {
		it(`yields ${JSON.stringify(change)} without nudging, reclaiming or stalling siblings`, async () => {
			const parent = await add("parent");
			const a = await add("blocked", parent.id);
			const b = await add("dependent", parent.id);
			const sibling = await add("independent", parent.id);
			await link(a, b, "blocks");
			const run = createRun(parent, {
				implementer: "gemini",
				stallAfter: 1,
				budget: { concurrency: 2, continuations: 3 },
			});
			const agent = join(home, "agent.mjs");
			writeFileSync(agent, AGENT);
			const controller = new AbortController();
			const running = Runner.run(run.id, {
				...deps(),
				signal: controller.signal,
				overrides: { gemini: { command: process.execPath, args: [agent] } },
			});
			try {
				await until(
					() =>
						existsSync(join(home, `${a.shortId}.prompt`)) &&
						existsSync(join(home, `${sibling.shortId}.prompt`)),
				);
				writeFileSync(
					join(home, `${a.shortId}.change.json`),
					JSON.stringify(change),
				);
				writeFileSync(join(home, `${a.shortId}.release`), "");
				await until(() =>
					readRun().claims.some(
						(c) => c.taskId === a.id && c.endedAt !== undefined,
					),
				);
				const witness = await add("later tick", parent.id);
				await until(() => existsSync(join(home, `${witness.shortId}.prompt`)));
				const snapshot = readRun();
				expect(snapshot.status).toBe("running");
				expect(snapshot.continuationsUsed).toBe(0);
				expect(snapshot.stall?.unchanged).toBe(0);
				expect(snapshot.claims.filter((c) => c.taskId === a.id)).toHaveLength(
					1,
				);
				expect(snapshot.claims.some((c) => c.taskId === b.id)).toBe(false);
				const current = await Planner.getTask(home, a.id);
				expect(current.ok && current.value).toMatchObject(change);
				const events = RunStore.readEvents(home, run.id);
				expect(
					events.ok && events.value.filter((e) => e.type === "continuation"),
				).toEqual([]);
				expect(
					readFileSync(join(home, `${a.shortId}.prompts`), "utf8")
						.trim()
						.split("\n"),
				).toHaveLength(1);
				if (change.state === "waiting") {
					// Free the witness slot, then explicitly ready a; ending a turn alone never completed it.
					writeFileSync(
						join(home, `${witness.shortId}.change.json`),
						JSON.stringify({ state: "done" }),
					);
					writeFileSync(join(home, `${witness.shortId}.release`), "");
					await until(() =>
						readRun().claims.some(
							(c) => c.taskId === witness.id && c.endedAt !== undefined,
						),
					);
					writeFileSync(
						join(home, `${a.shortId}.change.json`),
						JSON.stringify({ state: "done" }),
					);
					const ready = await Planner.updateTask(home, a.id, { state: "next" });
					if (!ready.ok) throw ready.error;
					await until(() => existsSync(join(home, `${b.shortId}.prompt`)));
					expect(
						readRun().claims.filter((c) => c.taskId === a.id),
					).toHaveLength(2);
				}
			} finally {
				controller.abort();
				const ended = await running;
				expect(ended.ok).toBe(true);
			}
		});
	}

	it("delivers deliberately queued human steering even when the task parks", async () => {
		const parent = await add("parent");
		const a = await add("blocked", parent.id);
		const run = createRun(parent, {
			implementer: "gemini",
			stallAfter: 1,
			budget: { continuations: 3 },
		});
		const agent = join(home, "agent.mjs");
		writeFileSync(agent, AGENT);
		const controller = new AbortController();
		const running = Runner.run(run.id, {
			...deps(),
			signal: controller.signal,
			overrides: { gemini: { command: process.execPath, args: [agent] } },
		});
		try {
			await until(() => existsSync(join(home, `${a.shortId}.prompt`)));
			const claim = readRun().claims[0];
			if (!claim) throw new Error("missing claim");
			const text =
				"Keep waiting: kabane_edit state waiting; kabane_comment the blocker.";
			const sent = RunStore.appendInbox(home, run.id, {
				kind: "inject",
				at: new Date().toISOString(),
				session: claim.sessionId,
				lane: claim.lane,
				text,
			});
			if (!sent.ok) throw sent.error;
			await until(() => {
				const events = RunStore.readEvents(home, run.id);
				return (
					events.ok && events.value.some((e) => e.type === "inject_queued")
				);
			});
			writeFileSync(
				join(home, `${a.shortId}.change.json`),
				JSON.stringify({ state: "waiting" }),
			);
			writeFileSync(join(home, `${a.shortId}.release`), "");
			await until(() => readRun().claims[0]?.endedAt !== undefined);
			expect(readRun().continuationsUsed).toBe(0);
			expect(readRun().status).toBe("running");
			const prompts = readFileSync(join(home, `${a.shortId}.prompts`), "utf8")
				.trim()
				.split("\n")
				.map((line) => String(JSON.parse(line)));
			expect(prompts).toHaveLength(2);
			expect(prompts[1]).toBe(text);
			const task = await Planner.getTask(home, a.id);
			expect(task.ok && task.value?.state).toBe("waiting");
		} finally {
			controller.abort();
			await running;
		}
	});

	it("still nudges active-owned work and does not invent a blocker when its budget runs out", async () => {
		const parent = await add("parent");
		const a = await add("active", parent.id);
		const run = createRun(parent, {
			implementer: "gemini",
			stallAfter: 1,
			budget: { continuations: 1 },
		});
		const agent = join(home, "agent.mjs");
		writeFileSync(agent, AGENT);
		writeFileSync(join(home, `${a.shortId}.release`), "");
		const ended = await Runner.run(run.id, {
			...deps(),
			overrides: { gemini: { command: process.execPath, args: [agent] } },
		});
		if (!ended.ok) throw ended.error;
		expect(ended.value.exit?.reason).toBe("stalled");
		expect(ended.value.continuationsUsed).toBe(1);
		expect(ended.value.claims).toHaveLength(1);
		expect(ended.value.claims[0]?.outcome).toBe("incomplete");
		const prompts = readFileSync(join(home, `${a.shortId}.prompts`), "utf8")
			.trim()
			.split("\n")
			.map((line) => String(JSON.parse(line)));
		expect(prompts).toHaveLength(2);
		for (const prompt of prompts) {
			expect(prompt).toContain("kabane_edit");
			expect(prompt).toContain("waiting");
			expect(prompt).toContain("kabane_comment");
		}
		const task = await Planner.getTask(home, a.id);
		expect(task.ok && task.value?.state).toBe("next");
	});

	for (const type of ["blocks", "blocked_by", "follows"] as const) {
		for (const concurrency of [1, 2]) {
			it(`${type}: fills only ${concurrency} slots with unblocked work`, async () => {
				const parent = await add("parent");
				const a = await add("prerequisite", parent.id);
				const b = await add("dependent", parent.id);
				const c = await add("independent", parent.id);
				// A blocked urgent task must lose even with only one free slot.
				const urgent = await Planner.updateTask(home, b.id, {
					priority: "urgent",
				});
				if (!urgent.ok) throw urgent.error;
				await link(a, b, type);
				const run = createRun(parent, {
					implementer: "gemini",
					stallAfter: 1,
					budget: { concurrency },
				});
				const ended = await Runner.run(run.id, deps());
				if (!ended.ok) throw ended.error;
				expect(ended.value.claims.map((claim) => claim.taskId)).toEqual(
					concurrency === 1 ? [a.id] : [a.id, c.id],
				);
			});
		}
	}

	for (const exit of [0, 1]) {
		it(`holds dependents through the live turn and gates (exit ${exit})`, async () => {
			const parent = await add("parent");
			const a = await add("prerequisite", parent.id);
			const b = await add("dependent", parent.id);
			await link(a, b, "blocks");
			const run = createRun(parent, {
				implementer: "gemini",
				budget: { concurrency: 2, continuations: 0 },
				gates: {
					check: `touch gate-started; while [ ! -e gate-release ]; do sleep 0.01; done; exit ${exit}`,
				},
			});
			const agent = join(home, "agent.mjs");
			writeFileSync(agent, AGENT);
			const controller = new AbortController();
			const running = Runner.run(run.id, {
				...deps(),
				signal: controller.signal,
				overrides: { gemini: { command: process.execPath, args: [agent] } },
			});
			try {
				await until(() => existsSync(join(home, `${a.shortId}.prompt`)));
				const closed = await Planner.updateTask(home, a.id, { state: "done" });
				if (!closed.ok) throw closed.error;
				// This independent claim proves a fresh tick ran with a free slot and a done,
				// still-live prerequisite, without starting its dependent.
				const c = await add("independent", parent.id);
				await until(() =>
					readRun().claims.some((claim) => claim.taskId === c.id),
				);
				expect(readRun().claims.some((claim) => claim.taskId === b.id)).toBe(
					false,
				);
				const parked = await Planner.updateTask(home, c.id, {
					state: "waiting",
				});
				if (!parked.ok) throw parked.error;
				writeFileSync(join(home, `${c.shortId}.release`), "");
				writeFileSync(join(home, `${a.shortId}.release`), "");
				await until(() => existsSync(join(home, "gate-started")));
				await until(() =>
					readRun().claims.some(
						(claim) => claim.taskId === c.id && claim.endedAt !== undefined,
					),
				);
				// Another independent claim witnesses a tick while a's gate is held open.
				const d = await add("during gates", parent.id);
				await until(() =>
					readRun().claims.some((claim) => claim.taskId === d.id),
				);
				expect(readRun().claims.some((claim) => claim.taskId === b.id)).toBe(
					false,
				);
				const parkedD = await Planner.updateTask(home, d.id, {
					state: "waiting",
				});
				if (!parkedD.ok) throw parkedD.error;
				writeFileSync(join(home, `${d.shortId}.release`), "");
				writeFileSync(join(home, "gate-release"), "");
				if (exit === 0) {
					await until(() =>
						readRun().claims.some((claim) => claim.taskId === b.id),
					);
				} else {
					await until(
						() =>
							readRun().claims.filter((claim) => claim.taskId === a.id)
								.length === 2,
					);
					expect(readRun().claims.some((claim) => claim.taskId === b.id)).toBe(
						false,
					);
				}
			} finally {
				writeFileSync(join(home, "gate-release"), "");
				controller.abort();
				const ended = await running;
				expect(ended.ok).toBe(true);
			}
		});
	}
});
