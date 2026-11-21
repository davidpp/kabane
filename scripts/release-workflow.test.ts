import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Step = z.object({
	uses: z.string().optional(),
	run: z.string().optional(),
	with: z.record(z.string(), z.unknown()).optional(),
	env: z.record(z.string(), z.string()).optional(),
});
const Job = z
	.object({
		steps: z.array(Step),
		if: z.string().optional(),
		environment: z.string().optional(),
		permissions: z.record(z.string(), z.string()).optional(),
		concurrency: z
			.object({ group: z.string(), "cancel-in-progress": z.boolean() })
			.optional(),
	})
	.passthrough();
const Workflow = z.object({
	on: z
		.object({
			push: z.object({ tags: z.array(z.string()) }).strict(),
			workflow_dispatch: z.object({
				inputs: z
					.object({
						publish: z.object({
							type: z.literal("boolean"),
							default: z.literal(false),
						}),
					})
					.passthrough(),
			}),
		})
		.strict(),
	permissions: z.object({ contents: z.literal("read") }).strict(),
	jobs: z
		.object({
			"native-binaries": Job,
			prepare: Job,
			"installed-smoke": Job,
			attest: Job,
			publish: Job,
			homebrew: Job,
		})
		.strict(),
});
/** The contexts a publication gate reads, for a pushed tag and for a tag-ref dispatch. */
const TAG = {
	"github.ref_type": "tag",
	"github.ref": "refs/tags/v1.2.3",
	"github.ref_name": "v1.2.3",
	"github.repository": "davidpp/kabane",
};
const EVENTS = {
	push: { ...TAG, "github.event_name": "push", "inputs.publish": null },
	dryRun: {
		...TAG,
		"github.event_name": "workflow_dispatch",
		"inputs.publish": false,
	},
	dispatch: {
		...TAG,
		"github.event_name": "workflow_dispatch",
		"inputs.publish": true,
	},
};

/**
 * A gate of the workflow evaluated for one event: a conjunction of `path == 'value'`,
 * `startsWith(path, 'value')` and bare `path` clauses, the shape its publication gates keep. Any
 * other clause, an `||` included, fails the test rather than being guessed at.
 */
const gate = (
	expression: string | undefined,
	context: Record<string, unknown>,
): boolean =>
	(expression ?? "")
		.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
		.split(" && ")
		.every((clause) => {
			const equals = /^([\w.]+) == '([^']*)'$/.exec(clause);
			if (equals?.[1]) return context[equals[1]] === equals[2];
			const starts = /^startsWith\(([\w.]+), '([^']*)'\)$/.exec(clause);
			if (starts?.[1])
				return String(context[starts[1]]).startsWith(starts[2] ?? "");
			if (!/^[\w.]+$/.test(clause) || !(clause in context))
				throw new Error(`unsupported gate clause: ${clause}`);
			return Boolean(context[clause]);
		});

const workflow = () =>
	readFileSync(
		join(import.meta.dir, "../.github/workflows/release.yml"),
		"utf8",
	);

test("release workflow default is nonpublishing, exact-artifact and permission-separated", () => {
	const raw = workflow();
	const parsed = Workflow.safeParse(Bun.YAML.parse(raw));
	expect(parsed.success).toBe(true);
	if (!parsed.success) return;
	const { prepare, publish } = parsed.data.jobs,
		smoke = parsed.data.jobs["installed-smoke"];
	for (const job of [parsed.data.jobs["native-binaries"], prepare, smoke]) {
		expect(job.permissions).toBeUndefined();
		const runs = job.steps.map((step) => step.run ?? "").join("\n");
		expect(runs).not.toMatch(
			/npm publish|gh release (create|upload|edit)|git (tag|push)/,
		);
		expect(runs).toContain("bun install --frozen-lockfile");
	}
	expect(
		prepare.steps.filter((step) => step.run?.includes("release.ts prepare")),
	).toHaveLength(1);
	expect(
		smoke.steps.some((step) => step.run?.includes("release.ts verify")),
	).toBe(true);
	expect(
		smoke.steps.some((step) => step.run?.includes("smoke.ts --artifact-dir")),
	).toBe(true);
	expect(
		smoke.steps.some(
			(step) => step.run?.includes("build") || step.run?.includes("pack"),
		),
	).toBe(false);
	for (const job of [smoke, publish]) {
		const download = job.steps.find((step) =>
			step.uses?.startsWith("actions/download-artifact@"),
		);
		expect(download?.with).toMatchObject({
			"artifact-ids": "${{ needs.prepare.outputs.artifact_id }}",
			"merge-multiple": true,
		});
	}
	expect(publish.environment).toBe("npm-release");
	expect(publish.permissions).toEqual({
		contents: "write",
		"id-token": "write",
		actions: "read",
	});
	expect(publish.if).toContain("github.ref_type == 'tag'");
	expect(publish.if).toContain("github.repository == 'davidpp/kabane'");
	expect(publish.concurrency).toEqual({
		group: "release-kabane-stable",
		"cancel-in-progress": false,
	});
	expect(
		publish.steps.find((step) => step.run?.includes("release.ts publish"))?.env,
	).toMatchObject({
		RELEASE_SETUP_CONFIRMED: "${{ vars.RELEASE_SETUP_CONFIRMED }}",
	});
	for (const job of Object.values(parsed.data.jobs))
		for (const step of job.steps) {
			if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
			expect(step.env?.NODE_AUTH_TOKEN).toBeUndefined();
		}
	expect(raw).toContain('node-version: "24.21.0"');
	expect(raw).toContain("npm@12.2.0");
});

test("native matrix retains four archives and smoke consumes the assembled bytes", () => {
	const parsed = Workflow.safeParse(Bun.YAML.parse(workflow()));
	expect(parsed.success).toBe(true);
	if (!parsed.success) return;
	const native = parsed.data.jobs["native-binaries"];
	expect(native.strategy).toEqual({
		"fail-fast": false,
		matrix: {
			include: [
				{ os: "macos-15", target: "darwin-arm64" },
				{ os: "macos-15-intel", target: "darwin-x64" },
				{ os: "ubuntu-24.04", target: "linux-x64" },
				{ os: "ubuntu-24.04-arm", target: "linux-arm64" },
			],
		},
	});
	expect(
		native.steps.filter((step) => step.run?.includes("build-binary.ts")),
	).toHaveLength(1);
	expect(
		native.steps.find((step) =>
			step.uses?.startsWith("actions/upload-artifact@"),
		)?.with?.name,
	).toBe("native-${{ matrix.target }}-${{ github.run_attempt }}");
	const { prepare } = parsed.data.jobs;
	expect(
		prepare.steps.find((step) =>
			step.uses?.startsWith("actions/download-artifact@"),
		)?.with,
	).toMatchObject({
		pattern: "native-*-${{ github.run_attempt }}",
		"merge-multiple": true,
	});

	expect(prepare.needs).toBe("native-binaries");
	expect(
		prepare.steps.some((step) => step.run?.includes("release-binaries.ts")),
	).toBe(true);
	const upload = prepare.steps.find((step) =>
		step.uses?.startsWith("actions/upload-artifact@"),
	);
	expect(upload?.with?.path).toContain("release/*.tar.gz");
	expect(
		parsed.data.jobs["installed-smoke"].steps.some((step) =>
			step.run?.includes("smoke.ts --binary"),
		),
	).toBe(true);
});

test("only a publish=true dispatch publishes; a pushed tag and a dry run verify and attest", () => {
	const parsed = Workflow.safeParse(Bun.YAML.parse(workflow()));
	expect(parsed.success).toBe(true);
	if (!parsed.success) return;
	const { attest, publish, prepare } = parsed.data.jobs;
	expect(parsed.data.on.push.tags).toEqual([
		"v[0-9]+.[0-9]+.[0-9]+",
		"v[0-9]+.[0-9]+.[0-9]+-beta.[0-9]+",
	]);
	const gates = [
		publish.if,
		prepare.steps.find((step) => step.run?.includes("release.ts prepare"))?.env
			?.RELEASE_PUBLISH,
		publish.steps.find((step) => step.run?.includes("release.ts publish"))?.env
			?.RELEASE_PUBLISH,
	];
	for (const expression of gates) {
		expect(gate(expression, EVENTS.push)).toBe(false);
		expect(gate(expression, EVENTS.dryRun)).toBe(false);
		expect(gate(expression, EVENTS.dispatch)).toBe(true);
	}
	// Attestation runs whatever the event, so a tag push still proves the attest job works.
	expect(attest.if).toBe("github.repository == 'davidpp/kabane'");
	expect(publish.needs).toEqual(["prepare", "installed-smoke", "attest"]);
	expect(attest.permissions).toEqual({
		contents: "read",
		"id-token": "write",
		attestations: "write",
	});
	const subjects = attest.steps.find((step) =>
		step.uses?.startsWith("actions/attest-build-provenance@"),
	)?.with?.["subject-path"];
	for (const subject of ["*.tgz", "*.tar.gz", "install.sh"])
		expect(subjects).toContain(`release/${subject}`);
	expect(
		prepare.steps.some((step) => step.run?.includes("release-formula.ts")),
	).toBe(true);
	const upload = prepare.steps.find((step) =>
		step.uses?.startsWith("actions/upload-artifact@"),
	);
	expect(upload?.with?.path).toContain("release/kabane.rb");
	expect(upload?.with?.path).toContain("release/install.sh");
	for (const job of Object.values(parsed.data.jobs))
		for (const step of job.steps)
			if (step.uses?.startsWith("oven-sh/setup-bun@"))
				expect(step.with?.["no-cache"]).toBe(true);
});

test("the tap takes a stable release's formula once its GitHub release is public, with its own key behind the approval", () => {
	const parsed = Workflow.safeParse(Bun.YAML.parse(workflow()));
	expect(parsed.success).toBe(true);
	if (!parsed.success) return;
	const { homebrew } = parsed.data.jobs;
	expect(homebrew.needs).toEqual(["prepare", "publish"]);
	// Its deploy key is an environment secret: only a job behind the approval can read it.
	expect(homebrew.environment).toBe("npm-release");
	expect(homebrew.if).toContain("!contains(github.ref_name, '-')");
	expect(homebrew.permissions).toEqual({});
	const runs = homebrew.steps.map((step) => step.run ?? "").join("\n");
	expect(runs).toContain(
		"https://github.com/davidpp/kabane/releases/download/$TAG/SHA256SUMS",
	);
	expect(runs).toContain("cmp published-SHA256SUMS release/SHA256SUMS");
	expect(runs).toContain("cp release/kabane.rb tap/Formula/kabane.rb");
	expect(runs).not.toMatch(/npm|gh release/);
	expect(
		homebrew.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
			?.with,
	).toMatchObject({
		repository: "davidpp/homebrew-tap",
		"ssh-key": "${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}",
	});
});
