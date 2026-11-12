import { z } from "zod";
import { trySync } from "../../packages/core/result";
import type { Harness, Usage } from "./schema";

const tokens = z
	.object({
		input_tokens: z.number().optional(),
		cached_input_tokens: z.number().optional(),
		output_tokens: z.number().optional(),
		cache_read_input_tokens: z.number().optional(),
		cache_creation_input_tokens: z.number().optional(),
	})
	.passthrough();
const eventSchema = z
	.object({
		type: z.string(),
		subtype: z.string().optional(),
		is_error: z.boolean().optional(),
		model: z.string().optional(),
		apiKeySource: z.string().optional(),
		skills: z.array(z.string()).optional(),
		plugins: z
			.array(
				z
					.object({
						name: z.string(),
						path: z.string().optional(),
						source: z.string().optional(),
					})
					.passthrough(),
			)
			.optional(),
		tools: z.array(z.string()).optional(),
		mcp_servers: z
			.array(z.object({ name: z.string(), status: z.string() }).passthrough())
			.optional(),
		usage: tokens.optional(),
		item: z
			.object({
				type: z.string(),
				server: z.string().optional(),
				tool: z.string().optional(),
			})
			.passthrough()
			.optional(),
		message: z
			.object({
				content: z
					.array(
						z
							.object({ type: z.string(), name: z.string().optional() })
							.passthrough(),
					)
					.optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();
type Event = z.infer<typeof eventSchema>;
export const emptyUsage = (): Usage => ({
	input: null,
	cachedInput: null,
	cacheWrite: null,
	output: null,
	source: "not reported",
});
export type Inventory = {
	tools: string[];
	servers: { name: string; status: string }[];
	plugins: string[];
	externalPlugins: string[];
	skills: string[];
	apiKeySource: string | null;
};
export type Trace = {
	usage: Usage;
	toolCalls: number;
	kabaneCalls: number;
	completed: boolean;
	failed: boolean;
	model: string | null;
	inventory: Inventory | null;
};
const accumulate = (
	old: number | null,
	value: number | undefined,
	first: boolean,
): number | null =>
	value === undefined || (!first && old === null) ? null : (old ?? 0) + value;
const codexEvent = (trace: Trace, event: Event): void => {
	if (event.type === "turn.completed") {
		trace.completed = true;
		if (event.usage)
			trace.usage = {
				input: accumulate(
					trace.usage.input,
					event.usage.input_tokens,
					trace.usage.source === "not reported",
				),
				cachedInput: accumulate(
					trace.usage.cachedInput,
					event.usage.cached_input_tokens,
					trace.usage.source === "not reported",
				),
				output: accumulate(
					trace.usage.output,
					event.usage.output_tokens,
					trace.usage.source === "not reported",
				),
				cacheWrite: null,
				source: "codex turn.completed usage; cached input is a subset of input",
			};
	}
	if (event.type === "turn.failed" || event.type === "error")
		trace.failed = true;
	if (event.type !== "item.completed" || !event.item) return;
	if (
		[
			"command_execution",
			"mcp_tool_call",
			"web_search",
			"file_change",
		].includes(event.item.type)
	)
		trace.toolCalls++;
	if (event.item.type === "mcp_tool_call" && event.item.server === "kabane")
		trace.kabaneCalls++;
};
const claudeUsage = (event: Event): Usage => ({
	input: event.usage?.input_tokens ?? null,
	cachedInput: event.usage?.cache_read_input_tokens ?? null,
	cacheWrite: event.usage?.cache_creation_input_tokens ?? null,
	output: event.usage?.output_tokens ?? null,
	source: "claude result usage; cache reads/writes reported separately",
});
const claudeEvent = (trace: Trace, event: Event): void => {
	if (event.type === "result") {
		trace.completed = !event.is_error && event.subtype === "success";
		trace.failed = !trace.completed;
		if (event.usage) trace.usage = claudeUsage(event);
	}
	for (const item of event.message?.content ?? []) {
		if (item.type !== "tool_use") continue;
		trace.toolCalls++;
		if (item.name?.startsWith("mcp__kabane__")) trace.kabaneCalls++;
	}
};
const inventory = (event: Event): Inventory => ({
	tools: event.tools ?? [],
	servers: event.mcp_servers ?? [],
	plugins: (event.plugins ?? []).map((plugin) => plugin.name).sort(),
	externalPlugins: (event.plugins ?? [])
		.filter(
			(plugin) =>
				!(plugin.path === "builtin" && plugin.source?.endsWith("@builtin")),
		)
		.map((plugin) => plugin.name),
	skills: event.skills ?? [],
	apiKeySource: event.apiKeySource ?? null,
});
export const summarizeTrace = (source: string, harness: Harness): Trace => {
	const trace: Trace = {
		usage: emptyUsage(),
		toolCalls: 0,
		kabaneCalls: 0,
		completed: false,
		failed: false,
		model: null,
		inventory: null,
	};
	for (const line of source.split("\n")) {
		if (!line.trim()) continue;
		const raw = trySync((): unknown => JSON.parse(line));
		if (!raw.ok) continue;
		const parsed = eventSchema.safeParse(raw.value);
		if (!parsed.success) continue;
		const event = parsed.data;
		if (event.type === "system" && event.subtype === "init") {
			trace.model = event.model ?? null;
			trace.inventory = inventory(event);
		}
		if (harness === "codex") codexEvent(trace, event);
		else claudeEvent(trace, event);
	}
	return trace;
};
export const inventoryProblems = (
	trace: Trace,
	expectedModel: string,
	treatment: boolean,
): string[] => {
	const problems: string[] = [];
	if (trace.model !== expectedModel)
		problems.push(
			`Observed model ${trace.model ?? "missing"} differs from requested ${expectedModel}`,
		);
	if (!trace.inventory)
		return [...problems, "No native startup inventory observed"];
	const observed = trace.inventory;
	if (observed.apiKeySource !== "none")
		problems.push("Native init did not confirm apiKeySource=none");
	if (observed.skills.length || observed.externalPlugins.length)
		problems.push("Unexpected external skills/plugins loaded");
	const servers = observed.servers;
	if (
		treatment
			? servers.length !== 1 ||
				servers[0]?.name !== "kabane" ||
				servers[0]?.status !== "connected"
			: servers.length !== 0
	)
		problems.push("MCP server inventory differs from the condition");
	if (!treatment && observed.tools.some((tool) => tool.startsWith("mcp__")))
		problems.push("Baseline exposed MCP tools");
	return problems;
};
export const normalizedInventory = (value: Inventory): string =>
	JSON.stringify({
		tools: value.tools
			.filter((tool) => !tool.startsWith("mcp__kabane__"))
			.sort(),
		plugins: value.plugins,
		externalPlugins: value.externalPlugins,
		skills: value.skills,
		apiKeySource: value.apiKeySource,
	});
