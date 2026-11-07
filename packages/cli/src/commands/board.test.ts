import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keymap } from "@cabane/board/keymap";
import { configPath } from "../config";

// The copilot's config-and-help procedure reads the board's keymap from here.
it("prints the board's keymap in `kabane board --help`", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-board-help-"));
	try {
		const proc = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../../index.ts"),
				"board",
				"--help",
			],
			{
				cwd: home,
				env: { ...process.env, KABANE_HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, code] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);
		expect(code).toBe(0);
		const lines = out.split("\n");
		const listed = (binding: { key: string; label: string }) =>
			lines.some(
				(line) =>
					line.trimStart().startsWith(binding.key) &&
					line.trimEnd().endsWith(binding.label),
			);
		expect(out).toContain("Press ? in the board");
		expect(Keymap.EVERYWHERE.every(listed)).toBe(true);
		for (const { name, bindings } of Object.values(Keymap.CONTEXTS)) {
			const [first] = bindings;
			if (!first) continue;
			expect(lines).toContain(`${name}:`);
			expect(listed(first)).toBe(true);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// Before the renderer, and before the terminal check, so a host that started the board on a
// pipe still reads which id was wrong.
it("fails on an unknown --issue in one line, without starting the board", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-board-issue-"));
	writeFileSync(
		configPath(home),
		JSON.stringify({ actor: "cabane://actor/human/ada", deviceId: "mbp" }),
	);
	try {
		const proc = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../../index.ts"),
				"board",
				"--issue",
				"NOPE-404",
			],
			{
				cwd: home,
				env: { ...process.env, KABANE_HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).toBe(1);
		expect(`${out}${err}`.trim()).toBe(
			"Error: No task found with ID: NOPE-404",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
