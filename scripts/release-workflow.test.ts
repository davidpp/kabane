import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Step = z.object({
	uses: z.string().optional(),
	run: z.string().optional(),
	with: z.record(z.unknown()).optional(),
	env: z.record(z.string()).optional(),
});
const Job = z
	.object({
		steps: z.array(Step),
		if: z.string().optional(),
		environment: z.string().optional(),
		permissions: z.record(z.string()).optional(),
		concurrency: z
			.object({ group: z.string(), "cancel-in-progress": z.boolean() })
			.optional(),
	})
	.passthrough();
const Workflow = z.object({
	on: z
		.object({
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
			publish: Job,
		})
		.strict(),
});
test("release workflow default is nonpublishing, exact-artifact and permission-separated", () => {
	const raw = readFileSync(
		join(import.meta.dir, "../.github/workflows/release.yml"),
		"utf8",
	);
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
	expect(publish.if).toContain("inputs.publish");
	expect(publish.if).toContain("github.ref_type == 'tag'");
	expect(publish.if).toContain("github.repository == 'davidpp/kabane'");
	expect(publish.concurrency).toEqual({
		group: "release-kabane-stable",
		"cancel-in-progress": false,
	});
	expect(
		publish.steps.find((step) => step.run?.includes("release.ts publish"))?.env,
	).toMatchObject({
		RELEASE_PUBLISH: "${{ inputs.publish }}",
		RELEASE_SETUP_CONFIRMED: "${{ vars.RELEASE_SETUP_CONFIRMED }}",
	});
	for (const job of [
		parsed.data.jobs["native-binaries"],
		prepare,
		smoke,
		publish,
	])
		for (const step of job.steps) {
			if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
			expect(step.env?.NODE_AUTH_TOKEN).toBeUndefined();
		}
	expect(raw).toContain('node-version: "24.21.0"');
	expect(raw).toContain("npm@12.2.0");
});

test("native matrix retains four archives and smoke consumes the assembled bytes", () => {
	const parsed = Workflow.safeParse(
		Bun.YAML.parse(
			readFileSync(
				join(import.meta.dir, "../.github/workflows/release.yml"),
				"utf8",
			),
		),
	);
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
