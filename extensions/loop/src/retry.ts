// A gate retry: a subtask its own red gate reopened, claimed again. Sessions are fresh by default;
// this is the one exception (JCAB-48). The retry continues the harness session that wrote the
// work, which already holds the change and needs only the gate's output, not a second cold read
// of the repository. It does so only while that session has room: past half its window, a longer
// conversation costs more in context rot than the re-read it saves, so the retry starts fresh with
// the gate's output in its brief. Whether the harness can resume at all is the harness's to say
// when the session opens (`AcpClient.resumeOrStart`). An interrupted claim is not a gate retry:
// JCAB-40's takeover continues it.
import type { Budget } from "./budget";
import type { RunStore } from "./store";

export namespace Retry {
	/**
	 * The share of its context window a session may have used and still be continued. A guard
	 * against context growth, not a knob: nothing says anyone needs another value.
	 */
	const WINDOW_SHARE = 0.5;

	type Session =
		/** Continue `acpSessionId`, the session of attempt `lane`. */
		| { resume: true; lane: string; acpSessionId: string }
		/** A new session; `why` says what kept attempt `lane`'s session from continuing. */
		| { resume: false; lane: string; why: string };
	export type Resume = Extract<Session, { resume: true }>;

	const percent = (share: number): string => `${Math.round(share * 100)}%`;

	/**
	 * Where the gate retry after attempt `previous` runs, on `harness`, given the run's usage meter;
	 * undefined when `previous` was interrupted, which JCAB-40's takeover continues instead.
	 */
	export const session = (
		previous: RunStore.Claim,
		harness: string,
		meter: Budget.Meter,
	): Session | undefined => {
		if (previous.outcome === "interrupted") return undefined;
		const fresh = (why: string): Session => ({
			resume: false,
			lane: previous.lane,
			why,
		});
		if (previous.outcome !== "done")
			return fresh(`it ended ${previous.outcome ?? "without an outcome"}`);
		if (previous.harness !== harness)
			return fresh(
				`it ran on ${previous.harness} and the run implements with ${harness}`,
			);
		if (previous.acpSessionId === undefined)
			return fresh(`it recorded no ${harness} session`);
		const usage = meter[previous.sessionId];
		if (usage === undefined || usage.size <= 0)
			return fresh("it reported no context window usage");
		const used = usage.used / usage.size;
		if (used >= WINDOW_SHARE)
			return fresh(
				`it had used ${percent(used)} of its context window, at least ${percent(WINDOW_SHARE)}`,
			);
		return {
			resume: true,
			lane: previous.lane,
			acpSessionId: previous.acpSessionId,
		};
	};
}
