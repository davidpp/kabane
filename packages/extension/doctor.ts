import { err, type Result, tryCatch } from "@cabane/core";
import type { Extension } from "./contract";

export namespace Doctor {
	export type Finding = {
		/** Stable kebab-case identifier, unique within its source. */
		id: string;
		path?: string;
		severity: "auto" | "mention" | "suggest" | "route";
		summary: string;
		fix?: () => Promise<Result<string>>;
		route?: string;
	};

	export type Source = {
		name: string;
		doctor: (ctx: Extension.Ctx) => Promise<Result<Finding[]>>;
	};

	export type Report = {
		findings: (Finding & { source: string })[];
		fixes: { source: string; id: string; result: Result<string> }[];
	};

	const accountForSelectors = (report: Report, selectors: string[]): void => {
		for (const selector of new Set(selectors)) {
			if (report.fixes.some((fix) => `${fix.source}/${fix.id}` === selector))
				continue;
			const finding = report.findings.find(
				(item) => `${item.source}/${item.id}` === selector,
			);
			const slash = selector.indexOf("/");
			report.fixes.push({
				source: finding?.source ?? (slash < 0 ? "" : selector.slice(0, slash)),
				id: finding?.id ?? (slash < 0 ? selector : selector.slice(slash + 1)),
				result: err(
					new Error(
						finding
							? `${selector} has no mechanical fix.${finding.route ? ` Its route: ${finding.route}` : ""}`
							: `No finding matches ${selector}. Run kabane doctor to see current source/id handles.`,
					),
				),
			});
		}
	};

	const append = (report: Report, source: string, finding: Finding): void => {
		const previous = report.findings.findIndex(
			(item) => item.source === source && item.id === finding.id,
		);
		if (previous < 0) {
			report.findings.push({ ...finding, source });
			return;
		}
		const original = report.findings[previous];
		report.findings[previous] = {
			source,
			id: finding.id,
			severity: "mention",
			summary: `Duplicate finding id ${source}/${finding.id}; no repair can be selected safely. ${original?.summary}; ${finding.summary}`,
		};
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
			const found = checked.ok ? checked.value : checked;
			if (found.ok)
				for (const finding of found.value) append(report, source.name, finding);
			else
				append(report, source.name, {
					id: "check-failed",
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
		if (Array.isArray(options.fix)) accountForSelectors(report, options.fix);

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
