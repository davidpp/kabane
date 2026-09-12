// Headless test harness: mount a React node into an OpenTUI test renderer and capture frames.
// Delegates to @opentui/react/test-utils testRender, which wraps the mount in React act() so the
// reconciler commits synchronously (a hand-rolled createRoot().render() does not flush in tests).
import {
	createTestRenderer,
	type TestRendererSetup,
} from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { ReactNode } from "react";

export type RenderTestOptions = {
	width?: number;
	height?: number;
};

export type RenderTestResult = TestRendererSetup & {
	destroy: () => void;
};

const defaultSize = { width: 80, height: 24 } as const;

// One renderer pinned alive for the whole test process — the tree-sitter teardown crash fix.
//
// Markdown/code cells (CodeRenderable) lazily create a PROCESS-GLOBAL tree-sitter client (worker
// thread + native FFI). OpenTUI ties that global's lifetime to the renderer population: the LAST
// `CliRenderer.destroy()` (when `rendererTracker.renderers.size` hits 0) *asynchronously* tears the
// global down. Across a suite with many renderTest mounts, the population repeatedly drops to 0
// between files, so the global is destroyed-and-recreated over and over. Under CPU contention (e.g.
// concurrent agents) a highlight still in flight on the old worker touches native memory being freed
// → intermittent whole-suite Bun native crash. Idle-sequential it only logs the benign "TreeSitter
// client destroyed" warning.
//
// Keeping one never-destroyed renderer registered means the population never reaches 0, so the global
// tree-sitter client is created once and lives for the process — no destroy/recreate churn, no race.
// This module is imported only by tui tests (via renderTest), so other packages' runs are unaffected;
// the process exit reaps the pinned renderer. Top-level await ensures it is registered before any
// test's renderTest runs.
const keepAliveRenderer = await createTestRenderer({ width: 1, height: 1 });

export const renderTest = async (
	node: ReactNode,
	options: RenderTestOptions = {},
): Promise<RenderTestResult> => {
	// Reference the pinned renderer so tree-shaking / linters can't drop the keep-alive (it must stay
	// registered in OpenTUI's renderer tracker; see keepAliveRenderer above).
	void keepAliveRenderer;
	// testRender mounts inside React act() (synchronous commit); renderOnce then rasterizes the
	// committed tree into the char buffer so captureCharFrame() reflects it.
	const setup = await testRender(node, {
		width: options.width ?? defaultSize.width,
		height: options.height ?? defaultSize.height,
	});
	await setup.renderOnce();
	return { ...setup, destroy: () => setup.renderer.destroy() };
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// Render frames until one satisfies `predicate`, and hand it back. Every async surface here — a poll,
// a stream, a debounce — lands over several frames, so a bare renderOnce asserts on a stale screen.
// Prefer a structurally unique predicate (a border, a rule) over a substring that also appears
// elsewhere: a loose one matches the frame BEFORE the thing arrives and the keystrokes after it go to
// whichever pane still had focus.
export const pumpUntil = async (
	renderOnce: () => Promise<void>,
	captureCharFrame: () => string,
	predicate: (frame: string) => boolean,
): Promise<string> => {
	let frame = "";
	for (let pass = 0; pass < 100; pass++) {
		await renderOnce();
		frame = captureCharFrame();
		if (predicate(frame)) return frame;
		await sleep(20);
	}
	// Silently returning a stale frame here makes the real failure surface somewhere else entirely,
	// two seconds later — say which wait gave up, and on what.
	throw new Error(`pumpUntil gave up. Last frame:\n${frame}`);
};
