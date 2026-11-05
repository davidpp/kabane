import {
	cpSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@cabane/core";

export const CLI_BIN = join(import.meta.dir, "index.ts");
export const payloadMetrics = (text: string) => ({
	bytes: Buffer.byteLength(text, "utf8"),
	characters: text.length,
	calls: 1,
});

type Variant = { prefixed?: boolean; synthetic?: boolean };

const tracker = (root: string, ids: string[]) => {
	const home = join(root, "tracker");
	const cwd = join(root, "project");
	const env = { ...process.env, HOME: join(root, "home"), KABANE_HOME: home };
	const close = () => rmSync(root, { recursive: true, force: true });
	const run = async (...args: string[]) => {
		const proc = Bun.spawn([process.execPath, CLI_BIN, ...args], {
			cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { out, stderr, code };
	};
	return { root, home, cwd, env, run, close, ids };
};

/** Owns the home/database lifecycle; no caller-supplied tracker paths. */
export const createCorpusTracker = async (options: Variant = {}) => {
	const root = mkdtempSync(join(tmpdir(), "kabane-corpus-"));
	const { home, cwd, env, run, close } = tracker(root, []);
	mkdirSync(join(cwd, ".kabane"), { recursive: true });
	mkdirSync(env.HOME, { recursive: true });
	writeFileSync(join(cwd, ".kabane", "scope"), "corpus\n");
	const initArgs = options.prefixed
		? ["--db-path", join(home, "kabane.db"), "--table-prefix", "fixture_"]
		: [];
	const init = await run(
		"init",
		"--actor",
		"cabane://actor/human/fixture",
		"--device",
		"fixture",
		...initArgs,
	);
	if (init.code !== 0) {
		close();
		return err(new Error(init.stderr));
	}
	const processSeed = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "issue-corpus-seed.ts"),
			root,
			options.prefixed ? "prefixed" : "fresh",
			options.synthetic ? "synthetic" : "public",
		],
		{ cwd, env, stdout: "pipe", stderr: "pipe" },
	);
	const [out, stderr, code] = await Promise.all([
		new Response(processSeed.stdout).text(),
		new Response(processSeed.stderr).text(),
		processSeed.exited,
	]);
	if (code !== 0) {
		close();
		return err(new Error(stderr));
	}
	const ids: unknown = JSON.parse(out);
	if (
		!Array.isArray(ids) ||
		!ids.every((id): id is string => typeof id === "string")
	) {
		close();
		return err(new Error("Seeder returned invalid task IDs"));
	}
	return ok(tracker(root, ids));
};

/**
 * Seeds one tracker and hands out byte copies of it, for files that need a fresh
 * corpus per case: seeding costs about a second, a copy a few milliseconds. Copies
 * share task IDs. File refs in the seeded rows keep naming the template's reference
 * files, which no test writes, so `close()` the template only after its copies.
 */
export const createCorpusTemplate = async (options: Variant = {}) => {
	const seeded = await createCorpusTracker(options);
	if (!seeded.ok) return seeded;
	const template = seeded.value;
	const clone = () => {
		const root = mkdtempSync(join(tmpdir(), "kabane-corpus-"));
		cpSync(template.root, root, { recursive: true });
		const copy = tracker(root, template.ids);
		// A prefixed config names its database by absolute path.
		const config = join(copy.home, "config.json");
		writeFileSync(
			config,
			readFileSync(config, "utf8").replaceAll(template.root, root),
		);
		return copy;
	};
	return ok({ clone, close: template.close });
};
