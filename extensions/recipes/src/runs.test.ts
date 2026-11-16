// The run store over a real database: core's runtime with the extension's own module registered,
// and the host's storage kit that `host.store` is in the CLI.
import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	err,
	ok,
	Oplog,
	Planner,
	type Result,
	tryCatch,
	trySync,
	withDb,
} from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { createHostStore } from "@cabane/extension";
import { z } from "zod";
import { Kabane } from "./result";
import { Runs } from "./runs";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

const value = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const SCOPE = "kabane://scope/runs-test";

let home: string;
let host: Parameters<typeof Runs.list>[0];

beforeEach(async () => {
	configureTestRuntime({ modules: [Runs.module()] });
	home = mkdtempSync(join(tmpdir(), "recipes-runs-"));
	value(await Planner.init(home));
	value(value(await withDb(home, (db) => Oplog.initDevice(db, "runs"))));
	host = {
		store: createHostStore(
			() => home,
			() => ["recipes_runs"],
			"recipes test",
		),
		z,
	};
});

afterEach(() => {
	configureTestRuntime();
	rmSync(home, { recursive: true, force: true });
});

const run = (id: string, overrides: Partial<Runs.Run> = {}): Runs.Run => ({
	id,
	recipe: { name: "research", hash: "abc123abc123" },
	scope: SCOPE,
	dir: "",
	machine: "here",
	cwd: "/repo",
	runtime: "hc",
	session: `research-${id.slice(-6).toLowerCase()}`,
	inputs: { depth: "quick" },
	state: "running",
	startedAt: "2026-11-16T10:00:00.000Z",
	...overrides,
});

const oplog = () =>
	withDb(home, (db) =>
		db
			.query<{ tbl: string; op: string; row_id: string }, []>(
				"SELECT tbl, op, row_id FROM sync_oplog WHERE tbl = 'recipes_runs' ORDER BY seq",
			)
			.all(),
	);

it("stores a run, captures each write, stamps ended_at on ended and clears it after", async () => {
	const first = run("01M7JT0TFJB7MF38VYDWCG8PKX", {
		target: { kind: "issue", id: "TASK1" },
	});
	value(await Runs.insert(host, first, "tester"));
	expect(value(await Runs.list(host, SCOPE))).toEqual([first]);

	value(await Runs.setState(host, first.id, "ended", "tester"));
	const [ended] = value(await Runs.list(host, SCOPE));
	expect(ended?.state).toBe("ended");
	expect(Date.parse(ended?.endedAt ?? "")).not.toBeNaN();

	value(await Runs.setState(host, first.id, "idle", "tester"));
	const [idle] = value(await Runs.list(host, SCOPE));
	expect(idle).toEqual({ ...first, state: "idle" });

	expect(value(await oplog()).map(({ op, row_id }) => [op, row_id])).toEqual([
		["insert", first.id],
		["update", first.id],
		["update", first.id],
	]);
});

it("lists a scope's runs newest first, and no other scope's", async () => {
	value(await Runs.insert(host, run("01M7JT0TFJB7MF38VYDWCG0001"), "t"));
	value(
		await Runs.insert(
			host,
			run("01M7JT0TFJB7MF38VYDWCG0002", {
				startedAt: "2026-11-16T11:00:00.000Z",
			}),
			"t",
		),
	);
	value(
		await Runs.insert(
			host,
			run("01M7JT0TFJB7MF38VYDWCG0003", { scope: "kabane://scope/other" }),
			"t",
		),
	);
	expect(value(await Runs.list(host, SCOPE)).map((r) => r.id)).toEqual([
		"01M7JT0TFJB7MF38VYDWCG0002",
		"01M7JT0TFJB7MF38VYDWCG0001",
	]);
});

it("finds a run by its id or a case-insensitive suffix, and returns every run an ambiguous suffix names", async () => {
	value(await Runs.insert(host, run("01M7JT0TFJB7MF38VYDWCGAPKX"), "t"));
	value(await Runs.insert(host, run("01M7JT0TFJB7MF38VYDWCGBPKX"), "t"));
	const ids = async (key: string) =>
		value(await Runs.find(host, SCOPE, key)).map((r) => r.id);
	expect(await ids("01M7JT0TFJB7MF38VYDWCGAPKX")).toEqual([
		"01M7JT0TFJB7MF38VYDWCGAPKX",
	]);
	expect(await ids("apkx")).toEqual(["01M7JT0TFJB7MF38VYDWCGAPKX"]);
	expect((await ids("pkx")).sort()).toEqual([
		"01M7JT0TFJB7MF38VYDWCGAPKX",
		"01M7JT0TFJB7MF38VYDWCGBPKX",
	]);
	// LIKE's wildcards are taken out of the key, never matched as patterns.
	expect(await ids("_PKX")).toHaveLength(2);
	expect(await ids("zzz")).toEqual([]);
});

it("refuses a row it cannot read, as one from another device's ops might be", async () => {
	value(await Runs.insert(host, run("01M7JT0TFJB7MF38VYDWCG0001"), "t"));
	value(
		await withDb(home, (db) =>
			db.run("UPDATE recipes_runs SET state = 'succeeded'"),
		),
	);
	const listed = await Runs.list(host, SCOPE);
	expect(listed.ok).toBe(false);
	if (!listed.ok) expect(listed.error.message).toContain("recipes_runs");

	value(
		await withDb(home, (db) =>
			db.run("UPDATE recipes_runs SET state = 'running', inputs = '[1]'"),
		),
	);
	const inputs = await Runs.find(host, SCOPE, "0001");
	expect(inputs.ok).toBe(false);
	if (!inputs.ok) expect(inputs.error.message).toContain("not a JSON object");

	value(
		await withDb(home, (db) =>
			db.run("UPDATE recipes_runs SET inputs = '{}', target_id = 'TASK1'"),
		),
	);
	const half = await Runs.find(host, SCOPE, "0001");
	expect(half.ok).toBe(false);
	if (!half.ok) expect(half.error.message).toContain("without the other");
});
