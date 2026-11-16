import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok, Planner } from "@cabane/core";
import { Doctor, flagList, success, usage } from "@cabane/extension";
import { configPath, DB_NAME, loadConfig } from "../config";
import {
	activateContextRecord,
	type Command,
	registerModules,
} from "../context";
import { copilotFiles } from "../doctor/copilot-files";
import { kabane } from "../doctor/kabane";
import { Extensions } from "../extensions";
import { activateHostRecord, hostHarnessMode } from "../host";

const USAGE = "kabane doctor [--fix [<source/id>...]] [--json]";

const text = (report: Doctor.Report): string => {
	if (report.findings.length === 0 && report.fixes.length === 0)
		return "No findings.";
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
			`${fix.source ? `${fix.source}/` : ""}${fix.id}: ${fix.result.ok ? fix.result.value : fix.result.error.message}`,
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
		const unavailable: Doctor.Finding[] = [];
		if (existsSync(configPath(ctx.home))) {
			const config = loadConfig(ctx.home);
			// Settings diagnostics report invalid config; it must not prevent the other checks.
			if (config.ok) {
				// The same stages as every process that opens the database. A stop is its own
				// finding, and the checks that need no store still run.
				const registered = await registerModules(
					ctx.home,
					config.value,
					config.value.actor,
				);
				if (!registered.ok)
					unavailable.push({
						id: "extension-modules",
						severity: "mention",
						summary: registered.error.message,
					});
				const initialized = registered.ok
					? await Planner.init(ctx.home)
					: undefined;
				if (initialized?.ok) {
					ctx = {
						...ctx,
						config: config.value,
						actor: config.value.actor,
						harnessMode: hostHarnessMode(ctx.home, config.value),
					};
					activateContextRecord(ctx, args);
				} else if (initialized)
					unavailable.push({
						id: "store-unavailable",
						severity: "mention",
						path: join(ctx.store, DB_NAME),
						summary: `Cannot open the store: ${initialized.error.message}. Restore a readable database before running checks that query issues.`,
					});
			}
		}
		const selected = [...flagList(args, "fix"), ...args.positionals];
		const sources: Doctor.Source[] = [...kabane];
		const enabled = Extensions.enabled(ctx.home);
		// A refused extension is that extension's finding; the rest still run their checks.
		const { loaded, refused, directories } = enabled.ok
			? await Extensions.loadAll(enabled.value, ctx.home)
			: { loaded: [], refused: [], directories: [] };
		sources.push(
			...Extensions.doctors(loaded),
			...copilotFiles(directories, ctx.home),
		);
		// The modules stop is already that extension's finding (`kabane/extension-modules`).
		for (const refusal of refused.filter(
			({ name }) => name !== Extensions.stopped(),
		))
			sources.push({
				name: refusal.name,
				doctor: async () =>
					ok([
						{
							id: "extension-refused",
							severity: "mention",
							summary: Extensions.line(refusal),
						},
					]),
			});
		if (!enabled.ok)
			unavailable.push({
				id: "extensions-unavailable",
				severity: "mention",
				summary: enabled.error.message,
			});
		sources.push({ name: "kabane", doctor: async () => ok(unavailable) });
		const report = await Doctor.run(
			sources,
			ctx,
			"fix" in args.flags ? { fix: selected.length > 0 ? selected : true } : {},
		);
		return success(Doctor.toJson(report), text(report));
	},
};
