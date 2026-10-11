/**
 * What `kabane --version` prints. The published bundle prints the release
 * (`kabane update` compares it); a run from a checkout, such as a `bun link`,
 * also names the commit, because package.json only knows the last release.
 */

import { version } from "../package.json";

export type Source = { branch: string; commit: string; dirty: boolean };

// scripts/build.ts defines this as "1" in the published bundle.
const bundled = process.env.KABANE_BUNDLED === "1";

const source = (dir: string): Source | undefined => {
	const status = Bun.spawnSync(
		["git", "status", "--porcelain=v2", "--branch", "--untracked-files=no"],
		{ cwd: dir, stdout: "pipe", stderr: "ignore" },
	);
	if (status.exitCode !== 0) return undefined;
	const lines = status.stdout.toString().split("\n");
	const header = (key: string): string | undefined =>
		lines.find((line) => line.startsWith(`# branch.${key} `))?.split(" ")[2];
	const oid = header("oid");
	if (!oid || oid === "(initial)") return undefined;
	return {
		branch: header("head") ?? "(detached)",
		commit: oid.slice(0, 7),
		dirty: lines.some((line) => line !== "" && !line.startsWith("#")),
	};
};

export const describeVersion = (
	dir: string = import.meta.dir,
): { version: string; source?: Source; text: string } => {
	const from = bundled ? undefined : source(dir);
	if (!from) return { version, text: version };
	const changes = from.dirty ? ", uncommitted changes" : "";
	return {
		version,
		source: from,
		text: `${version} (source: ${from.branch}@${from.commit}${changes})`,
	};
};
