import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "@cabane/core";

export const CLI_BIN = join(import.meta.dir, "index.ts");
export const payloadMetrics = (text: string) => ({
	bytes: Buffer.byteLength(text, "utf8"),
	characters: text.length,
	calls: 1,
});

/** Owns the home/database lifecycle; no caller-supplied tracker paths. */
export const createCorpusTracker = async (
	options: { prefixed?: boolean; synthetic?: boolean } = {},
) => {
	const root = mkdtempSync(join(tmpdir(), "kabane-corpus-"));
	const home = join(root, "tracker");
	const cwd = join(root, "project");
	const env = { ...process.env, HOME: join(root, "home"), KABANE_HOME: home };
	mkdirSync(join(cwd, ".kabane"), { recursive: true });
	mkdirSync(env.HOME, { recursive: true });
	writeFileSync(join(cwd, ".kabane", "scope"), "corpus\n");
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
	return ok({ root, home, cwd, env, run, close, ids });
};
