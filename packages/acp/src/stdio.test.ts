import { describe, expect, it } from "bun:test";
import { Stdio } from "./stdio";

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("Stdio.stdinSink", () => {
	it("writes then flushes every chunk and ends the sink on close", async () => {
		const calls: string[] = [];
		const sink: Stdio.Sink = {
			write: (chunk) => {
				calls.push(
					`write:${typeof chunk === "string" ? chunk : decode(chunk as Uint8Array)}`,
				);
				return 1;
			},
			flush: () => {
				calls.push("flush");
				return 0;
			},
			end: () => {
				calls.push("end");
				return 0;
			},
		};
		const writer = Stdio.stdinSink(sink).getWriter();
		await writer.write(encode("a"));
		await writer.write(encode("b"));
		await writer.close();
		expect(calls).toEqual(["write:a", "flush", "write:b", "flush", "end"]);
	});
});

const filter = async (chunks: string[]): Promise<string[]> => {
	const out: string[] = [];
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) controller.enqueue(encode(c));
			controller.close();
		},
	}).pipeThrough(Stdio.jsonLines());
	for await (const chunk of readable) out.push(decode(chunk));
	return out;
};

describe("Stdio.jsonLines", () => {
	it("drops log lines and keeps JSON lines newline-terminated", async () => {
		expect(
			await filter(['[info] starting\n{"jsonrpc":"2.0","id":1}\nwarn: slow\n']),
		).toEqual(['{"jsonrpc":"2.0","id":1}\n']);
	});

	it("reassembles a line split across chunks", async () => {
		expect(await filter(['{"a":', '1}\n{"b":2}\n'])).toEqual([
			'{"a":1}\n',
			'{"b":2}\n',
		]);
	});

	it("flushes a trailing line without a newline; leading whitespace is left for the SDK to trim", async () => {
		expect(await filter(['  {"tail":true}'])).toEqual(['  {"tail":true}\n']);
	});
});
