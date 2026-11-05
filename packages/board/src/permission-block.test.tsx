/** @jsxImportSource @opentui/react */
import { describe, expect, it } from "bun:test";
import {
	PermissionBlock,
	permissionLine,
	permissionSegments,
} from "./permission-block";
import { Segments } from "./segments";
import { Fixtures } from "./stories/fixtures";
import { renderTest } from "./testing";
import { Theme } from "./theme";

const T = Theme.DARK;

const request = {
	id: "p1",
	title: "kabane_edit JREP-1",
	options: [
		{ id: "once", label: "Allow once" },
		{ id: "no", label: "Reject" },
	],
};

describe("permissionSegments", () => {
	it("reads as permissionLine, with the request in the accent and the answers as content", () => {
		const line = permissionSegments(request, T, T.text);
		expect(Segments.plain(line)).toBe(permissionLine(request));
		expect(
			line.filter((part) => part.fg === T.accent).map((p) => p.text),
		).toEqual(["? "]);
		for (const key of ["1", "2", "esc"])
			expect(line.find((part) => part.text === key)?.fg).toBe(T.text);
		expect(line.find((part) => part.text === " Allow once")?.fg).toBe(T.text);
		expect(line.find((part) => part.text === " decline")?.fg).toBe(T.muted);
	});

	it("names how many more are queued behind it, muted, right after the title", () => {
		const line = permissionSegments(request, T, T.text, 3);
		expect(Segments.plain(line)).toBe(permissionLine(request, 3));
		expect(Segments.plain(line)).toBe(
			"? kabane_edit JREP-1 · 3 more waiting · 1 Allow once · 2 Reject · esc decline",
		);
		expect(line.find((part) => part.text === " · 3 more waiting")?.fg).toBe(
			T.muted,
		);
	});
});

describe("PermissionBlock", () => {
	if (Fixtures.PERMISSION.type !== "permission") throw new Error("fixture");
	const three = Fixtures.PERMISSION.request;

	const mount = async (width: number) => {
		const picked: number[] = [];
		const keys: string[] = [];
		const setup = await renderTest(
			<box style={{ flexDirection: "column", width }}>
				<PermissionBlock
					request={three}
					width={width}
					onPick={(index) => picked.push(index)}
					onKey={(name) => keys.push(name)}
				/>
			</box>,
			{ width, height: 6 },
		);
		const rows = setup.captureCharFrame().split("\n");
		const clickOn = async (text: string): Promise<void> => {
			const y = rows.findIndex((row) => row.includes(text));
			await setup.mockMouse.click(rows[y]?.indexOf(text) ?? 0, y);
		};
		return { ...setup, rows, picked, keys, clickOn };
	};

	it("keeps its answers on one row while they fit", async () => {
		const { rows, destroy } = await mount(80);
		try {
			expect(rows.slice(0, 2).map((row) => row.trimEnd())).toEqual([
				"? kabane_edit JREP-1",
				"1 Allow once · 2 Allow always · 3 Reject · esc decline",
			]);
		} finally {
			destroy();
		}
	});

	it("at 40 columns breaks between answers, so Reject and the way out still show", async () => {
		const { rows, picked, keys, clickOn, destroy } = await mount(40);
		try {
			expect(rows.slice(0, 3).map((row) => row.trimEnd())).toEqual([
				"? kabane_edit JREP-1",
				"1 Allow once · 2 Allow always · 3 Reject",
				"esc decline",
			]);
			// Each answer keeps its own click across the break.
			await clickOn("3 Reject");
			await clickOn("esc decline");
			expect(picked).toEqual([2]);
			expect(keys).toEqual(["escape"]);
		} finally {
			destroy();
		}
	});

	it("narrower still, an answer a row, none cut", async () => {
		const { rows, destroy } = await mount(20);
		try {
			expect(rows.slice(0, 5).map((row) => row.trimEnd())).toEqual([
				"? kabane_edit JREP-1",
				"1 Allow once",
				"2 Allow always",
				"3 Reject",
				"esc decline",
			]);
		} finally {
			destroy();
		}
	});
});
