import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "../../index.ts");
const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

const setup = () => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "kabane-scope-")));
	folders.push(folder);
	const cwd = join(folder, "project");
	mkdirSync(cwd);
	const env = { ...process.env, KABANE_HOME: join(folder, "home") };
	const cli = (...args: string[]) => {
		const result = Bun.spawnSync([process.execPath, entry, ...args], {
			cwd,
			env,
		});
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		return result.stdout.toString().trim();
	};
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args]);
		expect(result.exitCode).toBe(0);
	};
	return { cwd, cli, git };
};

test("reports a pinned repo and its text without device setup", () => {
	const { cwd, cli, git } = setup();
	git("init", "-q");
	git("remote", "add", "origin", "https://github.com/example/remote.git");
	mkdirSync(join(cwd, ".kabane"));
	writeFileSync(join(cwd, ".kabane/scope"), "pinned\n");
	expect(JSON.parse(cli("scope", "--json"))).toEqual({
		scopeUri: "jake://scope/pinned",
		baseUri: "jake://scope/pinned",
		scopeId: "pinned",
		name: "pinned",
		root: cwd,
		extensions: {},
	});
	expect(cli("scope")).toBe(`pinned · jake://scope/pinned · ${cwd}`);
});

test("resolves a git remote without a project pin", () => {
	const { cwd, cli, git } = setup();
	git("init", "-q");
	git("remote", "add", "origin", "git@github.com:example/repo.git");
	expect(JSON.parse(cli("scope", "--json"))).toEqual({
		scopeUri: "jake://scope/github.com%2Fexample%2Frepo",
		baseUri: "jake://scope/github.com%2Fexample%2Frepo",
		scopeId: "github.com/example/repo",
		name: "repo",
		root: cwd,
		extensions: {},
	});
});

test("returns null successfully outside a project", () => {
	const { cli } = setup();
	expect(JSON.parse(cli("scope", "--json"))).toEqual({ scopeUri: null });
});

test("keeps branch and package provenance while returning the base URI", () => {
	const { cwd, cli, git } = setup();
	git("init", "-q", "-b", "feature/scope");
	git(
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-qm",
		"Initial",
		"--allow-empty",
	);
	mkdirSync(join(cwd, ".kabane"));
	writeFileSync(join(cwd, ".kabane/scope"), "pinned");
	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify({ name: "@example/app" }),
	);
	expect(JSON.parse(cli("scope", "--json"))).toEqual({
		scopeUri:
			"jake://scope/pinned?branch=feature%2Fscope&package=%40example%2Fapp",
		baseUri: "jake://scope/pinned",
		scopeId: "pinned",
		name: "pinned",
		root: cwd,
		extensions: { branch: "feature/scope", package: "@example/app" },
	});
	expect(cli("scope", "--help")).toBe("kabane scope [--json]");
	expect(JSON.parse(cli("help", "--json")).commands).toContain("scope");
});
