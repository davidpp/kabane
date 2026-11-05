import { parseDecisionBody } from "./body";
import type { QuestionView } from "./schema";

export const singleLine = (text: string): string =>
	text.replace(/\s*[\r\n]+\s*/g, " ");

export const questionMarkdown = (row: QuestionView, brief = false): string => {
	const question = parseDecisionBody(row.body);
	const modes = [
		...(question.multiSelect ? ["multi-select"] : []),
		...(question.allowFreeform ? [] : ["choices only"]),
	];
	const mode = modes.length ? ` (${modes.join(", ")})` : "";
	const title = `${singleLine(row.handle)} ${singleLine(question.question)}${mode}`;
	// A handle can shift after sync; the ULID at the end of the question's line never does.
	const id = ` id:${row.id}`;
	const reasoning = row.reasoning ? singleLine(row.reasoning) : "";
	if (row.status === "answered") {
		const author = singleLine(row.answeredBy ?? "unknown");
		const answer = singleLine(row.answer ?? "");
		return brief
			? `${title} → ${answer} (${author}${reasoning ? `, ${reasoning}` : ""})${id}`
			: `${title}${id}\n→ ${answer} (${author})${reasoning ? `: ${reasoning}` : ""}`;
	}
	if (row.status === "withdrawn")
		return `${title}${id}\nWithdrawn${reasoning ? `: ${reasoning}` : ""}`;
	const choices = question.choices.map(
		(label) =>
			`- ${singleLine(label)}${label === question.recommended ? " ★" : ""}`,
	);
	return [
		`${title}${id}`,
		...choices,
		...(row.why ? [`why: ${singleLine(row.why)}`] : []),
	].join("\n");
};

export const questionsMarkdown = (
	rows: QuestionView[],
	brief = false,
): string => {
	const lines: string[] = [];
	let taskId: string | undefined;
	for (const row of rows) {
		if (row.taskId !== taskId) {
			lines.push(
				`## ${singleLine(row.shortId ?? row.taskId)} ${singleLine(row.title)} · ${singleLine(row.priority)} · ${singleLine(row.state)}`,
			);
			taskId = row.taskId;
		}
		lines.push(questionMarkdown(row, brief));
	}
	return lines.join("\n\n");
};
