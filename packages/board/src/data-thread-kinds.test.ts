// A thread of any kind reads on the board (ADR 0010): one with no work state has a section of its
// own, and its detail names the kind by the label its exact scope or a module declares, with its
// declared attributes by their choices' labels. Without the declarations (the module gone, the
// registry not registered) the same stored thread still reads, by its stored names and values.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checklistModule } from "@kabane/checklist";
import {
	type KabaneModule,
	Planner,
	type Result,
	Runtime,
	ScopeUri,
	withDb,
} from "@kabane/core";
import { handoffModule } from "@kabane/handoff";
import { questionsModule } from "@kabane/questions";
import { Registry, registryModule } from "@kabane/registry";
import { SqliteDb } from "@kabane/sqlite";
import { BoardData } from "./data";
import { DetailModel } from "./detail-model";
import { dropDb, freshDb } from "./test-db";

const BASE = join(tmpdir(), `kabane-board-kinds-${crypto.randomUUID()}`);
const SCOPE = ScopeUri.fromScopeId("github.com/acme/monitor");

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const monitor: KabaneModule = {
	name: "monitor",
	threadKinds: [{ name: "alert", label: "Alert" }],
};

// The modules every other board test registers (test-db.ts), and the two that declare.
const SHARED = [questionsModule, handoffModule, checklistModule];
const configure = (modules: KabaneModule[]): void => {
	unwrap(
		Runtime.configure({
			provider: SqliteDb.provider(),
			modules: [...SHARED, ...modules],
		}),
	);
};

let signal = "";
let alert = "";

beforeAll(async () => {
	configure([registryModule, monitor]);
	await freshDb(BASE);
	unwrap(
		await Registry.publish(BASE, SCOPE, {
			name: "signal",
			label: "Monitor signal",
		}),
	);
	unwrap(
		await Registry.publish(BASE, SCOPE, {
			key: "finding_type",
			description: "What sort of signal it is",
			choices: [{ value: "sql_injection", label: "SQL injection" }],
		}),
	);
	signal = unwrap(
		await Planner.addTask(BASE, {
			title: "Login form takes raw SQL",
			kind: "signal",
			scopeUri: SCOPE,
			description: "Seen on /login.",
		}),
	).id;
	unwrap(await Registry.set(BASE, signal, "finding_type", "sql_injection"));
	unwrap(
		await Planner.addComment(BASE, {
			taskId: signal,
			author: "kabane://actor/agent/monitor",
			authorType: "ai",
			content: "Reproduced twice.",
		}),
	);
	unwrap(
		await Planner.addContextRef(BASE, {
			taskId: signal,
			kind: "log",
			uri: "url:https://logs.example/login",
			label: "request log",
		}),
	);
	alert = unwrap(
		await Planner.addTask(BASE, { title: "Disk full", kind: "alert" }),
	).id;
});

afterAll(() => {
	dropDb(BASE);
	configure([]);
});

it("lists a thread with no state in the Threads section, and in no state's", async () => {
	const sections = unwrap(await BoardData.loadBoard(BASE));
	const threads = sections.find((s) => s.state === BoardData.STATELESS);
	expect(threads?.label).toBe("Threads");
	expect(threads?.rows.map((row) => row.task.id).sort()).toEqual(
		[signal, alert].sort(),
	);
	expect(sections.map((s) => s.state)).toEqual([BoardData.STATELESS]);
});

it("keeps a held stateless thread the section caps left out", async () => {
	const sections = unwrap(
		await BoardData.loadBoard(BASE, { kind: "issue", held: signal }),
	);
	expect(sections).toHaveLength(0);
	const held = unwrap(
		await BoardData.loadBoard(BASE, { kind: "signal", held: signal }),
	);
	expect(held[0]?.rows.map((row) => row.task.id)).toEqual([signal]);
});

it("names the kind and the attributes by the labels their declarations give", async () => {
	const detail = unwrap(await BoardData.taskDetail(BASE, signal));
	expect(detail.kindLabel).toBe("Monitor signal");
	expect(DetailModel.summary(detail.task, detail.kindLabel)).toEqual([
		{ text: "monitor signal", request: false },
	]);
	expect(DetailModel.attributes(detail)).toEqual([
		{ key: "finding_type", name: "finding type", value: "SQL injection" },
	]);
	expect(unwrap(await BoardData.taskDetail(BASE, alert)).kindLabel).toBe(
		"Alert",
	);
});

it("reads the same threads by their stored names without the module or the registry", async () => {
	configure([]);
	try {
		const detail = unwrap(await BoardData.taskDetail(BASE, signal));
		expect(detail.kindLabel).toBe("signal");
		expect(DetailModel.attributes(detail)).toEqual([
			{ key: "finding_type", name: "finding type", value: "sql_injection" },
		]);
		expect(detail.task.description).toBe("Seen on /login.");
		expect(detail.entries.map((entry) => entry.content)).toEqual([
			"Reproduced twice.",
		]);
		expect(detail.contextRefs.map((ref) => ref.uri)).toEqual([
			"url:https://logs.example/login",
		]);
		expect(unwrap(await BoardData.taskDetail(BASE, alert)).kindLabel).toBe(
			"alert",
		);
	} finally {
		configure([registryModule, monitor]);
	}
});

// Last: it leaves a row behind in the shared scope that no later test should see.
it("opens a thread's detail when its scope holds a declaration this build cannot read", async () => {
	unwrap(
		await withDb(BASE, (db) => {
			db.run(
				"INSERT INTO registry_thread_kinds (id, scope, document, publication, updated_by) VALUES (?, ?, ?, '01', 'x')",
				[
					JSON.stringify([SCOPE, "pager"]),
					SCOPE,
					'{"name":"pager","label":"Pager","icon":"!"}',
				],
			);
			db.run(
				"INSERT INTO registry_declarations (id, scope, document, publication, updated_by) VALUES (?, ?, ?, '01', 'x')",
				[
					JSON.stringify([SCOPE, "urgency"]),
					SCOPE,
					'{"key":"urgency","description":"How soon","choices":[],"colour":"red"}',
				],
			);
		}),
	);
	const detail = unwrap(await BoardData.taskDetail(BASE, signal));
	expect(detail.kindLabel).toBe("Monitor signal");
	expect(detail.task.description).toBe("Seen on /login.");
	expect(DetailModel.attributes(detail)).toEqual([
		{ key: "finding_type", name: "finding type", value: "SQL injection" },
	]);
});
