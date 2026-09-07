/**
 * Scripted session against the real binary: every command, human and JSON
 * output, and the exit-code contract (0 ok, 1 error, 2 usage). Each test
 * file gets its own CABANE_HOME under the OS temp dir.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "index.ts");

type Run = { code: number; out: string; err: string };

const makeRunner = (home: string, cwd: string) => {
	return async (...argv: string[]): Promise<Run> => {
		const proc = Bun.spawn(["bun", BIN, ...argv], {
			cwd,
			env: { ...process.env, CABANE_HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		return { code, out: out.trim(), err: err.trim() };
	};
};

const json = <T>(run: Run): T => JSON.parse(run.out) as T;

describe("cabane cli", () => {
	const home = join(tmpdir(), `cabane-cli-${crypto.randomUUID()}`);
	const cwd = join(home, "project");
	const run = makeRunner(home, cwd);
	let issueId = "";
	let taskId = "";

	beforeAll(() => {
		mkdirSync(join(cwd, ".cabane"), { recursive: true });
		writeFileSync(join(cwd, ".cabane", "scope"), "demo\n");
	});

	afterAll(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("refuses to run without a config", async () => {
		const r = await run("list");
		expect(r.code).toBe(1);
		expect(r.err).toContain("cabane init");
	});

	it("init writes config and creates the database", async () => {
		const r = await run(
			"init",
			"--actor",
			"cabane://actor/human/tester",
			"--device",
			"t1",
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("actor:  cabane://actor/human/tester");

		const again = await run("init");
		expect(again.code).toBe(1);
		expect(again.err).toContain("--force");
	});

	it("add picks the directory scope and returns the task as JSON", async () => {
		const r = await run(
			"add",
			"Ship the runbook",
			"--kind",
			"issue",
			"--priority",
			"high",
			"--assignee",
			"claude",
			"--tags",
			"docs,deploy",
			"--json",
		);
		expect(r.code).toBe(0);
		const task = json<{
			shortId: string;
			scopeUri: string;
			kind: string;
			provenance: { discoveredBy: string };
		}>(r);
		expect(task.scopeUri).toBe("jake://scope/demo");
		expect(task.kind).toBe("issue");
		expect(task.provenance.discoveredBy).toBe("cabane://actor/human/tester");
		issueId = task.shortId;

		const t = await run(
			"add",
			"Buy syrup",
			"--scope",
			"home",
			"--due",
			"2026-12-24",
			"--json",
		);
		expect(t.code).toBe(0);
		taskId = json<{ shortId: string; scopeUri: string; deadline: string }>(
			t,
		).shortId;
		expect(json<{ scopeUri: string }>(t).scopeUri).toBe("jake://scope/home");
		expect(
			json<{ deadline: string }>(t).deadline.startsWith("2026-12-24"),
		).toBe(true);
	});

	it("list filters by scope and hides closed by default", async () => {
		const all = await run("list", "--json");
		expect(json<unknown[]>(all)).toHaveLength(1); // directory scope "demo" applies
		const home = await run("list", "--scope", "home", "--json");
		expect(json<{ shortId: string }[]>(home)[0]?.shortId).toBe(taskId);

		await run("done", taskId);
		const open = await run("list", "--scope", "home", "--json");
		expect(json<unknown[]>(open)).toHaveLength(0);
		const closed = await run("list", "--scope", "home", "--all", "--json");
		expect(json<unknown[]>(closed)).toHaveLength(1);
	});

	it("edit, link, comment, log, show", async () => {
		const edited = await run(
			"edit",
			issueId,
			"--state",
			"next",
			"--description",
			"Five parts",
			"--json",
		);
		expect(edited.code).toBe(0);
		expect(json<{ state: string }>(edited).state).toBe("next");

		const linked = await run(
			"link",
			taskId,
			issueId,
			"--type",
			"blocks",
			"--note",
			"syrup first",
		);
		expect(linked.code).toBe(0);

		const human = await run("comment", issueId, "Starting on this", "--json");
		expect(json<{ authorType: string }>(human).authorType).toBe("human");
		const ai = await run(
			"comment",
			issueId,
			"Picked up",
			"--as",
			"cabane://actor/agent/claude",
			"--json",
		);
		expect(json<{ authorType: string; author: string }>(ai).authorType).toBe(
			"ai",
		);
		expect(json<{ author: string }>(ai).author).toBe(
			"cabane://actor/agent/claude",
		);

		const logged = await run(
			"log",
			issueId,
			"--commit",
			"abc123",
			"--ref",
			"branch:dp-x",
			"--note",
			"skeleton",
			"--json",
		);
		expect(logged.code).toBe(0);
		expect(
			json<{ refs: { uri: string }[] }>(logged)
				.refs.map((r) => r.uri)
				.sort(),
		).toEqual(["branch:dp-x", "commit:abc123"]);

		const shown = await run("show", issueId);
		expect(shown.code).toBe(0);
		expect(shown.out).toContain(`ID: ${issueId}`);
		expect(shown.out).toContain("Links:");
		expect(shown.out).toContain("Comments:");
		expect(shown.out).toContain("Work log:");
		expect(shown.out).toContain("🤖 cabane://actor/agent/claude");

		// Replication fields ride along in --json only: the edit above bumped the
		// version past 1 and stamped this device's actor as the last writer.
		const detail = json<{ task: { updatedBy?: string; version?: number } }>(
			await run("show", issueId, "--json"),
		);
		expect(detail.task.updatedBy).toBe("cabane://actor/human/tester");
		expect(detail.task.version).toBeGreaterThanOrEqual(2);
		expect(shown.out).not.toMatch(/^Version:/m);
	});

	it("search and context", async () => {
		const found = await run("search", "runbook", "--json");
		expect(json<{ shortId: string }[]>(found).map((t) => t.shortId)).toEqual([
			issueId,
		]);
		const none = await run("search", "zzz-nothing");
		expect(none.code).toBe(0);
		expect(none.out).toContain("No tasks match");

		const brief = await run("context", issueId);
		expect(brief.code).toBe(0);
		expect(brief.out).toContain(`# ${issueId}: Ship the runbook`);
		expect(brief.out).toContain("Blocked by:");
		expect(brief.out).toContain("commit:abc123");
	});

	it("sync status reports unarmed and push refuses when disabled", async () => {
		const status = await run("sync", "--json");
		expect(status.code).toBe(0);
		expect(json<{ enabled: boolean }>(status).enabled).toBe(false);
		const push = await run("sync", "push");
		expect(push.code).toBe(1);
		expect(push.err).toContain("disabled");
		const bad = await run("sync", "wat");
		expect(bad.code).toBe(2);
	});

	it("exit-code contract", async () => {
		expect((await run("bogus")).code).toBe(2);
		expect((await run("show")).code).toBe(2);
		expect((await run("edit", issueId)).code).toBe(2);
		expect((await run("link", taskId, issueId)).code).toBe(2);
		expect((await run("show", "NOPE-999")).code).toBe(1);
		// The test runner is not a TTY, which is the one way board fails.
		expect((await run("board")).code).toBe(1);
		expect((await run("mcp")).code).toBe(2);
		expect((await run("help")).code).toBe(0);
		expect((await run()).code).toBe(2);
		expect((await run("add", "--help")).code).toBe(0);
	});
});
