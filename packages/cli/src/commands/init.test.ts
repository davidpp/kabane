import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, SCOPE_FILE } from "../config";
import { run } from "../main";
import { buildConfig } from "./init";

const BASE = { actor: "cabane://actor/human/ada", deviceId: "mbp" };

describe("buildConfig", () => {
	test("a local device: sync off, no db block", () => {
		const built = buildConfig(BASE);
		expect(built.ok && built.value).toEqual({
			...BASE,
			sync: expect.objectContaining({ enabled: false, deviceId: "mbp" }),
		});
	});

	test("sync is on only with both the url and the token", () => {
		const half = buildConfig({ ...BASE, syncUrl: "https://hub.example" });
		expect(half.ok && half.value.sync.enabled).toBe(false);
		const both = buildConfig({
			...BASE,
			syncUrl: "https://hub.example",
			syncToken: "t",
		});
		expect(both.ok && both.value.sync.enabled).toBe(true);
	});

	test("half an Access service token is refused", () => {
		expect(buildConfig({ ...BASE, accessClientId: "id" }).ok).toBe(false);
	});

	test("an empty actor fails the schema", () => {
		expect(buildConfig({ ...BASE, actor: "" }).ok).toBe(false);
	});
});

describe("init --scope on a configured device", () => {
	let home: string;
	let cwd: string;
	const env = (): Record<string, string> => ({ KABANE_HOME: home });

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "kabane-init-"));
		cwd = join(home, "project");
		mkdirSync(cwd);
		const first = await run(
			["init", "--actor", "cabane://actor/human/ada", "--device", "mbp"],
			env(),
			cwd,
		);
		expect(first.exitCode).toBe(0);
	});

	afterEach(() => rmSync(home, { recursive: true, force: true }));

	test("pins the directory's scope and leaves the config as it was", async () => {
		const before = readFileSync(configPath(home), "utf8");

		const pinned = await run(["init", "--scope", "myapp"], env(), cwd);

		expect(pinned.exitCode).toBe(0);
		expect(readFileSync(join(cwd, SCOPE_FILE), "utf8")).toBe("myapp\n");
		expect(readFileSync(configPath(home), "utf8")).toBe(before);
	});

	test("still refuses to rewrite the config without --force", async () => {
		const refused = await run(
			["init", "--scope", "myapp", "--actor", "cabane://actor/human/bob"],
			env(),
			cwd,
		);

		expect(refused.exitCode).toBe(1);
		expect(refused.text).toContain("--force");
	});
});
