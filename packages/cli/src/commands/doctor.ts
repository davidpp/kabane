import { existsSync } from "node:fs";
import { Planner } from "@cabane/core";
import { Doctor, failure, flagList, success, usage } from "@cabane/extension";
import { configPath, loadConfig } from "../config";
import {
	activateContextRecord,
	type Command,
	configureRuntime,
} from "../context";
import { kabane } from "../doctor/kabane";
import { Extensions } from "../extensions";
import { activateHostRecord, hostHarnessMode } from "../host";

const USAGE = "kabane doctor [--fix [<source/id>...]] [--json]";

const text = (report: Doctor.Report): string => {
	if (report.findings.length === 0) return "No findings.";
	const lines: string[] = [];
	for (const severity of ["auto", "mention", "suggest", "route"] as const) {
		const findings = report.findings.filter(
			(finding) => finding.severity === severity,
		);
		if (findings.length === 0) continue;
		lines.push(`${severity}:`);
		for (const finding of findings)
			lines.push(
				`  ${finding.source}/${finding.id}: ${finding.summary}${finding.route ? ` → ${finding.route}` : ""}`,
			);
	}
	for (const fix of report.fixes)
		lines.push(
			`${fix.source}/${fix.id}: ${fix.result.ok ? fix.result.value : fix.result.error.message}`,
		);
	return lines.join("\n");
};

export const doctor: Command = {
	name: "doctor",
	summary: "Report configuration drift and repair automatic findings",
	usage: USAGE,
	standalone: true,
	run: async (args, ctx) => {
		if (
			Object.keys(args.flags).some((key) => key !== "fix") ||
			(!("fix" in args.flags) && args.positionals.length > 0)
		)
			return usage("Unexpected doctor arguments", USAGE);
		activateHostRecord(ctx.home);
		if (existsSync(configPath(ctx.home))) {
			const config = loadConfig(ctx.home);
			// Settings diagnostics report invalid config; it must not prevent the other checks.
			if (config.ok) {
				const configured = configureRuntime(config.value, config.value.actor);
				if (!configured.ok) return failure(configured.error);
				const initialized = await Planner.init(ctx.home);
				if (!initialized.ok) return failure(initialized.error);
				ctx = {
					...ctx,
					config: config.value,
					actor: config.value.actor,
					harnessMode: hostHarnessMode(ctx.home, config.value),
				};
				activateContextRecord(ctx, args);
			}
		}
		const selected = [...flagList(args, "fix"), ...args.positionals];
		const sources: Doctor.Source[] = [kabane];
		const enabled = Extensions.enabled(ctx.home);
		// A refused extension is that extension's finding; the rest still run their checks.
		const { loaded, refused } = enabled.ok
			? await Extensions.loadAll(enabled.value, ctx.home)
			: { loaded: [], refused: [] };
		sources.push(...Extensions.doctors(loaded));
		const report = await Doctor.run(
			sources,
			ctx,
			"fix" in args.flags ? { fix: selected.length > 0 ? selected : true } : {},
		);
		for (const refusal of refused)
			report.findings.push({
				id: "extension-refused",
				source: refusal.name,
				severity: "mention",
				summary: Extensions.line(refusal),
			});
		if (!enabled.ok)
			report.findings.push({
				id: "extensions-unavailable",
				source: "kabane",
				severity: "mention",
				summary: enabled.error.message,
			});
		return success(Doctor.toJson(report), text(report));
	},
};
