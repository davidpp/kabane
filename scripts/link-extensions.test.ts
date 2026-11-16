// The script run as a contributor runs it, against a temp KABANE_HOME.
import { afterAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutExtensions } from "./link-extensions";

const ROOT = resolve(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "kabane-link-extensions-test-"));

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let homes = 0;
const freshHome = (): string => {
	const home = join(TMP, `home-${homes++}`);
	mkdirSync(home);
	return home;
};

const link = async (home: string, ...names: string[]) => {
	const proc = Bun.spawn(
		[process.execPath, join(ROOT, "scripts/link-extensions.ts"), ...names],
		{
			env: { ...process.env, KABANE_HOME: home },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const [code, out] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
	]);
	expect(code).toBe(0);
	return out.trim().split("\n");
};

const linksHere = (home: string, name: string): boolean =>
	realpathSync(join(home, "extensions", name)) ===
	realpathSync(join(ROOT, "extensions", name));

describe("link-extensions", () => {
	it("links every extension of the checkout into a fresh home, and says it enables none", async () => {
		const home = freshHome();
		const names = checkoutExtensions(ROOT);
		expect(names).toContain("loop");

		const lines = await link(home);

		expect(lines.slice(1, -1)).toEqual(names.map((name) => `${name}: linked`));
		expect(lines.at(-1)).toContain("--layer global");
		for (const name of names) expect(linksHere(home, name)).toBe(true);
		expect(existsSync(join(home, "config.json"))).toBe(false);
	});

	it("says an extension it linked before is already linked here", async () => {
		const home = freshHome();
		await link(home, "loop");

		expect(await link(home, "loop")).toContain("loop: already linked here");
	});

	it("links only the named extensions", async () => {
		const home = freshHome();

		const lines = await link(home, "dispatch");

		expect(lines).toContain("dispatch: linked");
		expect(lines.some((line) => line.startsWith("loop:"))).toBe(false);
		expect(existsSync(join(home, "extensions/loop"))).toBe(false);
	});

	it("leaves an installed directory alone and says so", async () => {
		const home = freshHome();
		const installed = join(home, "extensions/loop");
		mkdirSync(installed, { recursive: true });

		const lines = await link(home, "loop");

		expect(lines).toContain(
			`loop: skipped, ${installed} is an installed directory`,
		);
		expect(lstatSync(installed).isDirectory()).toBe(true);
	});

	it("leaves a link to somewhere else alone and names where it points", async () => {
		const home = freshHome();
		const elsewhere = join(TMP, "elsewhere-loop");
		mkdirSync(elsewhere);
		const target = join(home, "extensions/loop");
		mkdirSync(join(home, "extensions"));
		symlinkSync(elsewhere, target);

		const lines = await link(home, "loop");

		expect(lines).toContain(
			`loop: skipped, ${target} is a link to ${elsewhere}`,
		);
		expect(readlinkSync(target)).toBe(elsewhere);
	});

	it("replaces a link that resolves nowhere", async () => {
		const home = freshHome();
		mkdirSync(join(home, "extensions"));
		symlinkSync(join(TMP, "gone"), join(home, "extensions/loop"));

		expect(await link(home, "loop")).toContain("loop: linked");
		expect(linksHere(home, "loop")).toBe(true);
	});

	it("skips a name the checkout has no extension for", async () => {
		const home = freshHome();

		const lines = await link(home, "nope");

		expect(lines).toContain(`nope: skipped, no extensions/nope in ${ROOT}`);
		expect(existsSync(join(home, "extensions/nope"))).toBe(false);
	});
});
