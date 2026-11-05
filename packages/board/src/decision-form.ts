// An agent's decision on an issue (`kabane_ask`, @cabane/questions) as the form a harness asks
// with, so the board answers it with the copilot's keys (elicitation-form.ts) and draws it with the
// copilot's block (elicitation-block.tsx) rather than a second form of its own. Pure: a question row
// in, its fields out, and the filled-in fields back to the one answer `Questions.answer` takes,
// judged by `validateAnswer` as the MCP tool judges it.
//
// A decision is up to three fields, in this order: its choices (one, or a multi-select), an `Other`
// box when the asker takes a typed answer (the whole answer when it offers no choices), and an
// optional reasoning line. The recommended choice carries `★` after its label.
import { err, ok, type Result } from "@cabane/core";
import {
	type ParsedDecision,
	parseDecisionBody,
	type QuestionView,
	validateAnswer,
} from "@cabane/questions";
import type {
	CopilotElicitation,
	CopilotFormField,
	CopilotFormOption,
	CopilotFormValue,
} from "./ports";

export namespace DecisionForm {
	/** `id` is the ULID `Questions.answer` takes and the form's id carries; `handle` what the notice calls it. */
	export type Decision = Pick<QuestionView, "id" | "handle" | "askedBy"> & {
		meta: ParsedDecision;
		request: CopilotElicitation;
	};

	/** What `Questions.answer` is called with, the question aside. */
	type Answer = { answer: string; reasoning?: string };

	const CHOICE = "choice";
	const OTHER = "other";
	const REASONING = "reasoning";

	const RECOMMENDED = "★";

	const optionsOf = (meta: ParsedDecision): CopilotFormOption[] =>
		meta.choices.map((label) => ({
			value: label,
			label: label === meta.recommended ? `${label} ${RECOMMENDED}` : label,
		}));

	const fieldsOf = (meta: ParsedDecision): CopilotFormField[] => {
		const options = optionsOf(meta);
		const typed = meta.allowFreeform || options.length === 0;
		const fields: CopilotFormField[] = [];
		// With an Other box behind them, the choices may be left for it.
		if (options.length > 0)
			fields.push(
				meta.multiSelect
					? {
							key: CHOICE,
							title: "Answers",
							required: !typed,
							type: "choices",
							options,
						}
					: {
							key: CHOICE,
							title: "Answer",
							required: !typed,
							type: "choice",
							options,
						},
			);
		if (typed)
			fields.push({
				key: OTHER,
				title: options.length > 0 ? "Other" : "Answer",
				required: options.length === 0,
				type: "text",
			});
		fields.push({
			key: REASONING,
			title: "Reasoning",
			required: false,
			type: "text",
		});
		return fields;
	};

	/** The question as a form: what is asked, why under it, then its fields. */
	export const of = (row: QuestionView): Decision => {
		const { id, handle, askedBy, body } = row;
		const meta = parseDecisionBody(body);
		const why = row.why?.trim();
		return {
			id,
			handle,
			askedBy,
			meta,
			request: {
				id,
				message: why ? `${meta.question}\nwhy: ${why}` : meta.question,
				fields: fieldsOf(meta),
			},
		};
	};

	const text = (value: CopilotFormValue | undefined): string =>
		typeof value === "string" ? value.trim() : "";

	const picks = (value: CopilotFormValue | undefined): readonly string[] => {
		if (typeof value === "string") return [value];
		return typeof value === "object" ? value : [];
	};

	/**
	 * The filled-in fields as one answer. A multi-select's picks and its Other box are one list, the
	 * comma list `validateAnswer` reads; on a single choice a typed Other is the answer, since typing
	 * one says none of the choices is it. Nothing picked and nothing typed is refused with why.
	 */
	export const answerOf = (
		decision: Decision,
		content: Readonly<Record<string, CopilotFormValue>>,
	): Result<Answer> => {
		const { meta } = decision;
		const chosen = picks(content[CHOICE]);
		const other = text(content[OTHER]);
		const given = meta.multiSelect
			? [...chosen, ...(other ? [other] : [])].join(", ")
			: other || (chosen[0] ?? "");
		if (!given)
			return err(
				new Error(
					meta.choices.length > 0
						? "pick an answer or type one"
						: "type an answer",
				),
			);
		const valid = validateAnswer(meta, given);
		if (!valid.ok) return valid;
		const reasoning = text(content[REASONING]);
		return ok({ answer: valid.value, ...(reasoning ? { reasoning } : {}) });
	};
}
