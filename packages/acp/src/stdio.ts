// The two seams between a harness subprocess and the SDK's `ndJsonStream`, which wants web
// streams on both sides. Bun's piped stdin is a `FileSink`, not a `WritableStream`, and
// harnesses interleave plain log lines with JSON-RPC on stdout, which `ndJsonStream` would
// answer with a parse-error response instead of ignoring.
import type { FileSink } from "bun";

export namespace Stdio {
	// Minimal surface of Bun's FileSink the adapter relies on, so tests can hand in a fake.
	export type Sink = Pick<FileSink, "write" | "flush" | "end">;

	export const stdinSink = (sink: Sink): WritableStream<Uint8Array> =>
		new WritableStream<Uint8Array>({
			async write(chunk) {
				await sink.write(chunk);
				await sink.flush();
			},
			async close() {
				await sink.end();
			},
			async abort(reason) {
				await sink.end(reason instanceof Error ? reason : undefined);
			},
		});

	const NEWLINE = 0x0a;
	const OPEN_BRACE = 0x7b;

	// A JSON-RPC message is one object per line. Anything else on stdout is harness chatter.
	const looksLikeJson = (line: Uint8Array): boolean => {
		for (const byte of line) {
			if (byte === 0x20 || byte === 0x09 || byte === 0x0d) continue;
			return byte === OPEN_BRACE;
		}
		return false;
	};

	export const jsonLines = (): TransformStream<Uint8Array, Uint8Array> => {
		let pending = new Uint8Array(0);
		const emit = (
			line: Uint8Array,
			controller: TransformStreamDefaultController<Uint8Array>,
		) => {
			if (!looksLikeJson(line)) return;
			const withNewline = new Uint8Array(line.byteLength + 1);
			withNewline.set(line, 0);
			withNewline[line.byteLength] = NEWLINE;
			controller.enqueue(withNewline);
		};
		return new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				let buffer = concat(pending, chunk);
				let newline = buffer.indexOf(NEWLINE);
				while (newline !== -1) {
					emit(buffer.subarray(0, newline), controller);
					buffer = buffer.subarray(newline + 1);
					newline = buffer.indexOf(NEWLINE);
				}
				pending = buffer.slice();
			},
			flush(controller) {
				if (pending.byteLength > 0) emit(pending, controller);
			},
		});
	};

	const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
		if (a.byteLength === 0) return b;
		const out = new Uint8Array(a.byteLength + b.byteLength);
		out.set(a, 0);
		out.set(b, a.byteLength);
		return out;
	};
}
