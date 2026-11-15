import { ok } from "@cabane/core";
import { type Doctor, type Extension } from "@cabane/extension";
import { settings } from "./settings";

const checks: { id: string; run: Doctor.Source["doctor"] }[] = [
	{ id: "settings", run: settings },
];

export const kabane = {
	name: "kabane",
	doctor: async (ctx: Extension.Ctx) => {
		const findings: Doctor.Finding[] = [];
		for (const check of checks) {
			const found = await check.run(ctx);
			if (Array.isArray(found)) findings.push(...found);
			else if (found.ok) findings.push(...found.value);
			else
				findings.push({
					id: `${check.id}-check-failed`,
					source: "kabane",
					severity: "mention",
					summary: found.error.message,
				});
		}
		return ok(findings);
	},
} satisfies Extension;
