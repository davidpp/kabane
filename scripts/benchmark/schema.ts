import { z } from "zod";

export const armSchema = z.enum(["baseline", "kabane"]);
export type Arm = z.infer<typeof armSchema>;
const harnessSchema = z.enum(["codex", "claude"]);
export type Harness = z.infer<typeof harnessSchema>;
const relativeFile = z
	.string()
	.min(1)
	.refine(
		(s) => !s.startsWith("/") && !s.split(/[\\/]/).includes(".."),
		"Use a relative path without ..",
	);
export const recipeSchema = z
	.object({
		version: z.literal(1),
		name: z.string().min(1),
		models: z
			.object({ codex: z.string().min(1), claude: z.string().min(1) })
			.strict(),
		effort: z.enum(["low", "medium", "high"]).default("medium"),
		maxSeconds: z.number().int().min(10).max(7200),
		maxAttempts: z.number().int().min(1).max(3).default(2),
		billingControlsVerified: z.boolean().default(false),
		common: relativeFile,
		rubric: relativeFile,
		starter: relativeFile,
		rounds: z
			.array(
				z.object({ prompt: relativeFile, harness: harnessSchema }).strict(),
			)
			.min(1)
			.max(8),
		evaluator: relativeFile.optional(),
		browser: z
			.object({ command: z.string().min(1), executable: z.string().optional() })
			.strict()
			.optional(),
	})
	.strict();
export type Recipe = z.infer<typeof recipeSchema>;
export const manifestSchema = z
	.object({
		version: z.literal(1),
		createdAt: z.string(),
		recipe: recipeSchema,
		common: z.string(),
		rubric: z.string(),
		prompts: z.array(z.string()),
		evaluator: z.string().nullable(),
		starterDigest: z.string(),
		digest: z.string(),
		order: z.tuple([armSchema, armSchema]),
		versions: z.object({
			codex: z.string(),
			claude: z.string(),
			bun: z.string(),
			kabane: z.string(),
			kabaneSource: z.string(),
			browser: z.string().nullable(),
		}),
		sourceRoot: z.string(),
	})
	.strict();
export type Manifest = z.infer<typeof manifestSchema>;
const usageSchema = z.object({
	input: z.number().nullable(),
	cachedInput: z.number().nullable(),
	cacheWrite: z.number().nullable(),
	output: z.number().nullable(),
	source: z.string(),
});
export type Usage = z.infer<typeof usageSchema>;
export const attemptSchema = z
	.object({
		arm: armSchema,
		round: z.number().int().min(1),
		attempt: z.number().int().min(1),
		harness: harnessSchema,
		model: z.string(),
		startedAt: z.string(),
		endedAt: z.string().nullable(),
		elapsedMs: z.number().nullable(),
		status: z.enum([
			"running",
			"completed",
			"failed",
			"timed_out",
			"interrupted",
		]),
		exitCode: z.number().nullable(),
		usage: usageSchema,
		toolCalls: z.number(),
		kabaneCalls: z.number(),
		trace: z.string(),
		workspaceDigest: z.string().nullable(),
	})
	.strict();
export type Attempt = z.infer<typeof attemptSchema>;
export const gradeSchema = z
	.object({
		arm: armSchema,
		round: z.number().int().min(1),
		attempt: z.number().int(),
		verdict: z.enum(["pass", "fail"]),
		evidence: z.string().min(1),
		at: z.string(),
		source: z.enum(["human", "command"]),
	})
	.strict();
export type Grade = z.infer<typeof gradeSchema>;
