import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
/** Disposable seeding process: never configure the parent test's shared Runtime. */
import { basename, join } from "node:path";
import { Planner, Runtime, err, ok, type Result } from "@cabane/core";
import { SqliteDb } from "@cabane/sqlite";
import { z } from "zod";
import issues from "../core/testing/fixtures/issue-corpus/issues.json";

export const corpusSchema = z.array(
	z.object({
		number: z.number().int(),
		url: z.string().url(),
		actor: z.string(),
		sourceTextSha256: z.string(),
		contentSha256: z.string(),
		title: z.string(),
		body: z.string(),
		comments: z.array(z.string()),
	}),
);
export const FIXTURE_TIME = "2025-01-01T00:00:00.000Z";
export const HUGE_BODY = "Synthetic body 🐛 café 漢字\n".repeat(12000);
export const HUGE_COMMENT =
	"Synthetic steering 🧭 — preserve every byte\n".repeat(8000);

const seedHistory = async (
	root: string,
	home: string,
	parent: string,
): Promise<Result<void>> => {
	writeFileSync(
		join(root, "reference.txt"),
		"Synthetic reference 🧪\n".repeat(10000),
	);
	for (const uri of [
		`file:${join(root, "reference.txt")}`,
		`file:${join(root, "missing.txt")}`,
	]) {
		const ref = await Planner.addContextRef(home, {
			taskId: parent,
			uri,
			kind: "spec",
			note: "Synthetic ref note ".repeat(2000),
		});
		if (!ref.ok) return ref;
	}
	const log = await Planner.addWorkLog(home, {
		taskId: parent,
		refs: [{ uri: "commit:synthetic", label: "synthetic history" }],
		note: "Synthetic prior work",
	});
	if (!log.ok) return log;
	const session = await Planner.startSession(home, {
		taskId: parent,
		agent: "synthetic-agent",
	});
	if (!session.ok) return session;
	for (let i = 0; i < 30; i++) {
		const activity = await Planner.addActivity(home, {
			sessionId: session.value.id,
			type: i % 5 === 0 ? "decision" : "progress",
			body: `Synthetic machine history ${i}`,
		});
		if (!activity.ok) return activity;
		const update = await Planner.updateTask(home, parent, {
			state: i % 2 === 0 ? "next" : "waiting",
		});
		if (!update.ok) return update;
	}
	return ok(undefined);
};

const syntheticDrafts = () =>
	Array.from({ length: 107 }, (_, index) => ({
		title:
			index === 0
				? "Synthetic oversize 🧭 " + "長".repeat(470)
				: `Synthetic child ${index.toString().padStart(3, "0")} 🐛`,
		body: index === 0 ? HUGE_BODY : `Synthetic generated task ${index}`,
		comments:
			index === 0
				? ["SYNTHETIC_EARLY_STEERING", HUGE_COMMENT, "SYNTHETIC_LATE_STEERING"]
				: [],
		actor: "synthetic-human",
	}));

const seedTasks = async (
	home: string,
	drafts: ReturnType<typeof syntheticDrafts>,
	synthetic: boolean,
): Promise<Result<string[]>> => {
	const ids: string[] = [];
	for (const [index, draft] of drafts.entries()) {
		const task = await Planner.addTask(home, {
			title: draft.title,
			description: draft.body,
			kind: "issue",
			state: index % 3 === 0 ? "waiting" : "next",
			priority: index % 2 === 0 ? "high" : "normal",
			scopeUri:
				index === drafts.length - 1 && synthetic
					? undefined
					: "jake://scope/corpus",
			assignee:
				synthetic && index === 24
					? "synthetic-" + "a".repeat(2000)
					: `fixture-agent-${index % 3}`,
			tags: [index < 24 ? "public-corpus" : "synthetic"],
			provenance: {
				source: "other",
				discoveredAt: FIXTURE_TIME,
				discoveredBy: "fixture-seeder",
			},
			parentTaskId: index > 24 && synthetic ? ids[24] : undefined,
		});
		if (!task.ok) return task;
		ids.push(task.value.id);
		for (const content of draft.comments) {
			const comment = await Planner.addComment(home, {
				taskId: task.value.id,
				author: index < 24 ? "source-comment-author-unknown" : draft.actor,
				authorType: "human",
				content,
			});
			if (!comment.ok) return comment;
		}
	}
	return ok(ids);
};

const seed = async (): Promise<Result<string[]>> => {
	const root = process.argv[2];
	const prefix = process.argv[3] === "prefixed" ? "fixture_" : "";
	const synthetic = process.argv[4] === "synthetic";
	if (
		!root ||
		!root.startsWith(join(tmpdir(), "kabane-corpus-")) ||
		!basename(root).startsWith("kabane-corpus-")
	)
		return err(
			new Error("Seeder requires its disposable kabane-corpus temp root"),
		);
	const parsed = corpusSchema.safeParse(issues);
	if (!parsed.success) return err(parsed.error);
	const home = join(root, "tracker");
	const provider = SqliteDb.provider();
	Runtime.configure({
		provider,
		tablePrefix: prefix,
		actor: () => "cabane://actor/human/fixture",
		timezone: () => "UTC",
	});
	const initialized = await Planner.init(home);
	if (!initialized.ok) return initialized;
	const drafts = parsed.data.map((issue) => ({
		title: issue.title,
		body: issue.body,
		comments: issue.comments,
		actor: issue.actor,
	}));
	if (synthetic) drafts.push(...syntheticDrafts());
	const tasks = await seedTasks(home, drafts, synthetic);
	if (!tasks.ok) return tasks;
	const ids = tasks.value;
	const parent = ids[24];
	if (synthetic && parent) {
		const history = await seedHistory(root, home, parent);
		if (!history.ok) return history;
	}
	// Test-only timestamps, not source chronology. All ordering ties are deliberate.
	const tied = await provider.withDb(home, (db) => {
		db.run(`UPDATE ${prefix}tasks SET created_at = ?, updated_at = ?`, [
			FIXTURE_TIME,
			FIXTURE_TIME,
		]);
		db.run(`UPDATE ${prefix}task_comments SET created_at = ?`, [FIXTURE_TIME]);
	});
	if (!tied.ok) return tied;
	return ok(ids);
};

if (import.meta.main) {
	const seeded = await seed();
	if (!seeded.ok) {
		console.error(seeded.error.message);
		process.exitCode = 1;
	} else console.log(JSON.stringify(seeded.value));
}
