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
	const json = body.match(/^```json\n([\s\S]*?)\n```\n?/)?.[1];
	if (json === undefined) return parsed;
	try {
		const meta = DecisionMetaSchema.safeParse(JSON.parse(json));
		return meta.success
			? { ...parsed, recommended: meta.data.recommended }
			: parsed;
	} catch {
		return parsed;
	}
};
