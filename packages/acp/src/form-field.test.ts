import { describe, expect, it } from "bun:test";
import { FormField } from "./form-field";

const WORKERS: FormField.Typed = {
	key: "n",
	title: "Workers",
	required: true,
	type: "number",
	integer: true,
	minimum: 1,
	maximum: 8,
};

const SLUG: FormField.Typed = {
	key: "slug",
	title: "Slug",
	required: true,
	type: "text",
	minLength: 2,
	maxLength: 5,
	pattern: "^[a-z]+$",
};

const why = (result: ReturnType<typeof FormField.read>): string | undefined =>
	result.ok ? undefined : result.error.message;

describe("FormField.read", () => {
	it("reads a number inside its bounds, trimmed", () => {
		expect(FormField.read(WORKERS, " 4 ")).toEqual({ ok: true, value: 4 });
		expect(
			FormField.read({ ...WORKERS, integer: false, maximum: undefined }, "2.5"),
		).toEqual({ ok: true, value: 2.5 });
	});

	it("refuses what is not a number, a fraction where a whole one is wanted, and a value out of range, saying what it wants", () => {
		for (const given of ["four", "", "2.5", "0", "9", "Infinity"])
			expect(why(FormField.read(WORKERS, given))).toBe(
				"is not a whole number from 1 to 8",
			);
	});

	it("keeps text to its length and its pattern", () => {
		expect(FormField.read(SLUG, "cache")).toEqual({ ok: true, value: "cache" });
		expect(why(FormField.read(SLUG, "caches"))).toBe(
			"is not text from 2 to 5 characters",
		);
		expect(why(FormField.read(SLUG, "c"))).toBe(
			"is not text from 2 to 5 characters",
		);
		expect(why(FormField.read(SLUG, "Cache"))).toBe("does not match ^[a-z]+$");
	});

	it("reads a pattern as Unicode, as JSON Schema's patterns are", () => {
		const letters: FormField.Typed = { ...SLUG, pattern: "^\\p{L}+$" };
		expect(FormField.read(letters, "été")).toEqual({ ok: true, value: "été" });
		expect(why(FormField.read(letters, "a1"))).toBe("does not match ^\\p{L}+$");
	});

	it("accepts an answer to a pattern that does not compile, which the harness is left to check", () => {
		expect(FormField.read({ ...SLUG, pattern: "(" }, "cache")).toEqual({
			ok: true,
			value: "cache",
		});
	});
});
