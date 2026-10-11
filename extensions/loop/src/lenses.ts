// Verifier lenses: a prompt file each, run as their own session once the plan is done and the gates
// are green. `functional` and `quality` ship with the extension; a repository adds a lens, or
// replaces a shipped one, with `.kabane/loop/lenses/<name>.md`. Which lenses a run has run, and
// how they ended, is read off its claims, so a runner that resumes knows where it was.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, type Result, trySync } from "@cabane/core";
import type { RunStore } from "./store";

export namespace Lenses {
	// `../templates/lenses` from this module: the extension's own directory in the workspace, and
	// `templates/lenses` beside `bin/` in the published package, where the build copies it.
	const SHIPPED_DIR = fileURLToPath(
		new URL("../templates/lenses", import.meta.url),
	);
	const SHIPPED = ["functional", "quality"] as const;

	/** Where a repository keeps its own lenses. */
	export const dir = (projectDir: string): string =>
		join(projectDir, ".kabane", "loop", "lenses");

	/** The lenses a run in `projectDir` can have: the shipped ones, then the repository's own. */
	export const offered = (projectDir: string): string[] => {
		const own = trySync(() => readdirSync(dir(projectDir)));
		const names = (own.ok ? own.value : [])
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.slice(0, -".md".length))
			.sort();
		return [...new Set([...SHIPPED, ...names])];
	};

	/** Lens `name`'s prompt: the repository's own file first, else the shipped one. */
	export const prompt = (projectDir: string, name: string): Result<string> => {
		const own = join(dir(projectDir), `${name}.md`);
		if (existsSync(own)) return trySync(() => readFileSync(own, "utf8"));
		if (!SHIPPED.some((shipped) => shipped === name))
			return err(
				new Error(
					`No lens ${name}: write ${own}, or use ${SHIPPED.join(" or ")}`,
				),
			);
		return trySync(() => readFileSync(join(SHIPPED_DIR, `${name}.md`), "utf8"));
	};

	type Status = {
		/** Lenses with no session yet, or whose last one was interrupted: to be run. */
		pending: string[];
		running: string[];
		done: string[];
		/** Lenses whose last session ended without finishing its review, and why. */
		failed: { name: string; detail: string }[];
	};

	/** Where each of `lenses` stands, from the run's claims: a lens's latest claim decides. */
	export const status = (
		lenses: readonly string[],
		claims: readonly RunStore.Claim[],
	): Status => {
		const status: Status = { pending: [], running: [], done: [], failed: [] };
		for (const name of lenses) {
			const last = claims.findLast((c) => c.lens === name);
			if (!last || last.outcome === "interrupted") status.pending.push(name);
			else if (last.endedAt === undefined) status.running.push(name);
			else if (last.outcome === "done") status.done.push(name);
			else
				status.failed.push({
					name,
					detail: `${last.outcome ?? "ended"}${last.detail ? `: ${last.detail}` : ""}`,
				});
		}
		return status;
	};

	/** Whether every lens has finished its review. */
	export const finished = (s: Status): boolean =>
		s.pending.length === 0 && s.running.length === 0 && s.failed.length === 0;
}
