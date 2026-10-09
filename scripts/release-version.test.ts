import { expect, test } from "bun:test";
import { bumpReleaseVersion, inferReleaseBump } from "./release-version";

const commits = (...messages: string[]) =>
	messages.map((message, index) => ({
		sha: String(index).padStart(40, "0"),
		message,
	}));
const value = <T>(
	result: { ok: true; value: T } | { ok: false; error: Error },
) => (result.ok ? result.value : result.error.message);

test("semantic bumps reset lower components and reject unsafe versions/overflow", () => {
	expect(value(bumpReleaseVersion("1.2.3", "patch"))).toBe("1.2.4");
	expect(value(bumpReleaseVersion("1.2.3", "minor"))).toBe("1.3.0");
	expect(value(bumpReleaseVersion("0.2.3", "major"))).toBe("1.0.0");
	for (const version of [
		"01.2.3",
		"1.2.3-beta",
		"../escape",
		"1.2.9007199254740992",
	])
		expect(bumpReleaseVersion(version, "patch").ok).toBe(false);
	expect(bumpReleaseVersion("1.2.9007199254740991", "patch").ok).toBe(false);
});

test("auto uses the highest Conventional Commit intent, including scoped/case-insensitive types", () => {
	expect(
		value(
			inferReleaseBump(
				"1.2.3",
				commits("fix: repair", "docs: explain", "perf(cli): optimize"),
			),
		),
	).toBe("patch");
	expect(
		value(
			inferReleaseBump(
				"1.2.3",
				commits("FEAT(cli): add command", "fix: repair"),
			),
		),
	).toBe("minor");
	for (const message of [
		"fix(cli)!: remove API",
		"docs: explain\n\nBREAKING CHANGE: remove API",
		"refactor: simplify\n\nBREAKING-CHANGE: remove API\nRefs: #1",
		"fix: repair\n\nRefs: #1\nBREAKING CHANGE: remove API\n\nMigration instructions continue here.",
	]) {
		expect(
			value(inferReleaseBump("1.2.3", commits(message, "feat: add"))),
		).toBe("major");
		expect(value(inferReleaseBump("0.2.3", commits(message)))).toBe("minor");
	}
});

test("auto never silently patches empty, maintenance-only, ambiguous or excessive history", () => {
	for (const messages of [
		[],
		[
			"docs: explain",
			"chore: release",
			"style: format",
			"refactor: simplify",
			"test: cover",
			"ci: gate",
		],
		["fix: repair", "unknown change"],
		["feat: add", "build: change packaging"],
		["revert: restore API"],
		["fix: repair", "Merge branch feature"],
	])
		expect(inferReleaseBump("1.2.3", commits(...messages)).ok).toBe(false);
	expect(
		inferReleaseBump(
			"1.2.3",
			commits(...Array.from({ length: 1001 }, () => "fix: repair")),
		).ok,
	).toBe(false);
	expect(
		value(
			inferReleaseBump(
				"1.2.3",
				commits(
					"fix: repair\n\nExample mentions BREAKING CHANGE: prose",
					"docs: explain\n\nbreaking change: not a footer",
				),
			),
		),
	).toBe("patch");
});
