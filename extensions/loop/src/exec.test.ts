// A failed tool's error, with real processes. The gh here is a script named gh in a directory of
// its own that only fails, so no test reaches the user's gh or GitHub.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Exec } from "./exec";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "loop-exec-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A tool named `name` that says `said` on stderr and exits 4.
const failing = (name: string, said: string): string => {
	const path = join(dir, name);
	writeFileSync(path, `#!/bin/sh\necho '${said}' >&2\nexit 4\n`);
	chmodSync(path, 0o755);
	return path;
};

describe("Exec.tool", () => {
	it("names gh's content flags, never their values, when gh fails", async () => {
		const gh = Exec.tool(failing("gh", "gh: not signed in"));
		const failed = await gh(dir, [
			"pr",
			"create",
			"--base",
			"main",
			"--title",
			"Rotate the leaked token",
			"--body",
			"The token is sk-live-123\n\n## Gates",
			"--body-file=/tmp/body.md",
		]);
		expect(!failed.ok && failed.error.message).toBe(
			`gh pr create --base main --title <…> --body <…> --body-file=<…> failed in ${dir}: gh: not signed in`,
		);
	});

	it("names git's message flag, never the message", async () => {
		const git = Exec.tool(failing("git", "hook refused"));
		const failed = await git(dir, [
			"commit",
			"-q",
			"-m",
			"JCAB-1 secret title",
		]);
		expect(!failed.ok && failed.error.message).toBe(
			`git commit -q -m <…> failed in ${dir}: hook refused`,
		);
	});

	it("cuts any other long or multi-line argument short", async () => {
		const sh = Exec.tool(failing("sh-tool", "no"));
		const failed = await sh(dir, ["a\nb", "x".repeat(70)]);
		expect(!failed.ok && failed.error.message).toBe(
			`sh-tool a… ${"x".repeat(60)}… failed in ${dir}: no`,
		);
	});
});
