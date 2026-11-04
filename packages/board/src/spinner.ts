// Braille spinner frames (opencode's set) — same glyph class as the box-drawing chars already on the
// board, not emoji. Every spinner ticks on the renderer's one animation clock and reads its frame
// from the clock's time, so two spinners on screen turn together and in step. The hook stays mounted
// for stable React hook ordering but subscribes only while `active`: a board with nothing running
// schedules no tick at all.
import { useAnimationTick } from "@opentui/react";
import { useState } from "react";

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
const SPINNER_FPS = 1000 / SPINNER_INTERVAL_MS;

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
	// A tick may run up to half an interval early to share a frame, so the slot is the nearest one.
	useAnimationTick(active ? SPINNER_FPS : undefined, (_delta, _ticks, time) =>
		setFrame(Math.round(time / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length),
	);
	return SPINNER_FRAMES[frame] ?? SPINNER_IDLE;
};
