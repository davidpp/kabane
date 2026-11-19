/** @jsxImportSource @opentui/react */
// useOwnNotice takes back only the notice it raised (JCAB-519): a good reload clears its own load
// error, never an act's error that replaced it, though both carry tone "error".
import { afterEach, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import type { BoardNav } from "./nav";
import { type SetNotice, useNotice, useOwnNotice } from "./notice";

type Handles = {
	setNotice: SetNotice;
	own: ReturnType<typeof useOwnNotice>;
};

const Footer = ({
	onMount,
}: {
	onMount: (handles: Handles) => void;
}): ReactNode => {
	const [notice, setNotice] = useNotice();
	const own = useOwnNotice(setNotice);
	onMount({ setNotice, own });
	return <text>{notice ? `${notice.tone}: ${notice.text}` : "none"}</text>;
};

let setup: TestRendererSetup | null = null;

afterEach(() => {
	setup?.renderer.destroy();
	setup = null;
});

const mount = async () => {
	let handles: Handles | undefined;
	const mounted = await testRender(<Footer onMount={(h) => (handles = h)} />, {
		width: 40,
		height: 1,
	});
	setup = mounted;
	const frame = async (change: (h: Handles) => void): Promise<string> => {
		// The change commits when act returns; the frame after it shows the result.
		act(() => {
			if (handles) change(handles);
		});
		await mounted.renderOnce();
		return mounted.captureCharFrame().trim();
	};
	return frame;
};

const loadFailed: BoardNav.Notice = { text: "db locked", tone: "error" };

test("clear takes back its own raised notice", async () => {
	const frame = await mount();
	expect(await frame((h) => h.own.raise(loadFailed))).toBe("error: db locked");
	expect(await frame((h) => h.own.clear())).toBe("none");
});

test("clear leaves an act's error that replaced its own notice", async () => {
	const frame = await mount();
	await frame((h) => h.own.raise(loadFailed));
	expect(
		await frame((h) => h.setNotice({ text: "cancel failed", tone: "error" })),
	).toBe("error: cancel failed");
	expect(await frame((h) => h.own.clear())).toBe("error: cancel failed");
});

test("clear with nothing raised leaves an act's error", async () => {
	const frame = await mount();
	await frame((h) => h.setNotice({ text: "cancel failed", tone: "error" }));
	expect(await frame((h) => h.own.clear())).toBe("error: cancel failed");
});
