import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harnesses } from "./harnesses";

describe("Harnesses.resolve", () => {
	it("pins the adapter version and always sets the session env", () => {
		const launch = Harnesses.resolve("claude");
		expect(launch.command).toBe("npx");
		expect(launch.args).toEqual([
			"-y",
			"@agentclientprotocol/claude-agent-acp@0.99.1",
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
		expect(claude.ok && claude.value).toEqual({
			CLAUDE_CODE_EXECUTABLE: "/opt/my-wrapper/claude",
		});
		const codex = Harnesses.installedCli(
			"codex",
			{ CODEX_PATH: "/opt/codex-dev/codex" },
			() => null,
		);
		expect(codex.ok && codex.value).toEqual({
			CODEX_PATH: "/opt/codex-dev/codex",
		});
	});
});

describe("Harnesses.agentDefinition", () => {
	const agent = (dir: string, file: string, frontmatter: string): string => {
		const agents = join(dir, ".claude", "agents");
		mkdirSync(agents, { recursive: true });
		const path = join(agents, file);
		writeFileSync(path, `---\n${frontmatter}\n---\nYou review board UI.\n`);
		return path;
	};

	it("reads the model a Claude agent pins, the project's over the user's, nearest first", () => {
		const root = mkdtempSync(join(tmpdir(), "harness-agents-"));
		try {
			const home = join(root, "home");
			const project = join(root, "project");
			const sub = join(project, "packages", "board");
			mkdirSync(sub, { recursive: true });
			agent(home, "board-ui.md", "name: board-ui\nmodel: haiku");
			expect(
				Harnesses.agentDefinition("claude", "board-ui", sub, home),
			).toEqual({
				path: join(home, ".claude", "agents", "board-ui.md"),
				model: "haiku",
			});
			// Named by its frontmatter, whatever its file is called, and found from a folder inside.
			const own = agent(project, "ui.md", 'name: board-ui\nmodel: "opus"');
			expect(
				Harnesses.agentDefinition("claude", "board-ui", sub, home),
			).toEqual({ path: own, model: "opus" });
			const nearer = agent(sub, "board-ui.md", "description: x");
			expect(
				Harnesses.agentDefinition("claude", "board-ui", sub, home),
			).toEqual({ path: nearer });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads no pin from inherit, and nothing for an agent nobody defines or a harness without agents", () => {
		const root = mkdtempSync(join(tmpdir(), "harness-agents-"));
		try {
			const path = agent(root, "docs.md", "name: docs\nmodel: inherit");
			expect(Harnesses.agentDefinition("claude", "docs", root, root)).toEqual({
				path,
			});
			expect(
				Harnesses.agentDefinition("claude", "nobody", root, root),
			).toBeUndefined();
			expect(
				Harnesses.agentDefinition("codex", "docs", root, root),
			).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
