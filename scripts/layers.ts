import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { z } from "zod";

type Rule = {
	layer: string;
	dependencies: readonly string[];
	// These are additional allowances; normal dependencies are also allowed in tests.
	devDependencies: readonly string[];
	// Repository-relative paths, in addition to *.test.* files.
	testSupport?: readonly string[];
	exceptions?: Readonly<Record<string, string>>;
	relativeImports?: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

// The current workspace graph, not a proposal for future package boundaries.
export const layers: Readonly<Record<string, Rule>> = {
	"@cabane/core": {
		layer: "core",
		dependencies: [],
		devDependencies: ["@cabane/sqlite"],
		testSupport: [
			"packages/core/testing.ts",
			"packages/core/testing/issue-corpus-seed.ts",
		],
	},
	"@cabane/sqlite": {
		layer: "storage adapter",
		dependencies: ["@cabane/core"],
		devDependencies: [],
	},
	"@cabane/questions": {
		layer: "data module",
		dependencies: ["@cabane/core"],
		devDependencies: ["@cabane/sqlite"],
	},
	"@cabane/checklist": {
		layer: "data module",
		dependencies: ["@cabane/core"],
		devDependencies: ["@cabane/sqlite"],
	},
	"@cabane/handoff": {
		layer: "data module",
		dependencies: ["@cabane/core"],
		devDependencies: [],
	},
	"@cabane/outcome": {
		layer: "data module",
		dependencies: ["@cabane/core"],
		devDependencies: [],
	},
	"@cabane/extension": {
		layer: "extension contract",
		dependencies: ["@cabane/core"],
		devDependencies: [],
	},
	"@cabane/acp": {
		layer: "harness client",
		dependencies: ["@cabane/core"],
		devDependencies: [],
	},
	"@cabane/board": {
		layer: "client",
		dependencies: [
			"@cabane/core",
			"@cabane/checklist",
			"@cabane/questions",
			"@cabane/acp",
			"@cabane/extension",
		],
		devDependencies: ["@cabane/handoff", "@cabane/sqlite"],
		// The gallery and its stories are dev tooling: `bun run gallery` and the render tests.
		testSupport: [
			"packages/board/gallery.tsx",
			"packages/board/src/test-db.ts",
			"packages/board/src/stories/fixtures.ts",
			"packages/board/src/stories/index.tsx",
		],
	},
	kabane: {
		layer: "host",
		testSupport: ["packages/cli/issue-corpus-harness.ts"],
		relativeImports: {
			"packages/cli/src/update-process.ts": {
				"../../core/result":
					"JCAB-334: let the release fixtures resolve core, or make update-process dependency-free",
			},
		},
		dependencies: [
			"@cabane/acp",
			"@cabane/board",
			"@cabane/checklist",
			"@cabane/core",
			"@cabane/extension",
			"@cabane/handoff",
			"@cabane/outcome",
			"@cabane/questions",
			"@cabane/sqlite",
		],
		devDependencies: [],
		exceptions: {
			"@cabane/loop": "JCAB-326: the build stops bundling the loop",
		},
	},
	"cabane-worker": {
		layer: "hub",
		dependencies: [
			"@cabane/core",
			"@cabane/checklist",
			"@cabane/handoff",
			"@cabane/outcome",
			"@cabane/questions",
		],
		devDependencies: [],
	},
	"@cabane/loop": {
		layer: "extension",
		// An extension brings its own harness client and bundles it (JCAB-316:2).
		dependencies: ["@cabane/acp"],
		devDependencies: [],
		exceptions: {
			"@cabane/checklist": "JCAB-326: port the loop onto the extension API",
			"@cabane/core": "JCAB-326: port the loop onto the extension API",
			"@cabane/extension": "JCAB-326: port the loop onto the extension API",
		},
	},
};

const Manifest = z.object({
	name: z.string().min(1),
	dependencies: z.record(z.string()).default({}),
	devDependencies: z.record(z.string()).default({}),
});
type Workspace = z.infer<typeof Manifest> & { directory: string };

function dependencyFindings(
	pkg: Workspace,
	names: Set<string>,
	rule: Rule | undefined,
): string[] {
	if (!rule)
		return [
			`${pkg.name} -> (workspace): no layer entry; add its rule to scripts/layers.ts.`,
		];
	const findings: string[] = [];
	for (const field of ["dependencies", "devDependencies"] as const) {
		const allowed =
			field === "dependencies"
				? rule.dependencies
				: [...rule.dependencies, ...rule.devDependencies];
		for (const dependency of Object.keys(pkg[field]).sort()) {
			if (!names.has(dependency) && !dependency.startsWith("@cabane/"))
				continue;
			if (allowed.includes(dependency)) continue;
			if (field === "dependencies" && rule.exceptions?.[dependency]) continue;
			findings.push(
				`${pkg.name} -> ${dependency}: ${rule.layer} ${field} forbids this edge; remove it or revise scripts/layers.ts with an architectural decision.`,
			);
		}
	}
	for (const [dependency, issue] of Object.entries(rule.exceptions ?? {})) {
		if (!(dependency in pkg.dependencies))
			findings.push(
				`${pkg.name} -> ${dependency}: stale exception (${issue}); remove this exception from scripts/layers.ts.`,
			);
	}
	return findings;
}

// Parse syntax only: no resolver, type checker, or workspace code is executed.
export function importSpecifiers(
	file: string,
): { specifier: string; line: number }[] {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const imports: { specifier: string; line: number }[] = [];
	function visit(node: ts.Node): void {
		let literal: ts.Node | undefined;
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			literal = node.moduleSpecifier;
		else if (ts.isExternalModuleReference(node)) literal = node.expression;
		else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
			literal = node.argument.literal;
		else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require"))
		)
			literal = node.arguments[0];
		if (
			literal &&
			(ts.isStringLiteral(literal) ||
				ts.isNoSubstitutionTemplateLiteral(literal))
		) {
			imports.push({
				specifier: literal.text,
				line:
					source.getLineAndCharacterOfPosition(literal.getStart(source)).line +
					1,
			});
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return imports;
}

function relativeImportFinding(
	pkg: Workspace,
	packages: Workspace[],
	file: string,
	specifier: string,
	location: string,
): string | undefined {
	const target = resolve(dirname(file), specifier);
	if (target === pkg.directory || target.startsWith(`${pkg.directory}${sep}`))
		return undefined;
	const owner = packages.find(
		(other) =>
			target === other.directory ||
			target.startsWith(`${other.directory}${sep}`),
	);
	return `${pkg.name} -> ${owner?.name ?? "(outside workspace packages)"}: relative cross-package import ${specifier} in ${location}; use a declared package import instead.`;
}

function workspaceImportFinding(
	pkg: Workspace,
	packages: Workspace[],
	{
		testSupport,
		specifier,
		location,
	}: { testSupport: boolean; specifier: string; location: string },
): string | undefined {
	const dependency = specifier.startsWith("@")
		? specifier.split("/").slice(0, 2).join("/")
		: specifier.split("/")[0];
	if (!dependency || dependency === pkg.name) return undefined;
	if (
		!dependency.startsWith("@cabane/") &&
		!packages.some((other) => other.name === dependency)
	)
		return undefined;
	if (!(dependency in pkg.dependencies) && !(dependency in pkg.devDependencies))
		return `${pkg.name} -> ${dependency}: undeclared workspace import ${specifier} in ${location}; declare it in package.json under the scripts/layers.ts allowance.`;
	if (!(dependency in pkg.dependencies) && !testSupport)
		return `${pkg.name} -> ${dependency}: production workspace import ${specifier} in ${location} is only in devDependencies; declare it in dependencies under the scripts/layers.ts allowance.`;
}

function isTestSupport(path: string, rule: Rule | undefined): boolean {
	return /\.test\.[^/]+$/.test(path) || !!rule?.testSupport?.includes(path);
}

function importsCoreTestSupport(
	pkg: Workspace,
	file: string,
	specifier: string,
): boolean {
	if (
		specifier === "@cabane/core/testing" ||
		specifier.startsWith("@cabane/core/testing/")
	)
		return true;
	if (pkg.name !== "@cabane/core" || !specifier.startsWith(".")) return false;
	const target = relative(pkg.directory, resolve(dirname(file), specifier))
		.split(sep)
		.join("/");
	return (
		target === "testing" ||
		target === "testing.ts" ||
		target === "testing.js" ||
		target.startsWith("testing/")
	);
}

function importsListedTestSupport(
	root: string,
	file: string,
	specifier: string,
	rule: Rule | undefined,
): boolean {
	const target = relative(root, resolve(dirname(file), specifier))
		.split(sep)
		.join("/");
	return !!rule?.testSupport?.some(
		(path) =>
			path === target ||
			path.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, "") === target ||
			path.replace(/\/index\.(?:[cm]?[jt]s|[jt]sx)$/, "") === target ||
			path.replace(/\.([cm]?)ts$/, ".$1js").replace(/\.tsx$/, ".jsx") ===
				target,
	);
}

function importFindings(
	pkg: Workspace,
	packages: Workspace[],
	root: string,
	rule: Rule | undefined,
): string[] {
	const pending = new Map(
		Object.entries(rule?.relativeImports ?? {}).flatMap(([file, imports]) =>
			Object.entries(imports).map(
				([specifier, issue]) =>
					[
						JSON.stringify([file, specifier]),
						{ file, specifier, issue },
					] as const,
			),
		),
	);
	const findings: string[] = [];
	const files = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}").scanSync({
		cwd: pkg.directory,
		absolute: true,
	});
	for (const file of [...files].sort()) {
		if (
			relative(pkg.directory, file)
				.split(sep)
				.some((part) =>
					["node_modules", "dist", ".wrangler", ".git"].includes(part),
				)
		)
			continue;
		const path = relative(root, file).split(sep).join("/");
		const testSupport = isTestSupport(path, rule);
		for (const { specifier, line } of importSpecifiers(file)) {
			const location = `${relative(root, file)}:${line}`;
			if (!testSupport && importsCoreTestSupport(pkg, file, specifier)) {
				findings.push(
					`${pkg.name} -> @cabane/core: production import ${specifier} in ${location} uses test support; move it to a test or listed test-support file.`,
				);
				continue;
			}
			if (specifier.startsWith(".")) {
				if (
					!testSupport &&
					importsListedTestSupport(root, file, specifier, rule)
				) {
					findings.push(
						`${pkg.name} -> ${pkg.name}: production import ${specifier} in ${location} uses test support; move it to a test or listed test-support file.`,
					);
					continue;
				}
				const finding = relativeImportFinding(
					pkg,
					packages,
					file,
					specifier,
					location,
				);
				if (!finding) continue;
				if (rule?.relativeImports?.[path]?.[specifier]) {
					pending.delete(JSON.stringify([path, specifier]));
				} else findings.push(finding);
				continue;
			}
			const finding = workspaceImportFinding(pkg, packages, {
				testSupport,
				specifier,
				location,
			});
			if (finding) findings.push(finding);
		}
	}
	for (const { file, specifier, issue } of pending.values()) {
		findings.push(
			`${pkg.name} -> ${specifier}: stale relative import exception in ${file} (${issue}); remove this exception from scripts/layers.ts.`,
		);
	}
	return findings;
}

export function checkLayers(root: string, rules = layers): string[] {
	const findings: string[] = [];
	const packages: Workspace[] = [];
	let input = root;
	try {
		const manifests = new Bun.Glob(
			"{packages,extensions}/*/package.json",
		).scanSync({ cwd: root, absolute: true });
		for (const file of [...manifests].sort()) {
			input = file;
			const parsed = Manifest.safeParse(JSON.parse(readFileSync(file, "utf8")));
			if (!parsed.success) {
				findings.push(
					`${relative(root, file)} -> (manifest): invalid package name or dependencies; fix package.json before checking layers.`,
				);
				continue;
			}
			packages.push({ ...parsed.data, directory: dirname(file) });
		}
		const names = new Set(packages.map((pkg) => pkg.name));
		for (const pkg of packages) {
			input = pkg.directory;
			findings.push(
				...dependencyFindings(pkg, names, rules[pkg.name]),
				...importFindings(pkg, packages, root, rules[pkg.name]),
			);
		}
	} catch (error) {
		findings.push(
			`${input} -> (scan): ${String(error).replaceAll(/\s+/g, " ")}; fix the unreadable manifest or source and rerun layers.`,
		);
	}
	return findings;
}

if (import.meta.main) {
	const findings = checkLayers(resolve(import.meta.dir, ".."));
	for (const finding of findings) console.error(finding);
	if (findings.length) process.exitCode = 1;
	else console.log("Workspace layers: OK");
}
