import { ok, err, type ToolDef } from "@cabane/core";
import type { z } from "zod";
import { ListSchema, questionPage } from "./page";
import { AnswerSchema, AskSchema } from "./schema";
import { Questions } from "./storage";

const define = <Shape extends z.ZodRawShape>(tool: ToolDef<Shape>): ToolDef =>
	tool as unknown as ToolDef;

export const questionTools: readonly ToolDef[] = [
	define({
		name: "kabane_ask",
		kind: "write",
		description:
			"File 1–10 human decisions on an issue (short id or ULID). Supply choices, a recommended choice label, and why. waiting defaults to true and moves the issue to waiting. Returns question handles in ULID order.",
		input: AskSchema.shape,
		handler: async (args, ctx) => {
			const rows = await Questions.ask(ctx.basePath, args, ctx.actor);
			return rows.ok
				? ok(rows.value.map((row) => row.handle).join("\n"))
				: rows;
		},
	}),
	define({
		name: "kabane_questions",
		kind: "read",
		description:
			"Read decisions grouped by issue. Supply id for one issue, or scopeUri (defaults to the current scope; required on the hub). status defaults to open; all includes answered and withdrawn. Default limit 20, maximum 100, bounded to 16KiB. Pass nextCursor unchanged as cursor with the same filters; relevant writes invalidate it.",
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
	define({
		name: "kabane_answer",
		kind: "write",
		description:
			"Answer a question by handle (JCAB-12:1) or ULID. Choices match ignoring case; multi-select uses a comma list; free text requires allowFreeform. Re-answering overwrites. Alternatively supply withdraw: true and reasoning, without answer. Closing the last open question moves a waiting issue to next atomically; the result says whether it moved.",
		input: AnswerSchema.innerType().shape,
		handler: async (args, ctx) => {
			const result = await Questions.answer(ctx.basePath, args, ctx.actor);
			if (!result.ok) return result;
			const { question, moved } = result.value;
			return ok(
				`${question.handle} ${question.status}${question.answer ? `: ${question.answer}` : ""}\n${moved ? "Issue moved to next." : "Issue did not move."}`,
			);
		},
	}),
];
