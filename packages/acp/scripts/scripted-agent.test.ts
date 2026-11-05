import { expect, it } from "bun:test";
import { ok } from "@cabane/core";
import { AcpClient } from "../src/client";

it("keeps scripted call ids unique across turns and matches their updates", async () => {
	const asks: string[] = [];
	const forms: string[] = [];
	const conn = await AcpClient.spawn("claude", import.meta.dir, {
		overrides: {
			command: process.execPath,
			args: [`${import.meta.dir}/scripted-agent.ts`],
		},
		onPermission: async (request) => {
			asks.push(request.toolCallId);
			return ok(asks.length === 1 ? "allow" : "reject");
		},
		onElicitation: async (request) => {
			expect(request.toolCallId).toBeDefined();
			if (request.toolCallId) forms.push(request.toolCallId);
			return ok({ action: "cancel" });
		},
	});
	if (!conn.ok) throw conn.error;
	try {
		const session = await AcpClient.newSession(conn.value, {
			cwd: import.meta.dir,
			mcpServers: [],
		});
		if (!session.ok) throw session.error;
		const calls: string[] = [];
		const ends: string[] = [];
		const statuses: string[] = [];
		for (let round = 0; round < 2; round++) {
			for (const text of [
				"ask permission",
				"tools",
				"ask form",
				"ask multi",
				"ask text",
			]) {
				for await (const update of AcpClient.prompt(session.value, [
					{ type: "text", text },
				])) {
					expect(update.type).not.toBe("error");
					if (update.type === "tool_call") calls.push(update.id);
					if (update.type === "tool_call_update") {
						ends.push(update.id);
						if (update.status) statuses.push(update.status);
					}
				}
			}
		}
		expect(calls).toHaveLength(8);
		expect(ends).toEqual(calls);
		expect(asks).toHaveLength(2);
		expect(asks[0]).toBe(calls[0]);
		expect(asks[1]).toBe(calls[4]);
		expect(statuses[0]).toBe("completed");
		expect(statuses[4]).toBe("failed");
		expect(forms).toHaveLength(6);
		expect(new Set([...calls, ...forms]).size).toBe(14);
	} finally {
		AcpClient.close(conn.value);
		await conn.value.closed;
	}
}, 15_000);
