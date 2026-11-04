import { afterEach, describe, expect, it } from "bun:test";
import type { ClipboardWriteResult } from "@opentui/core";
import {
	createTestRenderer,
	setRendererCapabilities,
	type TestRendererSetup,
} from "@opentui/core/testing";
import { Clipboard } from "./clipboard";

const NOT_ATTEMPTED = {
	status: "not-attempted",
	capability: "unknown",
} as const;

describe("Clipboard.outcome", () => {
	it("reports the host when the pasteboard took it", () => {
		expect(
			Clipboard.outcome({
				host: { status: "written" },
				terminal: NOT_ATTEMPTED,
			}),
		).toEqual({ ok: true, value: "host" });
	});

	it("reports the terminal once OSC 52 went out", () => {
		const result: ClipboardWriteResult = {
			host: { status: "unsupported" },
			terminal: { status: "attempted", capability: "unknown" },
		};
		expect(Clipboard.outcome(result)).toEqual({ ok: true, value: "terminal" });
	});

	it("names a terminal that refuses OSC 52", () => {
		const result = Clipboard.outcome({
			host: { status: "not-attempted" },
			terminal: { status: "not-attempted", capability: "unsupported" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.message).toBe("copy not supported by this terminal");
	});

	it("carries the host's own reason when it failed and nothing else stuck", () => {
		const result = Clipboard.outcome({
			host: { status: "failed", error: new Error("no display") },
			terminal: { status: "local-failure", capability: "unknown" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.message).toBe("copy failed: no display");
	});
});

// Remote, so `best-available` never reaches the host: a test run leaves this machine's pasteboard alone.
describe("Clipboard.write on a remote session", () => {
	let setup: TestRendererSetup | null = null;

	afterEach(async () => {
		if (!setup) return;
		await Clipboard.release(setup.renderer);
		await setup.dispose();
		setup = null;
	});

	const remoteRenderer = async (
		osc52: "supported" | "unsupported",
	): Promise<{ renderer: TestRendererSetup["renderer"]; sent: string[] }> => {
		setup = await createTestRenderer({ width: 20, height: 4 });
		const { renderer } = setup;
		setRendererCapabilities(renderer, { remote: true, osc52_support: osc52 });
		// A test renderer's native session has no terminal phase to write OSC 52 in (it throws
		// InvalidPhase), so the escape itself is recorded here; the bytes are checked live in a pty.
		const sent: string[] = [];
		renderer.copyToClipboardOSC52 = (text) => {
			sent.push(text);
			return true;
		};
		return { renderer, sent };
	};

	it("sends OSC 52 only, with NUL dropped", async () => {
		const { renderer, sent } = await remoteRenderer("supported");
		const result = await Clipboard.write(renderer, "the\0 brief");
		expect(result).toEqual({ ok: true, value: "terminal" });
		expect(sent).toEqual(["the brief"]);
	});

	it("says so when the terminal cannot take OSC 52", async () => {
		const { renderer, sent } = await remoteRenderer("unsupported");
		const result = await Clipboard.write(renderer, "the brief");
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.message).toBe("copy not supported by this terminal");
		expect(sent).toEqual([]);
	});

	it("errors on nothing to copy without reaching the terminal", async () => {
		const { renderer, sent } = await remoteRenderer("supported");
		const result = await Clipboard.write(renderer, "\0");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toBe("nothing to copy");
		expect(sent).toEqual([]);
	});
});
