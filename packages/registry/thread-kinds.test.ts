import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type KabaneModule,
	LocalRelay,
	Oplog,
	Planner,
	Portable,
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

it("lists a module kind's identity only, without the policy its code declaration carries", async () => {
	const routines: KabaneModule = {
		name: "routines",
		threadKinds: [
			{
				name: "routine",
				label: "Routine",
				initialState: "inbox",
				unlisted: true,
			},
		],
	};
	const base = await device("alpha", [routines]);
	const { kinds } = unwrap(await Registry.kinds(base, "acme"));
	expect(kinds.find((kind) => kind.name === "routine")).toEqual({
		name: "routine",
		label: "Routine",
		source: "module:routines",
	});
});

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

it("leaves out a stored declaration it cannot read and lists the rest", async () => {
	const base = await device("alpha");
	const classification = {
		key: "signal",
		description: "What sort of signal",
		choices: [{ value: "finding", label: "Finding" }],
	};
	unwrap(await Registry.publish(base, "acme", signal));
	unwrap(await Registry.publish(base, "acme", classification));
	// What a peer on a later build could sync in: a field this build does not know.
	unwrap(
		await withDb(base, (db) => {
			for (const [tbl, id, document] of <[string, string, string][]>[
				[
					"registry_thread_kinds",
					'["kabane://scope/acme","pager"]',
					'{"name":"pager","label":"Pager","icon":"!"}',
				],
				[
					"registry_declarations",
					'["kabane://scope/acme","urgency"]',
					'{"key":"urgency","description":"How soon","choices":[{"value":"now","label":"Now"}],"colour":"red"}',
				],
			])
				db.run(
					`INSERT INTO ${tbl} (id, scope, document, publication, updated_by) VALUES (?, 'kabane://scope/acme', ?, '01', 'x')`,
					[id, document],
				);
		}),
	);
	expect(await names(base, "acme")).toContain("scope:signal");
	expect(await names(base, "acme")).not.toContain("scope:pager");
	expect(unwrap(await Registry.list(base, "acme"))).toEqual([classification]);
});

it("rebuilds a scope's kind declaration and attribute choices from an export", async () => {
	const source = await device("alpha");
	const classification = {
		key: "classification",
		description: "What sort of signal",
		choices: [{ value: "noise", label: "Noise" }],
	};
	unwrap(await Registry.publish(source, "acme", signal));
	unwrap(await Registry.publish(source, "acme", classification));
	const thread = unwrap(
		await Planner.addTask(source, {
			title: "Error rate doubled",
			kind: "signal",
			scopeUri: "acme",
		}),
	);
	unwrap(await Registry.set(source, thread.id, "classification", "noise"));
	const snapshot = unwrap(unwrap(await withDb(source, Portable.snapshot)));
	if ("omitted" in snapshot) throw new Error("Incomplete snapshot");
	const jsonl = Portable.encode(snapshot);
	const rebuilt = mkdtempSync(join(tmpdir(), "registry-rebuilt-"));
	bases.push(rebuilt);
	unwrap(await Planner.init(rebuilt));
	unwrap(unwrap(await withDb(rebuilt, (db) => Portable.restore(db, jsonl))));
	expect(
		unwrap(await Registry.kinds(rebuilt, "acme")).kinds.filter(
			(kind) => kind.source === "scope",
		),
	).toEqual([{ ...signal, source: "scope" }]);
	expect(unwrap(await Registry.list(rebuilt, "acme"))).toEqual([
		classification,
	]);
	const read = unwrap(await Planner.getTask(rebuilt, thread.id));
	expect(read?.kind).toBe("signal");
	expect(read?.state).toBeUndefined();
	expect(unwrap(await Planner.getCustomAttributes(rebuilt, thread.id))).toEqual(
		{ classification: "noise" },
	);
});
