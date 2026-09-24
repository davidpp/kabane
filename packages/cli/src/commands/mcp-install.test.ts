import { describe, expect, it } from "bun:test";
import { parseArgs } from "../args";
import type { McpClients } from "../mcp-clients";
import { McpInstall, mcpInstall } from "./mcp-install";

const LAUNCHER = { command: "/opt/bun", args: ["/src/cli/index.ts"] };

/** Records every argv; `present` names the harnesses whose probe finds an entry. */
const fakeRunner = (present: McpClients.Id[] = [], failing: string[] = []) => {
	const calls: string[][] = [];
	const run: McpInstall.Runner = async (argv) => {
		calls.push(argv);
		const [binary, , verb] = argv;
		if (failing.includes(`${binary} ${verb}`))
			return { code: 1, out: "", err: `${binary} said no` };
		const listed = present.some((id) => id === binary);
		if (verb === "get") return { code: listed ? 0 : 1, out: "", err: "" };
		if (verb === "list")
			return {
				code: 0,
				out: "",
				err: listed ? "✓ kabane: /opt/bun (stdio) - Connected" : "",
			};
		return { code: 0, out: "", err: "" };
	};
	return { calls, run };
};

const onPath =
	(...binaries: string[]): McpInstall.Which =>
	(binary) =>
		binaries.includes(binary) ? `/usr/bin/${binary}` : null;

const verbs = (calls: string[][]) => calls.map((c) => c.slice(0, 3).join(" "));

describe("McpInstall.run", () => {
	it("probes, then adds with the harness's own actor", async () => {
		const fake = fakeRunner();
		const reports = await McpInstall.run(
			["claude"],
			{},
			{
				run: fake.run,
				which: onPath("claude"),
				launcher: LAUNCHER,
			},
		);
		expect(reports).toEqual([{ harness: "claude", status: "installed" }]);
		expect(fake.calls).toEqual([
			["claude", "mcp", "get", "kabane"],
			[
				"claude",
				"mcp",
				"add",
				"-s",
				"user",
				"kabane",
				"--",
				"/opt/bun",
				"/src/cli/index.ts",
				"mcp",
				"--as",
				"cabane://actor/agent/claude",
			],
		]);
	});

	it("leaves an existing entry alone without --force", async () => {
		const fake = fakeRunner(["codex", "gemini"]);
		const reports = await McpInstall.run(
			["codex", "gemini"],
			{},
			{
				run: fake.run,
				which: onPath("codex", "gemini"),
				launcher: LAUNCHER,
			},
		);
		expect(reports.map((r) => r.status)).toEqual(["present", "present"]);
		expect(verbs(fake.calls)).toEqual(["codex mcp get", "gemini mcp list"]);
	});

	it("removes then adds with --force", async () => {
		const fake = fakeRunner(["gemini"]);
		const reports = await McpInstall.run(
			["gemini"],
			{ force: true },
			{
				run: fake.run,
				which: onPath("gemini"),
				launcher: LAUNCHER,
			},
		);
		expect(reports).toEqual([{ harness: "gemini", status: "replaced" }]);
		expect(verbs(fake.calls)).toEqual([
			"gemini mcp list",
			"gemini mcp remove",
			"gemini mcp add",
		]);
	});

	it("reports a missing binary and a failed add without spawning past them", async () => {
		const fake = fakeRunner([], ["codex add"]);
		const reports = await McpInstall.run(
			["claude", "codex"],
			{},
			{
				run: fake.run,
				which: onPath("codex"),
				launcher: LAUNCHER,
			},
		);
		expect(reports).toEqual([
			{ harness: "claude", status: "missing" },
			{ harness: "codex", status: "failed", error: "codex said no" },
		]);
		expect(verbs(fake.calls)).toEqual(["codex mcp get", "codex mcp add"]);
	});
});

describe("McpInstall.detect", () => {
	it("keeps the harnesses on PATH, in table order", () => {
		expect(McpInstall.detect(onPath("gemini", "claude"), {})).toEqual([
			"claude",
			"gemini",
		]);
	});

	it("narrows to KABANE_HARNESSES, and finds none when it is empty", () => {
		const all = onPath("claude", "codex", "gemini");
		expect(
			McpInstall.detect(all, { KABANE_HARNESSES: "gemini, claude" }),
		).toEqual(["claude", "gemini"]);
		expect(McpInstall.detect(all, { KABANE_HARNESSES: "" })).toEqual([]);
	});

	it("is narrowed whenever KABANE_HARNESSES is set, empty included", () => {
		expect(McpInstall.narrowed({})).toBe(false);
		expect(McpInstall.narrowed({ KABANE_HARNESSES: "" })).toBe(true);
		expect(McpInstall.narrowed({ KABANE_HARNESSES: "codex" })).toBe(true);
	});
});

describe("mcp install command", () => {
	const install = (argv: string[], deps: McpInstall.Deps) =>
		mcpInstall(parseArgs(["install", ...argv]), {
			launcher: LAUNCHER,
			...deps,
		});

	it("installs into every detected harness when none is named", async () => {
		const fake = fakeRunner();
		const outcome = await install([], {
			run: fake.run,
			which: onPath("claude", "gemini"),
		});
		expect(outcome.exitCode).toBe(0);
		expect(outcome.text).toContain(
			"✓ claude installed  as cabane://actor/agent/claude",
		);
		expect(outcome.text).toContain("✓ gemini installed");
		expect(fake.calls.some((c) => c[0] === "codex")).toBe(false);
	});

	it("prints the snippets and spawns nothing with --print", async () => {
		const fake = fakeRunner();
		const outcome = await install(["--print"], {
			run: fake.run,
			which: onPath("claude"),
		});
		expect(outcome.exitCode).toBe(0);
		expect(fake.calls).toEqual([]);
		for (const title of ["Claude Code", "Codex", "Gemini", "Any other"])
			expect(outcome.text).toContain(`# ${title}`);
	});

	it("falls back to the snippets when no harness is on PATH", async () => {
		const outcome = await install([], {
			run: fakeRunner().run,
			which: onPath(),
		});
		expect(outcome.exitCode).toBe(0);
		expect(outcome.text).toContain("No claude, codex or gemini on PATH");
		expect(outcome.text).toContain("[mcp_servers.kabane]");
	});

	it("narrows --print to the named harness", async () => {
		const outcome = await install(["--harness", "codex", "--print"], {
			which: onPath(),
		});
		expect(outcome.text).toContain("# Codex");
		expect(outcome.text).not.toContain("# Claude Code");
	});

	it("exits 1 when a named harness is not installed", async () => {
		const outcome = await install(["--harness", "gemini"], {
			run: fakeRunner().run,
			which: onPath(),
		});
		expect(outcome.exitCode).toBe(1);
		expect(outcome.text).toContain("✗ gemini not on PATH");
	});

	it("rejects a harness it does not know", async () => {
		const outcome = await install(["--harness", "cursor"], {});
		expect(outcome.exitCode).toBe(2);
	});
});
