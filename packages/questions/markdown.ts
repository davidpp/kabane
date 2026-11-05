import { parseDecisionBody } from "./body";
import type { QuestionView } from "./schema";

export const questionMarkdown = (row: QuestionView, brief = false): string => {
	const question = parseDecisionBody(row.body);
	const title = `${row.handle} ${question.question}`;
	if (row.status === "answered") {
		const author = row.answered_by ?? "unknown";
		return brief
			? `${title} → ${row.answer} (${author}${row.reasoning ? `, ${row.reasoning}` : ""})`
			: `${title}\n→ ${row.answer} (${author})${row.reasoning ? `: ${row.reasoning}` : ""}`;
	}
	if (row.status === "withdrawn")
		return `${title}\nWithdrawn${row.reasoning ? `: ${row.reasoning}` : ""}`;
	const choices = question.choices.map(
		(label) => `- ${label}${label === question.recommended ? " ★" : ""}`,
	);
	return [
		title,
		...choices,
		...(row.why ? [`why: ${row.why.replace(/\s*\n\s*/g, " ")}`] : []),
	].join("\n");
};

export const questionsMarkdown = (
	rows: QuestionView[],
	brief = false,
): string => {
	const lines: string[] = [];
	let taskId: string | undefined;
	for (const row of rows) {
		if (row.task_id !== taskId) {
			lines.push(
				`## ${row.short_id ?? row.task_id} ${row.title} · ${row.priority} · ${row.state}`,
			);
			taskId = row.task_id;
		}
		lines.push(questionMarkdown(row, brief));
	}
	return lines.join("\n\n");
};
