import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateMain } from "./update-main";
import { UpdateNotice } from "./update-notice";

// A real origin in a temporary directory, moved by real commits and a real force push.
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "kabane-update-main-")));
const ORIGIN = join(WORK, "origin.git");
const CLONE = join(WORK, "clone");
const ENV: NodeJS.ProcessEnv = {
	PATH: process.env.PATH,
	HOME: WORK,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd: string, ...args: string[]): string => {
	const ran = Bun.spawnSync(["git", ...args], {
		cwd,
		env: ENV,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (ran.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
	return ran.stdout.toString().trim();
};

const commit = (message: string): string => {
	writeFileSync(join(CLONE, "file.txt"), message);
	git(CLONE, "commit", "-qam", message);
	git(CLONE, "push", "-q", "--force", "origin", "HEAD:main");
	return git(CLONE, "rev-parse", "HEAD");
};

const stampAt = (sha: string): UpdateMain.Stamp => ({
	channel: "main",
	commit: sha,
	date: "2026-11-17T12:00:00-05:00",
	source: { kind: "clone", clone: CLONE, remote: ORIGIN },
});

let first = "";
beforeAll(() => {
	git(WORK, "init", "-q", "--bare", "-b", "main", ORIGIN);
	git(WORK, "clone", "-q", ORIGIN, CLONE);
	git(CLONE, "symbolic-ref", "HEAD", "refs/heads/main");
	writeFileSync(join(CLONE, "file.txt"), "first");
	git(CLONE, "add", "file.txt");
	git(CLONE, "commit", "-qm", "first");
	git(CLONE, "push", "-q", "origin", "HEAD:main");
	first = git(CLONE, "rev-parse", "HEAD");
});
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

test("a stamp parses only as a main build's, and names its commit and date", () => {
	const stamp = stampAt("a".repeat(40));
	expect(UpdateMain.parse(JSON.stringify(stamp))).toEqual(stamp);
	expect(UpdateMain.label(stamp)).toBe("main aaaaaaa, 2026-11-17");
	expect(UpdateMain.parse(undefined)).toBeUndefined();
	expect(UpdateMain.parse("")).toBeUndefined();
	expect(UpdateMain.parse("{not json")).toBeUndefined();
	expect(
		UpdateMain.parse(JSON.stringify({ ...stamp, channel: "beta" })),
	).toBeUndefined();
	expect(
		UpdateMain.parse(JSON.stringify({ ...stamp, commit: "abc1234" })),
	).toBeUndefined();
});

test("level, behind by a count, then gone once main is rewritten without the stamped commit", async () => {
	const stamp = stampAt(first);
	expect(await UpdateMain.status(stamp, ENV)).toEqual({
		ok: true,
		value: { kind: "level" },
	});

	commit("second");
	const third = commit("third");
	const behind = await UpdateMain.status(stamp, ENV);
	expect(behind).toEqual({
		ok: true,
		value: { kind: "behind", head: third, commits: 2 },
	});
	if (behind.ok)
		expect(UpdateMain.describe(stamp, behind.value)).toContain(
			"is 2 commits past this build",
		);

	git(CLONE, "reset", "-q", "--hard", first);
	git(CLONE, "commit", "-q", "--amend", "-m", "first, rewritten");
	const rewritten = git(CLONE, "rev-parse", "HEAD");
	git(CLONE, "push", "-q", "--force", "origin", "HEAD:main");
	expect(await UpdateMain.status(stamp, ENV)).toEqual({
		ok: true,
		value: { kind: "gone", head: rewritten },
	});
	expect(await UpdateMain.status(stampAt(rewritten), ENV)).toEqual({
		ok: true,
		value: { kind: "level" },
	});
});

test("a remote that cannot be read is an error, not a status", async () => {
	const stamp = {
		...stampAt(first),
		source: {
			kind: "clone" as const,
			clone: CLONE,
			remote: join(WORK, "gone"),
		},
	};
	const read = await UpdateMain.status(stamp, ENV);
	expect(read.ok).toBe(false);
});

test("the board's notice counts main's commits, cached for its stamp, and names the remedy", async () => {
	const home = join(WORK, "home");
	const head = git(CLONE, "rev-parse", "HEAD");
	const ahead = commit("ahead");
	const stamp = stampAt(head);
	const now = Date.parse("2026-11-17T12:00:00.000Z");
	const moved = await UpdateNotice.checkMain({ home, stamp, now, env: ENV });
	expect(moved).toEqual({ kind: "behind", head: ahead, commits: 1 });
	commit("unseen");
	// Within the hour the cache answers; another stamp or an hour later reads main again.
	expect(await UpdateNotice.checkMain({ home, stamp, now, env: ENV })).toEqual(
		moved,
	);
	expect(
		await UpdateNotice.checkMain({
			home,
			stamp,
			now: now + 61 * 60 * 1000,
			env: ENV,
		}),
	).toMatchObject({ kind: "behind", commits: 2 });
	if (!moved) throw new Error("no status");
	expect(UpdateNotice.mainLine(moved, true)).toBe(
		"main is 1 commit past this build · run kabane update",
	);
	expect(UpdateNotice.mainLine({ kind: "gone", head }, false)).toBe(
		"main no longer has this build's commit · run bun run main-build in a kabane clone",
	);
	expect(UpdateNotice.mainLine({ kind: "level" }, true)).toBeNull();
});
