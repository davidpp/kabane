// A device that enabled the recipes extension before it was renamed jobs, as a merge leaves a
// source checkout: the old link resolves to a directory that holds only build output.
import { afterEach, expect, it } from "bun:test";
import {
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
import { join } from "node:path";
import { run } from "../main";

const JOBS = join(import.meta.dir, "../../../../extensions/jobs");

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("moves a recipes device's extensions entry, settings and link to jobs", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kabane-renamed-")));
	roots.push(root);
	const home = join(root, "home");
	const env = {
		KABANE_HOME: home,
		KABANE_HARNESSES: "",
		KABANE_JOB_TICK: "print",
	};
	const kabane = (argv: string[]) => run(argv, env, root);
	expect(
		(
			await kabane([
				"init",
				"--actor",
				"kabane://actor/human/test",
				"--device",
				"test",
			])
		).exitCode,
	).toBe(0);
	const checkout = join(root, "checkout/extensions");
	mkdirSync(join(checkout, "recipes/dist"), { recursive: true });
	symlinkSync(JOBS, join(checkout, "jobs"));
	mkdirSync(join(home, "extensions"), { recursive: true });
	symlinkSync(join(checkout, "recipes"), join(home, "extensions/recipes"));
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

	const stopped = await kabane(["list"]);
	expect(stopped.exitCode).toBe(1);
	expect(stopped.text).toContain(
		"Extension recipes: it is called jobs now, and `kabane doctor --fix` renames it on this device.",
	);
	expect((await kabane(["doctor"])).text).toContain(
		"kabane/extension-renamed-recipes: The recipes extension is now jobs",
	);

	const fixed = await kabane([
		"doctor",
		"--fix",
		"kabane/extension-renamed-recipes",
	]);
	expect(fixed.text).toContain(
		"extension-renamed-recipes: recipes is now jobs",
	);
	const stored = JSON.parse(readFileSync(config, "utf8"));
	expect(stored.extensions).toEqual(["jobs"]);
	expect(stored.jobs).toEqual({ harness: ["sh", "-c", "true"] });
	expect("recipes" in stored).toBe(false);
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
