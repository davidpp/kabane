import { expect, test } from "bun:test";
import { draftNotes, parseReleaseArgs, releaseSteps } from "./release-local";

test("a release takes one version selector, notes and a dry run", () => {
	expect(parseReleaseArgs([])).toMatchObject({
		ok: true,
		value: { dryRun: false },
	});
	expect(parseReleaseArgs(["--version", "1.0.0", "--dry-run"])).toEqual({
		ok: true,
		value: { version: "1.0.0", dryRun: true },
	});
	expect(
		parseReleaseArgs(["--bump", "minor", "--notes-file", "notes.md"]),
	).toMatchObject({
		ok: true,
		value: { bump: "minor", notesFile: "notes.md", dryRun: false },
	});
	expect(parseReleaseArgs(["--version", "1.0.0-beta.1"]).ok).toBe(true);
	for (const argv of [
		["--version", "1.0.0", "--bump", "patch"],
		["--version", "1.0.0-rc.1"],
		["--version", "v1.0.0"],
		["--bump", "huge"],
		["--version"],
		["--version", "--dry-run"],
		["--dry-run", "--dry-run"],
		["--version", "1.0.0", "--version", "1.0.1"],
		["1.0.0"],
		["prepare"],
	])
		expect(parseReleaseArgs(argv).ok).toBe(false);
});

test("the steps check the versioned tree locally, leave tests to CI, commit it with its lock, push main and the tag at once, and dispatch on the tag", () => {
	const steps = releaseSteps("1.0.0", "# kabane 1.0.0\n").map(
		(step) => step.argv,
	);
	expect(steps).toEqual([
		["bun", "install", "--lockfile-only", "--ignore-scripts"],
		["bun", "run", "check"],
		["bun", "run", "typecheck"],
		["git", "add", "--", "packages/cli/package.json", "bun.lock"],
		["git", "commit", "-m", "chore: release kabane 1.0.0"],
		["git", "tag", "-a", "v1.0.0", "-m", "kabane 1.0.0"],
		[
			"git",
			"push",
			"--atomic",
			"origin",
			"HEAD:refs/heads/main",
			"refs/tags/v1.0.0",
		],
		[
			"gh",
			"workflow",
			"run",
			"release.yml",
			"--repo",
			"davidpp/kabane",
			"--ref",
			"v1.0.0",
			"-f",
			"publish=true",
			"-f",
			"notes=# kabane 1.0.0\n",
		],
	]);
	// Nothing in a release reaches npm.
	expect(steps.flat().join(" ")).not.toMatch(/\bnpm\b/);
});

test("drafted notes keep the feat, fix and perf subjects, bounded, with the compare view", () => {
	const subjects = [
		"feat(cli): add update",
		"docs: explain",
		"fix!: drop npm",
		"chore: release kabane 0.3.0",
		...Array.from({ length: 70 }, (_, index) => `fix: repair ${index}`),
	];
	const notes = draftNotes("1.0.0", "v1.0.0-beta.0", subjects);
	expect(notes).toStartWith(
		"# kabane 1.0.0\n\nChanges since v1.0.0-beta.0:\n\n- feat(cli): add update\n- fix!: drop npm\n",
	);
	expect(notes).not.toContain("docs: explain");
	expect(notes).not.toContain("chore: release");
	expect(notes.match(/^- /gm)).toHaveLength(61);
	expect(notes).toContain("- and 12 more\n");
	expect(notes).toContain(
		"Every commit: https://github.com/davidpp/kabane/compare/v1.0.0-beta.0...v1.0.0",
	);
	expect(draftNotes("1.0.0", null, ["fix: a"])).not.toContain("compare");
});
