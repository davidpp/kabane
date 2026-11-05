// Where a gate retry runs: the decision on its own, then the real runner on a disposable tracker
// with a scripted ACP subprocess that writes a draft the gate refuses, then the fix.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Task } from "@cabane/core";
import type { Budget } from "./budget";
import { LoopConfig } from "./config";
import { Retry } from "./retry";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";

const done: RunStore.Claim = {
	taskId: "t1",
	shortId: "K-2",
	harness: "claude",
	lane: "K-2",
	sessionId: "core-1",
	acpSessionId: "acp-1",
	startedAt: "2026-11-05T00:00:00.000Z",
	endedAt: "2026-11-05T00:05:00.000Z",
	outcome: "done",
	continuations: 0,
};

const meter = (used: number, size = 1000) => ({ "core-1": { used, size } });

describe("Retry.session", () => {
	it("continues the session that closed the work while it has used under half its window", () => {
		expect(Retry.session(done, "claude", meter(499))).toEqual({
			resume: true,
			lane: "K-2",
			acpSessionId: "acp-1",
		});
	});

	it("starts fresh, saying why, when the session cannot or should not continue", () => {
		const cases: [RunStore.Claim, string, Budget.Meter, string][] = [
			[
				done,
				"claude",
				meter(500),
				"it had used 50% of its context window, at least 50%",
			],
			[done, "claude", {}, "it reported no context window usage"],
			[done, "claude", meter(0, 0), "it reported no context window usage"],
			[
				done,
				"codex",
				meter(10),
				"it ran on claude and the run implements with codex",
			],
			[
				{ ...done, acpSessionId: undefined },
				"claude",
				meter(10),
				"it recorded no claude session",
			],
			[
				{ ...done, outcome: "incomplete" },
				"claude",
				meter(10),
				"it ended incomplete",
			],
		];
		for (const [previous, harness, usage, why] of cases)
			expect(Retry.session(previous, harness, usage)).toEqual({
				resume: false,
				lane: "K-2",
				why,
			});
	});

	it("leaves an interrupted attempt to its takeover", () => {
		expect(
			Retry.session({ ...done, outcome: "interrupted" }, "claude", meter(10)),
		).toBeUndefined();
	});
});

let home = "";
beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-retry-"));
	await Planner.init(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// No model or MCP server is reached. `agent.json` says whether it advertises session/resume and
// how much of a 100-token window each turn reports; each turn writes `out.txt` (a draft the first
// time, the fix after) and closes the subtask named in `task`.
const AGENT = `
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import ${JSON.stringify(import.meta.resolve("@cabane/core/testing"))};
import { KABANE_TOOLS } from ${JSON.stringify(import.meta.resolve("@cabane/core"))};
const config = JSON.parse(readFileSync("agent.json", "utf8"));
const task = readFileSync("task", "utf8");
const tool = async (name, args) => {
 const definition = KABANE_TOOLS.find(t => t.name === name);
 const result = await definition.handler(args, {
  basePath: process.cwd(), actor: "cabane://actor/agent/gemini", scopeRequired: false
 });
 if (!result.ok) throw result.error;
};
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
const reply = (id, result) => send({ id, result });
createInterface({ input: process.stdin }).on("line", async line => {
 const message = JSON.parse(line);
 if (message.method === "initialize") reply(message.id, {
  protocolVersion: message.params.protocolVersion,
  agentCapabilities: config.resume ? { sessionCapabilities: { resume: {} } } : {},
 });
 if (message.method === "session/new") reply(message.id, { sessionId: "new-" + crypto.randomUUID() });
 if (message.method === "session/resume") reply(message.id, {});
 if (message.method === "session/prompt") {
  const { sessionId, prompt } = message.params;
  const text = prompt.filter(p => p.type === "text").map(p => p.text).join("\\n");
  appendFileSync("prompts.jsonl", JSON.stringify({ sessionId, text }) + "\\n");
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: config.used, size: 100 } } });
  writeFileSync("out.txt", existsSync("out.txt") ? "fixed\\n" : "draft\\n");
  await tool("kabane_done", { id: task });
  reply(message.id, { stopReason: "end_turn" });
 }
});
`;

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

type Prompt = { sessionId: string; text: string };

// A parent with one subtask, run to its end on the scripted agent.
const retried = async (agent: { resume: boolean; used: number }) => {
	const parent = await add("parent");
	const child = await add("write out.txt", parent.id);
	const label = child.shortId ?? child.id;
	writeFileSync(join(home, "task"), label);
	writeFileSync(join(home, "agent.json"), JSON.stringify(agent));
	writeFileSync(join(home, "agent.mjs"), AGENT);
	const config = LoopConfig.Schema.safeParse({
		implementer: "gemini",
		gates: { check: "grep -q fixed out.txt" },
		budget: { continuations: 0 },
	});
	if (!config.success) throw config.error;
	const created = RunStore.create(home, {
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
	});
	if (!created.ok) throw created.error;
	const ended = await Runner.run("run-1", {
		home,
		basePath: home,
		kabaneBin: "/nonexistent/kabane",
		pid: process.pid,
		overrides: {
			gemini: { command: process.execPath, args: [join(home, "agent.mjs")] },
		},
		tree: async () => "tree",
		tickMs: 5,
	});
	if (!ended.ok) throw ended.error;
	const events = RunStore.readEvents(home, "run-1");
	if (!events.ok) throw events.error;
	const prompts: Prompt[] = readFileSync(join(home, "prompts.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	return { label, run: ended.value, events: events.value, prompts };
};

describe("Runner, a subtask its own gate reopened", () => {
	it("continues in the session that closed it, told only the gate's failure", async () => {
		const { label, run, events, prompts } = await retried({
			resume: true,
			used: 10,
		});
		expect(run.claims.map((c) => c.lane)).toEqual([label, `${label}#2`]);
		expect(run.gateRuns.map((g) => g.ok)).toEqual([false, true]);
		const [first, second] = prompts;
		expect(second?.sessionId).toBe(first?.sessionId);
		expect(run.claims[1]?.acpSessionId).toBe(first?.sessionId);
		expect(second?.text).toStartWith(
			`After you called kabane_done on ${label}, the runner ran the gates and the \`check\` gate (\`grep -q fixed out.txt\`) failed with exit 1`,
		);
		expect(events.find((e) => e.type === "session_resumed")?.summary).toBe(
			`gemini session ${first?.sessionId} of ${label}, resumed for a gate retry`,
		);
	});

	it("starts a new session with the full brief once the session has used half its window", async () => {
		const { label, run, events, prompts } = await retried({
			resume: true,
			used: 50,
		});
		expect(run.gateRuns.map((g) => g.ok)).toEqual([false, true]);
		const [first, second] = prompts;
		expect(second?.sessionId).not.toBe(first?.sessionId);
		expect(second?.text).toStartWith("You are one implementing session");
		expect(second?.text).toContain(`${label} was closed before, then reopened`);
		expect(events.some((e) => e.type === "session_resumed")).toBe(false);
		expect(
			events.find((e) => e.type === "warning" && e.lane === `${label}#2`)
				?.summary,
		).toBe(
			`${label}'s session not resumed for a gate retry (it had used 50% of its context window, at least 50%): a new session gets the full brief`,
		);
	});

	it("starts a new session with the full brief when the harness does not advertise resume", async () => {
		const { label, events, prompts } = await retried({
			resume: false,
			used: 10,
		});
		const [first, second] = prompts;
		expect(second?.sessionId).not.toBe(first?.sessionId);
		expect(second?.text).toContain(`${label} was closed before, then reopened`);
		expect(
			events.find((e) => e.type === "warning" && e.lane === `${label}#2`)
				?.summary,
		).toBe(
			`gemini session ${first?.sessionId} of ${label} not resumed for a gate retry (gemini does not advertise session/resume): a new session gets the full brief`,
		);
	});
});
