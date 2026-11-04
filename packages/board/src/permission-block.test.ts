import { describe, expect, it } from "bun:test";
import { permissionLine, permissionSegments } from "./permission-block";
import { Segments } from "./segments";
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
	it("reads as permissionLine, with the request in the accent and the answers as keys", () => {
		const line = permissionSegments(request, T, T.text);
		expect(Segments.plain(line)).toBe(permissionLine(request));
		expect(
			line.filter((part) => part.fg === T.accent).map((p) => p.text),
		).toEqual(["? "]);
		for (const key of ["1", "2", "esc"])
			expect(line.find((part) => part.text === key)?.fg).toBe(T.text);
		expect(line.find((part) => part.text === " Allow once")?.fg).toBe(T.muted);
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
