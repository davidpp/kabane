/** @jsxImportSource @opentui/react */
import { describe, expect, test } from "bun:test";
import { err, ok } from "@kabane/core";
import type { Header, HeaderView } from "@kabane/extension";
import { RGBA } from "@opentui/core";
import { act, type ReactNode, useEffect, useState } from "react";
import { CardHeader, segmentsOf } from "./card-header";
import { Fixtures } from "./stories/fixtures";
import { pumpUntil, renderTest } from "./testing";
import { Theme } from "./theme";

describe("CardHeader", () => {
	test("lays out one padded row per line, cut with an ellipsis, at forty columns", async () => {
		let view: HeaderView | undefined;
		const header: Header = async (_card, given) => {
			view = given;
			return ok([
				...Fixtures.HEADER,
				[{ text: "● implement ×3 sessions  ›  ✗ gates lint" }],
				[{ text: "spend ▰▰▰▰▰▰▰▰▰▱ 8.50/10 USD   context" }],
			]);
		};
		const r = await renderTest(
			<CardHeader
				header={header}
				card={Fixtures.loop(1)}
				width={39}
				expanded
			/>,
			{ width: 40, height: 8 },
		);
		try {
			const frame = await pumpUntil(r.renderOnce, r.captureCharFrame, (text) =>
				text.includes("session lane"),
			);
			expect(view).toEqual({ width: 37, expanded: true });
			const rows = frame.split("\n");
			expect(rows[0]?.startsWith(" default muted faint secondary")).toBe(true);
			expect(rows[3]).toBe(" A long header line that is clipped a…  ");
			expect(rows[6]?.trim()).toBe("");
			expect(rows[4]).toBe(" ● implement ×3 sessions  ›  ✗ gates …  ");
			expect(rows[5]).toBe(" spend ▰▰▰▰▰▰▰▰▰▱ 8.50/10 USD   conte…  ");
			const spans = r.captureSpans().lines[3]?.spans ?? [];
			expect(spans.reduce((n, span) => n + span.text.length, 0)).toBe(40);
			expect(spans.at(-1)?.bg.toInts()).toEqual(
				RGBA.fromHex(Theme.DARK.surface.raised).toInts(),
			);
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
				intervalMs={20}
			/>,
		);
		try {
			expect(r.captureCharFrame().split("\n")[0]?.startsWith("loading…")).toBe(
				true,
			);
			const loading = r.captureSpans().lines[0]?.spans ?? [];
			expect(loading[0]?.fg.toInts()).toEqual(
				RGBA.fromHex(Theme.DARK.muted).toInts(),
			);
			expect(
				loading.every(
					(span) =>
						span.bg.toInts().join() !==
						RGBA.fromHex(Theme.DARK.surface.raised).toInts().join(),
				),
			).toBe(true);
			await Bun.sleep(50);
			expect(calls).toBe(1);
			first.resolve(ok([[{ text: "last good" }]]));
			await pumpUntil(r.renderOnce, r.captureCharFrame, (text) =>
				text.includes("last good"),
			);
			await Bun.sleep(70);
			await r.renderOnce();
			expect(calls).toBeGreaterThanOrEqual(3);
			expect(r.captureCharFrame()).toContain("last good");
		} finally {
			r.destroy();
		}
		const ended = calls;
		await Bun.sleep(50);
		expect(calls).toBe(ended);
	});

	for (const change of ["expanded", "width"] as const) {
		test(`redraws immediately when ${change} changes`, async () => {
			let update = () => {};
			const header: Header = async (_card, view) =>
				ok([
					[
						{
							text: `${view.expanded ? "expanded" : "compact"} at ${view.width}`,
						},
					],
				]);
			const View = (): ReactNode => {
				const [changed, setChanged] = useState(false);
				useEffect(() => {
					update = () => setChanged(true);
				}, []);
				return (
					<CardHeader
						header={header}
						card={Fixtures.loop(1)}
						width={changed && change === "width" ? 79 : 39}
						expanded={changed && change === "expanded"}
					/>
				);
			};
			const r = await renderTest(<View />);
			try {
				await pumpUntil(r.renderOnce, r.captureCharFrame, (text) =>
					text.includes("compact at 37"),
				);
				const start = performance.now();
				act(update);
				await pumpUntil(r.renderOnce, r.captureCharFrame, (text) =>
					text.includes(
						change === "expanded" ? "expanded at 37" : "compact at 77",
					),
				);
				expect(performance.now() - start).toBeLessThan(300);
			} finally {
				r.destroy();
			}
		});
	}

	test("refreshes a changed view after an in-flight read without overlap", async () => {
		const first = Promise.withResolvers<Awaited<ReturnType<Header>>>();
		let calls = 0;
		let expand = () => {};
		const header: Header = async (_card, view) => {
			calls++;
			return calls === 1
				? first.promise
				: ok([[{ text: view.expanded ? "expanded" : "compact" }]]);
		};
		const View = (): ReactNode => {
			const [expanded, setExpanded] = useState(false);
			useEffect(() => {
				expand = () => setExpanded(true);
			}, []);
			return (
				<CardHeader
					header={header}
					card={Fixtures.loop(1)}
					width={39}
					expanded={expanded}
				/>
			);
		};
		const r = await renderTest(<View />);
		try {
			act(expand);
			expect(calls).toBe(1);
			const start = performance.now();
			first.resolve(ok([[{ text: "stale compact" }]]));
			await pumpUntil(r.renderOnce, r.captureCharFrame, (text) =>
				text.includes("expanded"),
			);
			expect(performance.now() - start).toBeLessThan(300);
			expect(calls).toBe(2);
		} finally {
			r.destroy();
		}
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
