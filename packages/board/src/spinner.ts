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

// A frozen spinner frame, for a running card whose host stopped updating it. Reading as a stuck
// spinner is the point there: the thing really has stopped moving.
export const SPINNER_IDLE: string = SPINNER_FRAMES[0];

// Running, shown somewhere that is NOT the surface owning this fact. Motion is a claim that a thing
// is alive, and one thing on four surfaces does not need claiming four times — exactly one animates,
// the one that owns the detail, and every echo renders this. Deliberately not a spinner frame: a
// frozen `⠋` beside a turning one reads as broken rather than as deliberate.
export const RUNNING_ECHO = "●";

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
