import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LocalRelay,
	Runtime,
	Oplog,
	Planner,
	type Result,
	Sync,
	withDb,
} from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { SqliteDb } from "@cabane/sqlite";
import { questionsModule } from "./module";
import { Questions } from "./storage";

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
const register = (enabled: boolean, actor = "test") =>
	unwrap(
		Runtime.configure({
			provider: SqliteDb.provider(),
			modules: enabled ? [questionsModule] : [],
			actor: () => `cabane://actor/human/${actor}`,
		}),
	);
const device = async (name: string, enabled: boolean) => {
	const base = mkdtempSync(join(tmpdir(), `questions-${name}-`));
	bases.push(base);
	register(enabled, name);
	unwrap(await Planner.init(base));
	unwrap(unwrap(await withDb(base, (db) => Oplog.initDevice(db, name))));
	return base;
};

it("parks real question rows on a device without the module and replays on registration", async () => {
	const relay = LocalRelay.create();
	const alpha = await device("alpha", true);
	const a = LocalRelay.transportFor(relay, "alpha");
	const task = unwrap(
		await Planner.addTask(alpha, { title: "Park decisions", kind: "issue" }),
	);
	const questions = unwrap(
		await Questions.ask(alpha, {
			id: task.id,
			questions: [{ question: "Which?" }],
		}),
	);
	const question = questions[0];
	if (!question) throw new Error("No question");
	unwrap(
		await Questions.answer(alpha, { question: question.id, answer: "This" }),
	);
	unwrap(await Sync.push(alpha, a));
	const beta = await device("beta", false);
	const b = LocalRelay.transportFor(relay, "beta");
	expect(unwrap(await Sync.pull(beta, b)).parked).toBe(2);
	expect(unwrap(await Sync.status(beta)).parkedOps).toEqual({ questions: 2 });
	expect(unwrap(await Planner.getTask(beta, task.id))?.title).toBe(task.title);
	register(true, "beta");
	unwrap(await Planner.init(beta));
	expect(unwrap(await Sync.pull(beta, b)).replayed).toBe(2);
	expect(unwrap(await Questions.list(beta, { id: task.id }))[0]).toMatchObject({
		answer: "This",
		version: 2,
	});
	expect(unwrap(await Sync.status(beta)).parkedOps).toEqual({});
});

it("converges concurrent re-answers on two real SQLite devices", async () => {
	const relay = LocalRelay.create();
	const alpha = await device("alpha", true);
	const a = LocalRelay.transportFor(relay, "alpha");
	const task = unwrap(
		await Planner.addTask(alpha, {
			title: "Concurrent decisions",
			kind: "issue",
		}),
	);
	const question = unwrap(
		await Questions.ask(alpha, {
			id: task.id,
			questions: [{ question: "Which?" }],
		}),
	)[0];
	if (!question) throw new Error("No question");
	unwrap(
		await Questions.answer(alpha, {
			question: question.id,
			answer: "Original",
		}),
	);
	unwrap(await Sync.push(alpha, a));
	const beta = await device("beta", true);
	const b = LocalRelay.transportFor(relay, "beta");
	unwrap(await Sync.pull(beta, b));
	unwrap(
		await Questions.answer(beta, { question: question.id, answer: "Beta" }),
	);
	register(true, "alpha");
	unwrap(
		await Questions.answer(alpha, { question: question.id, answer: "Alpha" }),
	);
	unwrap(await Sync.push(alpha, a));
	register(true, "beta");
	unwrap(await Sync.push(beta, b));
	unwrap(await Sync.pull(beta, b));
	const betaRows = unwrap(await Questions.list(beta, { id: task.id }));
	register(true, "alpha");
	unwrap(await Sync.pull(alpha, a));
	expect(unwrap(await Questions.list(alpha, { id: task.id }))).toEqual(
		betaRows,
	);
	expect(betaRows[0]?.version).toBe(3);
	expect(["Alpha", "Beta"]).toContain(betaRows[0]?.answer ?? "");
});
