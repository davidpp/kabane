// Whether the git checkout this kabane runs from, when it runs from source, sits behind its
// origin/main. Nothing moves a clone's checkout when a pull request merges, so a person can run
// code for hours that the work they marked done has replaced. It reads the refs already on disk
// and never fetches, so doctor stays instant and works offline.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ok, type Result } from "@kabane/core";
import type { Doctor } from "@kabane/extension";

// packages/cli/src/doctor in a checkout; a built binary or an installed package has no
// repository there.
const SOURCE_ROOT = resolve(import.meta.dir, "../../../..");

const git = (dir: string, args: string[]): string | null => {
	const child = Bun.spawnSync(["git", "-C", dir, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	return child.exitCode === 0 ? child.stdout.toString().trim() : null;
};

/**
 * The finding for `root` when it is the top of a git checkout, on main or detached, whose HEAD is
 * behind its origin/main ref.
 */
export const checkoutBehind = (root: string): Doctor.Finding[] => {
	const top = git(root, ["rev-parse", "--show-toplevel"]);
	// A package installed inside some other repository is not a kabane checkout.
	if (top === null || realpathSync(top) !== realpathSync(root)) return [];
	// A feature branch runs its own code on purpose and is behind main by design: only main, or
	// a detached checkout, stands for the kabane a person relies on.
	const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (branch !== null && branch !== "main") return [];
	// No origin/main ref fails the count, which reads as level.
	const behind = Number(
		git(root, ["rev-list", "--count", "HEAD..refs/remotes/origin/main"]),
	);
	if (!(behind > 0)) return [];
	return [
		{
			id: "checkout-behind",
			path: root,
			severity: "suggest",
			summary: `This kabane runs from ${root}, ${behind} commit${behind === 1 ? "" : "s"} behind its origin/main as last fetched. Merge origin/main to bring it forward.`,
		},
	];
};

export const checkout = async (): Promise<Result<Doctor.Finding[]>> =>
	ok(checkoutBehind(SOURCE_ROOT));
