import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { Exec } from "./exec";

describe("Exec.tool", () => {
	it("says what failed with long or multi-line arguments cut short, and what the tool said", async () => {
		const sh = Exec.tool("sh");
		const body = `The brief.\n\n## Gates\n\n${"- a gate\n".repeat(20)}`;
		const failed = await sh(tmpdir(), [
			"-c",
			"echo 'not signed in' >&2; exit 4",
			body,
		]);
		expect(!failed.ok && failed.error.message).toBe(
			`sh -c echo 'not signed in' >&2; exit 4 The brief.… failed in ${tmpdir()}: not signed in`,
		);
	});
});
