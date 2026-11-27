import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TABLES } from "../db/tables";
import { createMcpServer } from "../mcp/server";
import { withDb } from "../runtime";
import { LocalRelay } from "../sync/local-relay";
import { Sync } from "../sync/namespace";
import "../testing";
import { Planner } from "./index";
import { Oplog } from "./oplog";

const bases: string[] = [];

afterEach(() => {
	for (const base of bases) rmSync(base, { recursive: true, force: true });
	bases.length = 0;
});

const device = async (id: string): Promise<string> => {
	const base = mkdtempSync(join(tmpdir(), "thread-kinds-"));
	bases.push(base);
	const init = await Planner.init(base);
	if (!init.ok) throw init.error;
	const armed = await withDb(base, (db) => Oplog.initDevice(db, id));
	if (!armed.ok) throw armed.error;
	if (!armed.value.ok) throw armed.value.error;
	return base;
};

const storedState = async (base: string, id: string) => {
	const row = await withDb(base, (db) =>
		db
			.query<{ kind: string; state: string | null }, [string]>(
				`SELECT kind, state FROM ${TABLES.threads} WHERE id = ?`,
			)
			.get(id),
	);
	if (!row.ok) throw row.error;
	return row.value;
};

const mcp = async (base: string) => {
	const server = createMcpServer({
		basePath: base,
		actor: "kabane://actor/agent/claude",
		scopeRequired: false,
	});
	if (!server.ok) throw server.error;
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "thread-kinds-test", version: "0" });
	await server.value.connect(serverSide);
	await client.connect(clientSide);
	const call = async (name: string, args: Record<string, unknown>) => {
		const response = await client.callTool({ name, arguments: args });
		const [first] = response.content as { type: string; text: string }[];
		return { isError: response.isError === true, text: first?.text ?? "" };
	};
	return {
		call,
		close: async () => {
			await client.close();
			await server.value.close();
		},
	};
};

describe("thread kinds on the record", () => {
	it("files a plain thread with no state, and a workflow kind in inbox", async () => {
		const base = await device("plain");
		const plain = await Planner.addTask(base, {
			title: "Incident notes",
			kind: "thread",
		});
		if (!plain.ok) throw plain.error;
		expect(plain.value.state).toBeUndefined();
		expect(await storedState(base, plain.value.id)).toEqual({
			kind: "thread",
			state: null,
		});
		const task = await Planner.addTask(base, { title: "Still a task" });
		if (!task.ok) throw task.error;
		expect(task.value).toMatchObject({ kind: "task", state: "inbox" });

		const read = await Planner.getTask(base, plain.value.id);
		if (!read.ok) throw read.error;
		expect(read.value).toMatchObject({ kind: "thread" });
		expect(read.value?.state).toBeUndefined();

		const all = await Planner.queryTasks(base, {});
		if (!all.ok) throw all.error;
		expect(all.value.map((t) => t.title).sort()).toEqual([
			"Incident notes",
			"Still a task",
		]);
		const queue = await Planner.queryTasks(base, { state: "inbox" });
		if (!queue.ok) throw queue.error;
		expect(queue.value.map((t) => t.title)).toEqual(["Still a task"]);

		const given = await Planner.updateTask(base, plain.value.id, {
			state: "next",
		});
		if (!given.ok) throw given.error;
		expect(given.value?.state).toBe("next");
	});

	it("takes a stateless kind's state away again, and refuses that for a workflow kind", async () => {
		const base = await device("clear");
		const signal = await Planner.addTask(base, {
			title: "Disk is filling",
			kind: "signal",
			assignee: "claude",
		});
		if (!signal.ok) throw signal.error;
		const claimed = await Planner.updateTask(base, signal.value.id, {
			state: "in_progress",
		});
		if (!claimed.ok) throw claimed.error;
		const held = await Planner.claimHolder(base, signal.value.id);
		if (!held.ok) throw held.error;
		expect(held.value).not.toBeNull();
		const done = await Planner.updateTask(base, signal.value.id, {
			state: "done",
		});
		if (!done.ok) throw done.error;
		expect(done.value?.completedAt).toBeDefined();

		const cleared = await Planner.updateTask(base, signal.value.id, {
			state: null,
		});
		if (!cleared.ok) throw cleared.error;
		expect(cleared.value?.state).toBeUndefined();
		expect(cleared.value?.completedAt).toBeUndefined();
		expect(await storedState(base, signal.value.id)).toEqual({
			kind: "signal",
			state: null,
		});
		const holder = await Planner.claimHolder(base, signal.value.id);
		if (!holder.ok) throw holder.error;
		expect(holder.value).toBeNull();

		const task = await Planner.addTask(base, { title: "Still a task" });
		if (!task.ok) throw task.error;
		const refused = await Planner.updateTask(base, task.value.id, {
			state: null,
		});
		expect(refused.ok).toBe(false);
		const kept = await Planner.getTask(base, task.value.id);
		if (!kept.ok) throw kept.error;
		expect(kept.value?.state).toBe("inbox");
	});

	it("refuses a kind that is not a name, on every write path", async () => {
		const base = await device("malformed");
		const added = await Planner.addTask(base, {
			title: "Bad",
			kind: "Signal!",
		});
		expect(added.ok).toBe(false);
		const ok = await Planner.addTask(base, { title: "Good" });
		if (!ok.ok) throw ok.error;
		const edited = await Planner.updateTask(base, ok.value.id, {
			kind: "no spaces",
		});
		expect(edited.ok).toBe(false);
	});

	it("creates, reads and filters a declared kind over MCP, plain and custom in one plan", async () => {
		const base = await device("mcp");
		const server = await mcp(base);
		try {
			const added = await server.call("kabane_add", {
				title: "Error rate doubled",
				kind: "signal",
			});
			expect(added.isError).toBe(false);
			const signal = JSON.parse(added.text) as {
				id: string;
				kind: string;
				state?: string;
			};
			expect(signal.kind).toBe("signal");
			expect(signal.state).toBeUndefined();

			const applied = await server.call("kabane_apply", {
				key: "watch",
				plan: {
					threads: [
						{ key: "notes", title: "Call notes", kind: "thread" },
						{ key: "spike", title: "Latency spike", kind: "signal" },
						{ key: "fix", title: "Fix it" },
					],
				},
			});
			expect(applied.isError).toBe(false);
			expect(await storedState(base, "watch/notes")).toEqual({
				kind: "thread",
				state: null,
			});
			expect(await storedState(base, "watch/fix")).toEqual({
				kind: "issue",
				state: "inbox",
			});

			const listed = await server.call("kabane_list", {
				kind: "signal",
				responseFormat: "concise",
			});
			expect(listed.isError).toBe(false);
			expect(listed.text).toContain("Error rate doubled");
			expect(listed.text).toContain("Latency spike");
			expect(listed.text).not.toContain("Call notes");

			const got = await server.call("kabane_get", { id: signal.id });
			expect(JSON.parse(got.text)).toMatchObject({ kind: "signal" });

			const refused = await server.call("kabane_add", {
				title: "Bad",
				kind: "Not A Kind",
			});
			expect(refused.isError).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("keeps a kind no device declares, and its missing state, through sync", async () => {
		const source = await device("source");
		const peer = await device("peer");
		const relay = LocalRelay.create();
		const added = await Planner.addTask(source, {
			title: "Mystery",
			kind: "vendor.alert",
			description: "kept as written",
		});
		if (!added.ok) throw added.error;
		const pushed = await Sync.push(
			source,
			LocalRelay.transportFor(relay, "source"),
		);
		if (!pushed.ok) throw pushed.error;
		const pulled = await Sync.pull(
			peer,
			LocalRelay.transportFor(relay, "peer"),
		);
		if (!pulled.ok) throw pulled.error;
		expect(await storedState(peer, added.value.id)).toEqual({
			kind: "vendor.alert",
			state: null,
		});
		const read = await Planner.queryTasks(peer, { kind: "vendor.alert" });
		if (!read.ok) throw read.error;
		expect(read.value).toMatchObject([
			{ title: "Mystery", description: "kept as written" },
		]);
	});
});
