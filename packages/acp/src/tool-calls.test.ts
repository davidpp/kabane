// A call folded back from what ACP sends, the way claude-agent-acp 0.99.1 sends it: the call opened
// with a provisional title and no input, refined once the input is complete, then the result alone.
import { describe, expect, it } from "bun:test";
import { AcpClient } from "./client";
import { ToolCalls } from "./tool-calls";

const fold = (updates: AcpClient.Update[]): ToolCalls.Call | undefined => {
	const calls = new Map<string, ToolCalls.Call>();
	let last: ToolCalls.Call | undefined;
	for (const update of updates)
		if (update.type === "tool_call" || update.type === "tool_call_update")
			last = ToolCalls.apply(calls, update);
	return last;
};

const updates = (...raw: Parameters<typeof AcpClient.toUpdate>[0][]) =>
	raw.flatMap((update) => {
		const mapped = AcpClient.toUpdate(update);
		return mapped ? [mapped] : [];
	});

describe("ToolCalls", () => {
	it("keeps what an update leaves out, and takes what it sends whole", () => {
		const call = fold(
			updates(
				{
					sessionUpdate: "tool_call",
					toolCallId: "t1",
					title: "Terminal",
					kind: "execute",
					status: "pending",
					rawInput: {},
				},
				{
					sessionUpdate: "tool_call_update",
					toolCallId: "t1",
					title: "`bun test`",
					rawInput: { command: "bun test", description: "Run the tests" },
				},
				{
					sessionUpdate: "tool_call_update",
					toolCallId: "t1",
					status: "completed",
					content: [
						{
							type: "content",
							content: {
								type: "text",
								text: "```console\n3 pass\n0 fail\n```",
							},
						},
					],
				},
			),
		);
		expect(call).toEqual({
			title: "`bun test`",
			kind: "execute",
			status: "completed",
			input: { command: "bun test", description: "Run the tests" },
			content: [{ type: "text", text: "```console\n3 pass\n0 fail\n```" }],
		});
		expect(call && ToolCalls.detail(call)).toEqual({
			kind: "execute",
			input: "command: bun test\ndescription: Run the tests",
			output: "3 pass\n0 fail",
		});
	});

	it("carries a diff as the two texts, without the old one for a new file", () => {
		const call = fold(
			updates({
				sessionUpdate: "tool_call",
				toolCallId: "t2",
				title: "Write notes.md",
				kind: "edit",
				status: "completed",
				content: [
					{ type: "diff", path: "/repo/notes.md", newText: "hello\n" },
					{
						type: "diff",
						path: "/repo/a.ts",
						oldText: "a\n",
						newText: "b\n",
					},
					{ type: "terminal", terminalId: "x" },
				],
			}),
		);
		expect(call && ToolCalls.detail(call).diffs).toEqual([
			{ path: "/repo/notes.md", newText: "hello\n" },
			{ path: "/repo/a.ts", oldText: "a\n", newText: "b\n" },
		]);
	});

	it("caps the input at its head, the output at its tail, and leaves out a diff too big to keep", () => {
		const call = fold(
			updates({
				sessionUpdate: "tool_call",
				toolCallId: "t3",
				title: "Read big.txt",
				kind: "read",
				rawInput: "x".repeat(10_000),
				rawOutput: `${"a".repeat(10_000)}END`,
				content: [
					{
						type: "diff",
						path: "/repo/big.txt",
						newText: "y".repeat(70_000),
					},
				],
			}),
		);
		const detail = call ? ToolCalls.detail(call) : {};
		expect(detail.input?.length).toBe(4_000);
		expect(detail.input?.endsWith("…")).toBe(true);
		expect(detail.output?.length).toBe(8_000);
		expect(detail.output?.startsWith("…")).toBe(true);
		expect(detail.output?.endsWith("END")).toBe(true);
		expect(detail.diffs).toBeUndefined();
	});

	it("opens a call it never saw open under its id, and reads a raw result when nothing showed one", () => {
		const call = fold([
			{
				type: "tool_call_update",
				id: "t4",
				status: "failed",
				output: { error: "denied" },
			},
		]);
		expect(call?.title).toBe("t4");
		expect(call && ToolCalls.detail(call)).toEqual({
			output: '{\n  "error": "denied"\n}',
		});
	});
});
