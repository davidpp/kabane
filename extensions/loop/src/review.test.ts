// The review plan triage answers, held to its bounds, and the runner that triages before its lenses,
// on a disposable tracker and a real git repository. An inline ACP subprocess stands in for the
// model: a triage prompt is answered with the plan the test writes, any other prompt ends its turn.
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
import { Planner, type Task } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { LoopConfig } from "./config";
import { Review } from "./review";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";

const LENSES: Review.Lens[] = [
	{ name: "functional", always: true },
	{ name: "quality", applies: "any code change", always: false },
	{ name: "docs", applies: "docs/ and READMEs", always: false },
	{
		name: "compat",
		applies: "persisted data, interfaces, config",
		always: false,
	},
];
const TIERS = ["frontier", "balanced", "fast"];
const SMALL = { files: 2, lines: 40 };

const answered = (plan: unknown, prose = "Here is the plan."): string =>
	`${prose}\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;

const decide = (summary: string, size = SMALL) =>
	Review.decide({ outcome: "done", summary }, LENSES, TIERS, size);

describe("Review.decide", () => {
	it("takes a good plan as answered: its groups at their tiers, its skips, each with its reason", () => {
		const decided = decide(
			answered({
				groups: [
					{
						lenses: ["functional", "quality"],
						tier: "balanced",
						reason: "one code path",
					},
					{ lenses: ["docs"], reason: "README changed" },
				],
				skipped: [{ lens: "compat", reason: "no persisted data in the diff" }],
			}),
		);
		expect(decided).toEqual({
			plan: {
				groups: [
					{
						lenses: ["functional", "quality"],
						tier: "balanced",
						reason: "one code path",
					},
					{ lenses: ["docs"], reason: "README changed" },
				],
				skipped: [{ lens: "compat", reason: "no persisted data in the diff" }],
			},
			notes: [],
		});
		expect(Review.lines(decided.plan)).toEqual([
			"functional+quality at tier balanced: one code path",
			"docs: README changed",
			"skipped compat: no persisted data in the diff",
		]);
	});

	// The shape claude (haiku) answered in a live run: a null tier for the run's model.
	it("takes a null tier or reason as none given", () => {
		const decided = decide(
			answered({
				groups: [
					{
						lenses: ["functional", "quality", "docs"],
						tier: null,
						reason: "small but risky",
					},
				],
				skipped: [{ lens: "compat", reason: null }],
			}),
		);
		expect(decided.plan).toEqual({
			groups: [
				{
					lenses: ["functional", "quality", "docs"],
					reason: "small but risky",
				},
			],
			skipped: [{ lens: "compat", reason: "no reason given" }],
		});
	});

	it("reads the last fenced block that is a plan, after any thinking aloud", () => {
		const summary = [
			"First thought:\n```json\n{ not json\n```",
			answered({
				groups: [
					{
						lenses: ["functional", "quality", "docs", "compat"],
						reason: "small",
					},
				],
			}),
		].join("\n\n");
		expect(decide(summary).plan.groups).toEqual([
			{ lenses: ["functional", "quality", "docs", "compat"], reason: "small" },
		]);
	});

	it("falls back to every lens on its own when the answer holds no plan, saying why", () => {
		for (const summary of [
			"I looked and it is fine.",
			"```json\n{ broken\n```",
			answered({ groups: "all" }),
			"",
		]) {
			const { plan } = decide(summary);
			expect(plan.fallback).toBe("triage answered no review plan");
			expect(plan.groups.map((g) => g.lenses)).toEqual([
				["functional"],
				["quality"],
				["docs"],
				["compat"],
			]);
			expect(plan.skipped).toEqual([]);
		}
	});

	it("falls back when the session did not finish, with its outcome as the reason", () => {
		const { plan } = Review.decide(
			{ outcome: "error", detail: "the recheck changed the working tree" },
			LENSES,
			TIERS,
			SMALL,
		);
		expect(plan.fallback).toBe(
			"triage error: the recheck changed the working tree",
		);
		expect(plan.groups).toHaveLength(4);
	});

	it("never skips an always lens: it reviews on its own, as always runs", () => {
		const decided = decide(
			answered({
				groups: [{ lenses: ["quality", "docs", "compat"], reason: "code" }],
				skipped: [{ lens: "functional", reason: "trivial" }],
			}),
		);
		expect(decided.plan.groups).toEqual([
			{ lenses: ["quality", "docs", "compat"], reason: "code" },
			{ lenses: ["functional"], reason: "always runs" },
		]);
		expect(decided.plan.skipped).toEqual([]);
		expect(decided.notes).toEqual([
			"triage skipped functional, which always runs: it reviews on its own",
		]);
	});

	it("drops a lens the run does not have, and gives one the plan forgot a session of its own", () => {
		const decided = decide(
			answered({
				groups: [{ lenses: ["functional", "perf"], reason: "code" }],
				skipped: [{ lens: "docs", reason: "no docs" }],
			}),
		);
		expect(decided.plan.groups).toEqual([
			{ lenses: ["functional"], reason: "code" },
			{ lenses: ["quality"], reason: "the triage's plan did not place it" },
			{ lenses: ["compat"], reason: "the triage's plan did not place it" },
		]);
		expect(decided.plan.skipped).toEqual([{ lens: "docs", reason: "no docs" }]);
		expect(decided.notes).toEqual([
			"triage named perf, which is not a lens of this run: dropped",
		]);
	});

	it("drops a tier no run knows, so the group runs on the run's model", () => {
		const decided = decide(
			answered({
				groups: [
					{
						lenses: ["functional", "quality", "docs", "compat"],
						tier: "huge",
						reason: "all",
					},
				],
			}),
		);
		expect(decided.plan.groups).toEqual([
			{ lenses: ["functional", "quality", "docs", "compat"], reason: "all" },
		]);
		expect(decided.notes[0]).toContain("tier huge, which is not a tier");
	});

	it("splits every group into one session per lens past the size cap, keeping skips and tiers", () => {
		const plan = answered({
			groups: [
				{ lenses: ["functional", "quality"], tier: "fast", reason: "code" },
			],
			skipped: [
				{ lens: "docs", reason: "no docs" },
				{ lens: "compat", reason: "no data" },
			],
		});
		for (const size of [
			{ files: Review.MAX_FILES + 1, lines: 10 },
			{ files: 1, lines: Review.MAX_LINES + 1 },
		]) {
			const decided = decide(plan, size);
			expect(decided.plan.groups).toEqual([
				{ lenses: ["functional"], tier: "fast", reason: "code" },
				{ lenses: ["quality"], tier: "fast", reason: "code" },
			]);
			expect(decided.plan.skipped.map((s) => s.lens)).toEqual([
				"docs",
				"compat",
			]);
			expect(decided.notes[0]).toContain("past the size cap");
		}
		expect(
			decide(plan, { files: Review.MAX_FILES, lines: Review.MAX_LINES }).plan
				.groups,
		).toHaveLength(1);
	});
});

describe("Review.diff", () => {
	it("counts files and changed lines from numstat, a binary file and each untracked one as a file", () => {
		expect(
			Review.diff(
				"abc",
				" a | 3 ++-",
				"2\t1\ta.ts\n-\t-\tlogo.png\n10\t0\tb.md\n",
				["new.ts"],
			),
		).toEqual({
			base: "abc",
			stat: " a | 3 ++-",
			untracked: ["new.ts"],
			files: 4,
			lines: 13,
		});
	});
});

let home = "";
let first = "";
beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-review-"));
	await Planner.init(home);
	writeFileSync(join(home, "code.txt"), "before\n");
	// The tracker, the agent and its notes live here too: only code.txt is the run's change.
	writeFileSync(join(home, ".gitignore"), "*\n!code.txt\n!.gitignore\n");
	GitFixture.run(home, ["init", "-q"]);
	GitFixture.run(home, ["add", "code.txt", ".gitignore"]);
	GitFixture.run(home, ["commit", "-q", "-m", "first"]);
	first = GitFixture.run(home, ["rev-parse", "HEAD"]).trim();
	writeFileSync(join(home, "code.txt"), "after\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// Answers a triage prompt with the plan in `plan.json`, then ends every turn; each prompt is kept.
// With `triage.edits` present, the triage also edits code.txt.
const AGENT = `
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
createInterface({ input: process.stdin }).on("line", line => {
 const message = JSON.parse(line);
 if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
 if (message.method === "session/new") send({ id: message.id, result: { sessionId: "fixture" } });
 if (message.method === "session/prompt") {
  const text = message.params.prompt.filter(p => p.type === "text").map(p => p.text).join("\\n");
  appendFileSync("prompts.jsonl", JSON.stringify(text) + "\\n");
  if (text.startsWith(${JSON.stringify(Review.OPENING)})) {
   if (existsSync("triage.edits")) appendFileSync("code.txt", "edited by the triage\\n");
   const plan = readFileSync("plan.json", "utf8");
   send({ method: "session/update", params: { sessionId: "fixture", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\`\`\`json\\n" + plan + "\\n\`\`\`" } } } });
  }
  send({ id: message.id, result: { stopReason: "end_turn" } });
 }
});
`;

const add = async (
	title: string,
	extra: Record<string, unknown> = {},
): Promise<Task> => {
	const created = await Planner.addTask(home, {
		title,
		kind: "issue",
		state: "next",
		...extra,
	});
	if (!created.ok) throw created.error;
	return created.value;
};

const start = async (
	input: LoopConfig.Input,
	extra: Partial<RunStore.Run> = {},
	plan: unknown = {
		groups: [
			{
				lenses: ["functional", "quality"],
				tier: "balanced",
				reason: "one code path",
			},
		],
	},
): Promise<RunStore.Run> => {
	const parent = await add("parent");
	await add("child", { parentTaskId: parent.id, state: "done" });
	const config = LoopConfig.Schema.safeParse({
		implementer: "gemini",
		gates: { ok: "true" },
		lenses: ["functional", "quality"],
		budget: { continuations: 0 },
		...input,
	});
	if (!config.success) throw config.error;
	const created = RunStore.create(home, {
		version: 1,
		id: "run-1",
		parentId: parent.id,
		parentShortId: parent.shortId ?? parent.id,
		projectDir: home,
		base: { sha: first },
		config: config.data,
		status: "pending",
		createdAt: new Date().toISOString(),
		claims: [],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		steering: Steering.INITIAL,
		gateRuns: [],
		...extra,
	});
	if (!created.ok) throw created.error;
	writeFileSync(join(home, "plan.json"), JSON.stringify(plan));
	const agent = join(home, "agent.mjs");
	writeFileSync(agent, AGENT);
	const ended = await Runner.run("run-1", {
		home,
		basePath: home,
		kabaneBin: "/nonexistent/kabane",
		pid: process.pid,
		overrides: { gemini: { command: process.execPath, args: [agent] } },
		// The tree is code.txt: what a session edits there changes it.
		tree: async () => readFileSync(join(home, "code.txt"), "utf8"),
		tickMs: 5,
	});
	if (!ended.ok) throw ended.error;
	return ended.value;
};

const prompts = (): string[] => {
	const file = join(home, "prompts.jsonl");
	return existsSync(file)
		? readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => String(JSON.parse(line)))
		: [];
};

const trace = (type: string): string[] => {
	const events = RunStore.readEvents(home, "run-1");
	return events.ok
		? events.value.filter((e) => e.type === type).map((e) => e.summary)
		: [];
};

describe("Runner review triage", () => {
	it("triages once after the gates, at loop.review.tier, then runs the plan's group as one session", async () => {
		const run = await start({ review: { tier: "triage" } });

		expect([run.status, run.exit?.reason]).toEqual(["completed", "plan-done"]);
		expect(
			run.claims.map((c) => [c.lane, c.triage, c.lenses, c.outcome]),
		).toEqual([
			["triage", true, undefined, "done"],
			["functional+quality-lens", undefined, ["functional", "quality"], "done"],
		]);
		expect(run.review).toEqual({
			groups: [
				{
					lenses: ["functional", "quality"],
					tier: "balanced",
					reason: "one code path",
				},
			],
			skipped: [],
		});
		expect(trace("review")).toEqual([
			"functional+quality at tier balanced: one code path",
		]);
		const claims = trace("claim");
		expect(claims[0]).toStartWith(
			"gemini at tier triage triages the review of",
		);
		expect(claims[0]).toContain("1 file and 2 lines changed");
		expect(claims[1]).toContain("gemini at tier balanced reviews");
		// The brief: the diff stat from the base, and each lens with its frontmatter.
		const [triage] = prompts();
		expect(triage).toStartWith(Review.OPENING);
		expect(triage).toContain(`git diff --stat ${first}`);
		expect(triage).toContain("code.txt");
		expect(triage).toContain("- `functional` (always runs: never skip it)");
		// Where it works, read-only, as a lens's brief says it (`Brief.working`).
		expect(triage).toContain("Review here without changing files.");
		const events = RunStore.readEvents(home, "run-1");
		const types = events.ok ? events.value.map((e) => e.type) : [];
		expect(types.indexOf("gate_passed")).toBeLessThan(types.indexOf("claim"));
	});

	it("counts a skipped lens as reviewed: it gets no session", async () => {
		const run = await start(
			{},
			{},
			{
				groups: [{ lenses: ["functional"], reason: "code" }],
				skipped: [{ lens: "quality", reason: "nothing to read" }],
			},
		);
		expect([run.status, run.exit?.reason]).toEqual(["completed", "plan-done"]);
		expect(run.claims.map((c) => c.lane)).toEqual([
			"triage",
			"functional-lens",
		]);
		expect(trace("review")).toEqual([
			"functional: code",
			"skipped quality: nothing to read",
		]);
	});

	it("does not triage again with a plan stored", async () => {
		const run = await start(
			{},
			{
				review: {
					groups: [
						{ lenses: ["functional"], reason: "stored" },
						{ lenses: ["quality"], reason: "stored" },
					],
					skipped: [],
				},
			},
		);
		expect([run.status, run.exit?.reason]).toEqual(["completed", "plan-done"]);
		expect(run.claims.map((c) => c.lane)).toEqual([
			"functional-lens",
			"quality-lens",
		]);
		expect(prompts().some((p) => p.startsWith(Review.OPENING))).toBe(false);
	});

	it("with mode all, runs every lens in a session of its own and records no plan", async () => {
		const run = await start({ review: { mode: "all" } });
		expect(run.claims.map((c) => c.lane)).toEqual([
			"functional-lens",
			"quality-lens",
		]);
		expect(run.review).toBeUndefined();
		expect(trace("review")).toEqual([]);
	});

	it("with one lens, does not triage", async () => {
		const run = await start({ lenses: ["functional"] });
		expect(run.claims.map((c) => c.lane)).toEqual(["functional-lens"]);
		expect(run.review).toBeUndefined();
	});

	it("never triages a review already under way: the lenses left run one each", async () => {
		const run = await start(
			{},
			{
				claims: [
					{
						taskId: "parent",
						shortId: "K-1",
						harness: "gemini",
						lane: "functional-lens",
						sessionId: "s-functional",
						startedAt: "2026-11-14T00:00:00.000Z",
						endedAt: "2026-11-14T00:01:00.000Z",
						outcome: "done",
						continuations: 0,
						lenses: ["functional"],
					},
				],
			},
		);
		expect([run.status, run.exit?.reason]).toEqual(["completed", "plan-done"]);
		expect(run.claims.map((c) => c.lane)).toEqual([
			"functional-lens",
			"quality-lens",
		]);
		expect(run.review?.fallback).toBe("review already under way");
		expect(prompts().some((p) => p.startsWith(Review.OPENING))).toBe(false);
	});

	it("runs an interrupted triage again, in a new session", async () => {
		const run = await start(
			{},
			{
				status: "failed",
				exit: { reason: "runner-died" },
				claims: [
					{
						taskId: "parent",
						shortId: "K-1",
						harness: "gemini",
						lane: "triage",
						sessionId: "s-triage",
						startedAt: "2026-11-14T00:00:00.000Z",
						continuations: 0,
						triage: true,
					},
				],
			},
		);
		expect(run.claims.map((c) => [c.lane, c.outcome])).toEqual([
			["triage", "interrupted"],
			["triage#2", "done"],
			["functional+quality-lens", "done"],
		]);
		expect(run.review?.fallback).toBeUndefined();
	});

	it("with no base to diff against, starts no triage and runs every lens on its own", async () => {
		const run = await start({}, { base: undefined });
		expect(run.claims.map((c) => c.lane)).toEqual([
			"functional-lens",
			"quality-lens",
		]);
		expect(run.review?.fallback).toBe("no base to diff against");
		expect(trace("review")).toEqual([
			"functional: no base to diff against",
			"quality: no base to diff against",
		]);
	});

	// Git reads failing are not an empty diff: a plan made on one would skip lenses on nothing.
	it("with a diff git cannot read, starts no triage and runs every lens on its own, naming the read", async () => {
		const missing = "0123456789abcdef0123456789abcdef01234567";
		const run = await start({}, { base: { sha: missing } });
		expect([run.status, run.exit?.reason]).toEqual(["completed", "plan-done"]);
		expect(run.claims.map((c) => c.lane)).toEqual([
			"functional-lens",
			"quality-lens",
		]);
		expect(run.review?.fallback).toStartWith(
			`triage did not start: \`git diff --stat --no-color ${missing}\` failed`,
		);
		expect(prompts().some((p) => p.startsWith(Review.OPENING))).toBe(false);
	});

	it("falls back when the triage answers no plan, and the run goes on", async () => {
		const run = await start({}, {}, "not a plan");
		expect([run.status, run.exit?.reason]).toEqual(["completed", "plan-done"]);
		expect(run.claims.map((c) => c.lane)).toEqual([
			"triage",
			"functional-lens",
			"quality-lens",
		]);
		expect(run.review?.fallback).toBe("triage answered no review plan");
	});

	it("falls back when the triage edits the tree, naming the triage, and leaves its edits in place", async () => {
		writeFileSync(join(home, "triage.edits"), "");
		const run = await start({});
		expect([run.status, run.exit?.reason]).toEqual(["completed", "plan-done"]);
		expect(run.claims.map((c) => [c.lane, c.outcome])).toEqual([
			["triage", "error"],
			["functional-lens", "done"],
			["quality-lens", "done"],
		]);
		const edited =
			"the triage changed the working tree, which a triage must not do: its changes are left in place and every lens reviews in a session of its own";
		expect(run.review?.fallback).toBe(`triage error: ${edited}`);
		expect(trace("session_end")[0]).toBe(`error: ${edited}`);
		expect(readFileSync(join(home, "code.txt"), "utf8")).toBe(
			"after\nedited by the triage\n",
		);
	});
});
