import { expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotInstructions } from "@cabane/acp";
import { GitFixture } from "@cabane/core/git-fixture";
import { ProjectDirs } from "@cabane/core/scope";
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
	// With a key, kabane_configGet and `config get` give the bare value, as they always have; with
	// layers, the value beside every leaf's layer.
	const valueOf = async (key: string): Promise<unknown> => {
		const layered = z
			.object({
				key: z.literal(key),
				value: z.unknown(),
				leaves: z.record(z.unknown()),
			})
			.parse(JSON.parse(await call("kabane_configGet", { key, layers: true })));
		expect(await cli("config", "get", key, "--layers")).toEqual(layered);
		expect(await cli("config", "get", key)).toEqual(layered.value);
		const bare = await call("kabane_configGet", { key });
		expect(typeof layered.value === "string" ? bare : JSON.parse(bare)).toEqual(
			layered.value,
		);
		return layered.value;
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
		// Outside any project a namespace key goes to the global layer, and there is no local one.
		expect(
			JSON.parse(
				await call("kabane_configSet", { key: "loop.model", value: "haiku" }),
			),
		).toMatchObject({ key: "loop.model", layer: "global", value: "haiku" });
		expect(JSON.parse(read()).loop).toEqual({ model: "haiku" });
		expect(
			await call(
				"kabane_configSet",
				{ key: "loop.model", value: "opus", layer: "local" },
				true,
			),
		).toContain("No project here for --layer local");
		// A former name still means its layer.
		expect(
			await call(
				"kabane_configSet",
				{ key: "timezone", value: "UTC", layer: "project" },
				true,
			),
		).toContain("it has the global layer only");
		await call(
			"kabane_configSet",
			{ key: "loop.model", value: "opus", layer: "team" },
			true,
		);
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
		expect(JSON.parse(reads[1] ?? "")).toMatchObject({
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

it("writes a project's local layer by default over stdio, and names layers the new way", async () => {
	const root = mkdtempSync(join(tmpdir(), "kabane-config-mcp-local-"));
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	GitFixture.run(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
	const env = { ...process.env, KABANE_HOME: home };
	const bin = join(import.meta.dir, "../index.ts");
	const init = Bun.spawnSync(
		[
			process.execPath,
			bin,
			"init",
			"--actor",
			"cabane://actor/human/config-test",
			"--device",
			"config-test",
		],
		{ cwd: home, env },
	);
	expect(init.exitCode).toBe(0);
	const client = new Client({ name: "config-test", version: "1" });
	const text = async (name: string, args: Record<string, unknown>) => {
		const result = z
			.object({ content: z.array(z.object({ text: z.string() })) })
			.parse(await client.callTool({ name, arguments: args }));
		return JSON.parse(result.content.map((part) => part.text).join(""));
	};
	try {
		await client.connect(
			new StdioClientTransport({
				command: process.execPath,
				args: [bin, "mcp"],
				cwd: repo,
				env,
				stderr: "pipe",
			}),
		);
		const local = join(
			home,
			"projects",
			ProjectDirs.slug(realpathSync(repo)),
			"loop.json",
		);
		expect(
			await text("kabane_configSet", { key: "loop.stallAfter", value: "7" }),
		).toMatchObject({ layer: "local", from: local, value: 7 });
		expect(
			await text("kabane_configSet", {
				key: "loop.model",
				value: "haiku",
				layer: "user",
			}),
		).toMatchObject({ layer: "global" });
		const rows: { key: string; layer: string }[] = await text(
			"kabane_configGet",
			{},
		);
		expect(rows.find((row) => row.key === "loop.stallAfter")?.layer).toBe(
			"local",
		);
		expect(rows.find((row) => row.key === "loop.model")?.layer).toBe("global");
		expect(
			await text("kabane_configGet", { key: "loop.stallAfter", layers: true }),
		).toMatchObject({
			leaves: { "loop.stallAfter": { value: 7, layer: "local", from: local } },
		});
	} finally {
		await client.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 20_000);
