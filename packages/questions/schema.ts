import { z } from "zod";

export const AskQuestionSchema = z
	.object({
		question: z.string().trim().min(1).max(8000),
		choices: z
			.array(z.string().trim().min(1).max(1000))
			.min(1)
			.max(50)
			.optional(),
		recommended: z.string().optional(),
		multiSelect: z.boolean().optional(),
		allowFreeform: z.boolean().optional(),
		why: z.string().max(8000).optional(),
	})
	.superRefine((value, ctx) => {
		const labels = value.choices?.map((label) => label.toLowerCase()) ?? [];
		if (new Set(labels).size !== labels.length)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Choice labels must be unique ignoring case.",
			});
		if (
			value.recommended !== undefined &&
			!value.choices?.includes(value.recommended)
		)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "recommended must be one of the choice labels.",
			});
		if (value.allowFreeform === false && !labels.length)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Supply choices when freeform answers are disabled.",
			});
		if (
			value.multiSelect &&
			value.choices?.some((label) => label.includes(","))
		)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Multi-select choice labels cannot contain commas.",
			});
	});
export const AskSchema = z.object({
	id: z.string().min(1),
	questions: z.array(AskQuestionSchema).min(1).max(10),
	waiting: z.boolean().default(true),
});
export type AskInput = z.input<typeof AskSchema>;
export const AnswerSchema = z
	.object({
		question: z.string().min(1),
		answer: z.string().trim().min(1).max(8000).optional(),
		withdraw: z.boolean().default(false),
		reasoning: z.string().trim().min(1).max(8000).optional(),
	})
	.superRefine((value, ctx) => {
		if (
			value.withdraw
				? !value.reasoning || value.answer !== undefined
				: value.answer === undefined
		)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"Supply answer, or withdraw: true with reasoning and no answer.",
			});
	});
export type AnswerInput = z.input<typeof AnswerSchema>;

export type Question = {
	id: string;
	task_id: string;
	status: string;
	asked_by: string;
	answered_by: string | null;
	answered_at: string | null;
	created_at: string;
	updated_at: string;
	updated_by: string;
	version: number;
	visibility: string;
	body: string;
	why: string | null;
	answer: string | null;
	reasoning: string | null;
};
export type QuestionView = Question & {
	handle: string;
	ordinal: number;
	title: string;
	priority: string;
	state: string;
	short_id: string;
};
