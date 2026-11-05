/** @jsxImportSource @opentui/react */
import { describe, expect, it } from "bun:test";
import type { TextareaRenderable } from "@opentui/core";
import { createRef } from "react";
import { CopilotLog } from "./copilot-log";
import { CopilotPane } from "./copilot-prompt";
import { Fixtures } from "./stories/fixtures";
import { renderTest } from "./testing";

const LONG =
	"Redis keeps tokens across restarts; drafting the migration steps for the readers and writers now.";

const tailLog = (): CopilotLog.Log => {
	const at = new Date().toISOString();
	const log = CopilotLog.apply(
		CopilotLog.start(null, "plan the token store", at),
		{
			type: "plan",
			entries: [{ content: "Draft the migration plan", status: "in_progress" }],
			at,
		},
	);
	return CopilotLog.apply(log, { type: "text", summary: LONG, at });
};

describe("the copilot pane's edges", () => {
	for (const width of [80, 40]) {
		it(`at ${width} columns, the tail fills the padding`, async () => {
			const { captureCharFrame, destroy } = await renderTest(
				<CopilotPane
					copilot={Fixtures.copilot({ turn: "running", hasLog: true })}
					chip="JREP-1"
					focused
					log={tailLog()}
					spinnerFrame="⠋"
					textareaRef={createRef<TextareaRenderable>()}
					onSubmit={() => {}}
					onContentChange={() => {}}
				/>,
				{ width, height: 12 },
			);
			try {
				const rows = captureCharFrame().split("\n");
				// Only the two padding cells surround a tail line, including its ellipsis.
				expect(rows.find((row) => row.startsWith(" Redis"))).toBe(
					` ${LONG.slice(0, width - 3)}… `,
				);
			} finally {
				destroy();
			}
		});
	}
});
