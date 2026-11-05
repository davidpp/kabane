import {
	formatQuestionBody,
	parseQuestionBody,
	QuestionMetaSchema,
	type ParsedQuestion,
} from "@cabane/core";
import { z } from "zod";

export const DecisionMetaSchema = QuestionMetaSchema.extend({
	recommended: z.string().optional(),
});
export type DecisionMeta = z.infer<typeof DecisionMetaSchema>;
export type ParsedDecision = ParsedQuestion & { recommended?: string };

export const formatDecisionBody = (
	question: string,
	meta: DecisionMeta,
): string => formatQuestionBody(question, meta);

export const parseDecisionBody = (body: string): ParsedDecision => {
	const parsed = parseQuestionBody(body);
	const meta = DecisionMetaSchema.safeParse(parsed.rawMeta);
	return meta.success
		? { ...parsed, recommended: meta.data.recommended }
		: parsed;
};
