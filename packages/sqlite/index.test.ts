import { describe, expect, test } from "bun:test";
import { PACKAGE_NAME } from "./index";

describe("@cabane/sqlite", () => {
	test("exports its package name", () => {
		expect(PACKAGE_NAME).toBe("@cabane/sqlite");
	});
});
