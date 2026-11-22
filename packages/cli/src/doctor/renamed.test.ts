// A device that enabled the recipes extension before it was renamed jobs: as a merge leaves a
// source checkout (the old link resolves to a directory that holds only build output), or as an
// older install left it (a copied directory), through the real `kabane doctor`.
import { afterEach, expect, it } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../main";

const JOBS = join(import.meta.dir, "../../../../extensions/jobs");
const FIX = ["doctor", "--fix", "kabane/extension-renamed-recipes"];

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** A device whose config enables recipes, with a recipes setting and a project's local settings file. */
const device = async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kabane-renamed-")));
	roots.push(root);
	const home = join(root, "home");
	const env = {
		KABANE_HOME: home,
		KABANE_HARNESSES: "",
		KABANE_JOB_TICK: "print",
	};
	const kabane = (argv: string[]) => run(argv, env, root);
	const init = await kabane([
		"init",
		"--actor",
		"kabane://actor/human/test",
		"--device",
		"test",
	]);
	expect(init.exitCode).toBe(0);
	const config = join(home, "config.json");
	writeFileSync(
		config,
		JSON.stringify({
			...JSON.parse(readFileSync(config, "utf8")),
			extensions: ["recipes"],
			recipes: { harness: ["sh", "-c", "true"] },
		}),
	);
	const local = join(home, "projects/somewhere");
	mkdirSync(local, { recursive: true });
	writeFileSync(join(local, "recipes.json"), '{ "onAttention": "true" }\n');
	mkdirSync(join(home, "extensions"), { recursive: true });
	return {
		root,
		home,
		local,
		kabane,
		stored: () => JSON.parse(readFileSync(config, "utf8")),
	};
};

it("moves a recipes device's extensions entry, settings and link to jobs", async () => {
	const { root, home, local, kabane, stored } = await device();
	const checkout = join(root, "checkout/extensions");
	mkdirSync(join(checkout, "recipes/dist"), { recursive: true });
	symlinkSync(join(checkout, "recipes"), join(home, "extensions/recipes"));

	const stopped = await kabane(["list"]);
	expect(stopped.exitCode).toBe(1);
	expect(stopped.text).toContain(
		"Extension recipes: it is called jobs now, and `kabane doctor --fix` renames it on this device.",
	);
	expect((await kabane(["doctor"])).text).toContain(
		"kabane/extension-renamed-recipes: The recipes extension is now jobs",
	);

	const fixed = await kabane(FIX);
	expect(fixed.exitCode).toBe(0);
	expect(fixed.text).toContain(
		"extension-renamed-recipes: recipes is now jobs",
	);
	expect(stored().extensions).toEqual(["jobs"]);
	expect(stored().jobs).toEqual({ harness: ["sh", "-c", "true"] });
	expect("recipes" in stored()).toBe(false);
	expect(readFileSync(join(local, "jobs.json"), "utf8")).toBe(
		'{ "onAttention": "true" }\n',
	);
	expect(existsSync(join(local, "recipes.json"))).toBe(false);
	expect(existsSync(join(home, "extensions/recipes"))).toBe(false);
	expect(realpathSync(join(home, "extensions/jobs"))).toBe(realpathSync(JOBS));

	const runs = await kabane(["runs", "--all"]);
	expect(runs.exitCode).toBe(0);
	expect(runs.text).toContain("No runs");
	expect((await kabane(["config", "get", "jobs.harness"])).text).toContain(
		"sh",
	);
	expect((await kabane(["doctor"])).text).not.toContain("extension-renamed");
});

it("links jobs beside a copied recipes directory, which it leaves in place and names", async () => {
	const { home, kabane, stored } = await device();
	const copied = join(home, "extensions/recipes");
	mkdirSync(copied);
	writeFileSync(join(copied, "package.json"), "{}\n");

	const fixed = await kabane(FIX);
	expect(fixed.exitCode).toBe(0);
	expect(fixed.text).toContain(`left ${copied}, a copied directory, in place`);
	expect(stored().extensions).toEqual(["jobs"]);
	expect(realpathSync(join(home, "extensions/jobs"))).toBe(realpathSync(JOBS));
	expect(lstatSync(copied).isDirectory()).toBe(true);
	expect((await kabane(["runs", "--all"])).exitCode).toBe(0);
});

it("changes nothing and fails when a destination is taken", async () => {
	const { root, home, local, kabane, stored } = await device();
	writeFileSync(join(local, "jobs.json"), '{ "onAttention": "false" }\n');
	const checkout = join(root, "checkout/extensions/recipes");
	mkdirSync(checkout, { recursive: true });
	symlinkSync(checkout, join(home, "extensions/recipes"));
	const before = JSON.stringify(stored());

	const fixed = await kabane(FIX);
	expect(fixed.exitCode).toBe(1);
	expect(fixed.text).toContain(
		`Refused: ${join(local, "jobs.json")} already exists beside ${join(local, "recipes.json")}`,
	);
	expect(JSON.stringify(stored())).toBe(before);
	expect(existsSync(join(local, "recipes.json"))).toBe(true);
	expect(lstatSync(join(home, "extensions/recipes")).isSymbolicLink()).toBe(
		true,
	);
	expect(existsSync(join(home, "extensions/jobs"))).toBe(false);
});
