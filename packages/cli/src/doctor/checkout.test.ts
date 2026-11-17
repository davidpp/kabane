import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutBehind } from "./checkout";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "doctor-checkout-")));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const git = (dir: string, ...args: string[]) =>
	expect(
		Bun.spawnSync(
			[
				"git",
				"-C",
				dir,
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{ stdout: "ignore", stderr: "ignore" },
		).exitCode,
	).toBe(0);

let repos = 0;
/** A repository with `commits` commits on main; a clone of it has them as origin/main. */
const origin = (commits: number): string => {
	const dir = join(TMP, `origin-${repos++}`);
	mkdirSync(dir);
	git(dir, "init", "-q", "-b", "main");
	for (let n = 0; n < commits; n++)
		git(dir, "commit", "-q", "--allow-empty", "-m", `c${n}`);
	return dir;
};

const clone = (from: string): string => {
	const dir = join(TMP, `clone-${repos++}`);
	git(TMP, "clone", "-q", from, dir);
	return dir;
};

test("a checkout behind its origin/main ref is a finding that names it and the count", () => {
	const dir = clone(origin(3));
	git(dir, "reset", "-q", "--hard", "HEAD~2");

	expect(checkoutBehind(dir)).toEqual([
		{
			id: "checkout-behind",
			path: dir,
			severity: "suggest",
			summary: `This kabane runs from ${dir}, 2 commits behind its origin/main as last fetched. \`bun run live\` brings a live checkout forward; in a checkout you work in, merge origin/main.`,
		},
	]);
});

test("a checkout level with or ahead of origin/main says nothing", () => {
	const dir = clone(origin(2));
	expect(checkoutBehind(dir)).toEqual([]);
	git(dir, "commit", "-q", "--allow-empty", "-m", "local");
	expect(checkoutBehind(dir)).toEqual([]);
});

test("a detached checkout behind origin/main is a finding; a feature branch behind it is not", () => {
	const dir = clone(origin(3));
	git(dir, "checkout", "-q", "--detach", "HEAD~1");
	expect(checkoutBehind(dir).map(({ summary }) => summary)).toEqual([
		expect.stringContaining("1 commit behind"),
	]);
	git(dir, "checkout", "-q", "-b", "feature");
	expect(checkoutBehind(dir)).toEqual([]);
});

test("a repository with no origin/main ref says nothing", () => {
	expect(checkoutBehind(origin(1))).toEqual([]);
});

test("a directory outside any repository, or inside one it does not top, says nothing", () => {
	const plain = join(TMP, "plain");
	mkdirSync(plain);
	expect(checkoutBehind(plain)).toEqual([]);

	const dir = clone(origin(3));
	git(dir, "reset", "-q", "--hard", "HEAD~1");
	const nested = join(dir, "node_modules/kabane");
	mkdirSync(nested, { recursive: true });
	expect(checkoutBehind(nested)).toEqual([]);
});
