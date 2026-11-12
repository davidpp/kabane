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

// The text of the reader's first row (the pane's second, under the tab bar), without the scrollbar.
const topRow = (frame: string): string =>
	(frame.split("\n")[1] ?? "").replace(/[█▀▄]\s*$/, "").trim();

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
		expect(topRow(await r.press(() => h().jump(-1)))).toBe("");
		expect(r.captureCharFrame()).toContain("handoff · claude");
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
		const end = await r.press(() => h().jump(1));
		expect(end).toContain("Delta");
		await r.press(() => h().jump(1));
		await r.press(() => h().jump(1));
		// From Delta, `[` steps back through Gamma and Beta, which the end of the scroll holds in
		// view, before it reaches Summary: the jumps went through every heading, not round Beta.
		expect(await r.press(() => h().jump(-1))).toBe(end);
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
		expect(topRow(frame)).toBe("");
		expect(frame).toContain("Redone.");
		r.destroy();
	});
});
