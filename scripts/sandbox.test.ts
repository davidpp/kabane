// The sandbox script itself, run as a contributor runs it, against a sandbox under a temp TMPDIR so
// the contributor's own sandbox is untouched: what `--scripted` writes into the sandbox's config and
// takes out again.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "kabane-sandbox-test-"));
const CONFIG = join(
	TMP,
	"kabane-sandbox",
	basename(ROOT),
	".kabane",
	"config.json",
);
const AGENT = join(ROOT, "packages/acp/scripts/scripted-agent.ts");

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// Its output is kept, not shown: a run that fails or leaves the config unexpected prints it.
const sandbox = async (...args: string[]) => {
	const proc = Bun.spawn(
		[process.execPath, join(ROOT, "scripts/sandbox.ts"), ...args],
		{
			env: { ...process.env, TMPDIR: TMP },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const [code, out, error] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, output: `${out}${error}` };
};

const config = (): Record<string, unknown> => {
	expect(realpathSync(join(CONFIG, "../extensions/loop"))).toBe(
		realpathSync(join(ROOT, "extensions/loop")),
	);
	return JSON.parse(readFileSync(CONFIG, "utf8"));
};

// The expectations on one sandbox run, with its output printed when one fails.
const after = async (
	ran: { code: number; output: string },
	check: () => void,
): Promise<void> => {
	try {
		expect(ran.code).toBe(0);
		check();
	} catch (failed) {
		console.error(`sandbox output:\n${ran.output}`);
		throw failed;
	}
};

describe("bun run sandbox --scripted", () => {
	it("launches every loop session on the scripted agent, and the next run without the flag takes it off", async () => {
		const scripted = { command: process.execPath, args: [AGENT] };
		await after(await sandbox("--scripted", "list"), () =>
			expect(config().loop).toEqual({
				harnesses: { claude: scripted, codex: scripted, gemini: scripted },
			}),
		);
		await after(await sandbox("list"), () => {
			expect(config().loop).toBeUndefined();
			expect(config().copilot).toBeUndefined();
		});
	}, 60_000);
});
