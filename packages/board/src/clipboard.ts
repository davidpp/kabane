// Board and CLI copy, through OpenTUI's clipboard. `best-available` writes the host's own pasteboard
// on a local session, falling back to OSC 52 when the host has none, and on a remote one sends only
// OSC 52: the copy lands in the human's terminal and never in the remote machine's pasteboard.
import { err, ok, type Result } from "@cabane/core";
import {
	type ClipboardService,
	type ClipboardWriteResult,
	createClipboard,
	createHostClipboard,
	createRendererClipboardAdapter,
	type RendererClipboardBoundary,
	type TerminalClipboardAdapter,
} from "@opentui/core";

export namespace Clipboard {
	/** Where the copy went: the host's pasteboard, or an OSC 52 escape to the terminal. */
	type Method = "host" | "terminal";

	// OpenTUI refuses NUL and unpaired surrogates before it tries any destination. Neither belongs
	// in a pasteboard, so NUL is dropped and a lone surrogate replaced instead of failing the copy.
	const pasteable = (text: string): string =>
		text.replaceAll("\0", "").toWellFormed();

	// `writeText` rejects on a disposed service or text it refuses.
	const failed = (cause: unknown): Result<never> =>
		err(
			new Error(
				`copy failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			),
		);

	/** What the footer says about what OpenTUI reported. */
	export const outcome = (result: ClipboardWriteResult): Result<Method> => {
		if (result.host.status === "written") return ok("host");
		// OSC 52 has no acknowledgement: `attempted` is as sure as a terminal copy gets.
		if (result.terminal.status === "attempted") return ok("terminal");
		if (result.host.status === "failed") return failed(result.host.error);
		if (result.host.status === "timed-out")
			return err(new Error("copy timed out"));
		if (result.terminal.status === "local-failure")
			return err(new Error("copy failed: could not write to the terminal"));
		return err(new Error("copy not supported by this terminal"));
	};

	// One service per renderer, made on the first copy, so a board that never copies starts no
	// native clipboard. `release` disposes it.
	const services = new WeakMap<RendererClipboardBoundary, ClipboardService>();

	const serviceFor = (
		renderer: RendererClipboardBoundary,
	): ClipboardService => {
		const existing = services.get(renderer);
		if (existing) return existing;
		const service = createClipboard({
			host: createHostClipboard(),
			terminal: createRendererClipboardAdapter(renderer),
		});
		services.set(renderer, service);
		return service;
	};

	/** Copy `text` from the board drawn by `renderer`. */
	export const write = async (
		renderer: RendererClipboardBoundary,
		text: string,
	): Promise<Result<Method>> => {
		const clean = pasteable(text);
		if (clean.length === 0) return err(new Error("nothing to copy"));
		return serviceFor(renderer)
			.writeText(clean, { destination: "best-available" })
			.then(outcome, failed);
	};

	/** A renderer-free terminal adapter for CLI stdout. */
	export const stdoutAdapter = (): TerminalClipboardAdapter => {
		const writeText: TerminalClipboardAdapter["writeText"] = (
			text,
			selection,
		) => {
			if (!process.stdout.isTTY)
				return { status: "not-attempted", capability: "unknown" };
			try {
				// OpenTUI's encoder is native and has no standalone export. OSC 52 has no
				// acknowledgement: attempted means queued on stdout, not confirmed pasted.
				const target = selection === "primary" ? "p" : "c";
				const encoded = Buffer.from(text).toString("base64");
				process.stdout.write(`\x1b]52;${target};${encoded}\x1b\\`);
				return { status: "attempted", capability: "unknown" };
			} catch {
				return { status: "local-failure", capability: "unknown" };
			}
		};
		return {
			// Match OpenTUI's native remote-session detection without creating a renderer.
			remote: [
				"SSH_CONNECTION",
				"SSH_CLIENT",
				"SSH_TTY",
				"MOSH_CONNECTION",
			].some((key) => process.env[key] !== undefined),
			writeText,
			clear: (selection) => writeText("", selection),
		};
	};

	/** Copy without a renderer, using the board's routing with stdout as the terminal. */
	export const writeCli = async (text: string): Promise<Result<Method>> => {
		const clean = pasteable(text);
		if (clean.length === 0) return err(new Error("nothing to copy"));
		const service = createClipboard({
			host: createHostClipboard(),
			terminal: stdoutAdapter(),
		});
		try {
			return await service
				.writeText(clean, { destination: "best-available" })
				.then(outcome, failed);
		} finally {
			await service.dispose();
		}
	};

	/** Dispose the clipboard `renderer` copied through, if it ever did. */
	export const release = async (
		renderer: RendererClipboardBoundary,
	): Promise<void> => {
		const service = services.get(renderer);
		if (!service) return;
		services.delete(renderer);
		await service.dispose();
	};
}
