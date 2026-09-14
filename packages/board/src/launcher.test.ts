import { describe, expect, test } from "bun:test";
import { Launcher } from "./launcher";

const LINEAR: Launcher.Target = {
	provider: "linear",
	identifier: "ENG-123",
	url: "https://linear.app/acme/issue/ENG-123",
};

const GITHUB: Launcher.Target = {
	provider: "github",
	identifier: "acme/web#42",
	url: "https://github.com/acme/web/issues/42",
};

describe("deepLink", () => {
	test("linear resolves to its desktop scheme", () => {
		expect(Launcher.deepLink(LINEAR)).toBe("linear://issue/ENG-123");
	});

	test("linear without an identifier has no deep link", () => {
		expect(Launcher.deepLink({ ...LINEAR, identifier: undefined })).toBeNull();
	});

	test("provider matching is case-insensitive", () => {
		expect(Launcher.deepLink({ ...LINEAR, provider: "Linear" })).toBe(
			"linear://issue/ENG-123",
		);
	});

	test("github registers no scheme", () => {
		expect(Launcher.deepLink(GITHUB)).toBeNull();
	});
});

describe("nativeCommand", () => {
	test("one handler per supported platform", () => {
		expect(Launcher.nativeCommand("darwin")?.command).toBe("open");
		expect(Launcher.nativeCommand("linux")?.command).toBe("xdg-open");
		expect(Launcher.nativeCommand("win32")?.command).toBe("cmd");
	});

	test("an unknown platform has no handler", () => {
		expect(Launcher.nativeCommand("aix")).toBeNull();
	});
});

describe("open", () => {
	test("the desktop app wins when it takes the deep link", async () => {
		const tried: string[] = [];
		const result = await Launcher.open(LINEAR, {
			run: async (uri) => {
				tried.push(uri);
				return true;
			},
		});

		expect(result).toEqual({ ok: true, value: "app" });
		expect(tried).toEqual(["linear://issue/ENG-123"]);
	});

	test("falls through to the web url when no app handles the scheme", async () => {
		const tried: string[] = [];
		const result = await Launcher.open(LINEAR, {
			run: async (uri) => {
				tried.push(uri);
				return uri.startsWith("https:");
			},
		});

		expect(result).toEqual({ ok: true, value: "browser" });
		expect(tried).toEqual([
			"linear://issue/ENG-123",
			"https://linear.app/acme/issue/ENG-123",
		]);
	});

	test("a provider with no scheme goes straight to the web url", async () => {
		const tried: string[] = [];
		const result = await Launcher.open(GITHUB, {
			run: async (uri) => {
				tried.push(uri);
				return true;
			},
		});

		expect(result).toEqual({ ok: true, value: "browser" });
		expect(tried).toEqual(["https://github.com/acme/web/issues/42"]);
	});

	test("with no opener at all the url reaches the clipboard", async () => {
		const copied: string[] = [];
		const result = await Launcher.open(LINEAR, {
			run: async () => false,
			copy: async (text) => {
				copied.push(text);
				return true;
			},
		});

		expect(result).toEqual({ ok: true, value: "clipboard" });
		expect(copied).toEqual(["https://linear.app/acme/issue/ENG-123"]);
	});

	test("failing every path names the issue, not the url", async () => {
		const result = await Launcher.open(LINEAR, {
			run: async () => false,
			copy: async () => false,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toBe("could not open ENG-123");
	});

	test("an unidentified issue falls back to its url as a label", () => {
		expect(Launcher.label({ ...GITHUB, identifier: undefined })).toBe(
			"https://github.com/acme/web/issues/42",
		);
	});
});
