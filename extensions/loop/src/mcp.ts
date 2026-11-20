import type { Extension, Host } from "@kabane/extension";
import { LoopAdvice } from "./advice";
import { Loop } from "./commands";

export const loopMcp =
	(host: Host): NonNullable<Extension["mcp"]> =>
	async (ctx) => ({
		instructions: LoopAdvice.INSTRUCTIONS,
		tools: [
			host.defineTool({
				name: "kabane_loop_advise",
				description:
					"Returns advised loop settings with reasons and each open subtask's route. Changes nothing. For overrides, use `kabane loop advise`.",
				kind: "read",
				input: {
					id: host.z
						.string()
						.min(1)
						.describe("Task id: the short label (JCAB-12) or the ULID."),
				},
				handler: async (input, toolCtx) =>
					Loop.advise(
						{
							home: ctx.home,
							basePath: toolCtx.basePath,
							host,
							cwd: ctx.cwd,
							settings: ctx.settings,
						},
						{ parent: input.id },
					),
			}),
		],
	});
