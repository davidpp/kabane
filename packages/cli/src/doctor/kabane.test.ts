import { expect, test } from "bun:test";
import { err } from "@kabane/core";
import { Doctor } from "@kabane/extension";
import { settingsPort } from "../context";
import { builtin } from "./kabane";

test("built-in returned and thrown failures retain distinct handles under kabane", async () => {
	const report = await Doctor.run(
		[
			builtin("settings", async () => err(new Error("settings broke"))),
			builtin("install", async () => {
				throw new Error("install broke");
			}),
		],
		{
			home: "/unused",
			store: "/unused",
			cwd: "/unused",
			actor: "",
			harnessMode: "auto",
			settings: settingsPort("/unused"),
		},
	);
	expect(report.findings).toEqual([
		{
			source: "kabane",
			id: "settings-check-failed",
			severity: "mention",
			summary:
				"Kabane's settings check failed: settings broke. Correct the reported problem and run kabane doctor again.",
		},
		{
			source: "kabane",
			id: "install-check-failed",
			severity: "mention",
			summary:
				"Kabane's install check failed: install broke. Correct the reported problem and run kabane doctor again.",
		},
	]);
});
