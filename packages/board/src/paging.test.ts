// The scroll keys every scrolling view shares: which key asks for which motion.
import { describe, expect, it } from "bun:test";
import { Paging } from "./paging";

describe("Paging.motion", () => {
	it("moves a couple of rows on j/k and the arrows", () => {
		expect(Paging.motion({ name: "j", sequence: "j" })).toEqual({ delta: 2 });
		expect(Paging.motion({ name: "down" })).toEqual({ delta: 2 });
		expect(Paging.motion({ name: "k", sequence: "k" })).toEqual({ delta: -2 });
		expect(Paging.motion({ name: "up" })).toEqual({ delta: -2 });
	});

	it("moves half the viewport on ctrl+d and ctrl+u", () => {
		expect(Paging.motion({ name: "d", ctrl: true })).toEqual({ page: 0.5 });
		expect(Paging.motion({ name: "u", ctrl: true })).toEqual({ page: -0.5 });
	});

	it("goes to the top on g and to the end on G, whatever name the terminal gives G", () => {
		expect(Paging.motion({ name: "g", sequence: "g" })).toEqual({ to: "top" });
		expect(Paging.motion({ name: "G", sequence: "G" })).toEqual({ to: "end" });
		expect(Paging.motion({ name: "g", sequence: "G", shift: true })).toEqual({
			to: "end",
		});
		expect(Paging.motion({ name: "g", shift: true })).toEqual({ to: "end" });
		expect(Paging.motion({ name: "G" })).toEqual({ to: "end" });
		expect(Paging.motion({ name: "g" })).toEqual({ to: "top" });
	});

	it("leaves every other key alone: space, the shifted J/K, and j/k with ctrl or meta", () => {
		for (const key of [
			{ name: "space", sequence: " " },
			{ name: "j", sequence: "J", shift: true },
			{ name: "j", shift: true },
			{ name: "K", sequence: "K" },
			{ name: "j", ctrl: true },
			{ name: "d", sequence: "d" },
			{ name: "g", sequence: "g", meta: true },
		])
			expect(Paging.motion(key)).toBeNull();
	});
});
