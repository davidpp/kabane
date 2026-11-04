// A harness's tool calls, folded back together from ACP's updates and shown to the board as text.
// ACP opens a call with `tool_call` and then sends only what changed, so whoever records a call keeps
// the call so far, and the board's port gets the detail it shows when the row is opened, capped here
// so a session that read a big file does not write the whole file into its event log.
import type { ActivityDiff, ActivityToolDetail } from "@cabane/board/ports";
import type { AcpClient } from "./client";

export namespace ToolCalls {
	export type Call = {
		title: string;
		kind?: string;
		status?: string;
		content: readonly AcpClient.ToolContent[];
		input?: unknown;
		output?: unknown;
	};

	type ToolUpdate = Extract<
		AcpClient.Update,
		{ type: "tool_call" | "tool_call_update" }
	>;

	// The head of what a call was given and the tail of what it gave back: an input says what it is
	// at its start, a command's output says how it went at its end.
	const INPUT_CHARS = 4_000;
	const OUTPUT_CHARS = 8_000;
	// A diff is two whole files. One past this is left out; the input still names the file.
	const DIFF_CHARS = 64_000;

	/**
	 * `update` folded into the call it belongs to, which `calls` then holds. A field the update
	 * carries replaces the old one whole, `content` too, as ACP says; an update for a call never
	 * opened opens it under its title, or its id.
	 */
	export const apply = (calls: Map<string, Call>, update: ToolUpdate): Call => {
		const known = calls.get(update.id);
		const call: Call = {
			...known,
			title: update.title ?? known?.title ?? update.id,
			content: update.content ?? known?.content ?? [],
			...(update.kind !== undefined ? { kind: update.kind } : {}),
			...(update.status !== undefined ? { status: update.status } : {}),
			...(update.input !== undefined ? { input: update.input } : {}),
			...(update.output !== undefined ? { output: update.output } : {}),
		};
		calls.set(update.id, call);
		return call;
	};

	/** What the board shows of `call` once its row is opened. */
	export const detail = (call: Call): ActivityToolDetail => {
		const input = inputText(call.input);
		const output = outputText(call);
		const diffs = call.content.flatMap((item): ActivityDiff[] =>
			item.type === "diff" &&
			(item.oldText ?? "").length + item.newText.length <= DIFF_CHARS
				? [
						{
							path: item.path,
							...(item.oldText !== undefined ? { oldText: item.oldText } : {}),
							newText: item.newText,
						},
					]
				: [],
		);
		return {
			...(call.kind ? { kind: call.kind } : {}),
			...(input ? { input: head(input, INPUT_CHARS) } : {}),
			...(output ? { output: tail(output, OUTPUT_CHARS) } : {}),
			...(diffs.length > 0 ? { diffs } : {}),
		};
	};

	const head = (text: string, chars: number): string =>
		text.length > chars ? `${text.slice(0, chars - 1)}…` : text;

	const tail = (text: string, chars: number): string =>
		text.length > chars ? `…${text.slice(text.length - chars + 1)}` : text;

	const stringify = (value: unknown): string =>
		typeof value === "string" ? value : (JSON.stringify(value) ?? "");

	const isRecord = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);

	// An argument object reads as one `name: value` line per argument, a string value as written, so
	// a shell command's own line breaks stay line breaks instead of `\n` inside a JSON string.
	const inputText = (input: unknown): string => {
		if (input === undefined || input === null) return "";
		if (!isRecord(input)) return stringify(input);
		return Object.entries(input)
			.filter(([, value]) => value !== undefined && value !== null)
			.map(([name, value]) => `${name}: ${stringify(value)}`)
			.join("\n");
	};

	// The text the call showed, else its raw result. A harness that fences its output as a code block
	// (claude-agent-acp's ```console) has the fence taken off: the board shows it as output already.
	const outputText = (call: Call): string => {
		const texts = call.content.flatMap((item) =>
			item.type === "text" ? [unfenced(item.text)] : [],
		);
		if (texts.length > 0) return texts.join("\n").trim();
		if (call.output === undefined || call.output === null) return "";
		return isRecord(call.output) || Array.isArray(call.output)
			? JSON.stringify(call.output, null, 2)
			: stringify(call.output);
	};

	const FENCE = /^```[\w-]*\n([\s\S]*?)\n?```\s*$/;

	const unfenced = (text: string): string => {
		const match = FENCE.exec(text.trim());
		return match ? (match[1] ?? "") : text;
	};
}
