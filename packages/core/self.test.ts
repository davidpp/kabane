import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { Self } from "./self";

const SCRIPT: Self.Host = {
	moduleUrl:
		"file:///home/me/.bun/install/global/node_modules/kabane/bin/kabane.js",
	execPath: "/home/me/.bun/bin/bun",
	main: "/home/me/.bun/install/global/node_modules/kabane/bin/kabane.js",
	entry: "/home/me/.bun/bin/kabane",
};

// What a probe binary printed on Bun 1.4.2: argv[1] and Bun.main are the embedded entry.
const BINARY: Self.Host = {
	moduleUrl: "file:///$bunfs/root/kabane",
	execPath: "/opt/kabane/kabane",
	main: "/$bunfs/root/kabane",
	entry: "/$bunfs/root/kabane",
};

describe("Self.compiled", () => {
	it("knows the embedded filesystem by each name Bun gives it", () => {
		for (const moduleUrl of [
			"file:///$bunfs/root/kabane",
			"file:///B:/~BUN/root/kabane.exe",
			"file:///B:/%7EBUN/root/kabane.exe",
		])
			expect(Self.compiled({ ...BINARY, moduleUrl })).toBe(true);
	});

	it("is false for a user path that holds those names past its root", () => {
		for (const moduleUrl of [
			"file:///home/me/~BUN-project/node_modules/kabane/bin/kabane.js",
			"file:///home/me/%7EBUN/node_modules/kabane/bin/kabane.js",
			"file:///home/me/$bunfs/root/kabane.js",
			"file:///C:/Users/me/~BUN/root/kabane.js",
			"file:///$bunfs-old/root/kabane.js",
		])
			expect(Self.compiled({ ...SCRIPT, moduleUrl })).toBe(false);
	});

	it("is false for a script on disk, and for this test run", () => {
		expect(Self.compiled(SCRIPT)).toBe(false);
		expect(Self.compiled()).toBe(false);
	});
});

describe("Self.launch", () => {
	it("runs a script as the absolute bun with its entry", () => {
		expect(Self.launch(SCRIPT)).toEqual({
			command: "/home/me/.bun/bin/bun",
			args: [SCRIPT.main],
		});
	});

	it("runs a binary as itself, never its embedded entry", () => {
		expect(Self.launch(BINARY)).toEqual({
			command: "/opt/kabane/kabane",
			args: [],
		});
	});
});

describe("Self.executable", () => {
	it("is a script's entry as invoked, resolved", () => {
		expect(Self.executable(SCRIPT)).toBe("/home/me/.bun/bin/kabane");
		expect(Self.executable({ ...SCRIPT, entry: "bin/kabane" })).toBe(
			resolve("bin/kabane"),
		);
	});

	it("is the binary itself when compiled", () => {
		expect(Self.executable(BINARY)).toBe("/opt/kabane/kabane");
	});

	it("falls back to kabane on PATH with no entry", () => {
		expect(Self.executable({ ...SCRIPT, entry: undefined })).toBe("kabane");
	});
});

describe("Self.templates", () => {
	it("reads a script's templates beside the reading module's directory", () => {
		expect(
			Self.templates(
				"lenses",
				"file:///repo/extensions/loop/src/lenses.ts",
				SCRIPT,
			),
		).toBe("/repo/extensions/loop/templates/lenses");
	});

	it("reads a binary's templates beside the executable", () => {
		expect(
			Self.templates("dispatch", "file:///$bunfs/root/kabane", BINARY),
		).toBe("/opt/kabane/templates/dispatch");
	});
});
