import "./test-host";
// The scripted agent (packages/acp/scripts/scripted-agent.ts) that `bun run sandbox --scripted`
// launches for a loop run, given the implementing brief this loop builds, over a real subprocess,
// a real git repository and the real kabane MCP server. It recognises an implementer by the
// brief's opening words, so a change to `Brief.instructions` that it no longer matches fails here
// rather than stalling a scripted run.
import "@cabane/core/testing";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcpClient } from "@cabane/acp";
import { ok, Planner, type Task } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { Brief } from "./brief";

const ROOT = resolve(import.meta.dir, "../../..");
const AGENT = join(ROOT, "packages/acp/scripts/scripted-agent.ts");
const CLI = join(ROOT, "packages/cli/index.ts");

let home = "";
let repo = "";

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "loop-scripted-"));
	// The device the MCP server opens, as `kabane init` makes it, with no harness registered.
	const init = Bun.spawnSync([process.execPath, CLI, "init"], {
		cwd: home,
		env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" },
	});
	if (init.exitCode !== 0) throw new Error(init.stderr.toString());
	await Planner.init(home);
	repo = join(home, "repo");
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	// The agent commits with the git a harness would use; the repository's own config gives it an
	// identity and no signing on any machine.
	for (const [key, value] of [
		["user.name", "Test"],
		["user.email", "test@example.com"],
		["commit.gpgsign", "false"],
	] as const)
		GitFixture.run(repo, ["config", key, value]);
	writeFileSync(join(repo, "README.md"), "seed\n");
	GitFixture.run(repo, ["add", "-A"]);
	GitFixture.run(repo, ["commit", "-q", "-m", "seed"]);
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

const label = (task: Task): string => task.shortId ?? task.id;

it("commits once and closes its own issue through kabane MCP, given the loop's implementing brief", async () => {
	const parent = await add("parent");
	const subtask = await add("subtask", parent.id);
	const single = await add("single issue");
	const tree: Brief.Tree = {
		worktree: false,
		isolation: "shared",
		land: "none",
		dir: repo,
		branch: "",
		runBranch: "",
	};
	const brief = (of: Task, task: Task) =>
		Brief.opening(
			{ tree, runId: "r1", gates: [], concurrent: false, parent: of, task },
			"ASSEMBLED",
		);

	const conn = await AcpClient.spawn("gemini", repo, {
		overrides: { command: process.execPath, args: [AGENT] },
		onPermission: async () => ok("reject"),
		onElicitation: async () => ok({ action: "cancel" }),
	});
	if (!conn.ok) throw conn.error;
	try {
		const session = await AcpClient.newSession(conn.value, {
			cwd: repo,
			mcpServers: [
				{
					name: "kabane",
					command: process.execPath,
					args: [CLI, "mcp", "--as", "cabane://actor/agent/gemini"],
					env: { KABANE_HOME: home },
				},
			],
		});
		if (!session.ok) throw session.error;
		const said: string[] = [];
		// A subtask's brief, then a single issue's: the two ways it opens.
		for (const [of, task] of [
			[parent, subtask],
			[single, single],
		] as const)
			for await (const update of AcpClient.prompt(session.value, [
				{ type: "text", text: brief(of, task) },
			]))
				if (update.type === "text") said.push(update.text);

		const text = said.join("");
		for (const task of [subtask, single]) {
			expect(text).toContain(`Committed scripted-${label(task)}.txt.`);
			const now = await Planner.getTask(home, task.id);
			expect(now.ok && now.value?.state).toBe("done");
		}
		expect(text).not.toContain("got no answer");
		expect(
			GitFixture.run(repo, ["log", "--format=%s"]).trim().split("\n"),
		).toEqual([
			`${label(single)}: scripted change`,
			`${label(subtask)}: scripted change`,
			"seed",
		]);
	} finally {
		AcpClient.close(conn.value);
		await conn.value.closed;
	}
}, 30_000);
