import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TaskDraft } from "../schemas";
import { Planner } from "./index";

const TEST_BASE = join(import.meta.dir, ".test-data-assemble-context");

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/** Create a task/issue and return its id. */
const createTask = async (draft: TaskDraft): Promise<string> => {
	const result = await Planner.addTask(TEST_BASE, draft);
	if (!result.ok) throw new Error(`failed to create task: ${result.error}`);
	return result.value.id;
};

const assemble = async (
	id: string,
	opts?: Parameters<typeof Planner.assembleContext>[2],
): Promise<string> => {
	const result = await Planner.assembleContext(TEST_BASE, id, opts);
	if (!result.ok) throw new Error(`assemble failed: ${result.error}`);
	return result.value;
};

describe("Planner — assembleContext", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });

		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	// ── Omission matrix ──────────────────────────────────────────────────

	it("bare reminder → description only, no other sections", async () => {
		const id = await createTask({
			title: "Call mom",
			description: "Ask about the trip",
		});
		const md = await assemble(id);

		expect(md).toContain("# ");
		expect(md).toContain("Call mom");
		expect(md).toContain("## Description");
		expect(md).toContain("Ask about the trip");
		expect(md).not.toContain("## Position");
		expect(md).not.toContain("## Context");
		expect(md).not.toContain("## Prior work");
		expect(md).not.toContain("## Discussion");
	});

	it("omits Description when the task has none", async () => {
		const id = await createTask({ title: "No body" });
		const md = await assemble(id);
		expect(md).not.toContain("## Description");
	});

	it("renders the cached Upstream snapshot between Description and Position", async () => {
		const parent = await createTask({ title: "Parent", kind: "issue" });
		const id = await createTask({
			title: "Implementation root",
			description: "Local implementation details",
			kind: "issue",
			parentTaskId: parent,
		});
		const linked = await Planner.upsertUpstreamLink(TEST_BASE, {
			taskId: id,
			provider: "linear",
			externalId: "linear-uuid",
			identifier: "ENG-123",
			url: "https://linear.app/acme/issue/ENG-123/example",
			title: "Team feature",
			description: "Cached team-wide product context",
			state: "In Progress",
			externalUpdatedAt: "2026-07-18T12:00:00.000Z",
		});
		if (!linked.ok) throw linked.error;

		const md = await assemble(id);
		expect(md).toContain("## Upstream");
		expect(md).toContain("linear · ENG-123 — Team feature");
		expect(md).toContain("Cached team-wide product context");
		expect(md).toContain(`Snapshot refreshed: ${linked.value.refreshedAt}`);
		expect(md.indexOf("## Description")).toBeLessThan(
			md.indexOf("## Upstream"),
		);
		expect(md.indexOf("## Upstream")).toBeLessThan(md.indexOf("## Position"));
	});

	it("renders metadata line with state/priority; assignee dropped when empty", async () => {
		const withAssignee = await createTask({
			title: "Owned",
			state: "in_progress",
			assignee: "claude",
		});
		const md1 = await assemble(withAssignee);
		expect(md1).toContain("**State:** in_progress");
		expect(md1).toContain("**Priority:** normal");
		expect(md1).toContain("**Assignee:** claude");

		const noAssignee = await createTask({ title: "Unowned" });
		const md2 = await assemble(noAssignee);
		expect(md2).not.toContain("**Assignee:**");
	});

	// ── Position (blocks / blocked_by / follows semantics) ──────────────

	it("renders Position: parent, blockers with states, blocks, subtasks", async () => {
		const parent = await createTask({ title: "Parent epic", kind: "issue" });
		const blocker = await createTask({
			title: "Do first",
			kind: "issue",
			state: "done",
		});
		const downstream = await createTask({
			title: "Do after",
			kind: "issue",
			state: "next",
		});
		const main = await createTask({
			title: "Main work",
			kind: "issue",
			parentTaskId: parent,
		});
		await createTask({
			title: "A subtask",
			kind: "issue",
			state: "in_progress",
			parentTaskId: main,
		});

		// blocker blocks main → main is blocked by blocker
		await Planner.addLink(TEST_BASE, {
			sourceId: blocker,
			targetId: main,
			type: "blocks",
		});
		// main blocks downstream
		await Planner.addLink(TEST_BASE, {
			sourceId: main,
			targetId: downstream,
			type: "blocks",
		});

		const md = await assemble(main);
		expect(md).toContain("## Position");
		expect(md).toContain("Parent:");
		expect(md).toContain("Parent epic");
		expect(md).toContain("Blocked by:");
		expect(md).toContain("Do first");
		expect(md).toContain("(done)");
		expect(md).toContain("Blocks:");
		expect(md).toContain("Do after");
		expect(md).toContain("Subtasks (1)");
		expect(md).toContain("A subtask");
		expect(md).toContain("(in_progress)");
	});

	it("blocked_by and follows both make the task depend on the target", async () => {
		const target = await createTask({ title: "Upstream", kind: "issue" });
		const follower = await createTask({ title: "Follower", kind: "issue" });
		// follower blocked_by target AND follower follows target
		await Planner.addLink(TEST_BASE, {
			sourceId: follower,
			targetId: target,
			type: "blocked_by",
		});
		const md = await assemble(follower);
		expect(md).toContain("Blocked by:");
		expect(md).toContain("Upstream");
	});

	it("omits subtasks when includeSubtasks is false", async () => {
		const main = await createTask({ title: "Parent", kind: "issue" });
		await createTask({
			title: "Child",
			kind: "issue",
			parentTaskId: main,
		});
		const md = await assemble(main, { includeSubtasks: false });
		expect(md).not.toContain("Subtasks");
	});

	// ── Context: deref, caps, truncation, downgrade, missing ────────────

	it("inlines a small file: ref, pointer for obsidian: scheme", async () => {
		const id = await createTask({ title: "With context", kind: "issue" });
		const filePath = join(TEST_BASE, "note.md");
		writeFileSync(filePath, "inline me fully");
		await Planner.addContextRef(TEST_BASE, {
			taskId: id,
			uri: `file:${filePath}`,
			kind: "research",
			label: "A note",
		});
		await Planner.addContextRef(TEST_BASE, {
			taskId: id,
			uri: "obsidian:prds/foo.md",
			kind: "PRD",
			label: "Foo PRD",
		});

		const md = await assemble(id);
		expect(md).toContain("## Context");
		expect(md).toContain("[research] A note");
		expect(md).toContain("inline me fully");
		// obsidian is a pointer — label + uri, never inlined content
		expect(md).toContain("[PRD] Foo PRD");
		expect(md).toContain("obsidian:prds/foo.md");
	});

	it("truncates a file larger than perRefCap with a marker", async () => {
		const id = await createTask({ title: "Big file", kind: "issue" });
		const filePath = join(TEST_BASE, "big.txt");
		writeFileSync(filePath, "X".repeat(5000));
		await Planner.addContextRef(TEST_BASE, {
			taskId: id,
			uri: `file:${filePath}`,
			kind: "doc",
		});

		const md = await assemble(id, { perRefCap: 1000 });
		expect(md).toContain("truncated");
		expect(md).toContain("5000 bytes total");
		// only the first 1000 chars inlined
		expect(md).not.toContain("X".repeat(1001));
	});

	it("downgrades remaining refs to pointers once totalRefCap is hit", async () => {
		const id = await createTask({ title: "Two files", kind: "issue" });
		const f1 = join(TEST_BASE, "one.txt");
		const f2 = join(TEST_BASE, "two.txt");
		writeFileSync(f1, "A".repeat(900));
		writeFileSync(f2, "B".repeat(900));
		await Planner.addContextRef(TEST_BASE, {
			taskId: id,
			uri: `file:${f1}`,
			kind: "doc",
			label: "one",
		});
		await Planner.addContextRef(TEST_BASE, {
			taskId: id,
			uri: `file:${f2}`,
			kind: "doc",
			label: "two",
		});

		// total budget only fits the first file's content
		const md = await assemble(id, { perRefCap: 2000, totalRefCap: 900 });
		expect(md).toContain("A".repeat(900)); // first inlined
		expect(md).not.toContain("B".repeat(900)); // second downgraded to pointer
		expect(md).toContain("[doc] two"); // pointer header still present
	});

	it("renders a missing file: ref as a pointer note", async () => {
		const id = await createTask({ title: "Missing ref", kind: "issue" });
		await Planner.addContextRef(TEST_BASE, {
			taskId: id,
			uri: `file:${join(TEST_BASE, "does-not-exist.md")}`,
			kind: "doc",
			label: "gone",
		});
		const md = await assemble(id);
		expect(md).toContain("missing file");
	});

	it("--no-deref renders file: refs as pointers", async () => {
		const id = await createTask({ title: "No deref", kind: "issue" });
		const filePath = join(TEST_BASE, "note.md");
		writeFileSync(filePath, "should not appear");
		await Planner.addContextRef(TEST_BASE, {
			taskId: id,
			uri: `file:${filePath}`,
			kind: "doc",
		});
		const md = await assemble(id, { deref: false });
		expect(md).toContain("## Context");
		expect(md).not.toContain("should not appear");
	});

	// ── Prior work ──────────────────────────────────────────────────────

	it("renders Prior work from work logs (refs + notes)", async () => {
		const id = await createTask({ title: "With work", kind: "issue" });
		await Planner.addWorkLog(TEST_BASE, {
			taskId: id,
			refs: [{ uri: "commit:abc123", label: "the fix" }],
			note: "landed the change",
		});
		const md = await assemble(id);
		expect(md).toContain("## Prior work");
		expect(md).toContain("landed the change");
		expect(md).toContain("commit:abc123");
	});

	// ── Discussion (pre-S4 heuristic) ───────────────────────────────────

	it("Discussion keeps all human comments and only the last 3 AI comments", async () => {
		const id = await createTask({ title: "Chatty", kind: "issue" });
		// oldest AI comment — should be dropped (only last 3 AI kept)
		await Planner.addComment(TEST_BASE, {
			taskId: id,
			author: "bot",
			authorType: "ai",
			content: "OLDEST_AI",
		});
		await sleep(5);
		await Planner.addComment(TEST_BASE, {
			taskId: id,
			author: "me",
			authorType: "human",
			content: "HUMAN_ONE",
		});
		for (const n of ["AI_TWO", "AI_THREE", "AI_FOUR"]) {
			await sleep(5);
			await Planner.addComment(TEST_BASE, {
				taskId: id,
				author: "bot",
				authorType: "ai",
				content: n,
			});
		}

		const md = await assemble(id);
		expect(md).toContain("## Discussion");
		expect(md).toContain("HUMAN_ONE");
		expect(md).toContain("AI_TWO");
		expect(md).toContain("AI_THREE");
		expect(md).toContain("AI_FOUR");
		expect(md).not.toContain("OLDEST_AI");
	});

	it("Discussion excludes work-log entries (Prior work owns them)", async () => {
		const id = await createTask({ title: "No dup", kind: "issue" });
		await Planner.addWorkLog(TEST_BASE, {
			taskId: id,
			refs: [{ uri: "commit:zzz", label: "WORKLOG_ONLY" }],
		});
		const md = await assemble(id);
		// work-log ref appears under Prior work, never inside Discussion
		const discussionIdx = md.indexOf("## Discussion");
		expect(discussionIdx).toBe(-1); // no comments → no Discussion section at all
	});

	// ── Discussion (S4+ session path) ───────────────────────────────────

	it("Discussion uses durable session activities when the task has sessions", async () => {
		const id = await createTask({ title: "With sessions", kind: "issue" });
		const started = await Planner.startSession(TEST_BASE, {
			taskId: id,
			agent: "claude",
		});
		if (!started.ok) throw new Error("failed to start session");
		await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "progress",
			body: "PROGRESS_NOISE",
		});
		await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "decision",
			body: "DURABLE_DECISION",
		});

		const md = await assemble(id);
		expect(md).toContain("## Discussion");
		expect(md).toContain("DURABLE_DECISION");
		expect(md).toContain("claude");
		// progress is not durable → excluded
		expect(md).not.toContain("PROGRESS_NOISE");
	});

	it("session path keeps ALL human comments merged with durable activities", async () => {
		const id = await createTask({
			title: "Sessions + comments",
			kind: "issue",
		});
		await Planner.addComment(TEST_BASE, {
			taskId: id,
			author: "me",
			authorType: "human",
			content: "HUMAN_COMMENT",
		});
		// An AI comment must NOT surface on the session path (only humans do).
		await Planner.addComment(TEST_BASE, {
			taskId: id,
			author: "bot",
			authorType: "ai",
			content: "AI_COMMENT",
		});
		const started = await Planner.startSession(TEST_BASE, {
			taskId: id,
			agent: "claude",
		});
		if (!started.ok) throw new Error("failed to start session");
		await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "finding",
			severity: "P1",
			body: "SESSION_FINDING",
		});

		const md = await assemble(id);
		expect(md).toContain("## Discussion");
		expect(md).toContain("SESSION_FINDING");
		// Human steering is the load-bearing content — always present.
		expect(md).toContain("HUMAN_COMMENT");
		// AI comments are the session-less heuristic only, never the session path.
		expect(md).not.toContain("AI_COMMENT");
	});

	// ── ShortId resolution & errors ─────────────────────────────────────

	it("resolves a short id to the full task", async () => {
		const id = await createTask({ title: "By short id", kind: "issue" });
		const task = await Planner.getTask(TEST_BASE, id);
		if (!task.ok || !task.value?.shortId) throw new Error("no short id");
		const md = await assemble(task.value.shortId);
		expect(md).toContain("By short id");
	});

	it("errors when the task does not exist", async () => {
		const result = await Planner.assembleContext(
			TEST_BASE,
			"01ZZZZZZZZZZZZZZZZZZZZZZZZZ",
		);
		expect(result.ok).toBe(false);
	});

	it("errors on invalid opts", async () => {
		const id = await createTask({ title: "Bad opts", kind: "issue" });
		const result = await Planner.assembleContext(TEST_BASE, id, {
			perRefCap: -5,
		});
		expect(result.ok).toBe(false);
	});
});
