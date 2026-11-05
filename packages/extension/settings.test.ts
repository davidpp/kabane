import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { Settings } from "./settings";

const Schema = z
	.object({
		mode: z.enum(["a", "b"]).default("a"),
		limits: z
			.object({ count: z.number().default(1), cap: z.number().optional() })
			.strict()
			.default({}),
		named: z.record(z.string()).default({}),
		gates: z
			.record(
				z.string().regex(/^[a-z]+$/, "a gate name is one word"),
				z.string(),
			)
			.default({ test: "bun test" }),
		list: z.array(z.string()).default([]),
	})
	.strict();

const source = (
	layer: Settings.Source["layer"],
	value: unknown,
): Settings.Source => ({ layer, label: `the ${layer} file`, value });

const resolve = (...sources: Settings.Source[]) =>
	Settings.resolve("demo", Schema, sources);

describe("Settings.resolve", () => {
	it("merges objects key by key and replaces lists, the later layer winning", () => {
		const resolved = resolve(
			source("user", { limits: { count: 2 }, named: { a: "1" }, list: ["x"] }),
			source("project", { named: { b: "2" }, list: ["y", "z"] }),
			source("scope", { limits: { cap: 9 }, named: { a: "3" } }),
		);
		expect(resolved.ok && resolved.value.value).toEqual({
			mode: "a",
			limits: { count: 2, cap: 9 },
			named: { a: "3", b: "2" },
			gates: { test: "bun test" },
			list: ["y", "z"],
		});
	});

	it("names the layer every leaf came from, and the default for the rest", () => {
		const resolved = resolve(
			source("user", { limits: { count: 2 }, named: { a: "1" } }),
			source("scope", { named: { a: "3" } }),
		);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(
			Object.fromEntries(
				resolved.value.origins.map(({ path, origin }) => [
					path.join("."),
					origin.layer,
				]),
			),
		).toEqual({
			mode: "default",
			"limits.count": "user",
			"named.a": "scope",
			"gates.test": "default",
			list: "default",
		});
	});

	it("unsets a key a lower layer set with null, back to its default", () => {
		const resolved = resolve(
			source("project", { mode: "b", named: { a: "1", b: "2" } }),
			source("scope", { mode: null, named: { a: null } }),
		);
		expect(resolved.ok && resolved.value.value).toMatchObject({
			mode: "a",
			named: { b: "2" },
		});
		expect(
			resolved.ok &&
				resolved.value.origins.find(({ path }) => path[0] === "mode")?.origin,
		).toEqual({ layer: "default" });
	});

	it("refuses an unset that names no setting, or a key its record refuses", () => {
		const refused = resolve(
			source("project", {
				mood: null,
				limits: { capp: null },
				gates: { "two words": null },
			}),
		);
		expect(!refused.ok && refused.error.message).toBe(
			[
				"Invalid demo settings in the project file:",
				"  mood: not a demo setting",
				"  limits.capp: not a demo setting",
				"  gates.two words: a gate name is one word",
			].join("\n"),
		);
		// From code, undefined is an unset too.
		const caller = resolve(source("caller", { mood: undefined }));
		expect(!caller.ok && caller.error.message).toContain(
			"mood: not a demo setting",
		);
	});

	it("validates each layer alone first, so the error names the layer it is in", () => {
		const refused = resolve(
			source("user", { limits: { count: 2 } }),
			source("project", { limit: {}, limits: { cap: "high" } }),
		);
		expect(!refused.ok && refused.error.message).toBe(
			[
				"Invalid demo settings in the project file:",
				"  limits.cap: Expected number, received string",
				"  limit: not a demo setting",
			].join("\n"),
		);
		const notObject = resolve(source("scope", ["mode"]));
		expect(!notObject.ok && notObject.error.message).toBe(
			"Invalid demo settings in the scope file: expected a JSON object",
		);
	});

	it("puts the caller's overrides over the host's layers through a port", async () => {
		const port = Settings.port(async (namespace, projectDir) => {
			expect([namespace, projectDir]).toEqual(["demo", "/repo"]);
			return { ok: true, value: [source("project", { mode: "b" })] };
		});
		const resolved = await port("demo", Schema, {
			projectDir: "/repo",
			overrides: { list: ["flag"], limits: { cap: undefined } },
		});
		expect(resolved.ok && resolved.value).toMatchObject({
			mode: "b",
			list: ["flag"],
		});
		const refused = await port("demo", Schema, {
			projectDir: "/repo",
			overrides: { mode: "c" },
		});
		expect(!refused.ok && refused.error.message).toStartWith(
			`Invalid demo settings in ${Settings.CALLER}:`,
		);
	});
});
