/** @jsxImportSource @opentui/react */
import { describe, expect, test } from "bun:test";
import { err, ok } from "@cabane/core";
import { CardHeader, segmentsOf } from "./card-header";
import type { Header, HeaderView } from "./ports";
import { Fixtures } from "./stories/fixtures";
import { pumpUntil, renderTest } from "./testing";
import { Theme } from "./theme";

describe("CardHeader", () => {
	test("lays out one padded, clipped row per line at forty columns", async () => {
		let view: HeaderView | undefined;
		const header: Header = async (_card, given) => {
			view = given;
			return ok(Fixtures.HEADER);
		};
		const r = await renderTest(
			<CardHeader
				header={header}
				card={Fixtures.loop(1)}
				width={40}
				expanded
			/>,
			{ width: 40, height: 8 },
		);
		try {
			const frame = await pumpUntil(r.renderOnce, r.captureCharFrame, (text) =>
				text.includes("session lane"),
			);
			expect(view).toEqual({ width: 38, expanded: true });
			const rows = frame.split("\n");
			expect(rows[0]?.startsWith(" default muted faint secondary")).toBe(true);
			expect(rows[3]).toBe(" A long header line that is clipped at  ");
			expect(rows[4]?.trim()).toBe("");
		} finally {
			r.destroy();
		}
	});

	test("keeps loading while pending without overlap, then keeps good rows after errors and throws", async () => {
		const first = Promise.withResolvers<Awaited<ReturnType<Header>>>();
		let calls = 0;
		const header: Header = () => {
			calls++;
			if (calls === 1) return first.promise;
			if (calls === 2) return Promise.resolve(err(new Error("read failed")));
			throw new Error("extension failed");
		};
		const r = await renderTest(
			<CardHeader
				header={header}
				card={Fixtures.loop(1)}
				width={40}
				expanded={false}
			/>,
		);
		try {
			expect(r.captureCharFrame()).toContain("loading…");
			await Bun.sleep(1100);
			expect(calls).toBe(1);
			first.resolve(ok([[{ text: "last good" }]]));
			await pumpUntil(r.renderOnce, r.captureCharFrame, (text) =>
				text.includes("last good"),
			);
			await Bun.sleep(2100);
			await r.renderOnce();
			expect(calls).toBeGreaterThanOrEqual(3);
			expect(r.captureCharFrame()).toContain("last good");
		} finally {
			r.destroy();
		}
		const ended = calls;
		await Bun.sleep(1100);
		expect(calls).toBe(ended);
	});

	test("maps every tone and session series on both themes", () => {
		for (const theme of [Theme.DARK, Theme.LIGHT]) {
			const parts = segmentsOf(Fixtures.HEADER.flat(), theme);
			expect(parts.map((part) => part.fg).slice(0, 9)).toEqual([
				theme.text,
				theme.muted,
				theme.faint,
				theme.secondary,
				theme.working,
				theme.done,
				theme.failed,
				theme.accent,
				Theme.seriesOf(theme, 1),
			]);
			expect(parts[0]?.attributes).toBeGreaterThan(0);
		}
	});
});
