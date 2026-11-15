import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotInstructions } from "@cabane/acp";
import { ok, Planner, type Task } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { Settings } from "@cabane/extension";
import { Brief } from "./brief";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { Lenses } from "./lenses";
import { LoopPlan } from "./plan";
import { Runner } from "./runner";
import { Steering } from "./steering";
import { RunStore } from "./store";

let root = "";
let home = "";
let repo = "";

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "loop-lenses-"));
	home = join(root, "home");
	repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	GitFixture.run(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
	await Planner.init(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

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

const claim = (
	lens: string,
	extra: Partial<RunStore.Claim> = {},
): RunStore.Claim => ({
	taskId: "parent",
	shortId: "K-1",
	harness: "claude",
	lane: `claude:${lens}-lens`,
	sessionId: `s-${lens}`,
	startedAt: "2026-10-11T00:00:00.000Z",
	continuations: 0,
	lenses: [lens],
	...extra,
});

// The documented homes, spelled out rather than taken from `Lenses`, so a wrong path there fails.
const SKILL = ".agents/skills/dispatch/references/lenses";
const CLAUDE = ".claude/skills/dispatch/references/lenses";
const LEGACY = ".kabane/loop/lenses";

/** Lens `name`'s file in `dir`, one of the three homes, in the repo. */
const at = (dir: string, name: string): string => join(repo, dir, `${name}.md`);

const write = (dir: string, name: string, text: string): void => {
	mkdirSync(join(repo, dir), { recursive: true });
	writeFileSync(at(dir, name), text);
};

describe("Lenses.prompt", () => {
	it("ships functional and quality in kabane's dispatch template", () => {
		for (const [name, heading] of [
			["functional", "# Functional lens"],
			["quality", "# Quality lens"],
		] as const) {
			const shipped = Lenses.prompt(repo, name);
			expect(shipped.ok && shipped.value.text).toStartWith(heading);
			expect(
				existsSync(
					join(
						CopilotInstructions.DISPATCH_TEMPLATE,
						"references/lenses",
						`${name}.md`,
					),
				),
			).toBe(true);
		}
	});

	it("reads the skill's file over the old directory's, and the old directory's over the shipped one", () => {
		write(LEGACY, "functional", "# Old\n");
		const legacy = at(LEGACY, "functional");
		expect(Lenses.prompt(repo, "functional")).toEqual({
			ok: true,
			value: { text: "# Old\n", legacy, always: false },
		});
		write(SKILL, "functional", "# Skill\n");
		expect(Lenses.prompt(repo, "functional")).toEqual({
			ok: true,
			value: { text: "# Skill\n", always: false },
		});
		write(SKILL, "security", "# Security\n");
		expect(Lenses.prompt(repo, "security")).toEqual({
			ok: true,
			value: { text: "# Security\n", always: false },
		});
	});

	it("reads the skill's file under .claude/ after .agents/ and before the old directory, with no move to name", () => {
		write(LEGACY, "security", "# Old\n");
		write(CLAUDE, "security", "# Claude\n");
		expect(Lenses.prompt(repo, "security")).toEqual({
			ok: true,
			value: { text: "# Claude\n", always: false },
		});
		expect(Lenses.moves(repo, ["security"])).toEqual([]);
		write(SKILL, "security", "# Agents\n");
		expect(Lenses.prompt(repo, "security")).toEqual({
			ok: true,
			value: { text: "# Agents\n", always: false },
		});
	});

	it("reads applies and always from the frontmatter, and gives the session the text without it", () => {
		write(
			SKILL,
			"compat",
			"---\napplies: persisted rows, CLI flags and output\nalways: false\n---\n\n# Compat\n",
		);
		expect(Lenses.prompt(repo, "compat")).toEqual({
			ok: true,
			value: {
				text: "# Compat\n",
				applies: "persisted rows, CLI flags and output",
				always: false,
			},
		});
		write(SKILL, "functional", "---\nalways: true\n---\n# Functional\n");
		expect(Lenses.prompt(repo, "functional")).toEqual({
			ok: true,
			value: { text: "# Functional\n", always: true },
		});
	});

	it("takes a quoted applies line as YAML would", () => {
		write(SKILL, "docs", '---\napplies: "help: flags, docs"\n---\n# Docs\n');
		const docs = Lenses.prompt(repo, "docs");
		expect(docs.ok && docs.value.applies).toBe("help: flags, docs");
	});

	it("leaves a file with no frontmatter whole, with no applies and not always", () => {
		write(SKILL, "perf", "# Perf\n\n---\n\nA rule, not a fence.\n");
		expect(Lenses.prompt(repo, "perf")).toEqual({
			ok: true,
			value: {
				text: "# Perf\n\n---\n\nA rule, not a fence.\n",
				always: false,
			},
		});
	});

	it("gives the shipped lenses' frontmatter: functional always runs, quality says when it applies", () => {
		const functional = Lenses.prompt(repo, "functional");
		expect(functional.ok && functional.value.always).toBe(true);
		const quality = Lenses.prompt(repo, "quality");
		expect(quality.ok && quality.value.always).toBe(false);
		expect(quality.ok && quality.value.applies).toBeString();
	});

	it("refuses frontmatter it cannot read, naming the file", () => {
		const cases: [string, string][] = [
			["---\napplies: x\nruns: always\n", "no closing ---"],
			["---\napplies: x\nruns: always\n---\n# X\n", "runs"],
			["---\nalways: yes\n---\n# X\n", "always"],
			["---\napplies:\n---\n# X\n", "applies"],
			["---\njust prose\n---\n# X\n", "Expected object"],
			["---\napplies: [unclosed\n---\n# X\n", "not YAML"],
		];
		for (const [text, says] of cases) {
			write(SKILL, "odd", text);
			const odd = Lenses.prompt(repo, "odd");
			const message = !odd.ok && odd.error.message;
			expect(message).toContain(at(SKILL, "odd"));
			expect(message).toContain(says);
		}
	});

	it("refuses a lens no file holds, naming the skill's path only", () => {
		const unknown = Lenses.prompt(repo, "perf");
		const message = !unknown.ok && unknown.error.message;
		expect(message).toContain(at(SKILL, "perf"));
		expect(message).not.toContain(LEGACY);
		expect(message).not.toContain(CLAUDE);
	});

	it("offers the shipped lenses, then the project's own from the skill, its .claude/ home and the old directory, once each", () => {
		expect(Lenses.offered(repo)).toEqual(["functional", "quality"]);
		write(SKILL, "security", "# Security\n");
		write(SKILL, "quality", "# Ours\n");
		write(CLAUDE, "compat", "# Compat\n");
		write(CLAUDE, "security", "# Claude security\n");
		write(LEGACY, "perf", "# Perf\n");
		write(LEGACY, "quality", "# Old quality\n");
		writeFileSync(join(repo, SKILL, "notes.txt"), "not a lens\n");
		write(SKILL, "security_review", "# Not a name\n");
		write(SKILL, "Perf", "# Not a name\n");
		expect(Lenses.offered(repo)).toEqual([
			"functional",
			"quality",
			"compat",
			"perf",
			"security",
		]);
	});
});

describe("Lenses.moves", () => {
	it("names each lens read from the old directory and where it goes in the skill", () => {
		write(LEGACY, "security", "# Security\n");
		expect(Lenses.moves(repo, ["functional", "security", "perf"])).toEqual([
			`lens security is read from ${at(LEGACY, "security")}; move it to ${at(SKILL, "security")}`,
		]);
		write(SKILL, "security", "# Security\n");
		expect(Lenses.moves(repo, ["security"])).toEqual([]);
	});
});

describe("Lenses.status", () => {
	it("reads each lens's latest claim; an interrupted one runs again", () => {
		const status = Lenses.status(
			["functional", "quality", "security", "perf"],
			[
				claim("functional", {
					endedAt: "2026-10-11T00:01:00.000Z",
					outcome: "done",
				}),
				claim("quality"),
				claim("security", {
					endedAt: "2026-10-11T00:01:00.000Z",
					outcome: "interrupted",
				}),
			],
		);
		expect(status).toEqual({
			pending: ["security", "perf"],
			running: ["quality"],
			done: ["functional"],
			failed: [],
		});
		expect(Lenses.finished(status)).toBe(false);
		const failed = Lenses.status(
			["functional"],
			[
				claim("functional", {
					endedAt: "2026-10-11T00:01:00.000Z",
					outcome: "error",
					detail: "claude is not on PATH",
				}),
			],
		);
		expect(failed.failed).toEqual([
			{ name: "functional", detail: "error: claude is not on PATH" },
		]);
		expect(Lenses.finished(Lenses.status([], []))).toBe(true);
	});
});

describe("Lenses.status of a group", () => {
	const group = (extra: Partial<RunStore.Claim> = {}): RunStore.Claim =>
		claim("functional", { lenses: ["functional", "quality"], ...extra });
	const ended = { endedAt: "2026-10-11T00:01:00.000Z" };

	it("reads each lens of a group from the group's claim", () => {
		const names = ["functional", "quality", "docs"];
		expect(
			Lenses.status(names, [group({ ...ended, outcome: "done" })]),
		).toEqual({
			pending: ["docs"],
			running: [],
			done: ["functional", "quality"],
			failed: [],
		});
		expect(Lenses.status(names, [group()]).running).toEqual([
			"functional",
			"quality",
		]);
		expect(
			Lenses.status(names, [group({ ...ended, outcome: "interrupted" })])
				.pending,
		).toEqual(["functional", "quality", "docs"]);
		expect(
			Lenses.status(names, [
				group({ ...ended, outcome: "error", detail: "no harness" }),
			]).failed,
		).toEqual([
			{ name: "functional", detail: "error: no harness" },
			{ name: "quality", detail: "error: no harness" },
		]);
	});

	it("takes a lens's latest claim, a lone one after its group or a group after it", () => {
		const alone = claim("quality", { ...ended, outcome: "done" });
		const failed = group({ ...ended, outcome: "error" });
		expect(Lenses.status(["quality"], [failed, alone]).done).toEqual([
			"quality",
		]);
		expect(
			Lenses.status(["quality"], [alone, failed]).failed.map((f) => f.name),
		).toEqual(["quality"]);
	});
});

describe("Brief.lens", () => {
	it("tells the lens to file findings as tagged children of the parent, then gives the lens", async () => {
		const parent = await add("Ship the cache");
		const brief = Brief.lens(
			{
				runId: "run-1",
				tree: {
					worktree: false,
					isolation: "shared",
					land: "none",
					dir: home,
					branch: "",
					runBranch: "",
				},
				parent,
				lenses: [{ name: "quality", prompt: "# Quality lens\n" }],
				gates: ["check", "test"],
			},
			"the parent's own brief",
		);
		expect(brief).toContain(
			"The run's gates (`check`, `test`) have no green pass on record",
		);
		expect(brief).toContain("kabane_add");
		expect(brief).toContain(`parentTaskId "${parent.shortId}"`);
		expect(brief).toContain('tags ["finding", "<severity>", "quality"]');
		expect(brief).toContain("Do not change files");
		expect(brief.indexOf("# Quality lens")).toBeLessThan(
			brief.indexOf("the parent's own brief"),
		);
	});

	it("has a group's session review through each lens in turn, tagging each finding with one", async () => {
		const parent = await add("Ship the cache");
		const brief = Brief.lens(
			{
				runId: "run-1",
				tree: {
					worktree: false,
					isolation: "shared",
					land: "none",
					dir: home,
					branch: "",
					runBranch: "",
				},
				parent,
				lenses: [
					{ name: "functional", prompt: "# Functional lens\n" },
					{ name: "docs", prompt: "# Docs lens\n" },
				],
				gates: [],
			},
			"the parent's own brief",
		);
		expect(brief).toStartWith(
			`You are the \`functional\` and \`docs\` verifier of kabane loop run run-1 on ${parent.shortId}`,
		);
		expect(brief).toContain("through each lens below in turn");
		expect(brief).toContain(
			'tags ["finding", "<severity>", "<lens>"] where lens is the name of the lens whose definitions the finding meets (one of `functional` and `docs`)',
		);
		expect(brief).toContain(
			"One finding carries one lens tag: a defect two lenses would both flag is filed once, under the lens whose reading of it is more severe",
		);
		const at = (text: string): number => brief.indexOf(text);
		expect(at("# Lens `functional`\n\n# Functional lens")).toBeGreaterThan(0);
		expect(at("# Lens `functional`")).toBeLessThan(
			at("# Lens `docs`\n\n# Docs lens"),
		);
		expect(at("# Docs lens")).toBeLessThan(at("the parent's own brief"));
		// A lone lens's brief has neither the headings nor the tagging rule.
		const lone = Brief.lens(
			{
				runId: "run-1",
				tree: {
					worktree: false,
					isolation: "shared",
					land: "none",
					dir: home,
					branch: "",
					runBranch: "",
				},
				parent,
				lenses: [{ name: "docs", prompt: "# Docs lens\n" }],
				gates: [],
			},
			"",
		);
		expect(lone).not.toContain("# Lens `docs`");
		expect(lone).not.toContain("One finding carries one lens tag");
	});

	it("never claims gates passed in a run that has none", async () => {
		const parent = await add("Ship the cache");
		const brief = Brief.lens(
			{
				runId: "run-1",
				tree: {
					worktree: false,
					isolation: "shared",
					land: "none",
					dir: home,
					branch: "",
					runBranch: "",
				},
				parent,
				lenses: [{ name: "functional", prompt: "" }],
				gates: [],
			},
			"",
		);
		expect(brief).not.toContain("gates pass");
		expect(brief).toContain("No gates are configured for this run");
	});
});

describe("LoopPlan.findings", () => {
	it("counts what the lenses filed and how many are still open", async () => {
		const parent = await add("parent");
		await add("done work", { parentTaskId: parent.id, state: "done" });
		await add("broken", {
			parentTaskId: parent.id,
			tags: ["finding", "p1", "functional"],
		});
		await add("nit", {
			parentTaskId: parent.id,
			tags: ["finding", "p3", "quality"],
		});
		const plan = await LoopPlan.load(home, parent.id);
		expect(plan.ok && LoopPlan.findings(plan.value)).toEqual({
			total: 2,
			open: 2,
		});
	});
});

describe("Runner lenses", () => {
	// The real runner on a plan whose work is done and whose gates pass: it runs the gates, then
	// starts the lens as a session on the parent. The launch points at no harness, so the lens
	// fails without reaching one, and the run stops saying so rather than completing unreviewed.
	it("reviews only after the gates, on the parent, and a lens that fails stops the run", async () => {
		const parent = await add("parent");
		await add("child", { parentTaskId: parent.id, state: "done" });
		const config = LoopConfig.Schema.safeParse({
			gates: { ok: "true" },
			lenses: ["functional"],
		});
		if (!config.success) throw config.error;
		const created = RunStore.create(home, {
			version: 1,
			id: "run-1",
			parentId: parent.id,
			parentShortId: parent.shortId ?? parent.id,
			projectDir: repo,
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
			overrides: { claude: { command: "/nonexistent/harness" } },
			tickMs: 5,
		});
		if (!ended.ok) throw ended.error;

		expect([ended.value.status, ended.value.exit?.reason]).toEqual([
			"stopped",
			"lens-failed",
		]);
		expect(
			ended.value.claims.map((c) => [c.lenses, c.lane, c.taskId, c.outcome]),
		).toEqual([[["functional"], "functional-lens", parent.id, "error"]]);
		const events = RunStore.readEvents(home, "run-1");
		const types = events.ok ? events.value.map((e) => e.type) : [];
		expect(types.indexOf("gate_passed")).toBeLessThan(types.indexOf("claim"));
		// The run took the parent; the lens that failed leaves it as the run left it.
		const after = await Planner.getTask(home, parent.id);
		expect(after.ok && after.value?.state).toBe("in_progress");
	});

	// One review session covered both lenses: the runner counts each as reviewed, starts neither
	// again, and with nothing filed completes. A harness it reached would be the missing one.
	it("counts each lens of a group's finished claim as reviewed", async () => {
		const parent = await add("parent");
		await add("child", { parentTaskId: parent.id, state: "done" });
		const config = LoopConfig.Schema.safeParse({
			gates: { ok: "true" },
			lenses: ["functional", "quality"],
		});
		if (!config.success) throw config.error;
		const reviewed = {
			...claim("functional", {
				lenses: ["functional", "quality"],
				lane: "functional+quality-lens",
				taskId: parent.id,
				endedAt: new Date().toISOString(),
				outcome: "done",
			}),
		};
		const created = RunStore.create(home, {
			version: 1,
			id: "run-1",
			parentId: parent.id,
			parentShortId: parent.shortId ?? parent.id,
			projectDir: repo,
			config: config.data,
			status: "pending",
			createdAt: new Date().toISOString(),
			claims: [reviewed],
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
			overrides: { claude: { command: "/nonexistent/harness" } },
			tickMs: 5,
		});
		if (!ended.ok) throw ended.error;

		expect([ended.value.status, ended.value.exit?.reason]).toEqual([
			"completed",
			"plan-done",
		]);
		expect(ended.value.claims.map((c) => c.lane)).toEqual([
			"functional+quality-lens",
		]);
	});

	it("start refuses a lens with no prompt before anything runs", async () => {
		const parent = await add("parent");
		await add("child", { parentTaskId: parent.id });
		const started = await Loop.start(
			{
				home,
				basePath: home,
				kabaneBin: "/nonexistent/kabane",
				cwd: repo,
				settings: Settings.port(async () => ok([])),
				runner: () => ["/nonexistent/runner"],
			},
			{ parent: parent.id, dir: ".", config: { lenses: ["perf"] } },
		);
		expect(!started.ok && started.error.message).toContain("No lens perf");
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value).toEqual([]);
	});
});
