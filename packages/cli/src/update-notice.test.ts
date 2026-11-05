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

// A real registry on localhost with made-up dist-tags: what it answers is set per test.
type Answer = { status: number; body: string; delayMs?: number };
let answer: Answer = { status: 200, body: "{}" };
// What each request asked, read in the handler: Bun recycles a Request once it is answered.
const requests: { path: string; userAgent: string | null }[] = [];
const registry = Bun.serve({
	port: 0,
	fetch: async (request) => {
		requests.push({
			path: new URL(request.url).pathname,
			userAgent: request.headers.get("user-agent"),
		});
		if (answer.delayMs) await Bun.sleep(answer.delayMs);
		return new Response(answer.body, { status: answer.status });
	},
});
afterAll(() => registry.stop(true));

const tags = (latest: string, beta?: string): Answer => ({
	status: 200,
	body: JSON.stringify({ latest, ...(beta ? { beta } : {}), next: "9.9.9" }),
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
		registry: registry.url.origin,
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

test("a cache under a day old answers without asking the registry", async () => {
	seed({ checkedAt: new Date(NOW - 23 * HOUR).toISOString(), latest: "1.4.0" });
	answer = tags("1.9.0");
	expect(await check("1.0.0")).toBe("1.4.0");
	expect(requests).toHaveLength(0);
});

test("an older cache is read again from the registry and written back", async () => {
	seed({ checkedAt: new Date(NOW - 25 * HOUR).toISOString(), latest: "1.4.0" });
	answer = tags("1.5.0", "1.6.0-beta.1");
	expect(await check("1.0.0")).toBe("1.5.0");
	expect(requests).toHaveLength(1);
	expect(requests).toEqual([
		{ path: "/-/package/kabane/dist-tags", userAgent: "kabane/1.0.0" },
	]);
	expect(JSON.parse(readFileSync(cacheFile(), "utf8"))).toEqual({
		latest: "1.5.0",
		beta: "1.6.0-beta.1",
		checkedAt: new Date(NOW).toISOString(),
	});
	// Written, the next check is answered from it.
	expect(await check("1.0.0")).toBe("1.5.0");
	expect(requests).toHaveLength(1);
});

test("no cache, a cache dated in the future, or a corrupt one, is read from the registry", async () => {
	answer = tags("1.1.0");
	expect(await check("1.0.0")).toBe("1.1.0");
	seed({ checkedAt: new Date(NOW + HOUR).toISOString(), latest: "1.4.0" });
	expect(await check("1.0.0")).toBe("1.1.0");
	writeFileSync(cacheFile(), "{ not json");
	expect(await check("1.0.0")).toBe("1.1.0");
	expect(requests).toHaveLength(3);
});

test("a registry that fails says nothing and leaves the cache as it was", async () => {
	for (const failing of [
		{ status: 500, body: "boom" },
		{ status: 200, body: "<html>" },
		{ status: 200, body: JSON.stringify({ latest: "not-a-version" }) },
	]) {
		answer = failing;
		expect(await check("1.0.0")).toBeUndefined();
		expect(existsSync(cacheFile())).toBe(false);
	}
	// A stale cache stays byte for byte, and still names what it knew.
	seed({ checkedAt: new Date(NOW - 48 * HOUR).toISOString(), latest: "1.3.0" });
	const before = readFileSync(cacheFile(), "utf8");
	answer = { status: 503, body: "" };
	expect(await check("1.0.0")).toBe("1.3.0");
	expect(readFileSync(cacheFile(), "utf8")).toBe(before);
});

test("a registry slower than the timeout, or not there at all, says nothing", async () => {
	answer = { ...tags("1.1.0"), delayMs: 500 };
	expect(await check("1.0.0", { timeoutMs: 50 })).toBeUndefined();
	const gone = Bun.serve({ port: 0, fetch: () => new Response("") });
	const origin = gone.url.origin;
	await gone.stop(true);
	expect(
		await UpdateNotice.check({ home, version: "1.0.0", registry: origin }),
	).toBeUndefined();
	expect(existsSync(cacheFile())).toBe(false);
});

test("the line names what this install runs to take the release", async () => {
	const { install, line } = UpdateNotice;
	const mise = join(home, "mise/installs/kabane/1.0.0/kabane");
	const opt = join(home, "opt/kabane");
	for (const dir of [mise, opt]) {
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
	expect(await binary(join(mise, "kabane"))).toBe("mise");
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
	expect(line("1.2.0", "bun")).toBe("kabane 1.2.0 is out · run kabane update");
	expect(line("1.2.0", "mise")).toBe(
		"kabane 1.2.0 is out · run mise up kabane",
	);
	expect(line("1.2.0", "manual")).toBe(
		"kabane 1.2.0 is out · update it the way you installed it",
	);
});
