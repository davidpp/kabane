import { describe, expect, it } from "bun:test";
import { Harnesses } from "./harnesses";

describe("Harnesses.resolve", () => {
	it("pins the adapter version and always sets the session env", () => {
		const launch = Harnesses.resolve("claude");
		expect(launch.command).toBe("npx");
		expect(launch.args).toEqual([
			"-y",
			"@agentclientprotocol/claude-agent-acp@0.76.0",
		]);
		expect(launch.env).toEqual({
			KABANE_SESSION: "1",
			ANTHROPIC_MODEL: "sonnet",
		});
	});

	it("pins Claude to Sonnet, and a configured model replaces it", () => {
		expect(Harnesses.resolve("claude").env.ANTHROPIC_MODEL).toBe("sonnet");
		expect(Harnesses.resolve("claude", { model: "opus" }).env).toEqual({
			KABANE_SESSION: "1",
			ANTHROPIC_MODEL: "opus",
		});
	});

	it("the model survives a command override — it belongs to the harness", () => {
		const launch = Harnesses.resolve("claude", { command: "/opt/my-claude" });
		expect(launch.args).toEqual([]);
		expect(launch.env.ANTHROPIC_MODEL).toBe("sonnet");
	});

	it("a harness whose model variable the registry does not name gets none", () => {
		expect(Harnesses.resolve("codex", { model: "gpt-5" }).env).toEqual({
			KABANE_SESSION: "1",
		});
	});

	it("an overridden command drops the registry args", () => {
		expect(Harnesses.resolve("codex", { command: "/opt/codex-acp" })).toEqual({
			command: "/opt/codex-acp",
			args: [],
			env: { KABANE_SESSION: "1" },
		});
	});

	it("overridden args ride on the registry command", () => {
		const launch = Harnesses.resolve("gemini", { args: ["--acp", "--debug"] });
		expect(launch.command).toBe("gemini");
		expect(launch.args).toEqual(["--acp", "--debug"]);
	});

	it("returns fresh arrays so callers cannot mutate the registry", () => {
		Harnesses.resolve("claude").args.push("--oops");
		expect(Harnesses.resolve("claude").args).toHaveLength(2);
	});

	it("a profile without the pin leaves the model to the user, and carries its own env", () => {
		const loop = { pinModel: false, env: { KABANE_LOOP: "1" } };
		expect(Harnesses.resolve("claude", {}, loop).env).toEqual({
			KABANE_LOOP: "1",
		});
		expect(Harnesses.resolve("claude", { model: "opus" }, loop).env).toEqual({
			KABANE_LOOP: "1",
			ANTHROPIC_MODEL: "opus",
		});
	});

	it("knows its ids and which harness reads a system prompt", () => {
		expect(Harnesses.isId("claude")).toBe(true);
		expect(Harnesses.isId("cursor")).toBe(false);
		expect(Harnesses.acceptsSystemPrompt("claude")).toBe(true);
		expect(Harnesses.acceptsSystemPrompt("codex")).toBe(false);
	});
});

describe("Harnesses.installedCli", () => {
	const on = (bin: string) => (name: string) =>
		name === bin ? `/usr/local/bin/${bin}` : null;

	it("points each adapter at the installed CLI through the variable it reads", () => {
		const claude = Harnesses.installedCli("claude", {}, on("claude"));
		expect(claude.ok && claude.value).toEqual({
			CLAUDE_CODE_EXECUTABLE: "/usr/local/bin/claude",
		});
		const codex = Harnesses.installedCli("codex", {}, on("codex"));
		expect(codex.ok && codex.value).toEqual({
			CODEX_PATH: "/usr/local/bin/codex",
		});
	});

	it("needs no CLI on PATH for a harness without an adapter, whose command is the CLI", () => {
		const gemini = Harnesses.installedCli("gemini", {}, () => null);
		expect(gemini.ok && gemini.value).toEqual({});
	});

	it("fails, rather than falling back to a bundled copy, when the CLI is missing", () => {
		const missing = Harnesses.installedCli("claude", {}, () => null);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.message).toContain("claude");
	});

	it("leaves an executable the user already exported alone, installed or not", () => {
		const claude = Harnesses.installedCli(
			"claude",
			{ CLAUDE_CODE_EXECUTABLE: "/opt/my-wrapper/claude" },
			on("claude"),
		);
		expect(claude.ok && claude.value).toEqual({});
		const codex = Harnesses.installedCli(
			"codex",
			{ CODEX_PATH: "/opt/codex-dev/codex" },
			() => null,
		);
		expect(codex.ok && codex.value).toEqual({});
	});
});
