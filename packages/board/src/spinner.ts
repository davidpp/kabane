// Braille spinner frames (opencode's set) — same glyph class as the box-drawing chars already on the
// board, not emoji. The hook stays mounted for stable React hook ordering but only schedules its
// interval while `active` — the leaked-idle-timer gotcha from zact-v2's spinner: a screen full of
// finished rows must not each keep an 80ms timer alive.
import { useEffect, useState } from "react";

export const SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
] as const;
const SPINNER_INTERVAL_MS = 80;

// Static glyph for non-animated loop states (paused/pending/stale) so badge width stays constant.
export const SPINNER_IDLE: string = SPINNER_FRAMES[0];

export const useSpinnerFrame = (active: boolean): string => {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(
			() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
			SPINNER_INTERVAL_MS,
		);
		return () => clearInterval(timer);
	}, [active]);
	return SPINNER_FRAMES[frame] ?? SPINNER_IDLE;
};
