/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test";
import { ManualClock, type TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import { SPINNER_FRAMES, SPINNER_IDLE, useSpinnerFrame } from "./spinner";

test("spinner frames are single-cell braille glyphs so badge width stays constant", () => {
	for (const frame of SPINNER_FRAMES) expect(frame.length).toBe(1);
	expect(SPINNER_IDLE).toBe(SPINNER_FRAMES[0]);
});

const Spinners = ({ active }: { active: readonly boolean[] }): ReactNode => (
	<box style={{ flexDirection: "row" }}>
		{active.map((on, i) => (
			<Spinner key={i} active={on} />
		))}
	</box>
);

const Spinner = ({ active }: { active: boolean }): ReactNode => (
	<text>{useSpinnerFrame(active)}</text>
);

describe("useSpinnerFrame on the shared animation clock", () => {
	let setup: TestRendererSetup | null = null;
	const clock = new ManualClock();

	afterEach(async () => {
		await setup?.dispose();
		setup = null;
	});

	const mount = async (node: ReactNode): Promise<TestRendererSetup> => {
		const mounted = await testRender(node, { width: 10, height: 1, clock });
		setup = mounted;
		await act(() => mounted.renderOnce());
		return mounted;
	};

	const after = async (s: TestRendererSetup, ms: number): Promise<string> => {
		// The tick runs inside the frame the clock's advance asks for, and commits its state there.
		await act(async () => {
			clock.advance(ms);
			await s.renderOnce();
		});
		return s.captureCharFrame().trim();
	};

	test("advances while active, every spinner on the same frame", async () => {
		const s = await mount(<Spinners active={[true, true]} />);
		const seen = new Set<string>();
		for (let i = 0; i < 4; i++) {
			const frame = await after(s, 80);
			const [a, b] = [...frame];
			expect(a).toBe(b);
			seen.add(frame);
		}
		expect(seen.size).toBe(4);
	});

	test("an idle spinner holds still and schedules nothing", async () => {
		const s = await mount(<Spinners active={[false]} />);
		const pending = clock.pendingTimerCount;
		expect(await after(s, 800)).toBe(SPINNER_IDLE);
		expect(clock.pendingTimerCount).toBe(pending);
	});
});
