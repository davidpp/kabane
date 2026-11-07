import { defineTool, err, humanActorOf, ok, type ToolDef } from "@cabane/core";
import { z } from "zod";
import { singleLine } from "./markdown";
import { ListSchema, questionPage } from "./page";
import { AnswerSchema, AskSchema } from "./schema";
import { Questions } from "./storage";

export const questionTools: readonly ToolDef[] = [
	defineTool({
		name: "kabane_ask",
		kind: "write",
		description:
			"File 1–10 human decisions on an issue (short id or ULID). Supply choices, the recommended choice (its full text or its label), and why. When choices are supplied, allowFreeform defaults to false; set it to true to accept other answers. waiting defaults to true and moves the issue to waiting. Returns one line per question in ULID order: its handle, then id:<ULID>.",
		input: AskSchema.shape,
		handler: async (args, ctx) => {
			const rows = await Questions.ask(ctx.basePath, args, ctx.actor);
			return rows.ok
				? ok(rows.value.map((row) => `${row.handle} id:${row.id}`).join("\n"))
				: rows;
		},
	}),
	defineTool({
		name: "kabane_questions",
		kind: "read",
		description:
			"Read decisions grouped by issue. Supply id for one issue, or scopeUri (defaults to the current scope; required on the hub). status defaults to open; all includes answered and withdrawn. Default limit 20, maximum 100, bounded to 16KiB. Pass nextCursor unchanged as cursor with the same filters; relevant writes invalidate it. A handle number can shift after sync brings in an earlier question from another device; each question's line ends with id:<ULID>, which never does.",
		input: ListSchema.shape,
		handler: (args, ctx) => {
			const scopeUri =
				args.scopeUri ?? (args.id === undefined ? ctx.defaultScope : undefined);
			if (args.id === undefined && scopeUri === undefined && ctx.scopeRequired)
				return Promise.resolve(
					err(
						new Error(
							"scopeUri is required here: call kabane_scopeList to see the scopes in use, or supply an issue id.",
						),
					),
				);
			return questionPage(ctx.basePath, { ...args, scopeUri });
		},
	}),
	defineTool({
		name: "kabane_answer",
		kind: "write",
		description:
			'Answer a question by handle (JCAB-12:1) or ULID. A choice is named by its full text or by its label, the text before its first ., : or ) (B for "B. One tree"), ignoring case; the full text is recorded. Multi-select takes a comma list; free text requires allowFreeform. Re-answering overwrites. Alternatively supply withdraw: true and reasoning, without answer. Set relayed: true only when recording a reply the human gave in this conversation: the answer is then credited to the human, and refused when this connection knows no human. Never set it for your own recommendation. Closing the last open question moves a waiting issue to next atomically; the result says whether it moved. A handle number can shift after sync brings in an earlier question from another device; pass the ULID from the question\'s id: when you need stability.',
		input: {
			...AnswerSchema.innerType().shape,
			relayed: z
				.boolean()
				.optional()
				.describe(
					"The human gave this reply in this conversation; credit it to them.",
				),
		},
		handler: async ({ relayed, ...args }, ctx) => {
			const human = relayed ? humanActorOf(ctx) : ctx.actor;
			if (human === undefined)
				return err(
					new Error(
						`relayed: true needs the human this connection relays for, and ${ctx.actor} has none configured. Omit relayed to record the answer as ${ctx.actor}.`,
					),
				);
			const result = await Questions.answer(ctx.basePath, args, human);
			if (!result.ok) return result;
			const { question, moved } = result.value;
			return ok(
				`${question.handle} ${question.status}${question.answer ? `: ${singleLine(question.answer)}` : ""}\n${moved ? "Issue moved to next." : "Issue did not move."}`,
			);
		},
	}),
];
