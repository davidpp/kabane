/**
 * Migration 4 moves `task_questions` rows onto the record: an ask entry per
 * question and a reply per closed one, read back as the row read, and the
 * same entries on two devices that migrate the same rows apart.
 */

import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Result, withDb } from "@kabane/core";
import { configureTestRuntime } from "@kabane/core/testing";
import { migrations } from "./migrations";
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

const AT = "2026-11-01T10:00:00.000Z";
const LATER = "2026-11-02T10:00:00.000Z";
const AGENT = "kabane://actor/agent/claude";
const HUMAN = "kabane://actor/human/david";

/** A device at questions schema 3 holding three rows, then migrated. */
const migrated = async (taskId: string) => {
	const base = mkdtempSync(join(tmpdir(), "kabane-questions-migrate-"));
	bases.push(base);
	configureTestRuntime({
		modules: [{ ...questionsModule, migrations: migrations.slice(0, 3) }],
		actor: () => AGENT,
	});
	unwrap(await Planner.init(base));
	const task = unwrap(
		await Planner.addTask(
			base,
			{ title: "Decide", kind: "issue", scopeUri: "questions" },
			{ key: taskId },
		),
	);
	const row = (
		id: string,
		status: string,
		rest: Record<string, string | null>,
	) =>
		withDb(base, (db) =>
			db.run(
				`INSERT INTO task_questions (id, task_id, status, asked_by, answered_by, answered_at,
				   created_at, updated_at, updated_by, version, body, why, answer, reasoning)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					task.id,
					status,
					AGENT,
					rest.by ?? null,
					rest.at ?? null,
					AT,
					rest.at ?? AT,
					rest.by ?? AGENT,
					status === "open" ? 1 : 2,
					`Which ${id}?`,
					rest.why ?? null,
					rest.answer ?? null,
					rest.reasoning ?? null,
				],
			),
		);
	unwrap(
		await row("01KQ0000000000000000000001", "open", { why: "it matters" }),
	);
	unwrap(
		await row("01KQ0000000000000000000002", "answered", {
			by: HUMAN,
			at: LATER,
			answer: "This one",
			reasoning: "cheaper",
		}),
	);
	unwrap(
		await row("01KQ0000000000000000000003", "withdrawn", {
			by: AGENT,
			at: LATER,
			reasoning: "issue closed",
		}),
	);
	configureTestRuntime({ modules: [questionsModule], actor: () => AGENT });
	unwrap(await Planner.init(base));
	return { base, taskId: task.id };
};

it("moves each question onto the record and reads it back as the row read", async () => {
	const { base, taskId } = await migrated("migrate/one");
	const rows = unwrap(
		await Questions.list(base, { id: taskId, status: "all" }),
	);
	expect(
		rows.map(
			({
				id,
				status,
				askedBy,
				answeredBy,
				answeredAt,
				updatedAt,
				answer,
				reasoning,
				why,
				version,
				ordinal,
			}) => ({
				id,
				status,
				askedBy,
				answeredBy,
				answeredAt,
				updatedAt,
				answer,
				reasoning,
				why,
				version,
				ordinal,
			}),
		),
	).toEqual([
		{
			id: "01KQ0000000000000000000001",
			status: "open",
			askedBy: AGENT,
			answeredBy: undefined,
			answeredAt: undefined,
			updatedAt: AT,
			answer: undefined,
			reasoning: undefined,
			why: "it matters",
			version: 1,
			ordinal: 1,
		},
		{
			id: "01KQ0000000000000000000002",
			status: "answered",
			askedBy: AGENT,
			answeredBy: HUMAN,
			answeredAt: LATER,
			updatedAt: LATER,
			answer: "This one",
			reasoning: "cheaper",
			why: undefined,
			version: 2,
			ordinal: 2,
		},
		{
			id: "01KQ0000000000000000000003",
			status: "withdrawn",
			askedBy: AGENT,
			answeredBy: AGENT,
			answeredAt: LATER,
			updatedAt: LATER,
			answer: undefined,
			reasoning: "issue closed",
			why: undefined,
			version: 2,
			ordinal: 3,
		},
	]);
	const gone = unwrap(
		await withDb(base, (db) =>
			db
				.query<{ n: number }, []>(
					"SELECT COUNT(*) n FROM sqlite_master WHERE name = 'task_questions'",
				)
				.get(),
		),
	);
	expect(gone?.n).toBe(0);
});

it("two devices migrating the same rows write the same entries", async () => {
	const entries = async (base: string) =>
		unwrap(
			await withDb(base, (db) =>
				db
					.query<Record<string, unknown>, []>(
						"SELECT id, thread_id, kind, author, body, re, data, created_at, updated_by FROM entries WHERE kind LIKE 'questions.%' ORDER BY id",
					)
					.all(),
			),
		);
	const one = await migrated("migrate/same");
	const two = await migrated("migrate/same");
	expect(await entries(one.base)).toEqual(await entries(two.base));
	expect(await entries(one.base)).toHaveLength(5);
});
