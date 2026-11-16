// What decides a landing before any git or gh runs: which branch, and whether there is anything to
// land at all. The script runs as a caller runs it, with no git or gh stand-in.
import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { parseLandArgs, resolveBranch } from "./land";

const SCRIPT = join(resolve(import.meta.dir, ".."), "scripts/land.ts");
const detached = () => null;
const on = (name: string) => () => name;

const run = async (args: string[], env: Record<string, string>) => {
	const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
		env: { ...process.env, KABANE_BRANCH: "", KABANE_PR: "", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [code, out, error] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, out, error };
};

describe("resolveBranch", () => {
	it("takes the argument over the loop's branch and the checkout's", () => {
		const branch = resolveBranch(
			"jcab-1",
			{ KABANE_BRANCH: "loop/x" },
			on("dev"),
		);
		expect(branch).toEqual({ ok: true, value: "jcab-1" });
	});

	it("takes the loop's branch over the checkout's", () => {
		expect(
			resolveBranch(undefined, { KABANE_BRANCH: "loop/x" }, on("dev")),
		).toEqual({ ok: true, value: "loop/x" });
	});

	it("falls back to the checkout's branch when KABANE_BRANCH is unset or empty", () => {
		expect(resolveBranch(undefined, {}, on("dev"))).toEqual({
			ok: true,
			value: "dev",
		});
		expect(resolveBranch(undefined, { KABANE_BRANCH: "" }, on("dev"))).toEqual({
			ok: true,
			value: "dev",
		});
	});

	it("refuses main and a detached HEAD", () => {
		expect(resolveBranch("main", {}, on("dev")).ok).toBe(false);
		expect(resolveBranch(undefined, {}, on("main")).ok).toBe(false);
		expect(resolveBranch(undefined, {}, detached).ok).toBe(false);
	});
});

describe("parseLandArgs", () => {
	it("passes everything after -- to gh pr create", () => {
		expect(
			parseLandArgs(["jcab-1", "--dry-run", "--", "--title", "x (A-1)"]),
		).toEqual({
			ok: true,
			value: { branch: "jcab-1", dryRun: true, create: ["--title", "x (A-1)"] },
		});
	});

	it("refuses an unknown option and a second branch", () => {
		expect(parseLandArgs(["--draft"]).ok).toBe(false);
		expect(parseLandArgs(["a", "b"]).ok).toBe(false);
	});
});

describe("bun run land", () => {
	it("does nothing after a merge landing", async () => {
		const ran = await run(["main"], { KABANE_LAND: "merge" });
		expect(ran).toEqual({ code: 0, out: "", error: "" });
	});

	it("refuses main before running git or gh", async () => {
		const ran = await run(["main"], {});
		expect(ran.code).toBe(1);
		expect(ran.error).toContain("Refusing to land main");
	});
});
