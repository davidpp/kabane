import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigLayers } from "../config-layers";
import { settingsPort } from "../context";
import { settings } from "./settings";

test("reports unknown device and other-project namespace keys without changing files", async () => {
	const home = mkdtempSync(join(tmpdir(), "doctor-settings-"));
	try {
		const path = join(home, "config.json");
		const stored = { mystery: true, scopes: { other: { loop: { typo: 1 } } } };
		expect(ConfigLayers.writeJson(path, stored).ok).toBe(true);
		const report = await settings({
			home,
			store: home,
			cwd: home,
			actor: "",
			harnessMode: "auto",
			settings: settingsPort(home),
		});
		if (!report.ok) throw report.error;
		expect(
			report.value.some((finding) =>
				finding.summary.startsWith("mystery in global:"),
			),
		).toBe(true);
		expect(
			report.value.every(
				(finding) => !finding.summary.includes("device.mystery"),
			),
		).toBe(true);
		expect(
			report.value.some((finding) => finding.summary.includes("loop.typo")),
		).toBe(true);
		expect(
			report.value.every(
				(finding) =>
					finding.severity === "mention" && finding.fix === undefined,
			),
		).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(stored);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
