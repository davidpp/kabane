import { describe, expect, it } from "bun:test";
import { firstGroups } from "./regex";

describe("firstGroups", () => {
	it("returns the first group of every match", () => {
		expect(firstGroups("a1 b2 c3", /[a-z](\d)/g)).toEqual(["1", "2", "3"]);
	});

	it("skips a match whose group took no part", () => {
		expect(firstGroups("a1 b c3", /[a-z](\d)?/g)).toEqual(["1", "3"]);
	});

	it("matches every occurrence of a non-global pattern", () => {
		expect(firstGroups("a1 b2", /[a-z](\d)/)).toEqual(["1", "2"]);
	});

	it("ignores a lastIndex left on a shared pattern", () => {
		const pattern = /[a-z](\d)/g;
		pattern.exec("a1 b2");
		expect(firstGroups("a1 b2", pattern)).toEqual(["1", "2"]);
	});
});
