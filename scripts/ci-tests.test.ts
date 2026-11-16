import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkCiTests, coverageFindings } from "./ci-tests";

const command = "bun test packages/cli scripts";
const files = [
	"packages/cli/src/commands/config.test.ts",
	"packages/cli/src/main.test.ts",
	"scripts/build.test.ts",
];
const groups = [
	{
		group: "cli",
		command:
			"bun test ./packages/cli --path-ignore-patterns=**/commands/config.test.ts",
	},
	{
		group: "cli-processes",
		command: "bun test ./packages/cli/src/commands/config.test.ts",
	},
	{ group: "scripts", command: "bun test ./scripts" },
	{ group: "worker", command: "bun run test:worker" },
];

test("the real CI matrix covers the root test:bun script", () => {
	expect(checkCiTests(resolve(import.meta.dir, ".."))).toEqual([]);
});

test("a directory and its excluded process tests cover each file once", () => {
	expect(coverageFindings(command, groups, files)).toEqual([]);
});

test("a missing root path is rejected even before it has tests", () => {
	expect(coverageFindings(`${command} packages/new`, groups, files)).toContain(
		"packages/new: require exactly one matrix path; retain the directory so new tests are included.",
	);
});

test("a duplicated path fails coverage", () => {
	expect(
		coverageFindings(
			command,
			[...groups, { group: "duplicate", command: "bun test ./scripts" }],
			files,
		).join("\n"),
	).toContain("scripts/build.test.ts: covered by 2 CI groups");
});

test("an exclusion without its separate group fails coverage", () => {
	expect(
		coverageFindings(
			command,
			groups.filter((group) => group.group !== "cli-processes"),
			files,
		).join("\n"),
	).toContain("config.test.ts: covered by 0 CI groups");
});

test("a missing exclusion fails coverage", () => {
	expect(
		coverageFindings(
			command,
			groups.map((group) =>
				group.group === "cli"
					? { ...group, command: "bun test ./packages/cli" }
					: group,
			),
			files,
		).join("\n"),
	).toContain("config.test.ts: covered by 2 CI groups");
});

test("unsupported commands and paths outside test:bun fail closed", () => {
	for (const command of [
		"bun test ./scripts && echo done",
		"bun test scripts",
		"bun test ./packages/worker",
		"bun test ./scripts --only",
	]) {
		expect(
			coverageFindings(
				"bun test scripts",
				[{ group: "bad", command }, groups[3]].filter(
					(group) => group !== undefined,
				),
				files,
			).length,
		).toBeGreaterThan(0);
	}
});

test("worker must run exactly once", () => {
	for (const workers of [
		[],
		[
			{ group: "worker-1", command: "bun run test:worker" },
			{ group: "worker-2", command: "bun run test:worker" },
		],
	]) {
		expect(
			coverageFindings(
				command,
				[...groups.filter((group) => group.group !== "worker"), ...workers],
				files,
			),
		).toContain(
			"worker: require exactly one bun run test:worker matrix entry.",
		);
	}
});
