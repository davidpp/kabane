import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigLayers } from "../config-layers";
import { settingsPort } from "../context";
import { settings } from "./settings";

test("reports unknown device and other-project namespace keys without changing files", async () => {
	const home = mkdtempSync(join(tmpdir(), "doctor-settings-"));
	try {
		mkdirSync(join(home, "extensions"));
		symlinkSync(
			join(import.meta.dir, "../../../../extensions/loop"),
			join(home, "extensions/loop"),
		);
		const path = join(home, "config.json");
		const stored = {
			actor: "test",
			deviceId: "test",
			extensions: ["loop"],
			mystery: true,
			scopes: { other: { loop: { typo: 1 }, unknownNamespace: {} } },
		};
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
		expect(
			report.value.find(({ summary }) =>
				summary.startsWith("mystery in global:"),
			)?.summary,
		).toBe(
			`mystery in global: unknown device setting; kabane ignores this key. Edit ${path} to remove or correct this key.`,
		);
		expect(
			report.value.find(({ summary }) => summary.startsWith("loop.typo"))
				?.summary,
		).toContain("a strict extension schema rejects this layer");
		expect(
			report.value.find(({ summary }) =>
				summary.startsWith("Legacy scopes.other.loop"),
			)?.summary,
		).toBe(
			`Legacy scopes.other.loop in ${path}. Run kabane doctor in that project to migrate it.`,
		);
		expect(
			report.value.find(({ summary }) =>
				summary.startsWith("Legacy scopes.other.unknownNamespace"),
			)?.summary,
		).toContain("with a version that ships this namespace");

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(stored);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
