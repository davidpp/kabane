import { expect, it } from "bun:test";
import { Harnesses } from "@kabane/acp";
import { TestHarnesses } from "./test-harnesses";

const before = process.env.CLAUDE_CODE_EXECUTABLE;

it("points each adapter's CLI at a path that does not exist once a test asks for overrides", () => {
	TestHarnesses.overrides();
	TestHarnesses.overrides();
	expect(Harnesses.installedCli("claude")).toEqual({
		ok: true,
		value: {
			CLAUDE_CODE_EXECUTABLE: TestHarnesses.CLIS.CLAUDE_CODE_EXECUTABLE,
		},
	});
	expect(Harnesses.installedCli("codex")).toEqual({
		ok: true,
		value: { CODEX_PATH: TestHarnesses.CLIS.CODEX_PATH },
	});
});

it("gives them back once that test has finished", () => {
	expect(process.env.CLAUDE_CODE_EXECUTABLE).toBe(before);
});
