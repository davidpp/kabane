import { expect, it } from "bun:test";
import { quoted } from "./result";

it("quotes a value on one line, escaping line breaks", () => {
	expect(quoted("a\nb\rc d")).toBe('"a\\nb\\rc\\u2028d"');
});

it("cuts a long value before an astral character that straddles the limit", () => {
	// 59 units, then a surrogate pair at units 60 and 61: the cut falls inside it.
	const value = `${"a".repeat(59)}😀`;
	expect(quoted(value)).toBe(`"${"a".repeat(59)}…"`);
	expect(quoted(value)).not.toMatch(/\\ud[89ab]/);
});

it("keeps an astral character that ends just inside the limit", () => {
	const value = `${"a".repeat(58)}😀b`;
	expect(quoted(value)).toBe(`"${"a".repeat(58)}😀…"`);
});

it("leaves a value at the limit whole", () => {
	const value = `${"a".repeat(58)}😀`;
	expect(quoted(value)).toBe(`"${value}"`);
});

it("keeps a lone surrogate at the limit, escaped, since it splits no pair", () => {
	expect(quoted("a\uD800b", 2)).toBe('"a\\ud800…"');
	expect(quoted("a\uDC00b", 2)).toBe('"a\\udc00…"');
});
