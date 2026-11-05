import { parseDecisionBody } from "./body";
import type { QuestionView } from "./schema";

export const singleLine = (text: string): string =>
	text.replace(/\s*[\r\n]+\s*/g, " ");

export const questionMarkdown = (row: QuestionView, brief = false): string => {
	const question = parseDecisionBody(row.body);
	const mode = question.multiSelect
		? " (multi-select)"
		: question.allowFreeform
			? ""
			: " (choices only)";
	const title = `${singleLine(row.handle)} ${singleLine(question.question)}${mode}`;
	const reasoning = row.reasoning ? singleLine(row.reasoning) : "";
	if (row.status === "answered") {
		const author = singleLine(row.answeredBy ?? "unknown");
		const answer = singleLine(row.answer ?? "");
		return brief
			? `${title} → ${answer} (${author}${reasoning ? `, ${reasoning}` : ""})`
			: `${title}\n→ ${answer} (${author})${reasoning ? `: ${reasoning}` : ""}`;
	}
	if (row.status === "withdrawn")
		return `${title}\nWithdrawn${reasoning ? `: ${reasoning}` : ""}`;
	const choices = question.choices.map(
		(label) =>
			`- ${singleLine(label)}${label === question.recommended ? " ★" : ""}`,
	);
	return [
		title,
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
