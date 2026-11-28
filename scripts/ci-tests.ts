import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const Manifest = z.object({ scripts: z.object({ "test:bun": z.string() }) });
const Workflow = z.object({
	jobs: z.object({
		test: z.object({
			strategy: z.object({
				matrix: z.object({
					include: z
						.array(z.object({ group: z.string(), command: z.string() }))
						.min(1),
				}),
			}),
		}),
	}),
});

// Bare Bun arguments are substring filters: "scripts" also selects nested scripts directories.
// CI uses explicit ./ paths so directory ownership matches the files Bun actually runs.
const Path = /^[\w-]+(?:\/[\w.-]+)*$/;
// Vitest under the Workers pool runs these, through test:worker.
const workerRoot = "packages/worker";
const under = (file: string, root: string) =>
	file === root || file.startsWith(`${root}/`);
function testSelection(command: string, explicit = false) {
	if (!command.startsWith("bun test ")) return undefined;
	const paths: string[] = [];
	const ignores: Bun.Glob[] = [];
	for (const word of command.slice("bun test ".length).trim().split(/\s+/)) {
		const path = word.startsWith("./") ? word.slice(2) : word;
		if (Path.test(path)) {
			if (explicit && !word.startsWith("./")) return undefined;
			paths.push(path);
		} else if (/^--path-ignore-patterns=[\w*/.-]+$/.test(word))
			ignores.push(new Bun.Glob(word.slice("--path-ignore-patterns=".length)));
		else return undefined;
	}
	return paths.length ? { paths, ignores } : undefined;
}

export function coverageFindings(
	command: string,
	groups: { group: string; command: string }[],
	files: string[],
): string[] {
	const baseline = testSelection(command);
	if (!baseline || baseline.ignores.length)
		return [
			"test:bun must be bun test followed by paths; update the CI coverage guard.",
		];
	const findings: string[] = [];
	const selections = groups.flatMap((group) => {
		if (group.command === "bun run test:worker") return [];
		const selection = testSelection(group.command, true);
		if (!selection) {
			findings.push(
				`${group.group}: unsupported test command; use explicit ./ paths and supported path exclusions.`,
			);
			return [];
		}
		for (const path of selection.paths) {
			if (
				!baseline.paths.some(
					(root) => path === root || path.startsWith(`${root}/`),
				)
			)
				findings.push(
					`${group.group}: unexpected path ${path}; align with test:bun.`,
				);
		}
		return [{ ...selection, group: group.group }];
	});
	if (
		groups.filter((group) => group.command === "bun run test:worker").length !==
		1
	)
		findings.push(
			"worker: require exactly one bun run test:worker matrix entry.",
		);
	for (const root of baseline.paths) {
		if (
			selections
				.flatMap((selection) => selection.paths)
				.filter((path) => path === root).length !== 1
		)
			findings.push(
				`${root}: require exactly one matrix path; retain the directory so new tests are included.`,
			);
	}
	for (const file of files) {
		if (under(file, workerRoot)) continue;
		if (!baseline.paths.some((root) => under(file, root))) {
			findings.push(
				`${file}: no test:bun path runs it; add its directory to test:bun and one CI group.`,
			);
			continue;
		}
		const owners = selections.filter(
			(selection) =>
				selection.paths.some(
					(path) => file === path || file.startsWith(`${path}/`),
				) && !selection.ignores.some((ignore) => ignore.match(file)),
		);
		if (owners.length !== 1)
			findings.push(
				`${file}: covered by ${owners.length} CI groups (${owners.map((owner) => owner.group).join(", ")}); require exactly one.`,
			);
	}
	return findings;
}

export function checkCiTests(root: string): string[] {
	try {
		const manifest = Manifest.safeParse(
			JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")),
		);
		const workflow = Workflow.safeParse(
			Bun.YAML.parse(
				readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"),
			),
		);
		if (!manifest.success || !workflow.success)
			return [
				"Cannot read test:bun or CI test matrix; update the CI coverage guard for the new shape.",
			];
		const baseline = testSelection(manifest.data.scripts["test:bun"]);
		if (!baseline)
			return ["Cannot parse test:bun; update the CI coverage guard."];
		// Every workspace package, not only the listed paths, so one left out is caught.
		const files = [
			...new Set(
				[...baseline.paths, "packages/*", "extensions/*"].flatMap((path) => [
					...new Bun.Glob(`${path}/**/*`).scanSync({ cwd: root }),
				]),
			),
		]
			.filter(
				(file) =>
					!file
						.split("/")
						.some((part) =>
							["node_modules", "dist", ".wrangler"].includes(part),
						),
			)
			.filter((file) => /[._](test|spec)\.[cm]?[jt]sx?$/.test(file));
		return coverageFindings(
			manifest.data.scripts["test:bun"],
			workflow.data.jobs.test.strategy.matrix.include,
			files,
		);
	} catch (error) {
		return [
			`Cannot check CI test coverage: ${String(error)}; fix the inputs and rerun check:ci-tests.`,
		];
	}
}

if (import.meta.main) {
	const findings = checkCiTests(resolve(import.meta.dir, ".."));
	for (const finding of findings) console.error(finding);
	if (findings.length) process.exitCode = 1;
	else
		console.log(
			"CI test coverage: every Bun test belongs to exactly one group; worker included.",
		);
}
