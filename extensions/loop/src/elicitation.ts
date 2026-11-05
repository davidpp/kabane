// A harness form (ACP form elicitation: AskUserQuestion, codex's request_user_input, an MCP
// server's form), relayed to the human as tracker questions. The loop fills nothing itself and
// never accepts a form on the human's behalf.
//
// Every field becomes one question on the claim's core session, asked together and numbered
// "i of n" so the board lists them as one group: the harness's message, then the field's title
// and description verbatim. A choice is the field's options, several choices a multi-select, a
// boolean Yes / No, text and numbers free text. An optional free-text field that follows an
// optional choice is not asked apart: it is that choice's "Other" box (AskUserQuestion sends one
// after every question), so the choice question takes a typed answer instead of a pick and fills
// the box with it. An optional field also offers `skip`, which leaves it out of the answer, and
// every field offers `decline`, which declines the form: among the choices of a choice or a
// boolean, and as words to type on any other field, so a multi-select's choices are its options
// alone and neither word is toggled beside one. The form resolves once every question has an
// answer; an answer that does not fit its field is asked again, with why, judged as the board's
// form judges it (`FormField`). A claim that stops, or a harness that withdraws the form, closes
// the questions still open as withdrawn (`questions.ts`).
import type { AcpClient } from "@cabane/acp";
import { FormField } from "@cabane/board/form-field";
import { err, formatQuestionBody, ok, type Result } from "@cabane/core";
import { Permission } from "./permission";
import { Questions } from "./questions";

export namespace Elicitation {
	type Field = AcpClient.ElicitationField;

	/** Leaves an optional field out of the answer. */
	const SKIP = "skip";
	/** Declines the whole form. */
	const DECLINE = "decline";
	/** Accepts a form that asks for nothing but a yes. */
	const ACCEPT = "accept";

	type Choice = { label: string; id?: string };

	type Text = Extract<Field, { type: "text" }>;

	/**
	 * One question put to the human: a field, and the free-text field folded into it as the answer
	 * to type instead of a pick, when it has one.
	 */
	export type Question = { field: Field; other?: Text };

	// An optional choice followed by an optional free-text field, which is its "Other" box: asked
	// apart, the human answers one question twice, and the box they skip reads as a choice they
	// made. A required choice keeps its box apart: a typed answer would leave the choice empty.
	const otherBox = (field: Field, next: Field | undefined): Text | undefined =>
		(field.type === "choice" || field.type === "choices") &&
		!field.required &&
		next?.type === "text" &&
		!next.required
			? next
			: undefined;

	/** The questions `fields` are asked as, in their order. */
	export const questions = (fields: readonly Field[]): Question[] =>
		fields.reduce<Question[]>((asked, field, i) => {
			if (asked.some((q) => q.other === field)) return asked;
			const other = otherBox(field, fields[i + 1]);
			return [...asked, other ? { field, other } : { field }];
		}, []);

	const optionChoices = (field: Field): Choice[] => {
		switch (field.type) {
			case "choice":
			case "choices":
				return field.options.map((o) => ({ label: o.label, id: o.value }));
			case "boolean":
				return [
					{ label: "Yes", id: "true" },
					{ label: "No", id: "false" },
				];
			default:
				return [];
		}
	};

	const reserved = (field: Field): Choice[] => [
		...(field.required ? [] : [{ label: SKIP }]),
		{ label: DECLINE },
	];

	// Whether skip and decline are among the question's choices. On a multi-select they would be
	// toggled beside its options, and `A, decline` reads as neither, so there, as on a free-text
	// field, they are words the human types instead.
	const listsReserved = (field: Field): boolean =>
		field.type === "choice" || field.type === "boolean";

	// What the question offers to pick: the field's own options, then skip and decline if it
	// lists them.
	const choices = (field: Field): string[] =>
		[
			...optionChoices(field),
			...(listsReserved(field) ? reserved(field) : []),
		].map((c) => c.label);

	// How to answer a question whose choices do not say it all: one that takes a typed answer
	// beside them, or does not list skip and decline.
	const hint = ({ field, other }: Question): string | undefined => {
		if (listsReserved(field))
			return other ? "Pick one, or type your own answer." : undefined;
		const what =
			field.type === "number"
				? `Type ${FormField.wants(field)}`
				: field.type === "choices"
					? `Pick any of the choices${other ? ", type your own answer" : ""}`
					: "Type the answer";
		const skip = field.required ? "" : `, \`${SKIP}\` to leave it empty`;
		return `${what}${skip}, or \`${DECLINE}\` to decline the form.`;
	};

	/**
	 * The body of `question`, the `index`th of `total`: the harness's message, then the field's
	 * title and description verbatim, then how to answer one whose choices do not say. `retry` says
	 * why the last answer was asked again.
	 */
	export const body = (
		harness: string,
		request: AcpClient.ElicitationRequest,
		question: Question,
		position: { index: number; total: number },
		retry?: string,
	): string => {
		const { field } = question;
		const { index, total } = position;
		const of = total > 1 ? ` (${index + 1} of ${total})` : "";
		const described = field.description
			? `${field.title}: ${field.description}`
			: field.title;
		const lines = [
			`${harness} asks: ${request.message}`,
			`${described}${of}`,
			hint(question),
			retry,
		].filter((line): line is string => line !== undefined);
		return formatQuestionBody(lines.join("\n"), {
			choices: choices(field),
			multiSelect: field.type === "choices",
			allowFreeform: !listsReserved(field) || question.other !== undefined,
			...(total > 1 ? { questionIndex: index, totalQuestions: total } : {}),
		});
	};

	/** The question for a form with no fields: the harness asks only for a yes. */
	const confirmBody = (
		harness: string,
		request: AcpClient.ElicitationRequest,
	): string =>
		formatQuestionBody(`${harness} asks: ${request.message}`, {
			choices: [ACCEPT, DECLINE],
			multiSelect: false,
			allowFreeform: false,
		});

	/**
	 * The choices a multi-select answer names: the whole answer as one choice, else each
	 * comma-separated part by id, label or position (`Permission.choose`). Undefined when any
	 * part names none; duplicates count once.
	 */
	export const chooseMany = <T extends Choice>(
		options: readonly T[],
		answer: string,
	): T[] | undefined => {
		const whole = Permission.choose(options, answer);
		if (whole) return [whole];
		const picked: T[] = [];
		for (const part of answer.split(",")) {
			const chosen = Permission.choose(options, part);
			if (!chosen) return undefined;
			if (!picked.includes(chosen)) picked.push(chosen);
		}
		return picked;
	};

	type Read =
		| { kind: "value"; value: AcpClient.ElicitationValue }
		| { kind: "skip" }
		| { kind: "decline" }
		| { kind: "invalid"; why: string };

	const invalid = (why: string): Read => ({ kind: "invalid", why });

	const action = (word: Choice): Read =>
		word.label === SKIP ? { kind: "skip" } : { kind: "decline" };

	// Skip or decline typed as a word, which is only ever the bare word.
	const typedWord = (field: Field, given: string): Choice | undefined =>
		reserved(field).find((c) => c.label === given.toLowerCase());

	const readChoices = (
		field: Extract<Field, { type: "choices" }>,
		given: string,
	): Read => {
		const picked = chooseMany(optionChoices(field), given);
		const word = picked ? undefined : typedWord(field, given);
		if (word) return action(word);
		if (!picked) return invalid("names something that is not an option");
		const count = picked.length;
		if (field.minItems !== undefined && count < field.minItems)
			return invalid(`picks ${count}, fewer than ${field.minItems}`);
		if (field.maxItems !== undefined && count > field.maxItems)
			return invalid(`picks ${count}, more than ${field.maxItems}`);
		return { kind: "value", value: picked.map((c) => c.id ?? c.label) };
	};

	/**
	 * What the human's answer to `field` gives the harness. The field's own options are matched
	 * before skip and decline, so an option that is itself called "decline" stays reachable; on a
	 * field whose choices do not list them, skip and decline are only ever the bare words.
	 */
	export const read = (field: Field, answer: string): Read => {
		const given = answer.trim();
		switch (field.type) {
			case "text":
			case "number": {
				const word = typedWord(field, given);
				if (word) return action(word);
				const value = FormField.read(field, given);
				return value.ok
					? { kind: "value", value: value.value }
					: invalid(value.error.message);
			}
			case "choices":
				return readChoices(field, given);
			case "boolean":
			case "choice": {
				const options = optionChoices(field);
				const chosen = Permission.choose(
					[...options, ...reserved(field)],
					given,
				);
				if (chosen && !options.includes(chosen)) return action(chosen);
				if (!chosen)
					return invalid(
						field.type === "boolean"
							? "is neither Yes nor No"
							: "names none of its choices",
					);
				return {
					kind: "value",
					value:
						field.type === "boolean"
							? chosen.id === "true"
							: (chosen.id ?? chosen.label),
				};
			}
		}
	};

	type Given =
		| Exclude<Read, { kind: "value" }>
		| { kind: "value"; key: string; value: AcpClient.ElicitationValue };

	/**
	 * What the human's answer to `question` fills: its field, or the free-text field folded into
	 * it when the answer is none of the field's own.
	 */
	export const answer = (question: Question, given: string): Given => {
		const { field, other } = question;
		const own = read(field, given);
		if (own.kind === "value")
			return { kind: "value", key: field.key, value: own.value };
		if (own.kind !== "invalid" || !other) return own;
		const typed = FormField.read(other, given);
		return typed.ok
			? { kind: "value", key: other.key, value: typed.value }
			: {
					kind: "invalid",
					why: `${own.why}, and as your own answer ${typed.error.message}`,
				};
	};

	// A form with no fields asks only for a yes: one question, accept or decline.
	const confirm: Question = {
		field: {
			key: "",
			title: "",
			required: true,
			type: "choice",
			options: [{ value: ACCEPT, label: ACCEPT }],
		},
	};

	/** One form being relayed: its questions, the ones still open and every one asked. */
	type Form = {
		deps: Questions.Deps;
		request: AcpClient.ElicitationRequest;
		questions: Question[];
		/** What each open question asks, by question id. */
		open: Map<string, Question>;
		asked: string[];
		askedAt: number;
		/** Who answered, as the answering surfaces noted it. */
		by: Set<string>;
	};

	const waited = (form: Form): number =>
		form.deps.now().getTime() - form.askedAt;

	// What every event about the form carries.
	const details = (form: Form): Record<string, string | number> => ({
		questionIds: form.asked.join(","),
		waitedMs: waited(form),
		...(form.request.toolCallId ? { toolCallId: form.request.toolCallId } : {}),
	});

	const ask = async (
		form: Form,
		question: Question,
		retry?: string,
	): Promise<Result<void>> => {
		const { deps, request, questions } = form;
		const text =
			question === confirm
				? confirmBody(deps.harness, request)
				: body(
						deps.harness,
						request,
						question,
						{ index: questions.indexOf(question), total: questions.length },
						retry,
					);
		const asked = await Questions.ask(deps, text);
		if (!asked.ok) return asked;
		form.open.set(asked.value.id, question);
		form.asked.push(asked.value.id);
		return ok(undefined);
	};

	const close = (form: Form, why: string): Promise<void> =>
		Questions.withdraw(form.deps, [...form.open.keys()], why);

	const notRelayed = async <T>(
		form: Form,
		error: Error,
	): Promise<Result<T>> => {
		await close(form, "withdrawn: the form could not be relayed");
		form.deps.emit({
			type: "error",
			summary: `form not relayed, so it is cancelled: ${form.request.message}: ${error.message}`,
		});
		return err(error);
	};

	const stoppedWaiting = async <T>(
		form: Form,
		withdrawn: AbortSignal,
	): Promise<Result<T>> => {
		const { deps, request } = form;
		const closed = Questions.closedBecause(deps, withdrawn);
		await close(form, closed.why);
		const after = Questions.seconds(waited(form));
		deps.emit({
			type: closed.stopped ? "elicitation_cancelled" : "elicitation_withdrawn",
			summary: closed.stopped
				? `${request.message}: the run stopped after ${after} waiting on a human; the form is cancelled, not answered`
				: `${request.message}: ${closed.why} after ${after}; its questions are closed, not answered`,
			data: details(form),
		});
		return err(new Error(closed.why));
	};

	const answered = (
		form: Form,
		answer: AcpClient.ElicitationAnswer,
	): Result<AcpClient.ElicitationAnswer> => {
		const by = [...form.by].join(", ");
		const after = Questions.seconds(waited(form));
		const fields =
			answer.action === "accept" ? Object.keys(answer.content) : [];
		form.deps.emit({
			type: "elicitation_answered",
			summary:
				answer.action === "accept"
					? `${form.request.message}: ${fields.length} of ${form.request.fields.length} fields answered by ${by} after ${after}`
					: `${form.request.message}: declined by ${by} after ${after}`,
			data: {
				...details(form),
				action: answer.action,
				by,
				...(answer.action === "accept" ? { fields: fields.join(",") } : {}),
			},
		});
		return ok(answer);
	};

	/**
	 * Put `request` to the human and wait for every field's answer: `accept` with the fields they
	 * answered, or `decline` once they decline any field. An error when the claim stops first,
	 * the harness withdraws the form (`withdrawn`), or a question cannot be written, which the ACP
	 * client sends as `cancel`; the questions still open then close as withdrawn.
	 */
	export const relay = async (
		deps: Questions.Deps,
		request: AcpClient.ElicitationRequest,
		withdrawn: AbortSignal,
	): Promise<Result<AcpClient.ElicitationAnswer>> => {
		const form: Form = {
			deps,
			request,
			questions:
				request.fields.length > 0 ? questions(request.fields) : [confirm],
			open: new Map(),
			asked: [],
			askedAt: deps.now().getTime(),
			by: new Set(),
		};
		for (const question of form.questions) {
			const asked = await ask(form, question);
			if (!asked.ok) return notRelayed(form, asked.error);
		}
		const total = form.questions.length;
		deps.emit({
			type: "elicitation_asked",
			summary: `${request.message} (${total} question${total === 1 ? "" : "s"}: ${form.asked.join(", ")})`,
			data: details(form),
		});
		const waiting = Questions.either(deps, withdrawn);
		const content: Record<string, AcpClient.ElicitationValue> = {};
		while (form.open.size > 0) {
			const answers = await Questions.awaitAnswers(
				deps,
				[...form.open.keys()],
				waiting,
			);
			if (!answers) return stoppedWaiting(form, withdrawn);
			for (const [questionId, reply] of answers) {
				const question = form.open.get(questionId);
				if (!question) continue;
				form.open.delete(questionId);
				form.by.add(deps.answeredBy(questionId) ?? "unrecorded");
				const given = answer(question, reply.body);
				if (given.kind === "decline") {
					await close(
						form,
						"withdrawn: the form was declined on another of its questions",
					);
					return answered(form, { action: "decline" });
				}
				if (given.kind === "value" && question !== confirm)
					content[given.key] = given.value;
				if (given.kind !== "invalid") continue;
				deps.emit({
					type: "warning",
					summary: `answer "${reply.body}" to question ${questionId} ${given.why}; asked again`,
				});
				const again = await ask(
					form,
					question,
					`Asked again: "${reply.body}" ${given.why}.`,
				);
				if (!again.ok) return notRelayed(form, again.error);
			}
		}
		return answered(form, { action: "accept", content });
	};
}
