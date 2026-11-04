// The fixer: one session, after the lenses, that takes every open finding under the parent and
// works through them most severe first. It is a claim on the parent, like a lens, on the run's
// implementer. A run has one fixer pass; where it stands is read off the run's claims, so a
// runner that resumes knows whether to start it again.
import type { RunStore } from "./store";

export namespace Fixer {
	export const LANE = "fixer";

	type Status =
		/** No fixer session yet, or its last one was interrupted: to be run when there is work. */
		| { kind: "unstarted" }
		| { kind: "running" }
		/** Its session ended on its own: the pass is over, whatever it left open. */
		| { kind: "ended" }
		/** Its session errored or was cancelled before it could work the findings. */
		| { kind: "failed"; detail: string };

	export const status = (claims: readonly RunStore.Claim[]): Status => {
		const last = claims.findLast((c) => c.fixer === true);
		if (!last || last.outcome === "interrupted") return { kind: "unstarted" };
		if (last.endedAt === undefined) return { kind: "running" };
		if (last.outcome === "done" || last.outcome === "incomplete")
			return { kind: "ended" };
		return {
			kind: "failed",
			detail: `${last.outcome ?? "ended"}${last.detail ? `: ${last.detail}` : ""}`,
		};
	};
}
