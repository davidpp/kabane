// Exercise the runner's claim path on disposable trackers. Missing harnesses test the first
// scheduling batch; the scripted ACP subprocess holds turns open while gates are exercised.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LinkType, Planner, type Task } from "@cabane/core";
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
import { existsSync, writeFileSync } from "node:fs";
let cancelled = false;
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
createInterface({ input: process.stdin }).on("line", async line => {
 const message = JSON.parse(line);
 if (message.method === "initialize") reply(message.id, { protocolVersion: message.params.protocolVersion, agentCapabilities: {} });
 if (message.method === "session/new") reply(message.id, { sessionId: "fixture" });
 if (message.method === "session/cancel") cancelled = true;
 if (message.method === "session/prompt") {
  const text = message.params.prompt.filter(p => p.type === "text").map(p => p.text).join("\\n");
  const task = /Your subtask is ([^.]+)\\./.exec(text)?.[1];
  if (!task) process.exit(1);
  writeFileSync(task + ".prompt", "");
  while (!cancelled && !existsSync(task + ".release")) await Bun.sleep(5);
  reply(message.id, { stopReason: cancelled ? "cancelled" : "end_turn" });
 }
});
`;

describe("Runner scheduling", () => {
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
