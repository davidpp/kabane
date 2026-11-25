// An enabled extension linked into another kabane release's copy loads, so it is no refusal: this
// kabane just runs that release's code, its migrations included. JCAB-669: a 2.0 binary ran the
// extensions of a Homebrew 1.2.0 left beside it, whose migrations stopped short of 2.0's.
import { join } from "node:path";
import { ok } from "@kabane/core";
import type { Doctor } from "@kabane/extension";
import { Extensions } from "../extensions";

/** One `<name>/extension-elsewhere` finding per enabled extension `Extensions.elsewhere` finds. */
export const linkedElsewhere = (
	home: string,
	enabled: readonly string[],
	root = Extensions.shippedRoot(),
): Doctor.Source[] =>
	enabled.flatMap((name) => {
		const there = Extensions.elsewhere(home, name, root);
		if (there === undefined || root === undefined) return [];
		const path = Extensions.directory(home, name);
		return [
			{
				name,
				doctor: async () =>
					ok([
						{
							id: "extension-elsewhere",
							// Safe and mechanical, as re-pointing a link to nothing is.
							severity: "auto",
							path,
							summary: `${path} links to ${there}, another kabane install's copy, so this kabane runs that release's ${name}, its migrations included`,
							fix: async () => {
								const linked = Extensions.link(home, [name], root);
								return linked.ok
									? ok(`linked ${name} to ${join(root, name)}`)
									: linked;
							},
						},
					]),
			},
		];
	});
