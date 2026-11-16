// The real `kabane doctor` over real directory extensions whose copilot files the board refuses.
import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kabane-doctor-files-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const install = (home: string, name: string, files: Record<string, string>) => {
	const dir = join(home, "extensions", name);
	for (const [path, text] of Object.entries({
		"package.json": JSON.stringify({
			kabane: { extension: "./index.ts", api: 1 },
		}),
		"index.ts": `export default () => ({name: ${JSON.stringify(name)}});`,
		...files,
	})) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
};

test("doctor lists every refused copilot file under its extension, one finding per file", () => {
	const home = join(ROOT, "home");
	const notes = install(home, "notes", {
		"copilot/procedures/ok.md": "---\ntitle: KEEPING NOTES\n---\nKeep them.\n",
		"copilot/procedures/bare.md": "No frontmatter.\n",
		"copilot/shortcuts/split.md": "---\nhint: mine\n---\nSplit my way.\n",
		"copilot/shortcuts/Odd Name.md": "---\nhint: odd\n---\nOne.\nTwo.\n",
	});
	const one = install(home, "one", {
		"copilot/shortcuts/go.md": "---\nhint: one\n---\nGo.\n",
	});
	install(home, "two", {
		"copilot/shortcuts/go.md": "---\nhint: two\n---\nGo.\n",
	});
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			actor: "cabane://actor/human/test",
			deviceId: "test",
			extensions: ["notes", "one", "two"],
		}),
	);
	const run = Bun.spawnSync(
		[
			process.execPath,
			resolve(import.meta.dir, "../../index.ts"),
			"doctor",
			"--json",
		],
		{
			cwd: home,
			env: { ...process.env, KABANE_HOME: home, KABANE_HARNESSES: "" },
		},
	);
	expect(run.exitCode).toBe(0);
	const report: {
		findings: {
			source: string;
			id: string;
			severity: string;
			fixable: boolean;
			path?: string;
			summary: string;
		}[];
	} = JSON.parse(run.stdout.toString());
	const files = report.findings.filter((finding) =>
		finding.id.startsWith("copilot-file-"),
	);
	expect(files).toEqual([
		{
			source: "notes",
			id: "copilot-file-procedures-bare",
			severity: "mention",
			fixable: false,
			path: join(notes, "copilot/procedures/bare.md"),
			summary:
				"Extension notes: copilot/procedures/bare.md has no frontmatter between --- lines; add one",
		},
		{
			source: "notes",
			id: expect.stringMatching(
				/^copilot-file-shortcuts-odd-name-[0-9a-f]{1,8}$/,
			),
			severity: "mention",
			fixable: false,
			path: join(notes, "copilot/shortcuts/Odd Name.md"),
			summary:
				"Extension notes: copilot/shortcuts/Odd Name.md: its body must be one line, the template dropped into the prompt",
		},
		{
			source: "notes",
			id: "copilot-file-shortcuts-split",
			severity: "mention",
			fixable: false,
			path: join(notes, "copilot/shortcuts/split.md"),
			summary:
				"Extension notes: copilot/shortcuts/split.md: /split is a built-in shortcut, which wins; rename the file",
		},
		{
			source: "one",
			id: "copilot-file-shortcuts-go",
			severity: "mention",
			fixable: false,
			path: join(one, "copilot/shortcuts/go.md"),
			summary:
				"Extension one: copilot/shortcuts/go.md: /go is also a shortcut of two, so neither is offered; rename one",
		},
		{
			source: "two",
			id: "copilot-file-shortcuts-go",
			severity: "mention",
			fixable: false,
			path: join(home, "extensions/two/copilot/shortcuts/go.md"),
			summary:
				"Extension two: copilot/shortcuts/go.md: /go is also a shortcut of one, so neither is offered; rename one",
		},
	]);
});
