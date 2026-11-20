import { expect, it } from "bun:test";
import { CopilotInstructions, Harnesses } from "@kabane/acp";
import { actorUri, SERVER_NAME } from "./session-identity";

it("keeps the loop's session identity aligned with ACP", () => {
	expect(SERVER_NAME).toBe(CopilotInstructions.SERVER_NAME);
	for (const harness of Harnesses.IDS)
		expect(actorUri(harness)).toBe(CopilotInstructions.actorUri(harness));
});
