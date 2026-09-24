/**
 * Question-body convention (S4b — ask_question onto sessions)
 *
 * A `question` activity carries its answerable metadata (choices, multiSelect,
 * allowFreeform, and optional batch position / default) as a fenced ```json
 * block at the TOP of the activity `body`, followed by a blank line and the
 * human-readable question text:
 *
 *   ```json
 *   {"choices":["Redis","In-memory"],"multiSelect":false,"allowFreeform":true}
 *   ```
 *
 *   Should we use Redis or an in-memory cache?
 *
 * Producers (recipe askQuestion/askQuestionBatch, CLI `jake plan ask`) serialize
 * via `formatQuestionBody`; consumers (dashboard question cards, CLI display)
 * recover the pieces via `parseQuestionBody`. The block is OPTIONAL — a body with
 * no leading json fence parses as a pure freeform question (choices=[], freeform
 * on). The activity `context` field stays reserved for the self-contained
 * questionContext (the "why"), NOT the metadata.
 */

import { z } from "zod";

/** Answerable metadata serialized into a question activity's body. */
export const QuestionMetaSchema = z.object({
	/** Predefined choices (rendered as buttons/pills). */
	choices: z.array(z.string()).optional(),
	/** Allow selecting multiple choices (default: false). */
	multiSelect: z.boolean().optional(),
	/** Allow freeform text input (default: true). */
	allowFreeform: z.boolean().optional(),
	/** Position in a batch ("Question 1 of 3"), 0-based. */
	questionIndex: z.number().optional(),
	/** Total questions in the batch. */
	totalQuestions: z.number().optional(),
	/** Default answer for "apply all defaults" batch flows. */
	defaultAnswer: z.string().optional(),
});
export type QuestionMeta = z.infer<typeof QuestionMetaSchema>;

/** Parsed shape of a question activity body. */
export type ParsedQuestion = {
	/** The human-readable question text (metadata block stripped). */
	question: string;
	choices: string[];
	multiSelect: boolean;
	allowFreeform: boolean;
	questionIndex?: number;
	totalQuestions?: number;
	defaultAnswer?: string;
};

const JSON_FENCE = /^```json\n([\s\S]*?)\n```\n?/;

/**
 * Serialize a question + its answerable metadata into an activity body.
 * Omits the json fence entirely when there is no metadata worth carrying
 * (pure freeform question), keeping the body clean.
 */
export function formatQuestionBody(
	question: string,
	meta: QuestionMeta = {},
): string {
	// Drop undefined keys so the serialized block stays minimal.
	const entries = Object.entries(meta).filter(([, v]) => v !== undefined);
	if (entries.length === 0) return question;
	const compact = Object.fromEntries(entries);
	return `\`\`\`json\n${JSON.stringify(compact)}\n\`\`\`\n\n${question}`;
}

/**
 * Recover the question text + metadata from an activity body. Tolerant: a body
 * with no leading json fence, or an unparseable one, yields the whole body as
 * the question with freeform-on defaults.
 */
export function parseQuestionBody(body: string): ParsedQuestion {
	const defaults: ParsedQuestion = {
		question: body,
		choices: [],
		multiSelect: false,
		allowFreeform: true,
	};

	const match = body.match(JSON_FENCE);
	const json = match?.[1];
	if (!match || json === undefined) return defaults;

	const parsed = QuestionMetaSchema.safeParse(
		((): unknown => {
			try {
				return JSON.parse(json);
			} catch {
				return undefined;
			}
		})(),
	);
	if (!parsed.success) return defaults;

	const meta = parsed.data;
	return {
		question: body.slice(match[0].length).trim(),
		choices: meta.choices ?? [],
		multiSelect: meta.multiSelect ?? false,
		allowFreeform: meta.allowFreeform ?? true,
		questionIndex: meta.questionIndex,
		totalQuestions: meta.totalQuestions,
		defaultAnswer: meta.defaultAnswer,
	};
}

/**
 * Answer-provenance convention (S4b): a `decision` activity answers a `question`
 * activity when its `context` is EXACTLY `answers <question-activity-id>`. This
 * is the single source of truth for the "which question does this decision
 * answer?" link — used by every answer surface (answerQuestion tRPC, CLI, loop
 * reconcile) and the storage state machine's unanswered-question check. Exact
 * match (not substring) so re-answers and multi-question batches stay unambiguous.
 */
export function answersContext(questionActivityId: string): string {
	return `answers ${questionActivityId}`;
}

/** True iff a decision activity's `context` answers the given question activity. */
export function isAnswerTo(
	context: string | undefined | null,
	questionActivityId: string,
): boolean {
	return context === answersContext(questionActivityId);
}
