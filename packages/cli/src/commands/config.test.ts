import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case spawns real `kabane config` processes, about 300 ms apiece on a CI runner, so the
// longer cases run past bun's 5 s default.
describe("config through the real CLI", () => {
	let home = "";
	const path = () => join(home, "config.json");
	const read = () => readFileSync(path(), "utf8");
	const write = (value: unknown) =>
		writeFileSync(path(), JSON.stringify(value));
	const run = async (...args: string[]) => {
		const proc = Bun.spawn(
			[process.execPath, join(import.meta.dir, "../../index.ts"), ...args],
			{
				cwd: home,
				env: { ...process.env, KABANE_HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { out: out.trim(), err: err.trim(), code };
	};
	const get = async (key: string): Promise<unknown> => {
		const result = await run("config", "get", key, "--json");
		expect(result.code).toBe(0);
		return JSON.parse(result.out);
	};
	const initial = { actor: "cabane://actor/human/tester", deviceId: "test" };

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kabane-config-"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	it("shows the path before init and directs missing-config operations to init", async () => {
		expect(await run("config", "path")).toEqual({
			code: 0,
			out: path(),
			err: "",
		});
		expect(JSON.parse((await run("config", "path", "--json")).out)).toBe(
			path(),
		);
		for (const args of [
			[],
			["list"],
			["get", "timezone"],
			["set", "timezone", "UTC"],
			["unset", "timezone"],
		]) {
			const result = await run("config", ...args, "--json");
			expect(result.code).toBe(1);
			expect(JSON.parse(result.err)).toHaveProperty(
				"error",
				expect.stringContaining("kabane init"),
			);
		}
		expect(existsSync(path())).toBe(false);
	}, 30_000);

	it("lists all keys and descriptions after init, and reads scalar, group and default values", async () => {
		expect(
			(
				await run(
					"init",
					"--actor",
					initial.actor,
					"--device",
					initial.deviceId,
				)
			).code,
		).toBe(0);
		const listed = await run("config", "--json");
		expect(listed.code).toBe(0);
		expect(await run("config", "list", "--json")).toEqual(listed);
		const rows: { key: string; description: string }[] = JSON.parse(listed.out);
		expect(rows.map((row) => row.key).sort()).toEqual(
			[
				"actor",
				"deviceId",
				"sync",
				"sync.enabled",
				"sync.url",
				"sync.token",
				"sync.deviceId",
				"sync.headers",
				"sync.batchBytes",
				"db",
				"db.path",
				"db.tablePrefix",
				"copilot",
				"copilot.harness",
				"copilot.command",
				"copilot.args",
				"copilot.model",
				"harness",
				"harness.mode",
				"timezone",
				"extensions",
			].sort(),
		);
		for (const row of rows) expect(row.description.length).toBeGreaterThan(0);
		expect((await run("config")).out).toContain("copilot.model = default");
		expect(await get("actor")).toBe(initial.actor);
		expect(await get("sync.enabled")).toBe(false);
		expect(await get("sync.batchBytes")).toBe(262144);
		expect(await get("sync")).toMatchObject({
			enabled: false,
			batchBytes: 262144,
		});
		expect(await get("timezone")).toBeNull();
		expect((await run("config", "get", "timezone")).out).toBe("default");
	}, 30_000);

	it("sets typed values without opening SQLite and preserves unknown fields at every level", async () => {
		const future = {
			future: { nested: [1, false, "keep"] },
			constructor: "preserve",
			["__proto__"]: { preserve: true },
		};
		write({
			...initial,
			...future,
			sync: { ...future },
			db: { ...future },
			copilot: { ...future },
		});
		const expected: Record<string, unknown> = {};
		for (const [key, input, value] of [
			["copilot.model", "opus", "opus"],
			["copilot.harness", "codex", "codex"],
			["copilot.command", "/custom/adapter", "/custom/adapter"],
			["copilot.args", "--model, custom", ["--model", "custom"]],
			["sync.enabled", "true", true],
			["sync.batchBytes", "4096", 4096],
			["sync.token", "false", "<set>"],
			["sync.url", "https://example.invalid", "https://example.invalid"],
			["sync.headers", '{"X-Test":"value"}', "<set>"],
			[
				"db.path",
				"/nonexistent/kabane-test/db.sqlite",
				"/nonexistent/kabane-test/db.sqlite",
			],
			["db.tablePrefix", "", ""],
			["timezone", "UTC", "UTC"],
			["extensions", "loop", ["loop"]],
		] as const) {
			const result = await run("config", "set", key, "--", input, "--json");
			expect(result.code).toBe(0);
			expect(JSON.parse(result.out)).toEqual({ key, value });
			expected[key] = value;
		}
		// One listing reads every value back through get's own lookup and redaction.
		const listed = await run("config", "list", "--json");
		expect(listed.code).toBe(0);
		const rows: { key: string; value: unknown }[] = JSON.parse(listed.out);
		expect(
			Object.fromEntries(
				rows
					.filter((row) => Object.hasOwn(expected, row.key))
					.map((row) => [row.key, row.value]),
			),
		).toEqual(expected);
		expect(JSON.parse(read())).toMatchObject({
			...future,
			sync: { ...future, token: "false", headers: { "X-Test": "value" } },
			db: future,
			copilot: future,
		});
		expect(existsSync(join(home, "kabane.db"))).toBe(false);
	}, 30_000);

	it("unsets overrides without persisting defaults or removing unknown siblings", async () => {
		write({
			...initial,
			sync: { enabled: true, batchBytes: 1, future: true },
			copilot: { model: "opus", future: true },
		});
		for (const key of [
			"sync.enabled",
			"sync.batchBytes",
			"copilot.model",
			"db.path",
			"extensions",
		]) {
			const result = await run("config", "unset", key, "--json");
			expect(result.code).toBe(0);
			expect(JSON.parse(result.out)).toEqual({ key, unset: true });
		}
		expect(JSON.parse(read())).toEqual({
			...initial,
			sync: { future: true },
			copilot: { future: true },
		});
		expect(await get("sync.enabled")).toBe(false);
		expect(await get("sync.batchBytes")).toBe(262144);
		expect(await get("copilot.model")).toBeNull();
		expect(await get("copilot.harness")).toBe("claude");
		expect((await run("config", "set", "extensions", "")).out).toBe(
			"extensions = []",
		);
		expect(await get("extensions")).toEqual([]);
	}, 30_000);

	it("creates missing groups for dotted writes and leaves absent overrides untouched", async () => {
		write(initial);
		const before = read();
		expect((await run("config", "unset", "copilot.model")).code).toBe(0);
		expect(read()).toBe(before);
		expect((await run("config", "set", "copilot.model", "opus")).code).toBe(0);
		expect((await run("config", "set", "sync.enabled", "false")).code).toBe(0);
		expect(JSON.parse(read())).toEqual({
			...initial,
			copilot: { model: "opus" },
			sync: { enabled: false },
		});
		expect(await get("copilot.harness")).toBe("claude");
	}, 30_000);

	it("refuses identity changes, group replacement, unknown paths and invalid types without touching the file", async () => {
		write({ ...initial, sync: { deviceId: "armed" } });
		const before = read();
		for (const key of ["actor", "deviceId", "sync.deviceId"]) {
			for (const verb of ["set", "unset"]) {
				const result = await run(
					"config",
					verb,
					key,
					...(verb === "set" ? ["changed"] : []),
					"--json",
				);
				expect(result.code).toBe(1);
				expect(JSON.parse(result.err)).toHaveProperty(
					"error",
					expect.stringContaining("read-only"),
				);
			}
		}
		for (const [key, value] of [
			["sync", "{}"],
			["db", "{}"],
			["copilot", "{}"],
			["sync.enabled", "yes"],
			["sync.enabled", '"false"'],
			["sync.batchBytes", "0"],
			["sync.batchBytes", "-1"],
			["sync.batchBytes", "NaN"],
			["sync.batchBytes", "1e999"],
			["sync.headers", '{"header":12}'],
			["timezone", "Mars/Olympus"],
			["copilot.model", ""],
			["copilot.harness", "nosuch"],
			["extensions", "loop,,bad"],
			["unknown", "value"],
			["sync.unknown", "value"],
			["__proto__.polluted", "true"],
			["constructor", "oops"],
		] as const)
			expect((await run("config", "set", key, value)).code).toBe(1);
		for (const key of ["sync", "db", "copilot", "unknown"])
			expect((await run("config", "unset", key)).code).toBe(1);
		expect((await run("config", "get", "sync.unknown")).code).toBe(1);
		expect(read()).toBe(before);
	}, 30_000);

	it("reports schema failures as messages, not Zod issue JSON", async () => {
		write(initial);
		for (const [key, value, expected] of [
			[
				"timezone",
				"Mars/Base",
				"Error: Invalid value for timezone: not a timezone this runtime knows (use an IANA name such as America/Montreal)",
			],
			["sync.headers", '{"a":1}', "Error: Invalid value for sync.headers: a: "],
			["sync.batchBytes", "-5", "Error: Invalid value for sync.batchBytes: "],
		] as const) {
			const result = await run("config", "set", key, value);
			expect(result.code).toBe(1);
			expect(result.err.split("\n")).toHaveLength(1);
			expect(result.err.startsWith(expected)).toBe(true);
			expect(result.err).not.toContain('"code"');
		}
		writeFileSync(path(), '{"actor":');
		for (const args of [["list"], ["set", "timezone", "UTC"]]) {
			const result = await run("config", ...args);
			expect(result.code).toBe(1);
			expect(result.err).toContain(`Invalid config at ${path()}: `);
		}
	}, 30_000);

	it("rejects malformed and invalid existing config without overwriting it", async () => {
		for (const content of [
			'{"actor":',
			JSON.stringify({ ...initial, sync: { batchBytes: -1 } }),
		]) {
			writeFileSync(path(), content);
			expect((await run("config", "set", "timezone", "UTC")).code).toBe(1);
			expect(read()).toBe(content);
		}
	}, 30_000);

	it("uses the loader's warning for unshipped extension names while keeping JSON stdout valid", async () => {
		write(initial);
		const changed = await run(
			"config",
			"set",
			"extensions",
			"loop,unshipped",
			"--json",
		);
		expect(changed.code).toBe(0);
		expect(JSON.parse(changed.out)).toEqual({
			key: "extensions",
			value: ["loop", "unshipped"],
			ignored: ["unshipped"],
		});
		expect(changed.err).toBe(
			`kabane: ignoring "unshipped" in "extensions" of ${path()}: this kabane ships loop`,
		);
		expect((await run("help")).err).toBe(changed.err);
	}, 30_000);

	it("reports usage errors for missing, extra and misspelled arguments", async () => {
		write(initial);
		for (const args of [
			["wat"],
			["get"],
			["set", "timezone"],
			["unset"],
			["list", "extra"],
			["path", "extra"],
			["get", "timezone", "extra"],
			["--typo"],
		])
			expect((await run("config", ...args, "--json")).code).toBe(2);
		const dashed = await run("config", "set", "copilot.args", "--foo,bar");
		expect(dashed.code).toBe(2);
		expect(dashed.err).toContain("Unknown config option --foo,bar");
		expect(dashed.err).toContain("kabane config set <key> -- <value>");
	}, 30_000);
});
