/** @jsxImportSource @opentui/react */
// The open copilot pane draws the turn's plan across its whole inner width: an entry is cut at the
// pane's right padding, not short of it.
import { describe, expect, it } from "bun:test";
import type { TextareaRenderable } from "@opentui/core";
import { createRef } from "react";
import { CopilotLog } from "./copilot-log";
import { CopilotPane } from "./copilot-prompt";
import { Fixtures } from "./stories/fixtures";
import { renderTest } from "./testing";

const LONG =
	"Draft the migration plan for the token store, the readers first and the writers after, then file each step";

const planLog = (): CopilotLog.Log => {
	const at = new Date().toISOString();
	return CopilotLog.apply(CopilotLog.start(null, "plan the token store", at), {
		type: "plan",
		entries: [
			{ content: "Read JREP-1", status: "completed" },
			{ content: LONG, status: "in_progress" },
		],
		at,
	});
};

describe("the copilot pane's plan", () => {
	it("at 80 columns, a long entry reaches the pane's padding and is cut there", async () => {
		const { captureCharFrame, destroy } = await renderTest(
			<CopilotPane
				copilot={Fixtures.copilot({
					turn: "running",
					actor: "cabane://actor/agent/claude",
					hasLog: true,
				})}
				chip="JREP-1"
				focused
				log={planLog()}
				spinnerFrame="⠋"
				askInHand
				textareaRef={createRef<TextareaRenderable>()}
				onSubmit={() => {}}
				onContentChange={() => {}}
			/>,
			{ width: 80, height: 12 },
		);
		try {
			const row = captureCharFrame()
				.split("\n")
				.find((each) => each.startsWith(" ⠋ "));
			// One cell of padding either side, the glyph and its space, then 76 columns of the entry,
			// its last the `…`.
			expect(row).toBe(` ⠋ ${LONG.slice(0, 75)}… `);
		} finally {
			destroy();
		}
	});
});
