import { describe, expect, it } from "bun:test";
import { err, ok } from "@cabane/core";
import { Doctor, type Extension, Settings } from "./index";

const ctx: Extension.Ctx = {
	home: "/unused",
	store: "/unused",
	cwd: "/unused",
	actor: "doctor-test",
	harnessMode: "default",
	settings: Settings.port(async () => ok([])),
};

const finding = (
	source: string,
	id: string,
	severity: Doctor.Finding["severity"] = "mention",
): Doctor.Finding => ({ source, id, severity, summary: id });

describe("Doctor", () => {
	it("merges Result checks in source order and isolates both failure forms", async () => {
		const report = await Doctor.run(
			[
				{
					name: "a",
					doctor: async (received) => {
						expect(received).toBe(ctx);
						return ok([finding("a", "one"), finding("a", "two")]);
					},
				},
				{
					name: "throws",
					doctor: () => Promise.reject(new Error("cannot read")),
				},
				{ name: "error", doctor: async () => err(new Error("missing file")) },
				{ name: "b", doctor: async () => ok([finding("b", "three")]) },
			],
			ctx,
		);
		expect(report.findings.map(({ source, id }) => `${source}/${id}`)).toEqual([
			"a/one",
			"a/two",
			"throws/check-failed",
			"error/check-failed",
			"b/three",
		]);
		expect(report.findings[2]).toMatchObject({
			severity: "mention",
			summary: "throws check failed: cannot read",
		});
		expect(report.findings[3]?.summary).toContain("missing file");
		expect(report.fixes).toEqual([]);
	});

	it("runs no repairs by default, only auto for true, and exactly qualified names when selected", async () => {
		const applied: string[] = [];
		const findings = (["auto", "mention", "suggest", "route"] as const).map(
			(severity) => ({
				...finding("src", severity, severity),
				fix: async () => {
					applied.push(severity);
					return ok(`repaired ${severity}`);
				},
			}),
		);
		const sources: Doctor.Source[] = [
			{ name: "src", doctor: async () => ok(findings) },
		];
		await Doctor.run(sources, ctx);
		expect(applied).toEqual([]);
		const automatic = await Doctor.run(sources, ctx, { fix: true });
		expect(applied).toEqual(["auto"]);
		expect(automatic.fixes).toEqual([
			{ source: "src", id: "auto", result: ok("repaired auto") },
		]);
		for (const severity of ["mention", "suggest", "route"]) {
			const named = await Doctor.run(sources, ctx, {
				fix: [`src/${severity}`],
			});
			expect(named.fixes.map(({ id }) => id)).toEqual([severity]);
		}
		await Doctor.run(sources, ctx, { fix: ["auto", "other/auto"] });
		expect(applied).toEqual(["auto", "mention", "suggest", "route"]);
	});

	it("continues after returned and thrown repair errors and projects closures and errors to JSON", async () => {
		const report = await Doctor.run(
			[
				{
					name: "src",
					doctor: async () =>
						ok([
							{
								...finding("src", "returned", "auto"),
								fix: async () => err(new Error("write failed")),
							},
							{
								...finding("src", "thrown", "auto"),
								fix: () => Promise.reject("permission denied"),
							},
							{
								...finding("src", "last", "auto"),
								path: "config.json",
								fix: async () => ok("updated"),
							},
							{
								...finding("src", "route", "route"),
								route: "run /setup-dispatch",
							},
						]),
				},
			],
			ctx,
			{ fix: true },
		);
		const json = Doctor.toJson(report);
		expect(JSON.parse(JSON.stringify(json))).toEqual(json);
		expect(json.fixes.map(({ result }) => result)).toEqual([
			{ ok: false, error: "write failed" },
			{ ok: false, error: "permission denied" },
			ok("updated"),
		]);
		expect(json.findings[0]).toEqual({
			...finding("src", "returned", "auto"),
			fixable: true,
		});
		expect(json.findings[3]).toEqual({
			...finding("src", "route", "route"),
			route: "run /setup-dispatch",
			fixable: false,
		});
	});
});

it("accounts for unmatched selectors and findings without fixes", async () => {
	const report = await Doctor.run(
		[{ name: "src", doctor: async () => ok([finding("src", "manual")]) }],
		ctx,
		{ fix: ["src/absent", "src/manual"] },
	);
	expect(Doctor.toJson(report).fixes).toEqual([
		{
			source: "src",
			id: "absent",
			result: {
				ok: false,
				error: expect.stringContaining("No finding matches src/absent"),
			},
		},
		{
			source: "src",
			id: "manual",
			result: {
				ok: false,
				error: expect.stringContaining("has no mechanical fix"),
			},
		},
	]);
});
