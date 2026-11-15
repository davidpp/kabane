import { type Result, tryCatch } from "@cabane/core";
import type { Extension } from "./contract";

export namespace Doctor {
	export type Finding = {
		/** Stable kebab-case identifier, unique within its source. */
		id: string;
		source: string;
		path?: string;
		severity: "auto" | "mention" | "suggest" | "route";
		summary: string;
		fix?: () => Promise<Result<string>>;
		route?: string;
	};

	export type Source = {
		name: string;
		doctor: (ctx: Extension.Ctx) => Promise<Finding[] | Result<Finding[]>>;
	};

	export type Report = {
		findings: Finding[];
		fixes: { source: string; id: string; result: Result<string> }[];
	};

	/** Checks finish before repairs start; a failed check or repair does not stop the others. */
	export const run = async (
		sources: readonly Source[],
		ctx: Extension.Ctx,
		options: { fix?: true | string[] } = {},
	): Promise<Report> => {
		const report: Report = { findings: [], fixes: [] };
		for (const source of sources) {
			const checked = await tryCatch(() => source.doctor(ctx));
			const found = checked.ok
				? Array.isArray(checked.value)
					? { ok: true as const, value: checked.value }
					: checked.value
				: checked;
			if (found.ok) report.findings.push(...found.value);
			else
				report.findings.push({
					id: "check-failed",
					source: source.name,
					severity: "mention",
					summary: `${source.name} check failed: ${found.error.message}`,
				});
		}
		for (const finding of report.findings) {
			const selected =
				options.fix === true
					? finding.severity === "auto"
					: options.fix?.includes(`${finding.source}/${finding.id}`);
			if (!selected || !finding.fix) continue;
			const fixed = await tryCatch(finding.fix);
			report.fixes.push({
				source: finding.source,
				id: finding.id,
				result: fixed.ok ? fixed.value : fixed,
			});
		}
		return report;
	};

	/** Keep error messages as well as successful repair summaries in machine output. */
	export const toJson = (report: Report) => ({
		findings: report.findings.map(
			({ id, source, path, severity, summary, fix, route }) => ({
				id,
				source,
				...(path === undefined ? {} : { path }),
				severity,
				summary,
				fixable: fix !== undefined,
				...(route === undefined ? {} : { route }),
			}),
		),
		fixes: report.fixes.map(({ source, id, result }) => ({
			source,
			id,
			result: result.ok ? result : { ok: false, error: result.error.message },
		})),
	});
}
