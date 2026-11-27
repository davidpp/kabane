import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type KabaneModule,
	LocalRelay,
	Oplog,
	Planner,
	type Result,
	Runtime,
	Sync,
	withDb,
} from "@kabane/core";
import { configureTestRuntime } from "@kabane/core/testing";
import { SqliteDb } from "@kabane/sqlite";
import { Registry, registryModule } from "./index";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const bases: string[] = [];
afterEach(() => {
	configureTestRuntime();
	for (const base of bases.splice(0))
		rmSync(base, { recursive: true, force: true });
});
const monitor: KabaneModule = {
	name: "monitor",
	threadKinds: [{ name: "alert", label: "Alert" }],
};
const register = (actor: string, extra: KabaneModule[] = []) =>
	unwrap(
		Runtime.configure({
			provider: SqliteDb.provider(),
			modules: [registryModule, ...extra],
			actor: () => `kabane://actor/human/${actor}`,
		}),
	);
const device = async (name: string, extra: KabaneModule[] = []) => {
	const base = mkdtempSync(join(tmpdir(), `registry-${name}-`));
	bases.push(base);
	register(name, extra);
	unwrap(await Planner.init(base));
	unwrap(unwrap(await withDb(base, (db) => Oplog.initDevice(db, name))));
	return base;
};
const signal = { name: "signal", label: "Monitor signal" };
const names = async (base: string, scope: string) =>
	unwrap(await Registry.kinds(base, scope)).kinds.map(
		(kind) => `${kind.source}:${kind.name}`,
	);

it("lists core's kinds, then a module's, then the scope's own, each with its label", async () => {
	const base = await device("alpha", [monitor]);
	expect(unwrap(await Registry.publish(base, "acme", signal))).toEqual(signal);
	const { kinds } = unwrap(await Registry.kinds(base, "acme"));
	expect(kinds.map((kind) => `${kind.source}:${kind.name}`)).toEqual([
		"core:thread",
		"core:task",
		"core:issue",
		"core:job",
		"module:monitor:alert",
		"scope:signal",
	]);
	expect(kinds.at(-1)).toEqual({ ...signal, source: "scope" });
});

it("keeps a scope's kinds to that exact scope, and a scope with none lists code's only", async () => {
	const base = await device("alpha");
	unwrap(await Registry.publish(base, "acme", signal));
	expect(await names(base, "other")).toEqual([
		"core:thread",
		"core:task",
		"core:issue",
		"core:job",
	]);
	expect(await names(base, "kabane://scope/acme")).toContain("scope:signal");
});

it("takes a retried publication as a no-op and refuses a different one under the same name", async () => {
	const base = await device("alpha");
	unwrap(await Registry.publish(base, "acme", signal));
	expect((await Registry.publish(base, "acme", signal)).ok).toBe(true);
	const changed = await Registry.publish(base, "acme", {
		...signal,
		label: "Signal",
	});
	expect(changed.ok).toBe(false);
	if (!changed.ok)
		expect(changed.error.message).toContain(
			'already declares thread kind "signal" differently',
		);
	expect(
		unwrap(await Registry.kinds(base, "acme")).kinds.filter(
			(kind) => kind.source === "scope",
		),
	).toEqual([{ ...signal, source: "scope" }]);
});

it("refuses a scope kind that core or a registered module already declares", async () => {
	const base = await device("alpha", [monitor]);
	for (const [name, owner] of [
		["thread", "core"],
		["job", "core"],
		["alert", "module:monitor"],
	] as const) {
		const result = await Registry.publish(base, "acme", { name, label: "X" });
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error.message).toBe(
				`Thread kind "${name}" is already declared by ${owner}; pick another name.`,
			);
	}
	const malformed = await Registry.publish(base, "acme", {
		name: "Signal",
		label: "x",
	});
	expect(malformed.ok).toBe(false);
});

it("keeps attribute declarations and thread kinds apart in one scope", async () => {
	const base = await device("alpha");
	const classification = {
		key: "signal",
		description: "What sort of signal",
		choices: [{ value: "finding", label: "Finding" }],
	};
	unwrap(await Registry.publish(base, "acme", classification));
	unwrap(await Registry.publish(base, "acme", signal));
	expect(unwrap(await Registry.list(base, "acme"))).toEqual([classification]);
	expect(await names(base, "acme")).toContain("scope:signal");
});

it("shadows a synced scope kind a module on this device declares, and lists it as shadowed", async () => {
	const relay = LocalRelay.create();
	const alpha = await device("alpha");
	unwrap(
		await Registry.publish(alpha, "acme", { name: "alert", label: "Ping" }),
	);
	unwrap(await Sync.push(alpha, LocalRelay.transportFor(relay, "alpha")));
	const beta = await device("beta", [monitor]);
	unwrap(await Sync.pull(beta, LocalRelay.transportFor(relay, "beta")));
	expect(unwrap(await Registry.kinds(beta, "acme"))).toEqual({
		kinds: expect.arrayContaining([
			{ name: "alert", label: "Alert", source: "module:monitor" },
		]),
		shadowed: [
			{ name: "alert", label: "Ping", source: "scope", by: "module:monitor" },
		],
	});
	expect(await names(beta, "acme")).not.toContain("scope:alert");
	register("alpha");
	expect(await names(alpha, "acme")).toContain("scope:alert");
});

it("converges two offline publications of one name to the same declaration everywhere", async () => {
	const relay = LocalRelay.create();
	const alpha = await device("alpha");
	const a = LocalRelay.transportFor(relay, "alpha");
	unwrap(await Registry.publish(alpha, "acme", signal));
	const beta = await device("beta");
	const b = LocalRelay.transportFor(relay, "beta");
	unwrap(await Registry.publish(beta, "acme", { ...signal, label: "Signal" }));
	register("alpha");
	unwrap(await Sync.push(alpha, a));
	register("beta");
	unwrap(await Sync.push(beta, b));
	unwrap(await Sync.pull(beta, b));
	register("alpha");
	unwrap(await Sync.pull(alpha, a));
	const scopeKind = async (base: string) =>
		unwrap(await Registry.kinds(base, "acme")).kinds.filter(
			(kind) => kind.source === "scope",
		);
	const onAlpha = await scopeKind(alpha);
	expect(onAlpha).toHaveLength(1);
	expect(await scopeKind(beta)).toEqual(onAlpha);
});
