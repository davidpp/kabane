import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keymap } from "@cabane/board/keymap";

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
