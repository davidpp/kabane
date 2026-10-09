import { afterAll, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { runUpdateProcess } from "../packages/cli/src/update-process";
import { sha256 } from "./release-artifact";
import { parseLocalReleaseArgs } from "./release-local";

const ROOT = resolve(import.meta.dir, ".."),
	WORK = realpathSync(
		mkdtempSync(join(tmpdir(), "kabane-local-release-test-")),
	);
afterAll(() => rmSync(WORK, { recursive: true, force: true }));
const State = z.object({
	immutable: z.boolean(),
	authenticated: z.boolean(),
	published: z.boolean(),
	integrity: z.string(),
	release: z.boolean(),
	draft: z.boolean(),
	assets: z.array(z.string()),
	writes: z.array(z.string()),
	failFinalize: z.boolean(),
	version: z.string(),
	baseline: z.string(),
	listingMode: z.enum([
		"normal",
		"stale",
		"partial",
		"duplicate",
		"oversized",
		"unauthorized",
		"publishedConflict",
		"malformed",
	]),
});
const fixtureTool = `#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
const path = process.env.LOCAL_RELEASE_FIXTURE_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
const root = process.env.LOCAL_RELEASE_FIXTURE_ROOT;
const args = process.argv.slice(2), tool = basename(process.argv[1]);
const save = () => writeFileSync(path, JSON.stringify(state));
const at = flag => args[args.indexOf(flag) + 1];
const selectedVersion = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
const directory = join(root, ".releases", selectedVersion);
const record = () => JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
if (tool === "npm") {
  if (args[0] === "--version") console.log("11.19.0");
  else if (args[0] === "pack") {
    const packed = Bun.spawnSync([process.env.LOCAL_RELEASE_REAL_NPM, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    process.stdout.write(packed.stdout); process.stderr.write(packed.stderr); process.exit(packed.exitCode);
  } else if (args[0] === "whoami") {
    if (!state.authenticated) process.exit(1);
    console.log("fixture-maintainer");
  } else if (args[0] === "view") {
    if (args[2] === "dist-tags.latest") console.log(JSON.stringify(state.published ? state.version : "0.1.0"));
    else if (args[1] === "kabane@0.1.0") console.log(JSON.stringify({ name: "kabane", version: "0.1.0", ...(state.baseline ? { gitHead: state.baseline } : {}) }));
    else if (!state.published || args[1] !== "kabane@" + state.version) { console.log(JSON.stringify({ error: { code: "E404" } })); process.exit(1); }
    else console.log(JSON.stringify({ name: "kabane", version: state.version, dist: { integrity: state.integrity } }));
  } else if (args[0] === "publish") {
    if (!state.authenticated || !args.includes("--ignore-scripts") || args[1] !== join(directory, "kabane-" + selectedVersion + ".tgz")) process.exit(1);
    if (process.env.NPM_CONFIG_USERCONFIG !== join(root, ".test-state/home/.npmrc")) process.exit(1);
    if (!readFileSync(process.env.NPM_CONFIG_USERCONFIG, "utf8").includes("fixture-config-preserved")) process.exit(1);
    state.writes.push("publish"); state.published = true; state.version = selectedVersion; state.integrity = record().integrity; save();
    console.log("Published controlled fixture archive");
  } else process.exit(1);
} else if (tool === "gh") {
  if (args[0] === "api" && args.some(value => value.endsWith("/immutable-releases"))) {
    if (args.includes("PUT")) { state.immutable = true; state.writes.push("enable-immutable"); save(); }
    else console.log(JSON.stringify({ enabled: state.immutable }));
  } else if (args[0] === "api" && args.includes("--include")) {
    const endpoint = at("--include");
    const release = { id: 1, tag_name: "v" + state.version, draft: state.draft, immutable: !state.draft && state.immutable, assets: state.assets.map(name => ({ name })) };
    const send = (body, link = "") => console.log("HTTP/2.0 200 OK\\n" + (link ? "Link: " + link + "\\n" : "") + "\\n" + JSON.stringify(body));
    if (endpoint.includes("/releases/tags/")) {
      if (!state.release || state.draft) { console.log("HTTP/2.0 404 Not Found\\n\\n{}"); process.exit(1); }
      send(release);
    } else if (endpoint === "repos/davidpp/kabane") send({ id: 12, full_name: "davidpp/kabane", permissions: { push: state.listingMode !== "unauthorized" } });
    else if (endpoint.includes("/releases?")) {
      const items = state.release ? [release] : [];
      if (state.listingMode === "stale") send([]);
      else if (state.listingMode === "partial") send(items, '<https://api.github.com/repos/davidpp/kabane/releases?per_page=100&page=2>; rel="next"');
      else if (state.listingMode === "duplicate") send([release, { ...release, id: 2 }]);
      else if (state.listingMode === "oversized") send(Array.from({ length: 101 }, (_, index) => ({ ...release, id: index + 1, tag_name: "vother-" + index })));
      else if (state.listingMode === "publishedConflict") send([{ ...release, draft: false }]);
      else if (state.listingMode === "malformed") send([{ tag_name: release.tag_name, draft: true }]);
      else send(items);
    } else process.exit(1);
  } else if (args[0] === "release" && args[1] === "create") {
    if (state.release || !args.includes("--verify-tag") || !args.includes("--draft")) process.exit(1);
    const store = join(root, ".test-state/assets"); mkdirSync(store, { recursive: true });
    for (const file of args.slice(3, args.indexOf("--repo"))) { copyFileSync(file, join(store, basename(file))); state.assets.push(basename(file)); }
    state.version = selectedVersion; state.release = true; state.draft = true; state.writes.push("draft"); save();
  } else if (args[0] === "release" && args[1] === "download") copyFileSync(join(root, ".test-state/assets", at("--pattern")), join(at("--dir"), at("--pattern")));
  else if (args[0] === "release" && args[1] === "edit") {
    if (state.failFinalize) process.exit(1);
    state.draft = false; state.writes.push("finalize"); save();
  } else process.exit(1);
} else process.exit(1);
`;
const fixtureBuild = `import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
const source = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
appendFileSync(".test-state/events", "build\\n");
mkdirSync("packages/cli/dist/bin", { recursive: true });
writeFileSync("packages/cli/dist/bin/kabane.js", '#!/usr/bin/env bun\\nconsole.log("' + source.version + '");\\n');
writeFileSync("packages/cli/dist/package.json", JSON.stringify({
  name: "kabane", version: source.version, type: "module", bin: { kabane: "bin/kabane.js" }, engines: { bun: ">=1.4.0" },
  repository: { type: "git", url: "git+https://github.com/davidpp/kabane.git" },
  dependencies: { "@opentui/core": "0.5.10", "@opentui/react": "0.5.10", react: "19.2.3" }
}));`;
const fixtureSmoke = `import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { verifyReleaseFiles } from "./release-artifact";
const directory = process.argv[3];
const verified = verifyReleaseFiles(directory);
if (!verified.ok || process.argv[2] !== "--artifact-dir") process.exit(1);
appendFileSync(".test-state/events", "smoke:" + verified.value.sha256 + "\\n");
const result = Bun.spawnSync([process.execPath, "-e", 'console.log("fixture installed-smoke boundary")']);
process.exit(result.exitCode);`;

let sequence = 0;
const createFixture = () => {
	const root = join(WORK, String(sequence++)),
		remote = join(root, ".test-state/remote.git"),
		home = join(root, ".test-state/home");
	mkdirSync(home, { recursive: true });
	const statePath = join(root, ".test-state/state.json");
	const initial: z.infer<typeof State> = {
		immutable: false,
		authenticated: false,
		published: false,
		integrity: "",
		release: false,
		draft: false,
		assets: [],
		writes: [],
		failFinalize: false,
		version: "0.1.1",
		baseline: "",
		listingMode: "normal",
	};
	writeFileSync(statePath, JSON.stringify(initial));
	writeFileSync(join(home, ".npmrc"), "# fixture-config-preserved\n");
	const tracker = join(home, ".kabane/config.json");
	mkdirSync(dirname(tracker), { recursive: true });
	writeFileSync(tracker, "invalid tracker sentinel");
	writeFileSync(
		join(root, ".gitignore"),
		".test-state/\n.releases/\nnode_modules\npackages/cli/dist/\n",
	);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "release-fixture",
			private: true,
			workspaces: ["packages/cli"],
			scripts: {
				"release:local": "bun scripts/release-local.ts",
				check: "bun scripts/fixture-stage.ts check",
				typecheck: "bun scripts/fixture-stage.ts typecheck",
				test: "bun scripts/fixture-stage.ts test",
			},
		}),
	);
	for (const file of [
		"scripts/release-local.ts",
		"scripts/release-process.ts",
		"scripts/release-version.ts",
		"scripts/release-publish.ts",
		"scripts/release-github.ts",
		"scripts/release-artifact.ts",
		"scripts/release.ts",
		"packages/cli/src/update-process.ts",
		"packages/core/result.ts",
	]) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		copyFileSync(join(ROOT, file), join(root, file));
	}
	writeFileSync(join(root, "scripts/build.ts"), fixtureBuild);
	writeFileSync(join(root, "scripts/smoke.ts"), fixtureSmoke);
	writeFileSync(
		join(root, "scripts/fixture-stage.ts"),
		'import { appendFileSync } from "node:fs"; appendFileSync(".test-state/events", process.argv[2] + "\\n");',
	);
	writeFileSync(
		join(root, "packages/cli/package.json"),
		JSON.stringify({ name: "kabane", version: "0.1.0", private: true }),
	);
	writeFileSync(join(root, ".test-state/events"), "");
	symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
	const realNpm = Bun.which("npm");
	expect(realNpm).toBeTruthy();
	const bin = join(root, ".test-state/bin");
	mkdirSync(bin);
	for (const tool of ["gh", "npm"])
		writeFileSync(join(bin, tool), fixtureTool, { mode: 0o755 });
	const env = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: home,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GITHUB_ACTIONS: "",
		PATH: `${bin}:${process.env.PATH ?? ""}`,
		NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
		NPM_CONFIG_CACHE: join(home, ".npm-cache"),
		LOCAL_RELEASE_FIXTURE_ROOT: root,
		LOCAL_RELEASE_FIXTURE_STATE: statePath,
		LOCAL_RELEASE_REAL_NPM: realNpm ?? "",
	};
	const git = (...args: string[]): string => {
		const result = Bun.spawnSync(["git", ...args], {
			cwd: root,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		return result.stdout.toString().trim();
	};
	git("init", "-b", "main");
	git("config", "user.name", "Release Fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "core.hooksPath", "/dev/null");
	git("config", "commit.gpgsign", "false");
	git("config", "tag.gpgsign", "false");
	git("add", ".");
	git("commit", "-m", "fixture source");
	git("init", "--bare", remote);
	git("remote", "add", "origin", "https://github.com/davidpp/kabane.git");
	git(
		"config",
		`url.file://${remote}.insteadOf`,
		"https://github.com/davidpp/kabane.git",
	);
	git("push", "origin", "main");
	writeFileSync(
		statePath,
		JSON.stringify({ ...initial, baseline: git("rev-parse", "HEAD") }),
	);
	const command = async (
		...args: string[]
	): Promise<{ ok: true; value: { code: number; stdout: string } }> => {
		const child = Bun.spawn(
			[process.execPath, "run", "release:local", ...args],
			{ cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { ok: true, value: { code, stdout: stdout + stderr } };
	};
	return {
		root,
		env,
		tracker,
		git,
		state: () => {
			const parsed = State.safeParse(
				JSON.parse(readFileSync(statePath, "utf8")),
			);
			expect(parsed.success).toBe(true);
			return parsed.success ? parsed.data : initial;
		},
		change: (patch: Partial<z.infer<typeof State>>): void => {
			writeFileSync(
				statePath,
				JSON.stringify({
					...JSON.parse(readFileSync(statePath, "utf8")),
					...patch,
				}),
			);
		},
		command,
		run: (mode: string, ...extra: string[]) =>
			command(mode, "--version", "0.1.1", ...extra),
		events: () => readFileSync(join(root, ".test-state/events"), "utf8"),
		directory: join(root, ".releases/0.1.1"),
	};
};

// Publication/auth/GitHub are controlled tools; Git commits/tags/pushes and npm pack are real.
// Gates and installed smoke are stage sentinels here, not evidence that the full project passed them.
test("actual local command prepares once, pauses for authentication and resumes identical bytes", async () => {
	const fixture = createFixture();
	const prepared = await fixture.run("prepare");
	if (prepared.ok && prepared.value.code !== 0)
		console.log(prepared.value.stdout);
	expect(prepared.ok && prepared.value.code).toBe(0);
	expect(prepared.ok && prepared.value.stdout).toContain("npm login");
	expect(fixture.state().writes).toEqual(["enable-immutable"]);
	expect(fixture.git("status", "--porcelain")).toBe("");
	expect(fixture.git("rev-parse", "v0.1.1^{commit}")).toBe(
		fixture.git("rev-parse", "HEAD"),
	);
	expect(fixture.git("ls-remote", "origin", "refs/tags/v0.1.1^{}")).toContain(
		fixture.git("rev-parse", "HEAD"),
	);
	const archive = join(fixture.directory, "kabane-0.1.1.tgz");
	const before = sha256(readFileSync(archive)),
		events = fixture.events();
	const again = await fixture.run("prepare");
	expect(again.ok && again.value.code).toBe(0);
	expect(fixture.events()).toBe(events);
	const unauthenticated = await fixture.run("publish");
	expect(unauthenticated.ok && unauthenticated.value.code).toBe(1);
	expect(fixture.state().writes).toEqual(["enable-immutable"]);
	fixture.change({ authenticated: true });
	const published = await fixture.run("publish");
	expect(published.ok && published.value.code).toBe(0);
	expect(fixture.state().writes).toEqual([
		"enable-immutable",
		"draft",
		"publish",
		"finalize",
	]);
	expect(fixture.events()).toBe(events);
	expect(sha256(readFileSync(archive))).toBe(before);
	const completed = await fixture.run("publish");
	expect(completed.ok && completed.value.code).toBe(0);
	expect(
		fixture.state().writes.filter((write) => write === "publish"),
	).toHaveLength(1);
	expect(readFileSync(fixture.tracker, "utf8")).toBe(
		"invalid tracker sentinel",
	);
}, 30_000);

test("default auto uses the complete release range, pins the handoff and selects a fresh next release only after completion", async () => {
	const fixture = createFixture();
	fixture.git("commit", "--allow-empty", "-m", "feat(cli): add command");
	for (let index = 0; index < 14; index++)
		fixture.git("commit", "--allow-empty", "-m", `docs: note ${index}`);
	const prepared = await fixture.command("prepare");
	expect(prepared.value.code).toBe(0);
	const directory = join(fixture.root, ".releases/0.2.0");
	const archive = readFileSync(join(directory, "kabane-0.2.0.tgz"));
	const events = fixture.events();
	expect(fixture.git("rev-parse", "v0.2.0^{commit}")).toBe(
		fixture.git("rev-parse", "HEAD"),
	);
	expect((await fixture.command("prepare")).value.code).toBe(0);
	expect((await fixture.command("publish")).value.code).toBe(1);
	expect((await fixture.command("prepare", "--bump", "patch")).value.code).toBe(
		1,
	);
	fixture.change({ authenticated: true, failFinalize: true });
	expect((await fixture.command("publish")).value.code).toBe(1);
	fixture.change({ failFinalize: false });
	expect((await fixture.command("publish")).value.code).toBe(0);
	expect((await fixture.command("publish")).value.code).toBe(0);
	expect(fixture.events()).toBe(events);
	expect(readFileSync(join(directory, "kabane-0.2.0.tgz"))).toEqual(archive);
	expect(
		fixture.state().writes.filter((write) => write === "publish"),
	).toHaveLength(1);
	fixture.git("commit", "--allow-empty", "-m", "fix: repair next release");
	expect((await fixture.command("prepare")).value.code).toBe(0);
	expect(
		existsSync(join(fixture.root, ".releases/0.2.1/verified.sha256")),
	).toBe(true);
	expect(readFileSync(join(directory, "kabane-0.2.0.tgz"))).toEqual(archive);
}, 30_000);

test("explicit semantic bumps work without auto history, and publishing never applies the bump twice", async () => {
	for (const { bump, version } of [
		{ bump: "patch", version: "0.1.1" },
		{ bump: "minor", version: "0.2.0" },
		{ bump: "major", version: "1.0.0" },
	]) {
		const fixture = createFixture();
		fixture.change({ baseline: "" });
		const prepared = await fixture.command("prepare", "--bump", bump);
		expect(prepared.value.code).toBe(0);
		expect(
			existsSync(join(fixture.root, `.releases/${version}/verified.sha256`)),
		).toBe(true);
		fixture.change({ authenticated: true });
		expect((await fixture.command("publish", "--bump", bump)).value.code).toBe(
			0,
		);
		expect((await fixture.command("publish")).value.code).toBe(0);
		expect(fixture.state().version).toBe(version);
		expect(
			fixture.state().writes.filter((write) => write === "publish"),
		).toHaveLength(1);
	}
}, 30_000);

test("auto refuses missing/conflicting baselines and unclear changes without source/settings writes", async () => {
	for (const failure of [
		"missing",
		"conflicting",
		"unknown",
		"shallow",
		"local-only",
	]) {
		const fixture = createFixture();
		fixture.git("commit", "--allow-empty", "-m", "feat: add command");
		if (failure === "missing") fixture.change({ baseline: "" });
		if (failure === "local-only") {
			fixture.git(
				"tag",
				"-a",
				"v0.1.0",
				"-m",
				"unconfirmed local baseline",
				fixture.state().baseline,
			);
			fixture.change({ baseline: "" });
		}
		if (failure === "conflicting") {
			fixture.git("tag", "-a", "v0.1.0", "-m", "wrong baseline");
			fixture.git("push", "origin", "v0.1.0");
		}
		if (failure === "unknown")
			fixture.git(
				"commit",
				"--allow-empty",
				"-m",
				"unclassified packaging change",
			);
		if (failure === "shallow")
			writeFileSync(
				join(fixture.root, ".git/shallow"),
				`${fixture.state().baseline}\n`,
			);
		const selected = await fixture.command("prepare");
		expect(selected.value.code).toBe(1);
		expect(fixture.state().writes).toEqual([]);
		expect(fixture.git("status", "--porcelain")).toBe("");
		expect(existsSync(join(fixture.root, ".releases/current.json"))).toBe(
			false,
		);
	}
}, 30_000);

test("an existing verified archive remains publishable by exact version without the new selection record", async () => {
	const fixture = createFixture();
	expect((await fixture.run("prepare")).value.code).toBe(0);
	const archive = readFileSync(join(fixture.directory, "kabane-0.1.1.tgz"));
	const events = fixture.events();
	rmSync(join(fixture.root, ".releases/current.json"));
	fixture.change({ authenticated: true });
	expect((await fixture.command("publish")).value.code).toBe(1);
	expect((await fixture.run("publish")).value.code).toBe(0);
	expect(fixture.events()).toBe(events);
	expect(readFileSync(join(fixture.directory, "kabane-0.1.1.tgz"))).toEqual(
		archive,
	);
}, 30_000);

test("corrupt selected-version state refuses without touching retained archive", async () => {
	const fixture = createFixture();
	expect((await fixture.run("prepare")).value.code).toBe(0);
	const archive = readFileSync(join(fixture.directory, "kabane-0.1.1.tgz"));
	writeFileSync(join(fixture.root, ".releases/current.json"), "invalid");
	fixture.change({ authenticated: true });
	expect((await fixture.command("publish")).value.code).toBe(1);
	expect(readFileSync(join(fixture.directory, "kabane-0.1.1.tgz"))).toEqual(
		archive,
	);
	expect(fixture.state().writes).toEqual(["enable-immutable"]);
}, 30_000);

test("actual command closes stale, partial, conflicting and oversized draft listings without npm writes", async () => {
	const fixture = createFixture();
	expect((await fixture.run("prepare")).value.code).toBe(0);
	const events = fixture.events();
	fixture.change({ authenticated: true, listingMode: "stale" });
	expect((await fixture.run("publish")).value.code).toBe(1);
	expect(fixture.state().draft).toBe(true);
	expect(fixture.state().published).toBe(false);
	for (const listingMode of [
		"partial",
		"duplicate",
		"oversized",
		"unauthorized",
		"publishedConflict",
		"malformed",
	] satisfies Array<z.infer<typeof State>["listingMode"]>) {
		fixture.change({ listingMode });
		expect((await fixture.run("publish")).value.code).toBe(1);
	}
	expect(fixture.state().writes).toEqual(["enable-immutable", "draft"]);
	fixture.change({ listingMode: "normal" });
	expect((await fixture.run("publish")).value.code).toBe(0);
	expect(fixture.events()).toBe(events);
	expect(
		fixture.state().writes.filter((write) => write === "draft"),
	).toHaveLength(1);
	expect(
		fixture.state().writes.filter((write) => write === "publish"),
	).toHaveLength(1);
}, 30_000);

test("fixed tooling publishes a retained original source checkout without accepting dirty source or CI", async () => {
	const fixture = createFixture();
	expect((await fixture.run("prepare")).value.code).toBe(0);
	fixture.change({ authenticated: true, listingMode: "stale" });
	expect((await fixture.run("publish")).value.code).toBe(1);
	fixture.change({ listingMode: "normal" });
	const events = fixture.events(),
		sourceCommit = fixture.git("rev-parse", "HEAD");
	const archive = readFileSync(join(fixture.directory, "kabane-0.1.1.tgz"));
	const tooling = join(fixture.root, ".test-state/tooling");
	fixture.git("worktree", "add", "--detach", tooling, "HEAD");
	symlinkSync(
		join(fixture.root, "node_modules"),
		join(tooling, "node_modules"),
	);
	writeFileSync(
		join(tooling, "tooling-only.md"),
		"fixed tooling source is intentionally different",
	);
	fixture.git("-C", tooling, "add", "tooling-only.md");
	fixture.git("-C", tooling, "commit", "-m", "fix: tooling only");
	expect(fixture.git("-C", tooling, "rev-parse", "HEAD")).not.toBe(
		sourceCommit,
	);
	const command = (...args: string[]) =>
		runUpdateProcess(
			[
				process.execPath,
				join(tooling, "scripts/release-local.ts"),
				"publish",
				...args,
			],
			tooling,
			fixture.env,
			30_000,
		);
	const wrong = await command();
	expect(wrong.ok && wrong.value.code).toBe(1);
	fixture.env.GITHUB_ACTIONS = "true";
	const ci = await command("--source-root", fixture.root);
	expect(ci.ok && ci.value.code).toBe(1);
	fixture.env.GITHUB_ACTIONS = "";
	writeFileSync(join(fixture.root, "unrelated-wip"), "keep");
	const dirty = await command("--source-root", fixture.root);
	expect(dirty.ok && dirty.value.code).toBe(1);
	expect(readFileSync(join(fixture.root, "unrelated-wip"), "utf8")).toBe(
		"keep",
	);
	rmSync(join(fixture.root, "unrelated-wip"));
	const published = await command("--source-root", fixture.root);
	expect(published.ok && published.value.code).toBe(0);
	expect(fixture.git("rev-parse", "HEAD")).toBe(sourceCommit);
	expect(fixture.git("status", "--porcelain")).toBe("");
	expect(fixture.events()).toBe(events);
	expect(readFileSync(join(fixture.directory, "kabane-0.1.1.tgz"))).toEqual(
		archive,
	);
	expect(
		fixture.state().writes.filter((write) => write === "publish"),
	).toHaveLength(1);
}, 30_000);

test("actual command resumes npm-success/GitHub-failure without rebuilding or republishing", async () => {
	const fixture = createFixture();
	const prepared = await fixture.run("prepare");
	if (prepared.ok && prepared.value.code !== 0)
		console.log(prepared.value.stdout);
	expect(prepared.ok && prepared.value.code).toBe(0);
	fixture.change({ authenticated: true, failFinalize: true });
	const failed = await fixture.run("publish");
	expect(failed.ok && failed.value.code).toBe(1);
	const events = fixture.events();
	expect(fixture.state().published).toBe(true);
	expect(fixture.state().draft).toBe(true);
	fixture.change({ failFinalize: false });
	const resumed = await fixture.run("publish");
	expect(resumed.ok && resumed.value.code).toBe(0);
	expect(fixture.events()).toBe(events);
	expect(
		fixture.state().writes.filter((write) => write === "publish"),
	).toHaveLength(1);
}, 30_000);

test("dirty/wrong repository and invalid CLI refuse before release writes", async () => {
	for (const input of [
		[],
		["prepare", "--bump", "minor", "--version", "0.1.1"],
		["prepare", "--source-root", "/tmp/source"],
		["publish", "--source-root"],
		["prepare", "--bump", "unknown"],
		["prepare", "--bump", "minor", "--bump", "patch"],
		["prepare", "--version", "0.1.1", "--version", "0.1.2"],
		["publish", "--version", "0.1.1", "--notes-file", "x"],
		["prepare", "--version", "../escape"],
		["prepare", "--version", "0.1.1-beta"],
		["prepare", "--version", "0.1.99999999999999999"],
	])
		expect(parseLocalReleaseArgs(input).ok).toBe(false);
	const fixture = createFixture();
	writeFileSync(join(fixture.root, "unrelated-wip"), "preserve me");
	const dirty = await fixture.run("prepare");
	expect(dirty.ok && dirty.value.code).toBe(1);
	expect(fixture.state().writes).toEqual([]);
	expect(existsSync(fixture.directory)).toBe(false);
	expect(readFileSync(join(fixture.root, "unrelated-wip"), "utf8")).toBe(
		"preserve me",
	);
	rmSync(join(fixture.root, "unrelated-wip"));
	fixture.git(
		"remote",
		"set-url",
		"origin",
		"https://github.com/example/other.git",
	);
	const wrong = await fixture.run("prepare");
	expect(wrong.ok && wrong.value.code).toBe(1);
	expect(fixture.state().writes).toEqual([]);
}, 30_000);

test("hash/source/proof/immutable mismatches prevent authentication and publication", async () => {
	const fixture = createFixture();
	const prepared = await fixture.run("prepare");
	expect(prepared.ok && prepared.value.code).toBe(0);
	fixture.change({ authenticated: true });
	const proof = join(fixture.directory, "verified.sha256"),
		saved = readFileSync(proof);
	writeFileSync(proof, "wrong");
	const unverified = await fixture.run("publish");
	expect(unverified.ok && unverified.value.code).toBe(1);
	writeFileSync(proof, saved);
	fixture.change({ immutable: false });
	const disabled = await fixture.run("publish");
	expect(disabled.ok && disabled.value.code).toBe(1);
	fixture.change({ immutable: true });
	writeFileSync(join(fixture.directory, "kabane-0.1.1.tgz"), "tampered");
	const tampered = await fixture.run("publish");
	expect(tampered.ok && tampered.value.code).toBe(1);
	expect(fixture.state().writes).toEqual(["enable-immutable"]);
}, 30_000);

test("existing tag/latest conflicts, missing preparation and CI mode fail without version/settings writes", async () => {
	const tagged = createFixture();
	tagged.git("tag", "-a", "v0.1.1", "-m", "conflicting source version");
	const conflict = await tagged.run("prepare");
	expect(conflict.ok && conflict.value.code).toBe(1);
	expect(tagged.git("status", "--porcelain")).toBe("");
	expect(tagged.state().writes).toEqual([]);
	const published = createFixture();
	published.change({ published: true });
	const duplicate = await published.run("prepare");
	expect(duplicate.ok && duplicate.value.code).toBe(1);
	expect(published.state().writes).toEqual([]);
	const missing = createFixture();
	const unprepared = await missing.run("publish");
	expect(unprepared.ok && unprepared.value.code).toBe(1);
	expect(missing.state().writes).toEqual([]);
	missing.env.GITHUB_ACTIONS = "true";
	const ci = await missing.run("prepare");
	expect(ci.ok && ci.value.code).toBe(1);
	expect(missing.state().writes).toEqual([]);
}, 30_000);

test("stale source, conflicting remote assets and an existing local lock never authorize another publish", async () => {
	const fixture = createFixture();
	const prepared = await fixture.run("prepare");
	expect(prepared.ok && prepared.value.code).toBe(0);
	fixture.change({ authenticated: true, failFinalize: true });
	const partial = await fixture.run("publish");
	expect(partial.ok && partial.value.code).toBe(1);
	fixture.change({ failFinalize: false });
	writeFileSync(
		join(fixture.root, ".test-state/assets/SHA256SUMS"),
		"conflicting remote bytes",
	);
	const conflicting = await fixture.run("publish");
	expect(conflicting.ok && conflicting.value.code).toBe(1);
	expect(
		fixture.state().writes.filter((write) => write === "publish"),
	).toHaveLength(1);
	const lock = join(fixture.root, ".releases/release.lock");
	mkdirSync(lock);
	const locked = await fixture.run("publish");
	expect(locked.ok && locked.value.code).toBe(1);
	expect(existsSync(lock)).toBe(true);
	rmSync(lock, { recursive: true });
	writeFileSync(join(fixture.root, "later-change.md"), "later source");
	fixture.git("add", "--", "later-change.md");
	fixture.git("commit", "-m", "later source");
	const stale = await fixture.run("publish");
	expect(stale.ok && stale.value.code).toBe(1);
	expect(
		fixture.state().writes.filter((write) => write === "publish"),
	).toHaveLength(1);
}, 30_000);
