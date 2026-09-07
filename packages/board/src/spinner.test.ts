import { expect, test } from "bun:test";
import { SPINNER_FRAMES, SPINNER_IDLE } from "./spinner";

test("spinner frames are single-cell braille glyphs so badge width stays constant", () => {
	for (const frame of SPINNER_FRAMES) expect(frame.length).toBe(1);
	expect(SPINNER_IDLE).toBe(SPINNER_FRAMES[0]);
});
