// The host's announcement (Announcer), asked for once the first frame is on screen so a slow answer
// never holds the board up, and put in the reducer's state, where `esc` dismisses it.
import { useEffect } from "react";
import type { BoardStore } from "./board-store";
import type { Announcer } from "./ports";

export const useAnnouncement = (
	announcer: Announcer,
	{ state, update }: BoardStore,
): void => {
	const loaded = state !== null;
	useEffect(() => {
		if (!loaded) return;
		let mounted = true;
		void announcer.announce().then((said) => {
			if (!mounted || !said.ok || !said.value) return;
			const announcement = said.value;
			update((prev) => ({ ...prev, announcement }));
		});
		return () => {
			mounted = false;
		};
	}, [loaded, announcer, update]);
};
