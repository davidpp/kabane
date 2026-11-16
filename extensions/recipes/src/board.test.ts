// The board's ports over a real tracker and the extension's real run table: the card a run maps to
// in each state, the tab's lines, stop, and the triggers and dispatch of `a`. The runtime is a
// script of what hc would answer, because a test never starts a terminal (AGENTS.md, "Verify");
// the real hc path is the sandbox check.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	defineTool,
	err,
	ok,
	Oplog,
	Planner,
	type ProjectScope,
	type Result,
	registeredTools,
	ScopeUri,
	tryCatch,
	trySync,
	withDb,
} from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import {
	conciseSuccess,
	createHostRecord,
	createHostStore,
	failure,
	flagBool,
	flagCsv,
	flagList,
	flagString,
	type Host,
	Settings,
	success,
	usage,
} from "@cabane/extension";
import { z } from "zod";
import { RecipeActivity } from "./activity";
import { RecipeDispatcher } from "./dispatcher";
import { Kabane } from "./result";
import { settingsSchema } from "./run-command";
import { Runs } from "./runs";
import { reconcile } from "./runs-command";
import type { Runtime } from "./runtime";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

const value = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

let folder = "";
let home = "";
let project: ProjectScope;
let host: Host;

const hostFor = (basePath: string): Host => ({
	api: 1,
	kabane: { version: "test", executable: "/nonexistent/kabane" },
	record: createHostRecord(registeredTools, {
		basePath,
		actor: "tester",
		scopeRequired: false,
	}),
	store: createHostStore(
		() => basePath,
		() => ["recipes_runs"],
		"recipes test",
	),
	scope: { detect: async () => ok(project), idOf: ScopeUri.getScopeId },
	harnessMode: "auto",
	z,
	result: { ok, err, tryCatch, trySync },
	args: { flagBool, flagCsv, flagList, flagString },
	outcome: { success, conciseSuccess, failure, usage },
	settings: {
		fields: Settings.fields,
		groupsOf: Settings.groupsOf,
		lookOf: Settings.lookOf,
		options: Settings.options,
	},
	defineTool,
});

/** What hc would answer, by terminal: its state, its screen, and every start and stop asked. */
const scripted = () => {
	const states = new Map<string, Runs.State>();
	const screens = new Map<string, string>();
	const started: Runtime.Start[] = [];
	const stopped: string[] = [];
	const got: string[] = [];
	const runtime: Runtime = {
		name: "hc",
		missing: () => undefined,
		start: async (start) => {
			started.push(start);
			const name = `${start.title}-${start.run.slice(-6).toLowerCase()}`;
			states.set(name, "running");
			return ok(name);
		},
		get: async (session) => {
			got.push(session);
			return ok(states.get(session) ?? "ended");
		},
		stop: async (session) => {
			stopped.push(session);
			states.set(session, "ended");
			return ok(undefined);
		},
		read: async (session) => {
			const screen = screens.get(session);
			return screen === undefined
				? err(new Error(`hc read failed (exit 3): no terminal ${session}`))
				: ok(screen);
		},
	};
	return { runtime, states, screens, started, stopped, got };
};

let issue: { id: string; shortId: string; title: string };

beforeEach(async () => {
	configureTestRuntime({ modules: [Runs.module()] });
	folder = realpathSync(mkdtempSync(join(tmpdir(), "recipes-board-")));
	home = join(folder, "home");
	const root = join(folder, "project");
	mkdirSync(home);
	mkdirSync(join(root, ".kabane/recipes"), { recursive: true });
	project = {
		root,
		scopeId: "board-test",
		name: "board-test",
		extensions: {},
		scopeUri: ScopeUri.format({ scopeId: "board-test" }),
	};
	value(await Planner.init(home));
	value(value(await withDb(home, (db) => Oplog.initDevice(db, "board"))));
	host = hostFor(home);
	const added = value(
		await Planner.addTask(home, { title: "Look into it", kind: "issue" }),
	);
	issue = {
		id: added.id,
		shortId: added.shortId ?? added.id,
		title: added.title,
	};
});

afterEach(() => {
	configureTestRuntime();
	rmSync(folder, { recursive: true, force: true });
});

const run = (id: string, overrides: Partial<Runs.Run> = {}): Runs.Run => ({
	id,
	recipe: { name: "research", hash: "abc123abc123" },
	target: { kind: "issue", id: issue.id },
	scope: project.scopeUri,
	dir: "",
	machine: hostname(),
	cwd: project.root,
	runtime: "hc",
	session: `research-${id.slice(-6).toLowerCase()}`,
	inputs: { depth: "quick" },
	state: "running",
	startedAt: "2026-11-16T10:00:00.000Z",
	...overrides,
});

const sourceWith = (runtime: Runtime) =>
	RecipeActivity.source({
		host,
		runtime,
		project: async () => ok(project),
		actor: "tester",
	});

describe("RecipeActivity", () => {
	it("maps each run state to the card the board draws, on the run's issue", () => {
		const statuses = (["running", "waiting", "idle", "ended"] as const).map(
			(state) => {
				const card = RecipeActivity.card({
					run: run("01M7JT0TFJB7MF38VYDWCG0001", { state }),
					shortId: issue.shortId,
				});
				return [state, card.status, card.actions?.map((a) => a.id) ?? []];
			},
		);
		expect(statuses).toEqual([
			["running", "running", ["stop"]],
			["waiting", "paused", ["stop"]],
			["idle", "completed", ["stop"]],
			["ended", "completed", []],
		]);
		const card = RecipeActivity.card({
			run: run("01M7JT0TFJB7MF38VYDWCG0001", { state: "waiting" }),
			shortId: issue.shortId,
		});
		expect(card).toMatchObject({
			kind: "runs",
			label: "research",
			taskId: issue.id,
			taskShortId: issue.shortId,
			tab: true,
			hasEvents: true,
			detail: [
				"waiting",
				"depth=quick",
				`on ${hostname()}`,
				"kabane runs attach 01M7JT0TFJB7MF38VYDWCG0001",
			],
		});
	});

	it("offers no stop on a run of another machine or one still starting", () => {
		const other = RecipeActivity.card({
			run: run("01M7JT0TFJB7MF38VYDWCG0001", { machine: "elsewhere" }),
			shortId: issue.shortId,
		});
		const starting = RecipeActivity.card({
			run: run("01M7JT0TFJB7MF38VYDWCG0002", { session: Runs.STARTING }),
			shortId: issue.shortId,
		});
		expect([other.actions, starting.actions]).toEqual([undefined, undefined]);
	});

	it("lists targeted runs only, reconciled against the runtime, keeping ten at most once ended", async () => {
		const hc = scripted();
		const live = run("01M7JT0TFJB7MF38VYDWCG0100", {
			startedAt: "2026-11-16T12:00:00.000Z",
		});
		hc.states.set(live.session, "waiting");
		value(await Runs.insert(host, live, "t"));
		value(
			await Runs.insert(
				host,
				run("01M7JT0TFJB7MF38VYDWCG0101", { target: undefined }),
				"t",
			),
		);
		for (let at = 0; at < 12; at++)
			value(
				await Runs.insert(
					host,
					run(`01M7JT0TFJB7MF38VYDWCG02${String(at).padStart(2, "0")}`, {
						state: "ended",
						startedAt: `2026-11-16T10:${String(at).padStart(2, "0")}:00.000Z`,
					}),
					"t",
				),
			);
		const cards = value(await sourceWith(hc.runtime).load());
		expect(cards).toHaveLength(10);
		expect(cards[0]).toMatchObject({ id: live.id, status: "paused" });
		expect(cards.some((card) => card.id.endsWith("0101"))).toBe(false);
		// The reconcile wrote what hc said.
		const [stored] = value(await Runs.find(host, project.scopeUri, live.id));
		expect(stored?.state).toBe("waiting");
	});

	it("counts an idle run as finished, so idle runs past ten drop off", async () => {
		const hc = scripted();
		const live = run("01M7JT0TFJB7MF38VYDWCG0500", {
			startedAt: "2026-11-16T09:00:00.000Z",
		});
		hc.states.set(live.session, "running");
		value(await Runs.insert(host, live, "t"));
		for (let at = 0; at < 12; at++) {
			const idle = run(
				`01M7JT0TFJB7MF38VYDWCG06${String(at).padStart(2, "0")}`,
				{
					state: "idle",
					startedAt: `2026-11-16T10:${String(at).padStart(2, "0")}:00.000Z`,
				},
			);
			hc.states.set(idle.session, "idle");
			value(await Runs.insert(host, idle, "t"));
		}
		const cards = value(await sourceWith(hc.runtime).load());
		expect(cards).toHaveLength(10);
		expect(cards.some((card) => card.id === live.id)).toBe(true);
		// The newest nine idle runs stay; the three oldest drop off.
		expect(
			cards
				.filter((card) => card.status === "completed")
				.map((card) => card.id.slice(-2)),
		).toEqual(["11", "10", "09", "08", "07", "06", "05", "04", "03"]);
	});

	it("shows the terminal's screen on the tab, then only the lines it gained", async () => {
		const hc = scripted();
		const one = run("01M7JT0TFJB7MF38VYDWCG0300");
		value(await Runs.insert(host, one, "t"));
		hc.states.set(one.session, "running");
		hc.screens.set(one.session, "one\ntwo\n\n\n");
		const source = sourceWith(hc.runtime);
		const first = value((await source.events?.(one.id, 0)) ?? ok([]));
		expect(first.map((e) => [e.seq, e.type, e.summary])).toEqual([
			[1, "output", "one"],
			[2, "output", "two"],
		]);
		expect(value((await source.events?.(one.id, 2)) ?? ok([]))).toEqual([]);
		hc.screens.set(one.session, "two\nthree\nfour\n");
		const scrolled = value((await source.events?.(one.id, 2)) ?? ok([]));
		expect(scrolled.map((e) => [e.seq, e.summary])).toEqual([
			[3, "three"],
			[4, "four"],
		]);
		hc.screens.set(one.session, "redrawn\n");
		const redrawn = value((await source.events?.(one.id, 4)) ?? ok([]));
		expect(redrawn.map((e) => [e.type, e.summary])).toEqual([
			["notice", "the screen was redrawn"],
			["output", "redrawn"],
		]);
	});

	it("says where a run is on another machine, and shows a gone terminal's last state once", async () => {
		const hc = scripted();
		const away = run("01M7JT0TFJB7MF38VYDWCG0400", { machine: "elsewhere" });
		const gone = run("01M7JT0TFJB7MF38VYDWCG0401", { state: "idle" });
		value(await Runs.insert(host, away, "t"));
		value(await Runs.insert(host, gone, "t"));
		hc.states.set(gone.session, "idle");
		const source = sourceWith(hc.runtime);
		const there = value((await source.events?.(away.id, 0)) ?? ok([]));
		expect(there.map((e) => e.summary)).toEqual([
			`run ${away.id} is running on elsewhere: read its terminal there, with kabane runs read ${away.id}`,
		]);
		const last = value((await source.events?.(gone.id, 0)) ?? ok([]));
		expect(last.map((e) => e.summary)).toEqual([
			`run ${gone.id} is idle; its terminal is gone`,
		]);
		expect(value((await source.events?.(gone.id, 1)) ?? ok([]))).toEqual([]);
	});

	it("stops a run from its card through the runtime and reports the state after", async () => {
		const hc = scripted();
		const one = run("01M7JT0TFJB7MF38VYDWCG0500");
		value(await Runs.insert(host, one, "t"));
		hc.states.set(one.session, "running");
		const source = sourceWith(hc.runtime);
		const notice = value(await (source.act?.(one.id, "stop", {}) ?? ok("")));
		expect(notice).toBe(`stopped run ${one.id}; it is ended`);
		expect(hc.stopped).toEqual([one.session]);
		const card = value(await (source.card?.(one.id) ?? ok(null)));
		expect([card?.status, card?.detail[0]]).toEqual(["completed", "ended"]);
		expect(card?.actions).toBeUndefined();
		const again = await (source.act?.(one.id, "stop", {}) ?? ok(""));
		expect(again.ok).toBe(false);
	});
});

describe("reconcile on a run recorded as starting", () => {
	/** The scripted runtime, with a `find` that knows the terminals in `found` by run id. */
	const finding = (found: Map<string, string>) => {
		const hc = scripted();
		return {
			...hc,
			runtime: {
				...hc.runtime,
				find: async (id: string) => ok(found.get(id)),
			} satisfies Runtime,
		};
	};
	const stored = async (id: string) =>
		value(await Runs.list(host, project.scopeUri)).find((r) => r.id === id);

	it("records the session the runtime finds and the state it reads on that session", async () => {
		const live = run("01M7JT0TFJB7MF38VYDWCG0600", {
			session: Runs.STARTING,
		});
		const gone = run("01M7JT0TFJB7MF38VYDWCG0601", {
			session: Runs.STARTING,
		});
		value(await Runs.insert(host, live, "t"));
		value(await Runs.insert(host, gone, "t"));
		const hc = finding(
			new Map([
				[live.id, "research-cg0600"],
				[gone.id, "research-cg0601"],
			]),
		);
		hc.states.set("research-cg0600", "idle");
		hc.states.set("research-cg0601", "ended");
		const now = value(await reconcile(host, hc.runtime, [live, gone], "t"));
		expect(now.map((r) => [r.session, r.state])).toEqual([
			["research-cg0600", "idle"],
			["research-cg0601", "ended"],
		]);
		expect([
			(await stored(live.id))?.session,
			(await stored(live.id))?.state,
			(await stored(gone.id))?.session,
			(await stored(gone.id))?.state,
		]).toEqual(["research-cg0600", "idle", "research-cg0601", "ended"]);
		expect(hc.got).toEqual(["research-cg0600", "research-cg0601"]);
	});

	it("does not report ended a run whose start recorded its session meanwhile", async () => {
		const listed = run("01M7JT0TFJB7MF38VYDWCG0602", {
			session: Runs.STARTING,
		});
		value(await Runs.insert(host, listed, "t"));
		// The start writes its session after the listing read the row, before reconcile ends it.
		value(await Runs.setSession(host, listed.id, "research-cg0602", "t"));
		const hc = finding(new Map());
		const [now] = value(await reconcile(host, hc.runtime, [listed], "t"));
		expect(now?.state).toBe("running");
		expect((await stored(listed.id))?.state).toBe("running");
		expect(hc.got).toEqual([]);
	});

	it("lets the board stop the run on the session it recovered, never on an empty one", async () => {
		const one = run("01M7JT0TFJB7MF38VYDWCG0603", { session: Runs.STARTING });
		value(await Runs.insert(host, one, "t"));
		const hc = finding(new Map([[one.id, "research-cg0603"]]));
		hc.states.set("research-cg0603", "running");
		const source = sourceWith(hc.runtime);
		const notice = value(await (source.act?.(one.id, "stop", {}) ?? ok("")));
		expect(notice).toBe(`stopped run ${one.id}; it is ended`);
		expect(hc.stopped).toEqual(["research-cg0603"]);
		expect(hc.got).not.toContain(Runs.STARTING);
	});
});

const recipe = (name: string, text: string) =>
	writeFileSync(join(project.root, ".kabane/recipes", `${name}.md`), text);

const RESEARCH = `---
description: Research an issue
target: issue
inputs:
  depth:
    options: [quick, medium, thorough]
    default: medium
  rounds:
    type: number
    default: 2
---
Research {{target.shortId}} at {{inputs.depth}} depth in {{inputs.rounds}} rounds.
`;

const dispatcherWith = (runtime: Runtime) =>
	RecipeDispatcher.make({
		host,
		runtime,
		project: async () => ok(project),
		settings: settingsSchema(z),
		ctx: {
			cwd: project.root,
			actor: "tester",
			settings: Settings.port(async () => ok([])),
		},
	});

describe("RecipeDispatcher", () => {
	it("offers each recipe that targets an issue, its inputs one to one, and a broken one unsatisfiable", async () => {
		recipe("research", RESEARCH);
		recipe("tidy", "---\ndescription: No target\n---\nTidy up.\n");
		recipe(
			"ask",
			"---\ntarget: issue\ninputs:\n  focus:\n    required: true\n---\nOn {{inputs.focus}}.\n",
		);
		recipe("broken", "---\ntarget: issue\ninputs: [\n---\nBody.\n");
		// A `:` in the file's name: the trigger is named from the file, not from its error's text.
		recipe("odd:name", "---\ntarget: issue\ninputs: [\n---\nBody.\n");
		const triggers = value(
			await dispatcherWith(scripted().runtime).triggers(issue.id),
		);
		expect(
			triggers.map(({ id, label, satisfiable }) => [id, label, satisfiable]),
		).toEqual([
			["recipe:ask", "ask", false],
			["recipe:research", "research", true],
			["recipe:broken", "broken", false],
			["recipe:odd:name", "odd:name", false],
		]);
		const [ask, research, broken] = triggers;
		expect(research).toMatchObject({
			description: "Research an issue",
			inputs: {
				depth: {
					type: "string",
					options: ["quick", "medium", "thorough"],
					default: "medium",
					required: false,
				},
				rounds: { type: "number", default: 2, required: false },
			},
		});
		expect(ask?.hint).toBe(
			`ask needs focus, which has no default: kabane run ask --target ${issue.shortId} --input focus=…`,
		);
		expect(broken?.hint).toStartWith(
			".kabane/recipes/broken.md: the frontmatter is not YAML",
		);
	});

	it("offers nothing on a human task", async () => {
		recipe("research", RESEARCH);
		const errand = value(
			await Planner.addTask(home, { title: "errand", kind: "task" }),
		);
		expect(
			value(await dispatcherWith(scripted().runtime).triggers(errand.id)),
		).toEqual([]);
	});

	it("starts the run with the form's inputs, records it on the issue and names it in the notice", async () => {
		recipe("research", RESEARCH);
		const hc = scripted();
		const notice = value(
			await dispatcherWith(hc.runtime).dispatch(
				"recipe:research",
				{ ...issue, brief: "" },
				{ depth: "thorough", rounds: 3 },
				["depth", "rounds"],
			),
		);
		const [stored] = value(await Runs.list(host, project.scopeUri));
		expect(stored).toMatchObject({
			recipe: { name: "research" },
			target: { kind: "issue", id: issue.id },
			inputs: { depth: "thorough", rounds: 3 },
			state: "running",
		});
		expect(notice).toBe(
			`started run ${stored?.id} (research on ${issue.shortId}) · kabane runs attach ${stored?.id}`,
		);
		expect(hc.started[0]?.argv.at(-1)).toEndWith(
			`Research ${issue.shortId} at thorough depth in 3 rounds.`,
		);
		expect(hc.started[0]?.argv.slice(0, -1)).toEqual(["claude"]);
	});
});
