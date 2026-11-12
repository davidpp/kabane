// How a scrolling view moves under the keys, the same on every one: the detail, the transcript, a
// card's tab and the `?` sheet. `j/k` (or the arrows) a couple of rows, `ctrl+d`/`ctrl+u` half the
// viewport, `g`/`G` the top and the end. `space` is no page key here: on the detail it ticks the
// checklist item under the cursor.
//
// The reducers name a motion (`motion`) and the screen applies it to the scrollbox it holds
// (`apply`): only the scrollbox knows how tall its viewport is.
import type { ScrollBoxRenderable } from "@opentui/core";
import type { BoardNav } from "./nav";

export namespace Paging {
	/** Rows `j/k` move. */
	const LINE_ROWS = 2;

	/** A move by rows, by a share of the viewport, or to either end. */
	export type Motion =
		| { delta: number }
		| { page: number }
		| { to: "top" | "end" };

	// A letter by what it types: `G` arrives as `g` with shift on some terminals, `G` on others, and
	// without the raw sequence a shifted letter is its uppercase.
	const typed = (key: BoardNav.KeyInput): string => {
		if (key.name.length !== 1) return key.name;
		if (key.sequence !== undefined) return key.sequence;
		return key.shift ? key.name.toUpperCase() : key.name;
	};

	/** The motion a key asks of a scrolling view; null for any other key. */
	export const motion = (key: BoardNav.KeyInput): Motion | null => {
		if (key.meta) return null;
		if (key.ctrl) {
			if (key.name === "d") return { page: 0.5 };
			if (key.name === "u") return { page: -0.5 };
			return null;
		}
		switch (typed(key)) {
			case "j":
			case "down":
				return { delta: LINE_ROWS };
			case "k":
			case "up":
				return { delta: -LINE_ROWS };
			case "g":
				return { to: "top" };
			case "G":
				return { to: "end" };
			default:
				return null;
		}
	};

	/** Moves `box` as `motion` says. */
	export const apply = (
		box: ScrollBoxRenderable | null,
		motion: Motion,
	): void => {
		if (!box) return;
		if ("delta" in motion) box.scrollBy(motion.delta);
		else if ("page" in motion) box.scrollBy(motion.page, "viewport");
		else box.scrollTo(motion.to === "top" ? 0 : box.scrollHeight);
	};
}
