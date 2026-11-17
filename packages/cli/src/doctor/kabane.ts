import { ok, tryCatch } from "@cabane/core";
import type { Doctor } from "@cabane/extension";
import { checkout } from "./checkout";
import { install } from "./install";
import { project } from "./project";
import { settings } from "./settings";

// Built-in checks share an owner, but their failures need distinct handles.
export const builtin = (
	name: string,
	check: Doctor.Source["doctor"],
): Doctor.Source => ({
	name: "kabane",
	doctor: async (ctx) => {
		const checked = await tryCatch(() => check(ctx));
		const found = checked.ok ? checked.value : checked;
		return found.ok
			? found
			: ok([
					{
						id: `${name}-check-failed`,
						severity: "mention",
						summary: `Kabane's ${name} check failed: ${found.error.message}. Correct the reported problem and run kabane doctor again.`,
					},
				]);
	},
});

export const kabane: Doctor.Source[] = [
	builtin("settings", settings),
	{ name: "project", doctor: project },
	builtin("install", install),
	builtin("checkout", checkout),
];
