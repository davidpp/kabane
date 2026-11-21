import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateNotice } from "./update-notice";

// A real releases API on localhost answering GitHub's shape from made-up releases, set per test:
// `/releases` lists them newest first, and `/releases/latest` is the newest that is neither a
// draft nor a prerelease, as GitHub picks it. `fail` makes one of the two paths answer otherwise.
type Release = { tag_name: string; draft: boolean; prerelease: boolean };
type Failure = { status: number; body: string; delayMs?: number };
type Answer = {
	releases: Release[];
	fail?: { path: "/releases" | "/releases/latest" } & Failure;
	delayMs?: number;
};
let answer: Answer = { releases: [] };
// What each request asked, read in the handler: Bun recycles a Request once it is answered.
const requests: { path: string; userAgent: string | null }[] = [];
const api = Bun.serve({
	port: 0,
	fetch: async (request) => {
		const path = new URL(request.url).pathname;
		requests.push({ path, userAgent: request.headers.get("user-agent") });
		const { fail } = answer;
		const delayMs = fail?.path === path ? fail.delayMs : answer.delayMs;
		if (delayMs) await Bun.sleep(delayMs);
		if (fail?.path === path)
			return new Response(fail.body, { status: fail.status });
		if (path === "/releases") return Response.json(answer.releases);
		const latest = answer.releases.find(
			(release) => !release.draft && !release.prerelease,
		);
		if (path === "/releases/latest" && latest) return Response.json(latest);
		return Response.json({ message: "Not Found" }, { status: 404 });
	},
});
afterAll(() => api.stop(true));

const release = (
	version: string,
	kind: "release" | "prerelease" | "draft" = "release",
): Release => ({
	tag_name: `v${version}`,
	draft: kind === "draft",
	prerelease: kind === "prerelease",
});
/** Releases with `latest` the newest stable one and `beta`, when given, a prerelease. */
const releases = (latest: string, beta?: string): Answer => ({
	releases: [...(beta ? [release(beta, "prerelease")] : []), release(latest)],
});

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
let home = "";
const cacheFile = (): string => join(home, UpdateNotice.FILE);
const seed = (cache: Record<string, unknown>): void =>
	writeFileSync(cacheFile(), JSON.stringify(cache));
const check = (version: string, over: { timeoutMs?: number } = {}) =>
	UpdateNotice.check({
		home,
		version,
		now: NOW,
		api: `${api.url.origin}/releases`,
		...over,
	});

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "kabane-update-notice-"));
	requests.length = 0;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("the candidate follows the install's channel, within its major and its 0.x minor", () => {
	const { candidate } = UpdateNotice;
	expect(candidate("1.0.0", { latest: "1.2.0" })).toBe("1.2.0");
	expect(candidate("1.2.0", { latest: "1.2.0" })).toBeUndefined();
	expect(candidate("1.2.0", { latest: "1.1.0" })).toBeUndefined();
	expect(candidate("1.2.0", { latest: "2.0.0" })).toBeUndefined();
	expect(candidate("0.3.0", { latest: "0.3.4" })).toBe("0.3.4");
	expect(candidate("0.3.0", { latest: "0.4.0" })).toBeUndefined();
	// A stable install never hears of a beta, nor of a prerelease put on latest.
	expect(
		candidate("1.0.0", { latest: "1.0.0", beta: "1.1.0-beta.0" }),
	).toBeUndefined();
	expect(candidate("1.0.0", { latest: "1.1.0-rc.1" })).toBeUndefined();
	// A beta install takes the higher of beta and latest.
	expect(
		candidate("1.0.0-beta.0", { latest: "0.3.0", beta: "1.0.0-beta.2" }),
	).toBe("1.0.0-beta.2");
	expect(
		candidate("1.0.0-beta.0", { latest: "1.0.0", beta: "1.0.0-beta.2" }),
	).toBe("1.0.0");
	expect(candidate("1.0.0-beta.0", { latest: "0.3.0" })).toBeUndefined();
});

test("a cache under a day old answers without asking the releases API", async () => {
	seed({ checkedAt: new Date(NOW - 23 * HOUR).toISOString(), latest: "1.4.0" });
	answer = releases("1.9.0");
	expect(await check("1.0.0")).toBe("1.4.0");
	expect(requests).toHaveLength(0);
});

test("an older cache is read again from the releases API and written back", async () => {
	seed({ checkedAt: new Date(NOW - 25 * HOUR).toISOString(), latest: "1.4.0" });
	answer = releases("1.5.0", "1.6.0-beta.1");
	expect(await check("1.0.0")).toBe("1.5.0");
	expect(requests).toEqual([
		{ path: "/releases/latest", userAgent: "kabane/1.0.0" },
		{ path: "/releases", userAgent: "kabane/1.0.0" },
	]);
	expect(JSON.parse(readFileSync(cacheFile(), "utf8"))).toEqual({
		latest: "1.5.0",
		beta: "1.6.0-beta.1",
		checkedAt: new Date(NOW).toISOString(),
	});
	// Written, the next check is answered from it.
	expect(await check("1.0.0")).toBe("1.5.0");
	expect(requests).toHaveLength(2);
});

test("latest skips drafts and prereleases, and beta is the highest published beta", async () => {
	answer = {
		releases: [
			release("2.0.0", "draft"),
			release("1.3.0-rc.1", "prerelease"),
			release("1.3.0-beta.2", "draft"),
			release("1.2.0-beta.9", "prerelease"),
			release("1.2.0-beta.10", "prerelease"),
			release("1.1.0"),
			release("1.2.0-beta.3", "prerelease"),
			release("1.0.0"),
		],
	};
	expect(await check("1.0.0")).toBe("1.1.0");
	expect(JSON.parse(readFileSync(cacheFile(), "utf8"))).toEqual({
		latest: "1.1.0",
		beta: "1.2.0-beta.10",
		checkedAt: new Date(NOW).toISOString(),
	});
	expect(await check("1.0.0-beta.0")).toBe("1.2.0-beta.10");
	// No beta among the prereleases: the cache names latest alone.
	rmSync(cacheFile());
	answer = {
		releases: [release("1.2.0-rc.1", "prerelease"), release("1.1.0")],
	};
	expect(await check("1.0.0-beta.0")).toBe("1.1.0");
	expect(JSON.parse(readFileSync(cacheFile(), "utf8"))).toEqual({
		latest: "1.1.0",
		checkedAt: new Date(NOW).toISOString(),
	});
});

test("no cache, a cache dated in the future, or a corrupt one, is read from the releases API", async () => {
	answer = releases("1.1.0");
	expect(await check("1.0.0")).toBe("1.1.0");
	seed({ checkedAt: new Date(NOW + HOUR).toISOString(), latest: "1.4.0" });
	expect(await check("1.0.0")).toBe("1.1.0");
	writeFileSync(cacheFile(), "{ not json");
	expect(await check("1.0.0")).toBe("1.1.0");
	expect(requests).toHaveLength(6);
});

test("a releases API that fails says nothing and leaves the cache as it was", async () => {
	const failures: Answer["fail"][] = [
		{ path: "/releases/latest", status: 500, body: "boom" },
		{ path: "/releases/latest", status: 200, body: "<html>" },
		{
			path: "/releases/latest",
			status: 200,
			body: JSON.stringify(release("not-a-version")),
		},
		// A latest that reads but a list that does not fails the whole check, beta and all.
		{ path: "/releases", status: 403, body: "rate limited" },
		{ path: "/releases", status: 200, body: JSON.stringify({}) },
	];
	for (const fail of failures) {
		answer = { ...releases("1.1.0", "1.2.0-beta.0"), fail };
		expect(await check("1.0.0")).toBeUndefined();
		expect(existsSync(cacheFile())).toBe(false);
	}
	// No stable release yet: GitHub answers 404 for latest.
	answer = { releases: [release("1.2.0-beta.0", "prerelease")] };
	expect(await check("1.0.0-beta.0")).toBeUndefined();
	expect(existsSync(cacheFile())).toBe(false);
	// A stale cache stays byte for byte, and still names what it knew.
	seed({ checkedAt: new Date(NOW - 48 * HOUR).toISOString(), latest: "1.3.0" });
	const before = readFileSync(cacheFile(), "utf8");
	answer = {
		...releases("1.4.0"),
		fail: { path: "/releases", status: 503, body: "" },
	};
	expect(await check("1.0.0")).toBe("1.3.0");
	expect(readFileSync(cacheFile(), "utf8")).toBe(before);
});

test("a releases API slower than the timeout, or not there at all, says nothing", async () => {
	answer = { ...releases("1.1.0"), delayMs: 500 };
	expect(await check("1.0.0", { timeoutMs: 50 })).toBeUndefined();
	const gone = Bun.serve({ port: 0, fetch: () => new Response("") });
	const origin = gone.url.origin;
	await gone.stop(true);
	expect(
		await UpdateNotice.check({
			home,
			version: "1.0.0",
			api: `${origin}/releases`,
		}),
	).toBeUndefined();
	expect(existsSync(cacheFile())).toBe(false);
});

test("the line names what this install runs to take the release", async () => {
	const { install, line } = UpdateNotice;
	const mise = join(home, "mise/installs/kabane/1.0.0/kabane");
	const github = join(home, "mise/installs/github-davidpp-kabane/1.0.0/kabane");
	const brew = join(home, "homebrew/Cellar/kabane/1.0.0/libexec");
	const opt = join(home, "opt/kabane");
	for (const dir of [mise, github, brew, opt]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "kabane"), "");
	}
	const binary = (executable: string) =>
		install({
			compiled: true,
			executable,
			bun: process.execPath,
			env: { HOME: home, MISE_DATA_DIR: join(home, "mise") },
		});
	writeFileSync(
		join(home, "mise/installs/github-davidpp-kabane/.mise.backend.toml"),
		'short = "github:davidpp/kabane"\n',
	);
	expect(await binary(join(mise, "kabane"))).toEqual({
		name: "mise",
		upgrade: "mise up kabane",
	});
	expect(await binary(join(github, "kabane"))).toEqual({
		name: "mise",
		upgrade: "mise up github:davidpp/kabane",
	});
	expect(await binary(join(brew, "kabane"))).toEqual({
		name: "brew",
		upgrade: "brew upgrade kabane",
	});
	expect(await binary(join(opt, "kabane"))).toBe("binary");
	// A script outside any verified Bun global layout: kabane update would refuse it.
	expect(
		await install({
			compiled: false,
			executable: join(opt, "kabane"),
			bun: process.execPath,
			env: { HOME: home },
		}),
	).toBe("manual");
	expect(line("1.2.0", "binary")).toBe(
		"kabane 1.2.0 is out · run kabane update",
	);
	expect(line("1.2.0", "bun")).toBe(
		"kabane 1.2.0 is out · releases moved to GitHub, run kabane update",
	);
	expect(line("1.2.0", { name: "brew", upgrade: "brew upgrade kabane" })).toBe(
		"kabane 1.2.0 is out · run brew upgrade kabane",
	);
	expect(line("1.2.0", "manual")).toBe(
		"kabane 1.2.0 is out · update it the way you installed it",
	);
});
