/** @jsxImportSource @opentui/react */
import { describe, expect, test } from "bun:test";
import {
	act,
	createRef,
	type ReactNode,
	useImperativeHandle,
	useState,
} from "react";
import { DetailModel } from "./detail-model";
import { LiftedReader, LiftedReaderSheet } from "./lifted-reader";
import { Fixtures } from "./stories/fixtures";
import { pumpUntil, renderTest } from "./testing";

const ISSUE = Fixtures.task({ id: "w1", shortId: "JREP-1" });
const CLAUDE = "cabane://actor/agent/claude";

// The issue's lifted entries with `bodies` as its handoffs, the last one the newest.
const lifted = (...bodies: string[]): DetailModel.LiftedEntry[] =>
	DetailModel.lifted(
		Fixtures.records(ISSUE, {
			kinds: [...Fixtures.KINDS],
			entries: bodies.map((body, n) =>
				Fixtures.entry(ISSUE, n + 1, "handoff", CLAUDE, body),
			),
		}),
	);

// The reader over `entries`, and a way to hand it newer ones as the poll would.
const mount = async (entries: DetailModel.LiftedEntry[]) => {
	const handle = createRef<LiftedReader.Handle>();
	const replace = createRef<(next: DetailModel.LiftedEntry[]) => void>();
	const Host = (): ReactNode => {
		const [shown, setShown] = useState(entries);
		useImperativeHandle(replace, () => setShown);
		return <LiftedReaderSheet entries={shown} handleRef={handle} />;
	};
	const setup = await renderTest(<Host />, { width: 40, height: 30 });
	const frame = (): Promise<string> =>
		pumpUntil(setup.renderOnce, setup.captureCharFrame, (f) =>
			f.includes("Summary"),
		);
	await frame();
	// Each move is drawn before the next is read, as keys land frames apart.
	const press = async (move: () => void): Promise<string> => {
		move();
		await setup.renderOnce();
		await setup.renderOnce();
		return setup.captureCharFrame();
	};
	return {
		...setup,
		handle,
		frame,
		press,
		// The newer entries, once their markdown has laid out: `shows` is text only they draw.
		newer: async (
			next: DetailModel.LiftedEntry[],
			shows: (frame: string) => boolean,
		): Promise<string> => {
			act(() => replace.current?.(next));
			await pumpUntil(setup.renderOnce, setup.captureCharFrame, shows);
			return press(() => {});
		},
	};
};

// The text of a row of the pane, without the scrollbar.
const row = (frame: string, n: number): string =>
	(frame.split("\n")[n] ?? "").replace(/[█▀▄]\s*$/, "").trim();
// The reader's pinned row (the pane's second, under the tab bar), and the top of its scroll under it.
const pinRow = (frame: string): string => row(frame, 1);
const topRow = (frame: string): string => row(frame, 2);

describe("LiftedReader.parts", () => {
	test("ids a repeated heading by which one it is, and leaves the opening unheaded", () => {
		const [entry] = lifted("Before.\n\n## A\none\n## B\ntwo\n## A\nthree");
		expect(
			LiftedReader.parts(entry as DetailModel.LiftedEntry).map((p) => p.id),
		).toEqual([
			undefined,
			"reader:handoff:A#0",
			"reader:handoff:B#0",
			"reader:handoff:A#1",
		]);
	});
});

describe("LiftedReaderSheet", () => {
	test("draws the whole handoff at forty columns, every heading in it, within the pane", async () => {
		const r = await mount(lifted(Fixtures.REAL_HANDOFF));
		const frame = r.captureCharFrame();
		expect(frame).toContain("handoff · claude");
		expect(frame).toContain("The author's own account of its work");
		expect(frame).toContain("[ ] headings · esc close");
		for (const line of frame.split("\n"))
			expect(line.length).toBeLessThanOrEqual(40);
		r.destroy();
	});

	test("`]` and `[` move the view from heading to heading, and back to the top", async () => {
		const r = await mount(lifted(Fixtures.REAL_HANDOFF));
		const h = (): LiftedReader.Handle =>
			r.handle.current as LiftedReader.Handle;
		expect(topRow(await r.press(() => h().jump(1)))).toBe("Summary");
		expect(topRow(await r.press(() => h().jump(1)))).toBe("Evidence");
		expect(topRow(await r.press(() => h().jump(1)))).toBe("Not verified");
		expect(topRow(await r.press(() => h().jump(-1)))).toBe("Evidence");
		await r.press(() => h().jump(-1));
		const top = await r.press(() => h().jump(-1));
		expect(topRow(top)).toStartWith("handoff · claude · ");
		expect(pinRow(top)).toBe("");
		r.destroy();
	});

	test("headings too near the end to reach the top are still each a step of `]` and `[`", async () => {
		// A long first section, then three one-line ones that all sit inside the last screen.
		const long = Array.from({ length: 40 }, (_, n) => `Line ${String(n)}.`);
		const body = `## Summary\n\n${long.join("\n\n")}\n\n## Beta\n\nb\n\n## Gamma\n\nc\n\n## Delta\n\nd`;
		const r = await mount(lifted(body));
		const h = (): LiftedReader.Handle =>
			r.handle.current as LiftedReader.Handle;
		expect(topRow(await r.press(() => h().jump(1)))).toBe("Summary");
		// The scroll stops at its end: the view holds still, and the pinned row names each step.
		const bodyOf = (frame: string): string =>
			frame.split("\n").slice(2).join("\n");
		const end = await r.press(() => h().jump(1));
		expect(end).toContain("Delta");
		expect(pinRow(end)).toBe("handoff · claude · Beta");
		await r.press(() => h().jump(1));
		expect(pinRow(await r.press(() => h().jump(1)))).toBe(
			"handoff · claude · Delta",
		);
		// From Delta, `[` steps back through Gamma and Beta, which the end of the scroll holds in
		// view, before it reaches Summary: the jumps went through every heading, not round Beta.
		const gamma = await r.press(() => h().jump(-1));
		expect(bodyOf(gamma)).toBe(bodyOf(end));
		expect(pinRow(gamma)).toBe("handoff · claude · Gamma");
		expect(await r.press(() => h().jump(-1))).toBe(end);
		expect(topRow(await r.press(() => h().jump(-1)))).toBe("Summary");
		r.destroy();
	});

	test("a scroll between jumps makes the next one step from the view, not the heading picked", async () => {
		const r = await mount(lifted(Fixtures.REAL_HANDOFF));
		const h = (): LiftedReader.Handle =>
			r.handle.current as LiftedReader.Handle;
		await r.press(() => h().jump(1));
		await r.press(() => h().scroll({ to: "top" }));
		expect(topRow(await r.press(() => h().jump(1)))).toBe("Summary");
		r.destroy();
	});

	test("a newer entry keeps the heading under the cursor where it was", async () => {
		const r = await mount(lifted(Fixtures.REAL_HANDOFF));
		const h = (): LiftedReader.Handle =>
			r.handle.current as LiftedReader.Handle;
		await r.press(() => h().jump(1));
		await r.press(() => h().jump(1));
		// The newer one's summary is longer, which moves Evidence down the content, and its evidence
		// opens on a line the frame can wait for.
		const longer = Fixtures.REAL_HANDOFF.replace(
			"### Evidence\n\n",
			"One more paragraph.\n\nAnd another.\n\n### Evidence\n\n- Rerun on the tip.\n",
		);
		const frame = await r.newer(lifted(Fixtures.REAL_HANDOFF, longer), (f) =>
			f.includes("Rerun on the tip."),
		);
		expect(topRow(frame)).toBe("Evidence");
		r.destroy();
	});

	test("pins whose entry and which heading the view is in while the body scrolls under it", async () => {
		const r = await mount(lifted(Fixtures.REAL_HANDOFF));
		const h = (): LiftedReader.Handle =>
			r.handle.current as LiftedReader.Handle;
		// At the top the entry's own first line is in sight, so the pinned row is padding.
		expect(pinRow(r.captureCharFrame())).toBe("");
		// A line down, that first line has gone: the row names the entry before any heading.
		expect(pinRow(await r.press(() => h().scroll({ delta: 1 })))).toBe(
			"handoff · claude",
		);
		await r.press(() => h().scroll({ to: "top" }));
		await r.press(() => h().jump(1));
		const evidence = await r.press(() => h().jump(1));
		expect(pinRow(evidence)).toBe("handoff · claude · Evidence");
		// Scrolled on into the section, the row still says where the view is.
		const inside = await r.press(() => h().scroll({ delta: 6 }));
		expect(topRow(inside)).not.toBe("Evidence");
		expect(pinRow(inside)).toBe("handoff · claude · Evidence");
		for (const line of inside.split("\n"))
			expect(line.length).toBeLessThanOrEqual(40);
		r.destroy();
	});

	test("pins the entry the view's top is in, and nothing while a later entry's first line is the top row", async () => {
		const finding = {
			name: "finding",
			title: "Finding",
			template: "## Gap",
			projection: {
				latest: {
					after: "description" as const,
					framing: "What a reviewer found.",
				},
			},
		};
		const entries = DetailModel.lifted(
			Fixtures.records(ISSUE, {
				kinds: [...Fixtures.KINDS, finding],
				entries: [
					Fixtures.entry(ISSUE, 1, "handoff", CLAUDE, Fixtures.REAL_HANDOFF),
					Fixtures.entry(
						ISSUE,
						2,
						"finding",
						CLAUDE,
						`## Gap\n\n${Array.from({ length: 40 }, (_, n) => `Line ${String(n)}.`).join("\n\n")}`,
					),
				],
			}),
		);
		expect(entries.map((entry) => entry.kind)).toEqual(["handoff", "finding"]);
		const r = await mount(entries);
		const h = (): LiftedReader.Handle =>
			r.handle.current as LiftedReader.Handle;
		// Line by line down to the finding's first line at the top of the view.
		let frame = r.captureCharFrame();
		for (let step = 0; step < 400; step++) {
			if (topRow(frame).startsWith("finding · claude")) break;
			frame = await r.press(() => h().scroll({ delta: 1 }));
		}
		expect(topRow(frame)).toStartWith("finding · claude");
		expect(pinRow(frame)).toBe("");
		// A line further, the finding's first line has gone above: the row names it, not the handoff.
		expect(pinRow(await r.press(() => h().scroll({ delta: 1 })))).toBe(
			"finding · claude",
		);
		r.destroy();
	}, 20_000);

	test("a newer entry without that heading starts the reader over at the top", async () => {
		const r = await mount(lifted(Fixtures.REAL_HANDOFF));
		const h = (): LiftedReader.Handle =>
			r.handle.current as LiftedReader.Handle;
		await r.press(() => h().jump(1));
		await r.press(() => h().jump(1));
		const frame = await r.newer(
			lifted(
				Fixtures.REAL_HANDOFF,
				"### Summary\n\nRedone.\n\n### Risk\n\nNone.",
			),
			(f) => f.includes("Redone."),
		);
		expect(topRow(frame)).toStartWith("handoff · claude · ");
		expect(pinRow(frame)).toBe("");
		expect(frame).toContain("Redone.");
		r.destroy();
	});
});
