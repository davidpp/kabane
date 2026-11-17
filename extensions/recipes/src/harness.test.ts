import { describe, expect, it } from "bun:test";
import { err, ok, tryCatch, trySync } from "@cabane/core";
import { Harness } from "./harness";
import { Kabane } from "./result";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

describe("Harness.choose", () => {
	it("takes the most specific harness given: launch, job, recipe, setting, then claude", () => {
		const all = {
			launch: ["a"],
			job: ["b"],
			recipe: ["c"],
			setting: ["d"],
		};
		expect(Harness.choose(all)).toEqual({ argv: ["a"], source: "launch" });
		expect(Harness.choose({ ...all, launch: undefined })).toEqual({
			argv: ["b"],
			source: "job",
		});
		expect(Harness.choose({ recipe: ["c"], setting: ["d"] })).toEqual({
			argv: ["c"],
			source: "recipe",
		});
		expect(Harness.choose({ setting: ["d"] })).toEqual({
			argv: ["d"],
			source: "setting",
		});
		expect(Harness.choose({})).toEqual({ argv: ["claude"], source: "default" });
		expect(Harness.describe(Harness.choose({ recipe: ["codex"] }))).toBe(
			"codex  (from the recipe)",
		);
	});
});

describe("Harness.line and Harness.split", () => {
	it("quote a command line that splits back into the same words", () => {
		const argv = [
			"sh",
			"-c",
			`printf "%s\\n" "$0"; read line; echo "it's $line"`,
			"",
			"a,b",
		];
		const text = Harness.line(argv);
		expect(text).toBe(
			`sh -c 'printf "%s\\n" "$0"; read line; echo "it'\\''s $line"' '' a,b`,
		);
		const back = Harness.split(text);
		expect(back.ok && back.value).toEqual(argv);
	});

	it("split blanks, both quotes and backslashes as a shell does, without expanding", () => {
		const words = Harness.split(`  codex  exec "a \\"b\\" $c" x\\ y 'd'e `);
		expect(words.ok && words.value).toEqual([
			"codex",
			"exec",
			'a "b" $c',
			"x y",
			"de",
		]);
	});

	it("refuse an empty command and an unclosed quote", () => {
		const empty = Harness.split("   ");
		expect(empty.ok ? "ok" : empty.error.message).toBe(
			"the harness is empty: give the command to start",
		);
		const open = Harness.split("sh -c 'echo");
		expect(open.ok ? "ok" : open.error.message).toBe(
			"the harness has an unclosed ': sh -c 'echo",
		);
	});
});
