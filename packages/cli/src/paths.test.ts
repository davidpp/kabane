import { describe, expect, test } from "bun:test";
import { Paths } from "./paths";

describe("Paths.inside", () => {
	test("the root itself and a child below it are inside", () => {
		expect(Paths.inside("/r", "/r")).toBe("");
		expect(Paths.inside("/r", "/r/src/deep")).toBe("src/deep");
	});

	test("a part made only of two dots leaves the root", () => {
		expect(Paths.inside("/r", "/r/..")).toBeUndefined();
		expect(Paths.inside("/r", "/r/../x")).toBeUndefined();
		expect(Paths.inside("/r/a", "/r")).toBeUndefined();
	});

	test("a name that starts with two dots is a child", () => {
		expect(Paths.inside("/r", "/r/..nested")).toBe("..nested");
		expect(Paths.inside("/r", "/r/a/..b")).toBe("a/..b");
	});
});
