// The sandbox script itself, run as a contributor runs it, against a sandbox under a temp TMPDIR so
// the contributor's own sandbox is untouched: what `--scripted` writes into the sandbox's config and
// takes out again.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const sandbox = async (...args: string[]): Promise<number> =>
	Bun.spawn([process.execPath, join(ROOT, "scripts/sandbox.ts"), ...args], {
		env: { ...process.env, TMPDIR: TMP },
		stdio: ["ignore", "ignore", "ignore"],
	}).exited;

const config = (): Record<string, unknown> =>
	JSON.parse(readFileSync(CONFIG, "utf8"));

describe("bun run sandbox --scripted", () => {
	it("launches every loop session on the scripted agent, and the next run without the flag takes it off", async () => {
		expect(await sandbox("--scripted", "list")).toBe(0);
		const scripted = { command: process.execPath, args: [AGENT] };
		expect(config().loop).toEqual({
			harnesses: { claude: scripted, codex: scripted, gemini: scripted },
		});

		expect(await sandbox("list")).toBe(0);
		expect(config().loop).toBeUndefined();
		expect(config().copilot).toBeUndefined();
	}, 60_000);
});
