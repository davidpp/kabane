import { describe, expect, test } from "bun:test";
import { UpgradeOffer } from "./upgrade-offer";

const BREW = { name: "brew", upgrade: "brew upgrade kabane" } as const;
const MISE = {
	name: "mise",
	upgrade: "mise up github:davidpp/kabane",
} as const;

describe("UpgradeOffer.applies", () => {
	const gate: UpgradeOffer.Gate = {
		tty: true,
		env: {},
		bundled: true,
		mainBuild: false,
		checks: true,
	};

	test("a published build at a terminal asks", () => {
		expect(UpgradeOffer.applies(gate)).toBe(true);
		expect(UpgradeOffer.applies({ ...gate, env: { CI: "false" } })).toBe(true);
	});

	test("never off a terminal, from a source checkout, on a main build, with updates.check false, or under CI", () => {
		expect(UpgradeOffer.applies({ ...gate, tty: false })).toBe(false);
		expect(UpgradeOffer.applies({ ...gate, bundled: false })).toBe(false);
		expect(UpgradeOffer.applies({ ...gate, mainBuild: true })).toBe(false);
		expect(UpgradeOffer.applies({ ...gate, checks: false })).toBe(false);
		expect(UpgradeOffer.applies({ ...gate, env: { CI: "true" } })).toBe(false);
	});

	test("never in the kabane an upgrade started, whatever brew installed", () => {
		expect(
			UpgradeOffer.applies({
				...gate,
				env: { [UpgradeOffer.RELAUNCHED]: "1.0.1" },
			}),
		).toBe(false);
	});
});

describe("UpgradeOffer.answer", () => {
	test("Enter and y take the upgrade, n and an ended stdin continue, s skips, Ctrl-C quits", () => {
		for (const key of ["\r", "\n", "y", "Y"])
			expect(UpgradeOffer.answer(key, BREW)).toBe("yes");
		for (const key of ["n", "N", ""])
			expect(UpgradeOffer.answer(key, BREW)).toBe("no");
		for (const key of ["s", "S"])
			expect(UpgradeOffer.answer(key, "binary")).toBe("skip");
		expect(UpgradeOffer.answer("\x03", BREW)).toBe("quit");
	});

	test("a fast key then Enter, sent as one chunk, answers with its first key", () => {
		expect(UpgradeOffer.answer("n\r", BREW)).toBe("no");
		expect(UpgradeOffer.answer("s\r", "binary")).toBe("skip");
		expect(UpgradeOffer.answer("y\r", BREW)).toBe("yes");
	});

	test("any other key answers nothing, and asks again", () => {
		for (const key of ["x", "\x1b", "\x1b[A", " "])
			expect(UpgradeOffer.answer(key, BREW)).toBeUndefined();
	});

	test("a manual install has nothing to run, so Enter continues", () => {
		expect(UpgradeOffer.answer("\r", "manual")).toBe("no");
		expect(UpgradeOffer.answer("s", "manual")).toBe("skip");
	});
});

describe("UpgradeOffer.command and question", () => {
	const launch = { command: "/opt/kabane/kabane", args: [] };

	test("a package manager runs its own upgrade, a binary or Bun install runs kabane update", () => {
		expect(UpgradeOffer.command(BREW, launch)).toEqual([
			"brew",
			"upgrade",
			"kabane",
		]);
		expect(UpgradeOffer.command(MISE, launch)).toEqual([
			"mise",
			"up",
			"github:davidpp/kabane",
		]);
		expect(UpgradeOffer.command("binary", launch)).toEqual([
			"/opt/kabane/kabane",
			"update",
		]);
		expect(
			UpgradeOffer.command("bun", {
				command: "/usr/local/bin/bun",
				args: ["/g/kabane.js"],
			}),
		).toEqual(["/usr/local/bin/bun", "/g/kabane.js", "update"]);
		expect(UpgradeOffer.command("manual", launch)).toBeUndefined();
	});

	test("the question names both versions and the command it would run", () => {
		expect(UpgradeOffer.question("1.0.1", "1.0.0", BREW)).toBe(
			'kabane 1.0.1 is out (you have 1.0.0). Upgrade now with "brew upgrade kabane"? [Y]es / [n]o, continue / [s]kip this version ',
		);
		expect(UpgradeOffer.question("1.0.1", "1.0.0", "binary")).toContain(
			'with "kabane update"?',
		);
		expect(UpgradeOffer.question("1.0.1", "1.0.0", "manual")).toContain(
			"Download it from https://github.com/davidpp/kabane/releases/tag/v1.0.1",
		);
	});
});
