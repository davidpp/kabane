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

// Real subprocess stdout and macOS PTYs; no replacement terminal or host implementation.
describe("Clipboard.stdoutAdapter", () => {
	const remoteKeys = [
		"SSH_CONNECTION",
		"SSH_CLIENT",
		"SSH_TTY",
		"MOSH_CONNECTION",
	];
	const run = async (body: string, remote?: string, pty = false) => {
		const env = { ...process.env };
		for (const key of remoteKeys) delete env[key];
		if (remote) env[remote] = "";
		const source = `import { Clipboard } from ${JSON.stringify(`${import.meta.dir}/clipboard.ts`)};
			import { createClipboard, createHostClipboard } from "@opentui/core";
			const adapter = Clipboard.stdoutAdapter();
			${body}`;
		const command = [process.execPath, "-e", source];
		const child = Bun.spawn(
			pty ? ["/usr/bin/script", "-q", "/dev/null", ...command] : command,
			{
				cwd: import.meta.dir,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(0);
		expect(stderr).toBe("");
		return stdout;
	};

	it("detects every remote marker, including an empty one, and skips piped stdout", async () => {
		expect(Clipboard.stdoutAdapter().remote).toBe(
			remoteKeys.some((key) => process.env[key] !== undefined),
		);
		for (const remote of [undefined, ...remoteKeys]) {
			const stdout = await run(
				`console.log(JSON.stringify({remote: adapter.remote, write: adapter.writeText("brief", "clipboard"), clear: adapter.clear("primary")}));`,
				remote,
			);
			expect(JSON.parse(stdout)).toEqual({
				remote: remote !== undefined,
				write: NOT_ATTEMPTED,
				clear: NOT_ATTEMPTED,
			});
		}
	});

	it.skipIf(process.platform !== "darwin")(
		"writes and clears both selections on local and remote TTYs",
		async () => {
			for (const remote of [undefined, ...remoteKeys]) {
				const stdout = await run(
					`
				for (const selection of ["clipboard", "primary"]) {
					console.log(JSON.stringify(adapter.writeText("café 🏠", selection)));
					console.log(JSON.stringify(adapter.clear(selection)));
				}`,
					remote,
					true,
				);
				for (const target of ["c", "p"]) {
					expect(stdout).toContain(
						`\x1b]52;${target};${Buffer.from("café 🏠").toString("base64")}\x1b\\`,
					);
					expect(stdout).toContain(`\x1b]52;${target};\x1b\\`);
				}
				expect(stdout.match(/"status":"attempted"/g)).toHaveLength(4);
			}
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"falls back locally when the real host does not support the selection",
		async () => {
			// macOS has no host primary selection: exercise fallback without changing the host pasteboard.
			const stdout = await run(
				`
			const service = createClipboard({host: createHostClipboard(), terminal: adapter});
			try {
				console.log(JSON.stringify(await service.writeText("brief", {destination: "best-available", selection: "primary"})));
			} finally { await service.dispose(); }
		`,
				undefined,
				true,
			);
			expect(stdout).toContain('"host":{"status":"unsupported"}');
			expect(stdout).toContain('"status":"attempted"');
			expect(stdout).toContain("\x1b]52;p;YnJpZWY=\x1b\\");
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"writeCli sanitizes text and refuses empty copies",
		async () => {
			const stdout = await run(
				`
			console.log(JSON.stringify(await Clipboard.writeCli("a\\0\\ud800")));
			const empty = await Clipboard.writeCli("\\0");
			console.log(empty.ok ? "unexpected success" : empty.error.message);
		`,
				"SSH_TTY",
				true,
			);
			expect(stdout).toContain(
				`\x1b]52;c;${Buffer.from("a�").toString("base64")}\x1b\\`,
			);
			expect(stdout).toContain('"value":"terminal"');
			expect(stdout).toContain("nothing to copy");
			expect(stdout.split("\x1b]52;")).toHaveLength(2);
		},
	);
});
