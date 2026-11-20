import type { ActivityStatus } from "@cabane/extension";

type StillStatus = Extract<ActivityStatus, "paused" | "unreported">;

// The in-flight statuses the board draws still, without a spinner: each one's glyph and the word
// after its label.
export const STILL: Readonly<
	Record<StillStatus, { glyph: string; word: string }>
> = {
	paused: { glyph: "⏸", word: "paused" },
	unreported: { glyph: "◌", word: "no status reported" },
};

export const stillMark = (
	status: ActivityStatus,
): (typeof STILL)[StillStatus] | undefined =>
	status === "paused" || status === "unreported" ? STILL[status] : undefined;
