import { describe, expect, it } from "bun:test";
import type { SettingField } from "@cabane/board/ports";
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
			source("global", {
				limits: { count: 2 },
				named: { a: "1" },
				list: ["x"],
			}),
			source("shared", { named: { b: "2" }, list: ["y", "z"] }),
			source("local", { limits: { cap: 9 }, named: { a: "3" } }),
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
			source("global", { limits: { count: 2 }, named: { a: "1" } }),
			source("local", { named: { a: "3" } }),
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
			"limits.count": "global",
			"named.a": "local",
			"gates.test": "default",
			list: "default",
		});
	});

	it("keeps, beside each leaf, the values of the layers under it that it replaced, lowest first", () => {
		const resolved = resolve(
			source("global", { mode: "b", list: ["x"], limits: { count: 2 } }),
			source("shared", { mode: "a", list: ["y"] }),
			source("local", { mode: "b" }),
		);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		const hides = (key: string) =>
			resolved.value.origins.find(({ path }) => path.join(".") === key)?.hides;
		expect(hides("mode")).toEqual([
			source("global", "b"),
			source("shared", "a"),
		]);
		expect(hides("list")).toEqual([source("global", ["x"])]);
		// A default is no layer's: what a layer replaces of it is not hidden.
		expect(hides("limits.count")).toEqual([]);
		expect(hides("gates.test")).toEqual([]);
	});

	it("unsets a key a lower layer set with null, back to its default", () => {
		const resolved = resolve(
			source("shared", { mode: "b", named: { a: "1", b: "2" } }),
			source("local", { mode: null, named: { a: null } }),
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

	it("merges a layer into a defaulted record, and a null removes a default entry", () => {
		const added = resolve(
			source("shared", { gates: { lint: "bun run lint" } }),
		);
		expect(added.ok && added.value.value.gates).toEqual({
			test: "bun test",
			lint: "bun run lint",
		});
		expect(
			added.ok &&
				Object.fromEntries(
					added.value.origins
						.filter(({ path }) => path[0] === "gates")
						.map(({ path, origin }) => [path.join("."), origin.layer]),
				),
		).toEqual({ "gates.test": "default", "gates.lint": "shared" });
		const removed = resolve(source("local", { gates: { test: null } }));
		expect(removed.ok && removed.value.value.gates).toEqual({});
	});

	it("refuses an unset that names no setting, or a key its record refuses", () => {
		const refused = resolve(
			source("shared", {
				mood: null,
				limits: { capp: null },
				gates: { "two words": null },
			}),
		);
		expect(!refused.ok && refused.error.message).toBe(
			[
				"Invalid demo settings in the shared file:",
				"  mood: not a demo setting",
				"  limits.capp: not a demo setting",
				"  gates.two words: a gate name is one word",
			].join("\n"),
		);
		// A name an object inherits is not one of its settings.
		const inherited = resolve(
			source("global", {
				constructor: null,
				toString: null,
				limits: { hasOwnProperty: null },
			}),
		);
		expect(!inherited.ok && inherited.error.message).toBe(
			[
				"Invalid demo settings in the global file:",
				"  constructor: not a demo setting",
				"  toString: not a demo setting",
				"  limits.hasOwnProperty: not a demo setting",
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
			source("global", { limits: { count: 2 } }),
			source("shared", { limit: {}, limits: { cap: "high" } }),
		);
		expect(!refused.ok && refused.error.message).toBe(
			[
				"Invalid demo settings in the shared file:",
				"  limits.cap: Expected number, received string",
				"  limit: not a demo setting",
			].join("\n"),
		);
		const notObject = resolve(source("local", ["mode"]));
		expect(!notObject.ok && notObject.error.message).toBe(
			"Invalid demo settings in the local file: expected a JSON object",
		);
	});

	it("puts the caller's overrides over the host's layers through a port", async () => {
		const port = Settings.port(async (namespace, projectDir) => {
			expect([namespace, projectDir]).toEqual(["demo", "/repo"]);
			return { ok: true, value: [source("shared", { mode: "b" })] };
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

describe("Settings.fields", () => {
	it("describes every setting of a schema, groups first, from its checks and wrappers", () => {
		const fields = Settings.fields(
			z.preprocess(
				(value) => value,
				z.object({
					size: z.number().int().min(1).max(8).optional().describe("How many."),
					spend: z.number().positive().optional(),
					name: z
						.string()
						.min(1)
						.refine((text) => text !== "x"),
					limits: Schema.shape.limits,
					gates: Schema.shape.gates,
					list: Schema.shape.list,
					mode: Schema.shape.mode,
					on: z.boolean().default(true),
					other: z.unknown(),
				}),
			),
		);
		expect(fields).toEqual([
			{
				path: ["size"],
				kind: "number",
				integer: true,
				minimum: 1,
				maximum: 8,
				optional: true,
				description: "How many.",
			},
			{
				path: ["spend"],
				kind: "number",
				integer: false,
				exclusiveMinimum: 0,
				optional: true,
			},
			{ path: ["name"], kind: "string", minLength: 1, optional: false },
			{ path: ["limits"], kind: "group", optional: false, default: {} },
			{
				path: ["limits", "count"],
				kind: "number",
				integer: false,
				optional: false,
				default: 1,
			},
			{
				path: ["limits", "cap"],
				kind: "number",
				integer: false,
				optional: true,
			},
			{
				path: ["gates"],
				kind: "record",
				keyPattern: "^[a-z]+$",
				value: { kind: "string", optional: false },
				optional: false,
				default: { test: "bun test" },
			},
			{
				path: ["list"],
				kind: "list",
				item: { kind: "string", optional: false },
				optional: false,
				default: [],
			},
			{
				path: ["mode"],
				kind: "enum",
				values: ["a", "b"],
				optional: false,
				default: "a",
			},
			{ path: ["on"], kind: "boolean", optional: false, default: true },
			{ path: ["other"], kind: "other", optional: false },
		]);
	});
});

describe("Settings looks", () => {
	const looks: Settings.Looks = {
		mode: { label: "the mode", group: "First" },
		"limits.count": {
			label: "count",
			group: "Second",
			options: ({ projectDir }) => (projectDir ? [projectDir] : []),
		},
		"limits.cap": { label: "cap", group: "First", options: [1, 2] },
	};
	const fieldAt = (path: string): SettingField => {
		const found = Settings.fields(Schema).find(
			(f) => f.path.join(".") === path,
		);
		if (!found) throw new Error(path);
		return found;
	};

	it("a setting with no look reads under its path, in its parent's group or Other", () => {
		expect(Settings.lookOf(looks, ["mode"])).toEqual({
			label: "the mode",
			group: "First",
		});
		expect(Settings.lookOf(undefined, ["named"])).toEqual({
			label: "named",
			group: "Other",
		});
		expect(Settings.lookOf(looks, ["limits", "other"])).toEqual({
			label: "limits.other",
			group: "Limits",
		});
	});

	it("groups come in the order the looks first name them", () => {
		expect(Settings.groupsOf(looks)).toEqual(["First", "Second"]);
	});

	it("options: a fixed list, a source called with the project, an enum, a bounded integer's range", () => {
		expect(
			Settings.options(
				fieldAt("limits.cap"),
				Settings.lookOf(looks, ["limits", "cap"]),
				{},
			),
		).toEqual([1, 2]);
		expect(
			Settings.options(
				fieldAt("limits.count"),
				Settings.lookOf(looks, ["limits", "count"]),
				{ projectDir: "/repo" },
			),
		).toEqual(["/repo"]);
		expect(
			Settings.options(fieldAt("mode"), Settings.lookOf(looks, ["mode"]), {}),
		).toEqual(["a", "b"]);
		const size = Settings.field(z.number().int().min(2).max(4), ["size"]);
		expect(
			Settings.options(size, Settings.lookOf(undefined, ["size"]), {}),
		).toEqual([2, 3, 4]);
		const wide = Settings.field(z.number().int().min(0).max(1000), ["wide"]);
		expect(
			Settings.options(wide, Settings.lookOf(undefined, ["wide"]), {}),
		).toBeUndefined();
	});
});
