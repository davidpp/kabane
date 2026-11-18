/** @jsxImportSource @opentui/react */
import { expect, it } from "bun:test";
import { SettingsOverlay } from "./settings-overlay";
import { SettingsView } from "./settings-view";
import { renderTest } from "./testing";

it("a save the settings no longer resolve after shows what was saved, where, the warning and the failure", async () => {
	const error = "/r/.kabane/loop.json: JSON Parse error: Expected '}'";
	const said = SettingsView.outcome("loop.stallAfter", {
		key: "loop.stallAfter",
		layer: "global",
		from: "/h/config.json",
		value: 6,
		unresolved: error,
		restart: "resolve",
	});
	const { captureCharFrame, destroy } = await renderTest(
		<SettingsOverlay
			view={{
				rows: { type: "failed", error },
				selected: 0,
				detail: false,
				said,
			}}
		/>,
		{ width: 100, height: 12 },
	);
	const frame = captureCharFrame();
	destroy();
	expect(frame).toContain("loop.stallAfter");
	expect(frame).toContain("saved 6 to global");
	expect(frame).toContain("but settings no longer resolve:");
	// The warning carries the failure, so it is not drawn a second time.
	expect(frame).toContain(error);
	expect(frame.split("JSON Parse error").length - 1).toBe(1);
});

it("a failure with no save behind it shows the failure alone", async () => {
	const { captureCharFrame, destroy } = await renderTest(
		<SettingsOverlay
			view={{
				rows: { type: "failed", error: "/r/.kabane/loop.json: bad" },
				selected: 0,
				detail: false,
			}}
		/>,
		{ width: 80, height: 12 },
	);
	const frame = captureCharFrame();
	destroy();
	expect(frame).toContain("/r/.kabane/loop.json: bad");
	expect(frame).not.toContain("saved");
});
