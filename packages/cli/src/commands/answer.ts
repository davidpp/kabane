import { failure, flagString, success, usage } from "@cabane/extension";
import { questionMarkdown, Questions } from "@cabane/questions";
import type { Command } from "../context";

export const answer: Command = {
	name: "answer",
	summary: "Answer a question by handle (JCAB-12:1), or withdraw it",
	usage:
		'kabane answer <handle> <answer…> [--why "<text>"] | kabane answer <handle> --withdraw --why "<text>"',
	run: async (args, ctx) => {
		const [handle, ...rest] = args.positionals;
		const text = rest.join(" ").trim();
		const { withdraw: withdrawFlag, why: whyFlag } = args.flags;
		// A value after --withdraw is a mistyped answer or reason, not a flag argument.
		if (withdrawFlag !== undefined && withdrawFlag !== true)
			return usage(
				"--withdraw takes no value; give the reason with --why",
				answer.usage,
			);
		if (whyFlag !== undefined && flagString(args, "why") === undefined)
			return usage("--why needs a reason", answer.usage);
		const withdraw = withdrawFlag === true;
		const reasoning = flagString(args, "why");
		if (!handle) return usage("Question handle required", answer.usage);
		if (withdraw ? text || !reasoning : !text)
			return usage(
				withdraw
					? "--withdraw takes --why and no answer"
					: "An answer, or --withdraw --why, is required",
				answer.usage,
			);

		const answered = await Questions.answer(
			ctx.store,
			withdraw
				? { question: handle, withdraw, reasoning }
				: { question: handle, answer: text, reasoning },
			ctx.actor,
		);
		if (!answered.ok) return failure(answered.error);
		const { question, moved } = answered.value;
		const lines = [questionMarkdown(question)];
		if (moved)
			lines.push(`${question.short_id ?? question.task_id} moved to next`);
		return success(answered.value, lines.join("\n\n"));
	},
};
