/**
 * The hub as an MCP server and as a sync device, through the edge.
 *
 * MCP: initialize, tools/list, tools/call for every tool, over Streamable HTTP
 * with the Access assertion the edge maps to an actor.
 *
 * Sync round trip, both directions, without bun:sqlite (unavailable under
 * pool-workers): a write at the hub is pushed to `CabaneLog` and shows up on
 * a device's `/pull`; an op pushed by a device is applied by the hub's alarm
 * and shows up in `cabane_list`. The device-side op is derived from one the
 * hub itself emitted, so the payload shape is exactly what a real device sends.
 */

import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { HUB_NAME } from "./names";
import { HERMES, HUMAN, withAccess } from "./test-access";
import type { PullPage, PushAck } from "./wire";

const TOKEN = env.SYNC_TOKEN ?? "";

type JsonRpc = {
	jsonrpc: "2.0";
	id?: number;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

let nextId = 1;

const rpc = async (
	token: string,
	method: string,
	params: Record<string, unknown> = {},
): Promise<{ status: number; body: JsonRpc }> => {
	const res = await SELF.fetch("https://cabane.test/mcp", {
		method: "POST",
		headers: withAccess(token, {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		}),
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
	const text = await res.text();
	return {
		status: res.status,
		body: text ? (JSON.parse(text) as JsonRpc) : { jsonrpc: "2.0" },
	};
};

const callTool = async (
	token: string,
	name: string,
	args: Record<string, unknown> = {},
): Promise<{ isError: boolean; value: unknown }> => {
	const { status, body } = await rpc(token, "tools/call", {
		name,
		arguments: args,
	});
	expect(status).toBe(200);
	const result = body.result as {
		isError?: boolean;
		content: { type: string; text: string }[];
	};
	const text = result.content[0]?.text ?? "";
	return {
		isError: result.isError === true,
		value: result.isError ? text : JSON.parse(text),
	};
};

const log = (
	path: "/push" | "/pull",
	body: unknown,
	deviceToken: string = HERMES,
): Promise<Response> =>
	SELF.fetch(`https://cabane.test${path}`, {
		method: "POST",
		headers: withAccess(deviceToken, {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
		}),
		body: JSON.stringify(body),
	});

type TaskLike = {
	id: string;
	title: string;
	shortId?: string;
	updatedBy?: string;
	version?: number;
	state: string;
};

describe("hub MCP over Streamable HTTP", () => {
	it("refuses without an assertion, and refuses GET", async () => {
		const noAuth = await SELF.fetch("https://cabane.test/mcp", {
			method: "POST",
			body: "{}",
		});
		expect(noAuth.status).toBe(401);

		const get = await SELF.fetch("https://cabane.test/mcp", {
			headers: withAccess(HUMAN),
		});
		expect(get.status).toBe(405);
	});

	it("initializes with server instructions", async () => {
		const { status, body } = await rpc(HUMAN, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		});
		expect(status).toBe(200);
		const result = body.result as {
			serverInfo: { name: string };
			instructions?: string;
		};
		expect(result.serverInfo.name).toBe("cabane-hub");
		expect(result.instructions).toContain("cabane_scopeList");
	});

	it("lists the replicated-surface tools and no session tools", async () => {
		const { body } = await rpc(HUMAN, "tools/list");
		const names = (body.result as { tools: { name: string }[] }).tools.map(
			(t) => t.name,
		);
		expect(names).toContain("cabane_add");
		expect(names).toContain("cabane_context");
		expect(names).toContain("cabane_scopeList");
		expect(names.some((n) => n.toLowerCase().includes("session"))).toBe(false);
	});

	it("requires a scope on writes at the hub", async () => {
		const bad = await callTool(HUMAN, "cabane_add", { title: "no scope" });
		expect(bad.isError).toBe(true);
		expect(String(bad.value)).toContain("cabane_scopeList");
	});

	it("stamps the Access identity as the actor: human and service", async () => {
		const human = await callTool(HUMAN, "cabane_add", {
			title: "Filed by David",
			scopeUri: "cabane",
		});
		expect(human.isError).toBe(false);
		expect((human.value as TaskLike).updatedBy).toBe(
			"cabane://actor/human/david",
		);

		const service = await callTool(HERMES, "cabane_add", {
			title: "Filed by Hermes",
			kind: "issue",
			state: "next",
			assignee: "claude",
			scopeUri: "cabane",
		});
		expect(service.isError).toBe(false);
		const issue = service.value as TaskLike;
		expect(issue.updatedBy).toBe("cabane://actor/agent/hermes");
		expect(issue.shortId).toMatch(/^JCAB-\d+$/);

		const comment = await callTool(HERMES, "cabane_comment", {
			id: issue.id,
			content: "from hermes",
		});
		expect((comment.value as { authorType: string }).authorType).toBe("ai");
	});

	it("runs every tool once", async () => {
		const a = (
			await callTool(HUMAN, "cabane_add", {
				title: "Alpha searchable",
				scopeUri: "tools",
				kind: "issue",
				state: "next",
				assignee: "claude",
			})
		).value as TaskLike;
		const b = (
			await callTool(HUMAN, "cabane_add", { title: "Beta", scopeUri: "tools" })
		).value as TaskLike;

		expect(
			((await callTool(HUMAN, "cabane_get", { id: a.id })).value as TaskLike)
				.title,
		).toBe("Alpha searchable");

		const queue = (
			await callTool(HUMAN, "cabane_list", {
				assignee: "claude",
				state: "next",
				scopeUri: "tools",
			})
		).value as TaskLike[];
		expect(queue.map((t) => t.id)).toEqual([a.id]);

		const found = (
			await callTool(HUMAN, "cabane_search", {
				query: "searchable",
				scopeUri: "tools",
			})
		).value as TaskLike[];
		expect(found.map((t) => t.id)).toEqual([a.id]);

		const today = (await callTool(HUMAN, "cabane_today", {})).value as {
			next: TaskLike[];
		};
		expect(Array.isArray(today.next)).toBe(true);

		const scopes = (await callTool(HUMAN, "cabane_scopeList")).value as {
			scopeId: string;
		}[];
		expect(scopes.map((s) => s.scopeId)).toContain("tools");

		expect(
			(
				await callTool(HUMAN, "cabane_link", {
					sourceId: a.id,
					targetId: b.id,
					type: "blocks",
				})
			).isError,
		).toBe(false);

		const edited = (
			await callTool(HUMAN, "cabane_edit", {
				id: a.shortId ?? a.id,
				state: "in_progress",
			})
		).value as TaskLike;
		expect(edited.state).toBe("in_progress");
		expect(edited.version).toBe(2);

		expect(
			(
				await callTool(HUMAN, "cabane_log", {
					id: a.id,
					refs: [{ uri: "commit:deadbeef" }],
				})
			).isError,
		).toBe(false);

		const ref = (
			await callTool(HUMAN, "cabane_contextAdd", {
				id: a.id,
				uri: "file:docs/auth.md",
				kind: "ADR",
			})
		).value as { id: string };
		const refs = (await callTool(HUMAN, "cabane_contextList", { id: a.id }))
			.value as { id: string }[];
		expect(refs.map((r) => r.id)).toEqual([ref.id]);
		expect(
			(await callTool(HUMAN, "cabane_contextRemove", { refId: ref.id }))
				.isError,
		).toBe(false);

		const brief = (await callTool(HUMAN, "cabane_context", { id: a.id }))
			.value as { markdown: string };
		expect(brief.markdown).toContain("Alpha searchable");

		expect(
			((await callTool(HUMAN, "cabane_done", { id: a.id })).value as TaskLike)
				.state,
		).toBe("done");
	});
});

describe("hub as sync device cloud", () => {
	it("pushes an MCP write to the log, where a device can pull it", async () => {
		const created = (
			await callTool(HUMAN, "cabane_add", {
				title: "Replicated from the hub",
				scopeUri: "sync",
			})
		).value as TaskLike;
		expect(created.updatedBy).toBe("cabane://actor/human/david");

		// The post-write push runs in waitUntil; a direct pass makes it deterministic.
		const hub = env.CABANE_HUB.getByName(HUB_NAME);
		const pass = await hub.syncNow();
		expect(pass.push.ok).toBe(true);

		const page = await (
			await log("/pull", { deviceId: "device-a", sinceSeq: 0, limit: 1000 })
		).json<PullPage>();
		const titles = page.ops
			.map((o) => JSON.parse(o.payload))
			.filter((op) => op.deviceId === "cloud" && op.tbl === "tasks")
			.map((op) => op.payload?.title);
		expect(titles).toContain("Replicated from the hub");
		expect(
			page.ops.every((o) => JSON.parse(o.payload).deviceId !== "device-a"),
		).toBe(true);
	});

	it("applies a device's op on the alarm and reschedules", async () => {
		// Seed the log with a real-shaped insert: take one the hub emitted and
		// re-author it as device-a with a fresh identity and title.
		const seed = (
			await callTool(HUMAN, "cabane_add", {
				title: "Template",
				scopeUri: "sync",
			})
		).value as TaskLike;
		const hub = env.CABANE_HUB.getByName(HUB_NAME);
		await hub.syncNow();

		const page = await (
			await log("/pull", { deviceId: "device-a", sinceSeq: 0, limit: 1000 })
		).json<PullPage>();
		const template = page.ops
			.map((o) => JSON.parse(o.payload))
			.find((op) => op.tbl === "tasks" && op.payload?.id === seed.id);
		expect(template).toBeDefined();

		const rowId = `01DEVICEA${crypto.randomUUID().replace(/-/g, "").slice(0, 17).toUpperCase()}`;
		const now = new Date().toISOString();
		const foreign = {
			...template,
			opId: `device-a:${rowId}`,
			deviceId: "device-a",
			rowId,
			rowUpdatedAt: now,
			updatedBy: "cabane://actor/human/david",
			capturedAt: now,
			payload: {
				...template.payload,
				id: rowId,
				short_id: "JSYN-9001",
				title: "Written on device-a",
				updated_by: "cabane://actor/human/david",
				created_at: now,
				updated_at: now,
			},
		};
		const ack = await (
			await log("/push", { deviceId: "device-a", ops: [foreign] })
		).json<PushAck>();
		expect(ack.accepted).toBe(1);

		expect(await hub.nextAlarm()).not.toBeNull();
		expect(await runDurableObjectAlarm(hub)).toBe(true);
		expect(await hub.nextAlarm()).not.toBeNull();

		const listed = (
			await callTool(HUMAN, "cabane_list", {
				scopeUri: "sync",
				includeClosed: true,
			})
		).value as TaskLike[];
		expect(listed.map((t) => t.title)).toContain("Written on device-a");
		const applied = listed.find((t) => t.title === "Written on device-a");
		expect(applied?.updatedBy).toBe("cabane://actor/human/david");
	});
});
