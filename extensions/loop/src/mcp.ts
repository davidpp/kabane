import { defineTool } from "@cabane/core";
import type { Extension } from "@cabane/extension";
import { z } from "zod";
import { LoopAdvice } from "./advice";
import { Loop } from "./commands";

export const loopMcp: NonNullable<Extension["mcp"]> = async (ctx) => ({
	instructions: LoopAdvice.INSTRUCTIONS,
	tools: [
		defineTool({
			name: "kabane_loop_advise",
			description:
				"Returns advised loop settings with reasons and each open subtask's route. Changes nothing. For overrides, use `kabane loop advise`.",
			kind: "read",
			input: {
				id: z
					.string()
					.min(1)
					.describe("Task id: the short label (JCAB-12) or the ULID."),
			},
			handler: async (input, toolCtx) =>
				Loop.advise(
					{
						home: ctx.home,
						basePath: toolCtx.basePath,
						cwd: ctx.cwd,
						settings: ctx.settings,
					},
					{ parent: input.id },
				),
		}),
	],
});
