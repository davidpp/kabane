/**
 * Planner Storage — Durable Activity Selector + Session Card (S5)
 *
 * The shared read fold. From a session's activity trail, `selectDurableActivities`
 * keeps only the durable signal (response|finding|verification|decision|handoff)
 * and drops progress/action/question/error plus all-but-latest ephemeral. S3's
 * Discussion, the folded timeline, and the digest all consume it, so "what
 * matters" is defined in exactly one place.
 *
 * Pure — no DB. Callers pass activities from `getActivities` (the S4a shared
 * read: durable + latest-ephemeral, chronological), so a stable pass preserves
 * that canonical order (created_at, then rowid).
 */

import type { AgentActivity, AgentSession, SessionCard } from "../schemas";

/** Activity types that carry durable signal; everything else is noise/transient. */
const DURABLE_ACTIVITY_TYPES = new Set<string>([
	"response",
	"finding",
	"verification",
	"decision",
	"handoff",
]);

/** Excerpt length (chars) for a session card's finalResponse. */
const EXCERPT_CHARS = 200;

/** Trim + cap a body to an excerpt, appending an ellipsis when truncated. */
const excerpt = (body: string, max = EXCERPT_CHARS): string => {
	const trimmed = body.trim();
	return trimmed.length <= max
		? trimmed
		: `${trimmed.slice(0, max).trimEnd()}…`;
};

export namespace Planner {
	/**
	 * Keep only durable activities. Drops progress/action/question/error and
	 * every ephemeral row except the latest (mirrors the getActivities fold:
	 * created_at then insertion order — the input is expected chronological, so
	 * the last ephemeral encountered is the latest).
	 */
	export const selectDurableActivities = (
		activities: AgentActivity[],
	): AgentActivity[] => {
		// Latest ephemeral wins (input is chronological → last one seen).
		let latestEphemeralId: string | undefined;
		for (const a of activities) {
			if (a.ephemeral) latestEphemeralId = a.id;
		}
		return activities.filter((a) => {
			if (!DURABLE_ACTIVITY_TYPES.has(a.type)) return false;
			if (a.ephemeral && a.id !== latestEphemeralId) return false;
			return true;
		});
	};

	/**
	 * Build a folded card for a session from its activity trail (getActivities
	 * output).
	 *
	 * - activityCount: the DURABLE activities only (the meaningful ones the card
	 *   summarizes), not the raw noise.
	 * - findingCounts: durable severity-carrying activities bucketed by P1/P2/P3.
	 *   Counts BOTH `finding` and `verification` types (S4b's VerificationParser
	 *   emits `verification` activities with severity) — anything durable with a
	 *   P1/P2/P3 severity, so the card's P1 pill/footer never undercounts.
	 * - hasQuestion: state-based — true iff the session is currently
	 *   `awaiting_input` (an unanswered question). NOT "ever asked a question": a
	 *   session that asked and was answered is back to active/complete and is not
	 *   awaiting input, so its card must not imply action is needed.
	 * - finalResponse: latest non-blank `response` excerpt, else latest non-blank
	 *   durable excerpt — NEVER a blank string; undefined only when no durable
	 *   activity carries a non-blank body.
	 */
	export const toSessionCard = (
		session: AgentSession,
		activities: AgentActivity[],
	): SessionCard => {
		const durable = selectDurableActivities(activities);

		const findingCounts = { P1: 0, P2: 0, P3: 0 };
		for (const a of durable) {
			if (a.severity === "P1") findingCounts.P1 += 1;
			else if (a.severity === "P2") findingCounts.P2 += 1;
			else if (a.severity === "P3") findingCounts.P3 += 1;
		}

		// Latest first: prefer the last non-blank response, else the last
		// non-blank durable of any type.
		const reversed = [...durable].reverse();
		const chosen =
			reversed.find((a) => a.type === "response" && a.body.trim().length > 0) ??
			reversed.find((a) => a.body.trim().length > 0);

		return {
			id: session.id,
			agent: session.agent,
			state: session.state,
			finalResponse: chosen ? excerpt(chosen.body) : undefined,
			activityCount: durable.length,
			findingCounts,
			hasQuestion: session.state === "awaiting_input",
			startedAt: session.startedAt,
			lastActivityAt: session.lastActivityAt,
			endedAt: session.endedAt,
		};
	};
}
