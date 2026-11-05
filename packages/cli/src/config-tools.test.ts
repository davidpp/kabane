import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotInstructions } from "@cabane/acp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

it("manages device config through the real stdio MCP server", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-config-mcp-"));
	const bin = join(import.meta.dir, "../index.ts");
	const env = { ...process.env, KABANE_HOME: home };
	const path = join(home, "config.json");
	const read = () => readFileSync(path, "utf8");
	const client = new Client({ name: "config-test", version: "1" });
	const cli = async (...args: string[]) => {
		const proc = Bun.spawn([process.execPath, bin, ...args, "--json"], {
			cwd: home,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, error, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(error).toBe("");
		expect(code).toBe(0);
		return JSON.parse(out) as unknown;
	};
	const call = async (
		name: string,
		args: Record<string, unknown>,
		error = false,
	) => {
		const result = z
			.object({
				isError: z.boolean().optional(),
				content: z.array(
					z.object({ type: z.literal("text"), text: z.string() }),
				),
			})
			.safeParse(await client.callTool({ name, arguments: args }));
		expect(result.success).toBe(true);
		if (!result.success) return "";
		expect(result.data.isError ?? false).toBe(error);
		return result.data.content.map((part) => part.text).join("\n");
	};
	// kabane_configGet and `config get` with a key: the effective value beside its leaves' layers.
	const valueOf = async (key: string): Promise<unknown> => {
		const got = z
			.object({
				key: z.literal(key),
				value: z.unknown(),
				leaves: z.record(z.unknown()),
			})
			.parse(JSON.parse(await call("kabane_configGet", { key })));
		expect(await cli("config", "get", key)).toEqual(got);
		return got.value;
	};
	try {
		await cli(
			"init",
			"--actor",
			"cabane://actor/human/config-test",
			"--device",
			"config-test",
		);
		// Exercise home binding when ToolContext.basePath points elsewhere.
		const dbDir = join(home, "alternate");
		await cli("config", "set", "db.path", join(dbDir, "tracker.db"));
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [bin, "mcp"],
				cwd: home,
				env,
				stderr: "pipe",
			}),
		);
		const { tools } = await client.listTools();
		expect(
			tools.find((tool) => tool.name === "kabane_configGet")?.annotations
				?.readOnlyHint,
		).toBe(true);
		expect(
			tools.find((tool) => tool.name === "kabane_configSet")?.annotations
				?.readOnlyHint,
		).toBe(false);
		const rows: Record<string, unknown>[] = JSON.parse(
			await call("kabane_configGet", {}),
		);
		expect(rows).toEqual(
			z.array(z.record(z.unknown())).parse(await cli("config", "list")),
		);
		// The copilot is told to leave alone any key these flags mark; they must be what the tool reports.
		const flags = (flag: string) =>
			rows.filter((row) => row[flag] === true).map((row) => row.key);
		expect(CopilotInstructions.SKILLS).toContain(
			"whose readOnly or protected flag is true",
		);
		for (const row of rows) {
			expect(typeof row.readOnly).toBe("boolean");
			expect(typeof row.protected).toBe("boolean");
		}
		expect(flags("readOnly")).toEqual(["actor", "deviceId", "sync.deviceId"]);
		expect(flags("protected")).toEqual(
			rows
				.map((row) => String(row.key))
				.filter((key) => /^(sync|db)(\.|$)/.test(key)),
		);
		expect(flags("protected")).toContain("sync.token");
		expect(flags("protected")).toContain("db.path");
		expect(await valueOf("timezone")).toBeNull();
		for (const [key, value, expected] of [
			["timezone", "UTC", "UTC"],
			["sync.enabled", "true", true],
			["sync.batchBytes", "4096", 4096],
			["extensions", "loop", ["loop"]],
		] as const) {
			const changed = JSON.parse(
				await call("kabane_configSet", { key, value }),
			);
			expect(changed).toMatchObject({
				key,
				value: expected,
				restartRequired: true,
			});
			expect(changed.note).toContain("Restart running board and MCP");
			expect(await valueOf(key)).toEqual(expected);
		}
		expect(existsSync(join(dbDir, "config.json"))).toBe(false);
		// A namespace key takes a layer; the server started outside any project has no scope.
		expect(
			JSON.parse(
				await call("kabane_configSet", {
					key: "loop.model",
					value: "haiku",
					layer: "user",
				}),
			),
		).toMatchObject({ key: "loop.model", layer: "user", value: "haiku" });
		expect(JSON.parse(read()).loop).toEqual({ model: "haiku" });
		expect(
			await call(
				"kabane_configSet",
				{ key: "loop.model", value: "opus", layer: "scope" },
				true,
			),
		).toContain("No scope here");
		expect(
			await call(
				"kabane_configSet",
				{ key: "timezone", value: "UTC", layer: "project" },
				true,
			),
		).toContain("it has no project layer");
		const typo = JSON.parse(
			await call("kabane_configSet", { key: "extensions", value: "loop,lopo" }),
		);
		expect(typo).toMatchObject({
			key: "extensions",
			value: ["loop", "lopo"],
			ignored: ["lopo"],
		});
		expect(typo.note).toContain("does not ship lopo");
		const secret = "hub-bearer-secret";
		const accessSecret = "access-client-secret";
		for (const [key, value] of [
			["sync.token", secret],
			[
				"sync.headers",
				JSON.stringify({ "CF-Access-Client-Secret": accessSecret }),
			],
		] as const) {
			expect(
				JSON.parse(await call("kabane_configSet", { key, value })),
			).toMatchObject({ key, value: "<set>" });
			expect(await valueOf(key)).toBe("<set>");
		}
		expect(JSON.parse(read()).sync).toMatchObject({
			token: secret,
			headers: { "CF-Access-Client-Secret": accessSecret },
		});
		const reads = [
			await call("kabane_configGet", {}),
			await call("kabane_configGet", { key: "sync" }),
			JSON.stringify(await cli("config", "list")),
			JSON.stringify(await cli("config", "get", "sync")),
		];
		for (const text of reads) {
			expect(text).not.toContain(secret);
			expect(text).not.toContain(accessSecret);
		}
		expect(JSON.parse(reads[1] ?? "").value).toMatchObject({
			token: "<set>",
			headers: "<set>",
			enabled: true,
		});
		const before = read();
		for (const key of ["actor", "deviceId", "sync.deviceId"]) {
			for (const change of [{ value: "changed" }, { unset: true }]) {
				expect(
					await call("kabane_configSet", { key, ...change }, true),
				).toContain("read-only");
				expect(read()).toBe(before);
			}
		}
		for (const args of [
			{ key: "sync.enabled", value: "yes" },
			{ key: "sync.batchBytes", value: "0" },
			{ key: "timezone", value: "Mars/Olympus" },
			{ key: "copilot.harness", value: "nosuch" },
			{ key: "sync", unset: true },
			{ key: "unknown", value: "value" },
			{ key: "timezone" },
			{ key: "timezone", value: "UTC", unset: true },
			{ key: "sync.enabled", value: true },
		]) {
			await call("kabane_configSet", args, true);
			expect(read()).toBe(before);
		}
		expect(await call("kabane_configGet", { key: "unknown" }, true)).toContain(
			"Unknown config key",
		);
		for (const key of ["sync.enabled", "extensions"]) {
			expect(
				JSON.parse(await call("kabane_configSet", { key, unset: true })),
			).toMatchObject({ key, unset: true, restartRequired: true });
		}
		expect(await valueOf("sync.enabled")).toBe(false);
		expect(await valueOf("extensions")).toBeNull();
		// Long-lived MCP reads pick up later CLI edits instead of a startup snapshot.
		await cli("config", "set", "timezone", "America/Toronto");
		expect(await valueOf("timezone")).toBe("America/Toronto");
	} finally {
		await client.close();
		rmSync(home, { recursive: true, force: true });
	}
}, 20_000);
