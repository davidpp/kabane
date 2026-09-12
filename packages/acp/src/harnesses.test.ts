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
		expect(launch.env).toEqual({ CABANE_SESSION: "1" });
	});

	it("an overridden command drops the registry args", () => {
		expect(Harnesses.resolve("codex", { command: "/opt/codex-acp" })).toEqual({
			command: "/opt/codex-acp",
			args: [],
			env: { CABANE_SESSION: "1" },
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

	it("knows its ids and which harness reads a system prompt", () => {
		expect(Harnesses.isId("claude")).toBe(true);
		expect(Harnesses.isId("cursor")).toBe(false);
		expect(Harnesses.acceptsSystemPrompt("claude")).toBe(true);
		expect(Harnesses.acceptsSystemPrompt("codex")).toBe(false);
	});
});
