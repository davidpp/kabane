import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { GitFixture } from "@cabane/core/git-fixture";
import { ProjectDirs } from "@cabane/core/scope";
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
		GitFixture.run(cwd, ["init", "-q"]);
		const first = await run(
			["init", "--actor", "cabane://actor/human/ada", "--device", "mbp"],
			env(),
			cwd,
		);
		expect(first.exitCode).toBe(0);
	});

	afterEach(() => rmSync(home, { recursive: true, force: true }));

	const scopeOf = async (dir: string): Promise<string> => {
		const out = await run(["scope"], env(), dir);
		return (out.json as { scopeId: string }).scopeId;
	};

	test("pins the project's scope under KABANE_HOME, leaving the repo and the config as they were", async () => {
		const before = readFileSync(configPath(home), "utf8");

		const pinned = await run(["init", "--scope", "myapp"], env(), cwd);

		expect(pinned.exitCode).toBe(0);
		const local = join(ProjectDirs.of(home, realpathSync(cwd)), "scope");
		expect(readFileSync(local, "utf8")).toBe("myapp\n");
		expect(pinned.text).toContain(local);
		expect(existsSync(join(cwd, ".kabane"))).toBe(false);
		expect(readFileSync(configPath(home), "utf8")).toBe(before);
		expect(await scopeOf(cwd)).toBe("myapp");
	});

	test("--shared pins in the repo, and your own pin still wins", async () => {
		expect((await run(["init", "--scope", "mine"], env(), cwd)).exitCode).toBe(
			0,
		);

		const shared = await run(
			["init", "--scope", "team", "--shared"],
			env(),
			cwd,
		);

		expect(shared.exitCode).toBe(0);
		expect(readFileSync(join(cwd, SCOPE_FILE), "utf8")).toBe("team\n");
		expect(await scopeOf(cwd)).toBe("mine");
		rmSync(join(ProjectDirs.of(home, realpathSync(cwd)), "scope"));
		expect(await scopeOf(cwd)).toBe("team");
	});

	test("refuses a local pin outside any project", async () => {
		const loose = mkdtempSync(join(tmpdir(), "kabane-loose-"));
		try {
			const refused = await run(["init", "--scope", "myapp"], env(), loose);
			expect(refused.exitCode).toBe(1);
			expect(refused.text).toContain("--shared");
		} finally {
			rmSync(loose, { recursive: true, force: true });
		}
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
