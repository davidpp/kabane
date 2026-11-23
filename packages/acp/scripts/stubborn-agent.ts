#!/usr/bin/env bun
/**
 * An ACP harness that does not want to stop, for tests that check closing one leaves nothing
 * running: it ignores stdin EOF and SIGTERM, and starts a child that ignores SIGTERM too, the way
 * an npx wrapper holds the adapter it launched. Its second argument picks how far a start gets,
 * and once the start is there it writes `<its pid> <child pid>` to the file named by its first:
 *
 *   handshake   never answers `initialize`; written when `initialize` arrives
 *   session     answers `initialize`, never `session/new`; written when `session/new` arrives
 *   open        answers `initialize`, `session/new` and every prompt (an empty `end_turn`);
 *               written when `session/new` arrives
 *   deaf        answers `initialize` and `session/new`, then reads nothing more from stdin, so a
 *               large write to it stays pending; written when `session/new` arrives
 *   turn        answers `initialize` and `session/new`, never a prompt, and ignores
 *               `session/cancel`; written when the first prompt arrives
 *
 * A third argument, `eof`, makes it exit once stdin closes, leaving behind its child, which
 * still ignores SIGTERM: a wrapper that dies on EOF and orphans what it launched.
 */
import { renameSync } from "node:fs";
import {
	agent,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const [pidfile, stage, onEof] = process.argv.slice(2);
if (
	!pidfile ||
	!["handshake", "session", "open", "deaf", "turn"].includes(stage ?? "") ||
	![undefined, "eof"].includes(onEof)
)
	throw new Error(
		"usage: stubborn-agent.ts <pidfile> handshake|session|open|deaf|turn [eof]",
	);

process.on("SIGTERM", () => {});
// An ignored signal stays ignored across exec, so `sleep` ignores it as well.
const child = Bun.spawn(["sh", "-c", "trap '' TERM; exec sleep 600"], {
	stdio: ["ignore", "ignore", "ignore"],
});
// Renamed into place, so a reader never sees the file half written.
const reached = async (): Promise<void> => {
	await Bun.write(`${pidfile}.tmp`, `${process.pid} ${child.pid}`);
	renameSync(`${pidfile}.tmp`, pidfile);
};
// Kept alive after stdin closes.
setInterval(() => {}, 1 << 30);

const never = () => new Promise<never>(() => {});

// Stdin as the SDK reads it, until `deaf` is set: from then on nothing is read, and what kabane
// writes piles up in the pipe.
let deaf = false;
const stdin = Bun.stdin.stream().getReader();
const input = new ReadableStream<Uint8Array>({
	async pull(controller) {
		if (deaf) return never();
		const read = await stdin.read();
		if (!read.done) return controller.enqueue(read.value);
		if (onEof) process.exit(0);
		controller.close();
	},
});

const app = agent({ name: "kabane-stubborn" })
	.onRequest(methods.agent.initialize, async () => {
		if (stage !== "handshake")
			return {
				protocolVersion: PROTOCOL_VERSION,
				agentCapabilities: { loadSession: false },
			};
		await reached();
		return never();
	})
	.onRequest(methods.agent.session.new, async () => {
		// `turn` writes it only once a prompt is pending, so a test that waits for it is in a turn.
		if (stage !== "turn") await reached();
		if (stage === "deaf") deaf = true;
		return stage === "session" ? never() : { sessionId: "stubborn" };
	})
	.onRequest(methods.agent.session.prompt, async () => {
		if (stage !== "turn") return { stopReason: "end_turn" as const };
		await reached();
		return never();
	});

const stdout = new WritableStream<Uint8Array>({
	write: (chunk) => {
		process.stdout.write(chunk);
	},
});
app.connect(ndJsonStream(stdout, input));
