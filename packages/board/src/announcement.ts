// The host's announcement (Announcer), put in the reducer's state, where `esc` dismisses it. Asked
// for only once the loaded board has been presented, so whatever the host does before its first
// await never holds that frame up. A React effect follows the commit, not the terminal, so it waits
// for the renderer's `frame` event, which OpenTUI emits after a frame is written out, and requests
// one so the wait never depends on something else changing on screen.
import { useRenderer } from "@opentui/react";
import { useEffect } from "react";
import type { BoardStore } from "./board-store";
import type { Announcer } from "./ports";

export const useAnnouncement = (
	announcer: Announcer,
	{ state, update }: BoardStore,
): void => {
	const renderer = useRenderer();
	const loaded = state !== null;
	useEffect(() => {
		if (!loaded) return;
		let mounted = true;
		const ask = (): void => {
			void announcer.announce().then((said) => {
				if (!mounted || !said.ok || !said.value) return;
				const announcement = said.value;
				update((prev) => ({ ...prev, announcement }));
			});
		};
		renderer.once("frame", ask);
		renderer.requestRender();
		return () => {
			mounted = false;
			renderer.off("frame", ask);
		};
	}, [loaded, renderer, announcer, update]);
};
