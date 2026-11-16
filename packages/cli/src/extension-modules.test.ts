/**
 * An extension's data modules through the real CLI: a real extension directory under a temp
 * `KABANE_HOME`, the real loader and `run`, two devices converging over `LocalRelay`.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LocalRelay,
	Oplog,
	Planner,
	type Relay,
	type Result,
	Sync,
	withDb,
} from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { parseArgs } from "@cabane/extension";
import { configPath } from "./config";
import { openContext } from "./context";
import { NotesExtension } from "./extension-fixture";
import { activateHostRecord } from "./host";
import { run } from "./main";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const homes: string[] = [];
afterEach(() => {
	activateHostRecord("");
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});
afterAll(() => configureTestRuntime());

const configure = (home: string, deviceId: string, extensions: string[]) =>
	writeFileSync(
		configPath(home),
		JSON.stringify({
			actor: `cabane://actor/human/${deviceId}`,
			deviceId,
			extensions,
		}),
	);

/** A device with the notes extension installed, enabled or not. */
const device = (deviceId: string, enabled: boolean, relay?: Relay) => {
	const home = mkdtempSync(join(tmpdir(), `kabane-modules-${deviceId}-`));
	homes.push(home);
	NotesExtension.install(home);
	configure(home, deviceId, enabled ? [NotesExtension.NAME] : []);
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	const transport = relay && LocalRelay.transportFor(relay, deviceId);
	/** What a process that opens this device's database does first; leaves it registered. */
	const open = async () => unwrap(await openContext(home, home, parseArgs([])));
	return {
		home,
		enable: (on: boolean) =>
			configure(home, deviceId, on ? [NotesExtension.NAME] : []),
		open,
		kabane: (argv: string[]) => run(argv, env, home),
		arm: async () => {
			await open();
			unwrap(
				unwrap(await withDb(home, (db) => Oplog.initDevice(db, deviceId))),
			);
		},
		push: async () => {
			await open();
			if (!transport) throw new Error("no relay");
			return unwrap(await Sync.push(home, transport));
		},
		pull: async () => {
			await open();
			if (!transport) throw new Error("no relay");
			return unwrap(await Sync.pull(home, transport));
		},
		notes: async () => {
			await open();
			return unwrap(
				await withDb(home, (db) =>
					db
						.query<{ id: string; body: string; version: number }, []>(
							`SELECT id, body, version FROM ${NotesExtension.TABLE_NAME} ORDER BY id`,
						)
						.all(),
				),
			);
		},
	};
};

it("writes a row through host.store, converges it, parks it on a device with the extension disabled and replays it once enabled", async () => {
	const relay = LocalRelay.create();
	const alpha = device("alpha", true, relay);
	const beta = device("beta", false, relay);
	await alpha.arm();
	await beta.arm();
	await alpha.open();
	const task = unwrap(
		await Planner.addTask(alpha.home, { title: "Noted", kind: "issue" }),
	);

	const added = await alpha.kabane(["notes", "add", task.id, "first", "note"]);
	expect(added.exitCode).toBe(0);
	expect(added.json).toMatchObject({ sameHost: true });
	expect((await alpha.kabane(["notes", "list", task.id])).text).toBe(
		"first note",
	);
	await alpha.push();

	const parked = await beta.pull();
	expect(parked.parked).toBe(1);
	await beta.open();
	expect(unwrap(await Sync.status(beta.home)).parkedOps).toEqual({ notes: 1 });
	expect(unwrap(await Planner.getTask(beta.home, task.id))?.title).toBe(
		"Noted",
	);

	beta.enable(true);
	const replayed = await beta.pull();
	expect(replayed.replayed).toBe(1);
	expect(await beta.notes()).toEqual(await alpha.notes());
	expect((await beta.kabane(["notes", "list", task.id])).text).toBe(
		"first note",
	);
	expect(unwrap(await Sync.status(beta.home)).parkedOps).toEqual({});

	// Alpha disables the extension: its rows stay, and a task delete still captures their deletes.
	alpha.enable(false);
	await alpha.open();
	expect(await alpha.notes()).toHaveLength(1);
	unwrap(await Planner.deleteTask(alpha.home, task.id));
	await alpha.push();
	expect((await beta.pull()).parked).toBe(0);
	expect(await beta.notes()).toEqual([]);
});

const stops = [
	{
		why: "a modules factory that throws",
		install: (home: string) =>
			NotesExtension.install(home, {
				modules: 'export default () => { throw new Error("modules broke"); };',
			}),
		reason: "the modules factory failed: modules broke",
	},
	{
		why: "a modules entry that cannot be imported",
		install: (home: string) =>
			NotesExtension.install(home, {
				modules: 'throw new Error("import broke");',
			}),
		reason: "the modules entry could not be imported: import broke",
	},
	{
		why: "an unsupported api on a manifest that names modules",
		install: (home: string) => NotesExtension.install(home, { api: 2 }),
		reason: "requires API 2; this kabane supports API 1",
		// Its main entry is refused too, so `notes` is no command.
		refused: true,
	},
	{
		why: "a module set Runtime.configure refuses",
		install: (home: string) =>
			NotesExtension.install(home, {
				modules:
					'export default () => [{ name: "notes", syncTables: [{ table: "tasks", family: "row-lww", clock: "updated_at", childOfTasks: false }] }];',
			}),
		reason:
			'its data modules were refused: Runtime.configure: module "notes" table "tasks"',
	},
];

for (const stop of stops) {
	it(`stops every command that opens the database on ${stop.why}, and config still runs`, async () => {
		const home = mkdtempSync(join(tmpdir(), "kabane-modules-stop-"));
		homes.push(home);
		stop.install(home);
		configure(home, "stop", [NotesExtension.NAME]);
		const kabane = (argv: string[]) =>
			run(argv, { KABANE_HOME: home, KABANE_HARNESSES: "" }, home);

		const commands = [["list"], ["mcp"], ["board"]];
		if (!("refused" in stop)) commands.push(["notes", "list", "x"]);
		for (const argv of commands) {
			const stopped = await kabane(argv);
			expect(stopped.exitCode).toBe(1);
			expect(stopped.text).toStartWith("Error: Extension notes: ");
			expect(stopped.text).toContain(stop.reason);
			expect(stopped.text).toContain(
				`, or remove it from "extensions" in ${configPath(home)} by hand or with \`kabane config set extensions "" --layer global\`; kabane opens the database only with every enabled extension's data modules registered`,
			);
			expect(stopped.text.match(/repair/g)?.length ?? 0).toBeLessThanOrEqual(1);
			expect(stopped.text).not.toContain("\n");
		}

		const doctor = await kabane(["doctor"]);
		expect(doctor.exitCode).toBe(0);
		expect(doctor.text).toContain(
			"kabane/extension-modules: Extension notes: ",
		);
		expect(doctor.text).not.toContain("store-unavailable");

		const cleared = await kabane([
			"config",
			"set",
			"extensions",
			"",
			"--layer",
			"global",
		]);
		expect(cleared.exitCode).toBe(0);
		expect((await kabane(["list"])).exitCode).toBe(0);
	});
}

it("stops on an installed extension whose manifest cannot be read, and treats an enabled name with no directory as disabled", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-modules-manifest-"));
	homes.push(home);
	const dir = NotesExtension.install(home);
	configure(home, "manifest", [NotesExtension.NAME, "absent"]);
	const kabane = (argv: string[]) =>
		run(argv, { KABANE_HOME: home, KABANE_HARNESSES: "" }, home);
	expect((await kabane(["add", "Kept", "--scope", "manifest"])).exitCode).toBe(
		0,
	);

	// A trailing comma: the manifest cannot prove the extension has no modules.
	const manifest = join(dir, "package.json");
	writeFileSync(
		manifest,
		'{ "kabane": { "extension": "./index.ts", "api": 1, } }',
	);
	for (const argv of [["list"], ["done", "JMAN-1"]]) {
		const stopped = await kabane(argv);
		expect(stopped.exitCode).toBe(1);
		expect(stopped.text).toStartWith(
			`Error: Extension notes: ${manifest} contains invalid JSON; correct its JSON, or remove it from "extensions"`,
		);
		expect(stopped.text).toContain(
			"`kabane config set extensions absent --layer global`",
		);
	}

	// The enabled name "absent" has no directory: no stop, and commands that load extensions refuse it.
	const cleared = await kabane([
		"config",
		"set",
		"extensions",
		"absent",
		"--layer",
		"global",
	]);
	expect(cleared.exitCode).toBe(0);
	const listed = await kabane(["list", "--scope", "manifest"]);
	expect(listed.exitCode).toBe(0);
	expect(listed.text).toContain("Kept");
	expect((await kabane(["--help"])).exitCode).toBe(0);
});

it("names the other enabled extensions in the way out", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-modules-rest-"));
	homes.push(home);
	NotesExtension.install(home, {
		modules: 'export default () => { throw new Error("modules broke"); };',
	});
	configure(home, "rest", ["loop", NotesExtension.NAME]);
	const stopped = await run(
		["list"],
		{ KABANE_HOME: home, KABANE_HARNESSES: "" },
		home,
	);
	expect(stopped.text).toContain(
		"`kabane config set extensions loop --layer global`",
	);
});
