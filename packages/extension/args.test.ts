import { describe, expect, it } from "bun:test";
import { flagBool, flagCsv, flagList, flagString, parseArgs } from "./args";

describe("parseArgs", () => {
	it("separates positionals from flags", () => {
		const args = parseArgs(["add", "Fix the bug", "--priority", "high"]);
		expect(args.positionals).toEqual(["add", "Fix the bug"]);
		expect(flagString(args, "priority")).toBe("high");
	});

	it("reads --key=value and bare booleans", () => {
		const args = parseArgs(["--json", "--state=next", "list"]);
		expect(flagBool(args, "json")).toBe(true);
		expect(flagString(args, "state")).toBe("next");
		expect(args.positionals).toEqual(["list"]);
	});

	it("collects a repeated flag", () => {
		const args = parseArgs(["--ref", "commit:abc", "--ref", "branch:main"]);
		expect(flagList(args, "ref")).toEqual(["commit:abc", "branch:main"]);
		expect(flagString(args, "ref")).toBe("branch:main");
	});

	it("stops flag parsing at --", () => {
		const args = parseArgs(["comment", "JCAB-1", "--", "--not-a-flag"]);
		expect(args.positionals).toEqual(["comment", "JCAB-1", "--not-a-flag"]);
	});

	it("splits comma lists", () => {
		expect(flagCsv(parseArgs(["--tags", "a, b,,c"]), "tags")).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(flagCsv(parseArgs([]), "tags")).toBeUndefined();
	});
});
