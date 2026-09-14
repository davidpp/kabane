/**
 * Scripted session against the real binary: every command, human and JSON
 * output, and the exit-code contract (0 ok, 1 error, 2 usage). Each test
 * file gets its own CABANE_HOME under the OS temp dir.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

	// `--parent none` used to send an empty string, which the parent_task_id
	// foreign key rejects outright — detaching a subtask failed every time.
	it("attaches and detaches a subtask", async () => {
		const parent = json<{ id: string }>(
			await run("add", "Parent", "--scope", "home", "--json"),
		);
		const child = json<{ id: string; parentTaskId?: string }>(
			await run(
				"add",
				"Child",
				"--scope",
				"home",
				"--parent",
				parent.id,
				"--json",
			),
		);
		expect(child.parentTaskId).toBe(parent.id);

		const renamed = json<{ parentTaskId?: string }>(
			await run("edit", child.id, "--title", "Child renamed", "--json"),
		);
		expect(renamed.parentTaskId).toBe(parent.id);

		const detached = await run("edit", child.id, "--parent", "none", "--json");
		expect(detached.code).toBe(0);
		expect(
			json<{ parentTaskId?: string }>(detached).parentTaskId,
		).toBeUndefined();
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

	it("init writes Access service-token headers and the directory scope", async () => {
		const other = join(tmpdir(), `cabane-cli-init-${crypto.randomUUID()}`);
		const otherCwd = join(other, "repo");
		mkdirSync(otherCwd, { recursive: true });
		const runOther = makeRunner(other, otherCwd);
		try {
			const half = await runOther("init", "--access-client-id", "id.access");
			expect(half.code).toBe(1);
			expect(half.err).toContain("--access-client-secret");

			const r = await runOther(
				"init",
				"--sync-url",
				"http://127.0.0.1:1/",
				"--sync-token",
				"t",
				"--access-client-id",
				"id.access",
				"--access-client-secret",
				"s3cret",
				"--scope",
				"cabane",
				"--json",
			);
			expect(r.code).toBe(0);
			const shown = json<{
				config: { sync: { headers: Record<string, string> } };
				scope: string;
			}>(r);
			expect(shown.config.sync.headers["CF-Access-Client-Id"]).toBe(
				"id.access",
			);
			expect(shown.config.sync.headers["CF-Access-Client-Secret"]).toBe("***");
			expect(shown.scope).toBe("cabane");

			const saved = JSON.parse(
				readFileSync(join(other, "config.json"), "utf8"),
			) as { sync: { headers: Record<string, string> } };
			expect(saved.sync.headers).toEqual({
				"CF-Access-Client-Id": "id.access",
				"CF-Access-Client-Secret": "s3cret",
			});
			expect(readFileSync(join(otherCwd, ".cabane", "scope"), "utf8")).toBe(
				"cabane\n",
			);

			const added = await runOther("add", "Scoped by init", "--json");
			expect(added.code).toBe(0);
			expect(json<{ scopeUri: string }>(added).scopeUri).toBe(
				"jake://scope/cabane",
			);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("links a task to an external issue and drops the link again", async () => {
		const linked = await run(
			"upstream",
			"link",
			taskId,
			"https://linear.app/acme/issue/ENG-123/pancake-routing",
			"--title",
			"Pancake routing",
			"--json",
		);
		expect(linked.code).toBe(0);
		const record = json<{
			provider: string;
			identifier: string;
			title: string;
			url: string;
		}>(linked);
		// Provider and issue key are read off the URL, so the everyday call is two arguments.
		expect(record.provider).toBe("linear");
		expect(record.identifier).toBe("ENG-123");
		expect(record.title).toBe("Pancake routing");

		// The brief an agent reads carries the link as one line.
		const brief = await run("context", taskId);
		expect(brief.out).toContain("ENG-123");

		const gone = await run("upstream", "unlink", taskId, "--json");
		expect(gone.code).toBe(0);
		expect((await run("context", taskId)).out).not.toContain("ENG-123");
	});

	it("refuses a url it cannot attribute, and an unlink with nothing to drop", async () => {
		expect(
			(await run("upstream", "link", taskId, "https://jira.acme.com/x")).code,
		).toBe(2);
		expect((await run("upstream", "unlink", taskId)).code).toBe(1);
		// `open` on a task with no link fails rather than launching anything.
		expect((await run("open", taskId)).code).toBe(1);
	});

	it("exit-code contract", async () => {
		expect((await run("bogus")).code).toBe(2);
		expect((await run("upstream")).code).toBe(2);
		expect((await run("open")).code).toBe(1);
		expect((await run("show")).code).toBe(2);
		expect((await run("edit", issueId)).code).toBe(2);
		expect((await run("link", taskId, issueId)).code).toBe(2);
		expect((await run("show", "NOPE-999")).code).toBe(1);
		// The test runner is not a TTY, which is the one way board fails.
		expect((await run("board")).code).toBe(1);
		expect((await run("help")).code).toBe(0);
		expect((await run()).code).toBe(2);
		expect((await run("add", "--help")).code).toBe(0);
	});

	it("db block opens another file with a prefix; two homes share it; the default stays separate", async () => {
		const root = join(tmpdir(), `cabane-cli-db-${crypto.randomUUID()}`);
		const shared = join(root, "jake-like", "jake.db");
		const homeA = join(root, "a");
		const homeB = join(root, "b");
		const homeC = join(root, "c");
		const runA = makeRunner(homeA, root);
		const runB = makeRunner(homeB, root);
		const runC = makeRunner(homeC, root);
		mkdirSync(root, { recursive: true });
		try {
			const initA = await runA(
				"init",
				"--actor",
				"cabane://actor/human/a",
				"--device",
				"a",
				"--db-path",
				shared,
				"--table-prefix",
				"planner_",
				"--json",
			);
			expect(initA.code).toBe(0);
			const cfg = JSON.parse(
				readFileSync(join(homeA, "config.json"), "utf8"),
			) as { db?: { path?: string; tablePrefix?: string } };
			expect(cfg.db).toEqual({ path: shared, tablePrefix: "planner_" });
			expect(initA.out).toContain("planner_");

			const added = await runA("add", "Shared row", "--json");
			expect(added.code).toBe(0);
			const { shortId } = json<{ shortId: string }>(added);

			// Same file, same prefix, different CABANE_HOME: same rows.
			const initB = await runB(
				"init",
				"--device",
				"b",
				"--db-path",
				shared,
				"--table-prefix",
				"planner_",
			);
			expect(initB.code).toBe(0);
			const listB = await runB("list", "--json");
			expect(listB.code).toBe(0);
			expect(
				json<{ shortId: string }[]>(listB).map((t) => t.shortId),
			).toContain(shortId);
			expect((await runB("show", shortId)).code).toBe(0);

			// No db block: CABANE_HOME/cabane.db with plain names, nothing shared.
			expect((await runC("init", "--device", "c")).code).toBe(0);
			const cfgC = JSON.parse(
				readFileSync(join(homeC, "config.json"), "utf8"),
			) as { db?: unknown };
			expect(cfgC.db).toBeUndefined();
			expect(json<unknown[]>(await runC("list", "--json"))).toHaveLength(0);

			// Sync against a shared file is allowed but warned about.
			const initShared = await runB(
				"init",
				"--force",
				"--device",
				"b",
				"--db-path",
				shared,
				"--table-prefix",
				"planner_",
				"--sync-url",
				"http://127.0.0.1:1",
				"--sync-token",
				"t",
			);
			expect(initShared.code).toBe(0);
			const status = await runB("sync", "status");
			expect(status.code).toBe(0);
			expect(status.out).toContain("another host may already sync");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("mcp serves the same tools over stdio, with the directory scope as default", async () => {
		const transport = new StdioClientTransport({
			command: "bun",
			args: [BIN, "mcp", "--as", "cabane://actor/agent/codex"],
			cwd,
			env: { ...process.env, CABANE_HOME: home },
		});
		const client = new Client({ name: "cli-test", version: "0" });
		await client.connect(transport);
		try {
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name)).toContain("cabane_add");

			const created = await client.callTool({
				name: "cabane_add",
				arguments: { title: "Filed over stdio", kind: "issue" },
			});
			expect(created.isError).toBeFalsy();
			const task = JSON.parse(
				(created.content as { text: string }[])[0]?.text ?? "{}",
			) as { scopeUri: string; updatedBy: string; shortId: string };
			expect(task.scopeUri).toBe("jake://scope/demo");
			expect(task.updatedBy).toBe("cabane://actor/agent/codex");

			const shown = await run("show", task.shortId, "--json");
			expect(shown.code).toBe(0);
		} finally {
			await client.close();
		}
	});
});
