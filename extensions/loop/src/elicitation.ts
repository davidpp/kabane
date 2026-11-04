// A harness form (ACP form elicitation: AskUserQuestion, codex's request_user_input, an MCP
// server's form), relayed to the human as tracker questions. The loop fills nothing itself and
// never accepts a form on the human's behalf.
//
// Every field becomes one question on the claim's core session, asked together and numbered
// "i of n" so the board lists them as one group: the harness's message, then the field's title
// and description verbatim. A choice is the field's options, several choices a multi-select, a
// boolean Yes / No, text and numbers free text. An optional field also offers `skip`, which
// leaves it out of the answer, and every field offers `decline`, which declines the form. The
// form resolves once every question has an answer; an answer that does not fit its field is
// asked again, with why. A claim that stops, or a harness that withdraws the form, closes the
// questions still open as withdrawn (`questions.ts`).
import type { AcpClient } from "@cabane/acp";
import {
	err,
	formatQuestionBody,
	ok,
	type Result,
	trySync,
} from "@cabane/core";
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

	const freeform = (field: Field): boolean =>
		field.type === "text" || field.type === "number";

	/** What the question offers to pick, in order: the field's own options, then skip and decline. */
	const choices = (field: Field): string[] =>
		freeform(field)
			? []
			: [...optionChoices(field), ...reserved(field)].map((c) => c.label);

	const range = (low?: number, high?: number): string =>
		low !== undefined && high !== undefined
			? ` from ${low} to ${high}`
			: low !== undefined
				? ` of at least ${low}`
				: high !== undefined
					? ` of at most ${high}`
					: "";

	// How to answer a free-text question, which has no choices to show it.
	const hint = (field: Field): string | undefined => {
		if (!freeform(field)) return undefined;
		const what =
			field.type === "number"
				? `${field.integer ? "a whole number" : "a number"}${range(field.minimum, field.maximum)}`
				: "the answer";
		const skip = field.required ? "" : `, \`${SKIP}\` to leave it empty`;
		return `Type ${what}${skip}, or \`${DECLINE}\` to decline the form.`;
	};

	/**
	 * The question for `field`, the `index`th of `total`: the harness's message, then the field's
	 * title and description verbatim, then how to answer one that takes free text. `retry` says
	 * why the last answer was asked again.
	 */
	export const body = (
		harness: string,
		request: AcpClient.ElicitationRequest,
		field: Field,
		position: { index: number; total: number },
		retry?: string,
	): string => {
		const { index, total } = position;
		const of = total > 1 ? ` (${index + 1} of ${total})` : "";
		const described = field.description
			? `${field.title}: ${field.description}`
			: field.title;
		const lines = [
			`${harness} asks: ${request.message}`,
			`${described}${of}`,
			hint(field),
			retry,
		].filter((line): line is string => line !== undefined);
		return formatQuestionBody(lines.join("\n"), {
			choices: choices(field),
			multiSelect: field.type === "choices",
			allowFreeform: freeform(field),
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

	const readText = (
		field: Extract<Field, { type: "text" }>,
		given: string,
	): Read => {
		if (field.minLength !== undefined && given.length < field.minLength)
			return invalid(`is shorter than ${field.minLength} characters`);
		if (field.maxLength !== undefined && given.length > field.maxLength)
			return invalid(`is longer than ${field.maxLength} characters`);
		// A pattern this runtime cannot compile is left to the harness to check.
		const { pattern } = field;
		const compiled =
			pattern === undefined ? undefined : trySync(() => new RegExp(pattern));
		if (compiled?.ok && !compiled.value.test(given))
			return invalid(`does not match ${pattern}`);
		return { kind: "value", value: given };
	};

	const readNumber = (
		field: Extract<Field, { type: "number" }>,
		given: string,
	): Read => {
		const value = given === "" ? Number.NaN : Number(given);
		if (!Number.isFinite(value)) return invalid("is not a number");
		if (field.integer && !Number.isInteger(value))
			return invalid("is not a whole number");
		if (
			(field.minimum !== undefined && value < field.minimum) ||
			(field.maximum !== undefined && value > field.maximum)
		)
			return invalid(`is not${range(field.minimum, field.maximum)}`);
		return { kind: "value", value };
	};

	const readChoices = (
		field: Extract<Field, { type: "choices" }>,
		given: string,
	): Read => {
		const picked = chooseMany(optionChoices(field), given);
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
	 * free-text field, skip and decline are only ever the bare words.
	 */
	export const read = (field: Field, answer: string): Read => {
		const given = answer.trim();
		const options = optionChoices(field);
		const extra = reserved(field);
		const chosen = freeform(field)
			? extra.find((c) => c.label === given.toLowerCase())
			: Permission.choose([...options, ...extra], given);
		if (chosen && !options.includes(chosen))
			return chosen.label === SKIP ? { kind: "skip" } : { kind: "decline" };
		switch (field.type) {
			case "text":
				return readText(field, given);
			case "number":
				return readNumber(field, given);
			case "choices":
				return readChoices(field, given);
			case "boolean":
				return chosen
					? { kind: "value", value: chosen.id === "true" }
					: invalid("is neither Yes nor No");
			case "choice":
				return chosen
					? { kind: "value", value: chosen.id ?? chosen.label }
					: invalid("names none of its choices");
		}
	};

	// A form with no fields asks only for a yes: one question, accept or decline.
	const confirm: Field = {
		key: "",
		title: "",
		required: true,
		type: "choice",
		options: [{ value: ACCEPT, label: ACCEPT }],
	};

	/** One form being relayed: its fields, the questions still open and every one asked. */
	type Form = {
		deps: Questions.Deps;
		request: AcpClient.ElicitationRequest;
		fields: Field[];
		/** The field each open question asks, by question id. */
		open: Map<string, Field>;
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
		field: Field,
		retry?: string,
	): Promise<Result<void>> => {
		const { deps, request, fields } = form;
		const text =
			field === confirm
				? confirmBody(deps.harness, request)
				: body(
						deps.harness,
						request,
						field,
						{ index: fields.indexOf(field), total: fields.length },
						retry,
					);
		const asked = await Questions.ask(deps, text);
		if (!asked.ok) return asked;
		form.open.set(asked.value.id, field);
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

	const stoppedWaiting = async <T>(form: Form): Promise<Result<T>> => {
		const { deps, request } = form;
		const closed = Questions.closedBecause(deps);
		await close(form, closed.why);
		const after = Questions.seconds(waited(form));
		deps.emit({
			type: closed.stopped ? "elicitation_cancelled" : "elicitation_withdrawn",
			summary: closed.stopped
				? `${request.message}: the run stopped after ${after} waiting on a human; the form is cancelled, not answered`
				: `${request.message}: ${deps.harness} withdrew the form after ${after}; its questions are closed, not answered`,
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
			fields: request.fields.length > 0 ? request.fields : [confirm],
			open: new Map(),
			asked: [],
			askedAt: deps.now().getTime(),
			by: new Set(),
		};
		for (const field of form.fields) {
			const asked = await ask(form, field);
			if (!asked.ok) return notRelayed(form, asked.error);
		}
		const total = form.fields.length;
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
			if (!answers) return stoppedWaiting(form);
			for (const [questionId, answer] of answers) {
				const field = form.open.get(questionId);
				if (!field) continue;
				form.open.delete(questionId);
				form.by.add(deps.answeredBy(questionId) ?? "unrecorded");
				const given = read(field, answer.body);
				if (given.kind === "decline") {
					await close(
						form,
						"withdrawn: the form was declined on another of its questions",
					);
					return answered(form, { action: "decline" });
				}
				if (given.kind === "value" && field !== confirm)
					content[field.key] = given.value;
				if (given.kind !== "invalid") continue;
				deps.emit({
					type: "warning",
					summary: `answer "${answer.body}" to question ${questionId} ${given.why}; asked again`,
				});
				const again = await ask(
					form,
					field,
					`Asked again: "${answer.body}" ${given.why}.`,
				);
				if (!again.ok) return notRelayed(form, again.error);
			}
		}
		return answered(form, { action: "accept", content });
	};
}
