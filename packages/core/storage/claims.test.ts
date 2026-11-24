/**
 * A claim is entries (ADR 0006): setting a thread in progress writes a
 * `claim` for the writer, putting it back a `release` in each claimant's
 * name, and the holder is the earliest claim that stands. And an entry
 * addressed to someone waits on them until a reply its kind declares closes it.
 */

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KabaneModule } from "../module";
import type { Result } from "../result";
import { atomic, withDb } from "../runtime";
import { configureTestRuntime } from "../testing";
import { Planner } from "./index";

const A = "kabane://actor/agent/claude";
const B = "kabane://actor/agent/codex";
const HUMAN = "kabane://actor/human/david";
let who = A;
let base: string;
const must = <T>(r: Result<T>): T => {
	if (!r.ok) throw r.error;
	return r.value;
};

const asks: KabaneModule = {
	name: "asks",
	kinds: [
		{
			name: "asks.ask",
			title: "Ask",
			template: "",
			projection: "none",
			closedBy: ["asks.answer"],
		},
	],
};

beforeEach(async () => {
	configureTestRuntime({ actor: () => who, modules: [asks] });
	base = mkdtempSync(join(tmpdir(), "kabane-claims-"));
	must(await Planner.init(base));
});
afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});

const as = async <T>(actor: string, fn: () => Promise<T>): Promise<T> => {
	who = actor;
	return fn();
};
const thread = async () =>
	must(
		await Planner.addTask(base, {
			title: "Claim me",
			kind: "issue",
			state: "next",
		}),
	).id;
const claim = (actor: string, id: string, assignee: string) =>
	as(actor, () =>
		Planner.updateTask(base, id, { state: "in_progress", assignee }),
	);
const holder = async (id: string) => must(await Planner.claimHolder(base, id));

it("the first claim holds; a second claimant learns it lost", async () => {
	const id = await thread();
	must(await claim(A, id, "claude"));
	must(await claim(B, id, "codex"));
	expect(await holder(id)).toBe(A);
});

it("a claim lasts through waiting, and an answer that puts the thread back releases it", async () => {
	const id = await thread();
	must(await claim(A, id, "claude"));
	must(await as(A, () => Planner.updateTask(base, id, { state: "waiting" })));
	expect(await holder(id)).toBe(A);
	must(await as(HUMAN, () => Planner.updateTask(base, id, { state: "next" })));
	expect(await holder(id)).toBeNull();
	must(await claim(B, id, "codex"));
	expect(await holder(id)).toBe(B);
});

it("someone else putting the thread back releases the claim in its claimant's name", async () => {
	const id = await thread();
	must(await claim(A, id, "claude"));
	must(await as(HUMAN, () => Planner.updateTask(base, id, { state: "next" })));
	must(await claim(B, id, "codex"));
	expect(await holder(id)).toBe(B);
	const entries = must(await Planner.getEntries(base, id));
	expect(entries.map((e) => e.kind)).not.toContain("claim");
});

it("no claim without an assignee, and a comment cannot forge one", async () => {
	const id = await thread();
	must(
		await as(A, () => Planner.updateTask(base, id, { state: "in_progress" })),
	);
	expect(await holder(id)).toBeNull();
	const forged = await Planner.addEntry(base, {
		taskId: id,
		kind: "claim",
		author: B,
		authorType: "ai",
		content: "mine",
	});
	expect(forged.ok).toBe(false);
});

it("an addressed entry waits until a reply of a closing kind", async () => {
	const id = await thread();
	const ask = must(
		await atomic(base, (db) =>
			Planner.addEntryIn(db, {
				taskId: id,
				kind: "asks.ask",
				author: A,
				body: "Which?",
				to: [HUMAN],
			}),
		),
	);
	const open = async () =>
		must(await Planner.addressed(base, HUMAN)).map((e) => e.id);
	expect(await open()).toEqual([ask]);
	expect(must(await Planner.addressed(base, B))).toEqual([]);
	const reply = (kind: string) =>
		atomic(base, (db) =>
			Planner.addEntryIn(db, {
				taskId: id,
				kind,
				author: HUMAN,
				body: "?",
				re: ask,
			}),
		);
	must(await reply("asks.clarify"));
	expect(await open()).toEqual([ask]);
	must(await reply("asks.answer"));
	expect(await open()).toEqual([]);
});

it("a reclaim holds after a release stamped ahead of this device's clock", async () => {
	const id = await thread();
	must(await claim(A, id, "claude"));
	// The claim came from a device whose clock runs three seconds ahead.
	const ahead = new Date(Date.now() + 3000).toISOString();
	must(
		await withDb(base, (db) =>
			db.run("UPDATE entries SET created_at = ? WHERE kind = 'claim'", [ahead]),
		),
	);
	must(await as(A, () => Planner.updateTask(base, id, { state: "next" })));
	must(await claim(A, id, "claude"));
	expect(await holder(id)).toBe(A);
});
