import { env, runInDurableObject } from "cloudflare:test";
import { KABANE_TOOLS, Runtime, type ToolDef } from "@cabane/core";
import { expect, it } from "vitest";
import { DoDb } from "./db-do";
import { type CabaneHub, HUB_BASE } from "./hub";
import { handleHttpRequest } from "./mcp-http";

it("answers 500 with the duplicate tool error before serving Streamable HTTP", async () => {
	const hub = env.CABANE_HUB.getByName("http-tool-collision");
	await runInDurableObject(hub, async (_instance: CabaneHub, ctx) => {
		const core = KABANE_TOOLS[0];
		if (!core) throw new Error("Missing core tools");
		const tools: ToolDef[] = [];
		const configured = Runtime.configure({
			provider: DoDb.provider(ctx.storage),
			modules: [{ name: "collision", tools }],
		});
		if (!configured.ok) throw configured.error;
		// A module can mutate its tool array after registration succeeds.
		tools.push(core);
		try {
			const response = await handleHttpRequest(
				{
					basePath: HUB_BASE,
					actor: "cabane://actor/agent/test",
					scopeRequired: true,
				},
				new Request("https://cabane.test/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "initialize",
						params: {
							protocolVersion: "2025-06-18",
							capabilities: {},
							clientInfo: { name: "test", version: "0" },
						},
					}),
				}),
			);
			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({
				error: `Duplicate MCP tool name: ${core.name}. Rename the module or host tool.`,
			});
		} finally {
			tools.length = 0;
		}
	});
});
