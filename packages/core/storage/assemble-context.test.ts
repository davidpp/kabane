import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteDb } from "@cabane/sqlite";
import type { Db, DbProvider } from "../db/port";
import { TABLES } from "../db/tables";
import type { KabaneModule } from "../module";
import { Runtime } from "../runtime";
import { formatQuestionBody, type TaskDraft, type TaskEntry } from "../schemas";
import { configureTestRuntime, TEST_DB_NAME } from "../testing";
import { steeringSections } from "./assemble-context";
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
		});
		if (!linked.ok) throw linked.error;

		const md = await assemble(id);
		expect(md).toContain("## Upstream");
		expect(md).toContain(
			"- linear · ENG-123 — Team feature — https://linear.app/acme/issue/ENG-123/example",
		);
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

	it("lists a human's choice as a decision with its question and author, and no tool approval or skipped question", async () => {
		const id = await createTask({ title: "Answered", kind: "issue" });
		const started = await Planner.startSession(TEST_BASE, {
			taskId: id,
			agent: "claude",
		});
		if (!started.ok) throw started.error;
		const sessionId = started.value.id;
		const ask = async (body: string): Promise<string> => {
			const q = await Planner.addActivity(TEST_BASE, {
				sessionId,
				type: "question",
				body,
			});
			if (!q.ok) throw q.error;
			return q.value.id;
		};
		const approval = await ask(
			formatQuestionBody("claude asks to run: Write a.ts", {
				choices: ["Yes", "No"],
				allowFreeform: false,
				permission: {
					toolCallId: "toolu_01",
					title: "Write a.ts",
					options: [
						{ id: "allow", label: "Yes", kind: "allow_once" },
						{ id: "reject", label: "No", kind: "reject_once" },
					],
				},
			}),
		);
		const skipped = await ask(
			formatQuestionBody("Any optional notes?", { skipAnswer: "skip" }),
		);
		const real = await ask(
			formatQuestionBody("Plain text or markdown?", {
				choices: ["Plain text", "Markdown"],
				skipAnswer: "skip",
				allowFreeform: false,
			}),
		);
		configureTestRuntime("", { actor: () => "cabane://actor/human/ada" });
		try {
			for (const [questionId, answer] of [
				[approval, "Yes"],
				[skipped, "skip"],
				[real, "Markdown"],
			] as const) {
				const answered = await Planner.answerQuestion(TEST_BASE, {
					questionId,
					answer,
				});
				if (!answered.ok) throw answered.error;
			}
		} finally {
			configureTestRuntime();
		}

		const md = await assemble(id);
		expect(md).toMatch(
			/\*\*cabane:\/\/actor\/human\/ada\*\* \(decision, [^)]+\):\nPlain text or markdown\?\n→ Markdown/,
		);
		expect(md).not.toContain("asks to run");
		expect(md).not.toContain("Any optional notes?");
		expect(md).not.toContain("→ skip");
		expect(md.match(/\(decision,/g)?.length).toBe(1);
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

describe("Planner — assembleContext over typed timeline entries", () => {
	const AGENT = "cabane://actor/agent/claude";

	const entry = async (taskId: string, kind: string, content: string) => {
		const added = await Planner.addEntry(TEST_BASE, {
			taskId,
			kind,
			author: AGENT,
			authorType: "ai",
			content,
		});
		if (!added.ok) throw added.error;
	};
	const aiComment = async (taskId: string, content: string) => {
		const added = await Planner.addComment(TEST_BASE, {
			taskId,
			author: AGENT,
			authorType: "ai",
			content,
		});
		if (!added.ok) throw added.error;
	};
	const discussionOf = (md: string): string =>
		md.slice(md.indexOf("## Discussion"));

	const verdicts: KabaneModule = {
		name: "verdicts",
		kinds: [
			{
				name: "verdicts",
				title: "Verdict",
				template: "## Verdict\n\nWhat you decided and why.",
				projection: {
					latest: {
						after: "description",
						framing:
							"The newest verdict on record; check it before relying on it.",
					},
				},
			},
			{
				name: "verdicts.note",
				title: "Verdict note",
				template: "",
				projection: "discussion",
			},
		],
	};

	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });
		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		configureTestRuntime();
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("keeps a typed AI entry no module declares, labelled, behind more than three later AI comments", async () => {
		const id = await createTask({ title: "Typed", kind: "issue" });
		await entry(id, "review", "REVIEW_BODY");
		for (const n of ["AI_1", "AI_2", "AI_3", "AI_4"]) await aiComment(id, n);

		const discussion = discussionOf(await assemble(id));
		expect(discussion).toContain(`**${AGENT}** (review, ai, `);
		expect(discussion).toContain("REVIEW_BODY");
		// Plain AI comments keep today's rule: the last three.
		expect(discussion).not.toContain("AI_1");
		expect(discussion).toContain("AI_4");
		expect(discussion.indexOf("REVIEW_BODY")).toBeLessThan(
			discussion.indexOf("AI_2"),
		);
	});

	it("keeps a typed AI entry on an issue with a session, where plain AI comments drop", async () => {
		const id = await createTask({ title: "Session", kind: "issue" });
		const started = await Planner.startSession(TEST_BASE, {
			taskId: id,
			agent: "claude",
		});
		if (!started.ok) throw started.error;
		await entry(id, "finding", "TYPED_FINDING");
		await aiComment(id, "PLAIN_AI");

		const discussion = discussionOf(await assemble(id));
		expect(discussion).toContain("(finding, ai, ");
		expect(discussion).toContain("TYPED_FINDING");
		expect(discussion).not.toContain("PLAIN_AI");
	});

	it("lifts a latest kind's newest entry into its own section, counts the older ones and leaves them out of the Discussion", async () => {
		configureTestRuntime("", { modules: [verdicts] });
		const id = await createTask({
			title: "Lifted",
			kind: "issue",
			description: "DESCRIPTION",
		});
		await entry(id, "verdicts", "OLDEST_VERDICT");
		await entry(id, "verdicts", "OLDER_VERDICT");
		await entry(id, "verdicts.note", "A_NOTE");
		await entry(id, "verdicts", "NEWEST_VERDICT");
		const human = await Planner.addComment(TEST_BASE, {
			taskId: id,
			author: "me",
			authorType: "human",
			content: "HUMAN",
		});
		if (!human.ok) throw human.error;

		const md = await assemble(id);
		const section = md.slice(
			md.indexOf("## Verdict from"),
			md.indexOf("## Discussion"),
		);
		expect(section).toMatch(
			new RegExp(
				`^## Verdict from ${AGENT} · \\S+\\n\\nThe newest verdict on record; check it before relying on it\\.\\n\\nNEWEST_VERDICT\\n\\n2 earlier verdicts entries on record\\.\\n\\n$`,
			),
		);
		expect(md.indexOf("DESCRIPTION")).toBeLessThan(
			md.indexOf("## Verdict from"),
		);
		const discussion = discussionOf(md);
		expect(discussion).not.toContain("VERDICT");
		expect(discussion).toContain(`**${AGENT}** (verdicts.note, ai, `);
		expect(discussion).toContain("HUMAN");

		const bounded = await Planner.getContextPage(TEST_BASE, id, {
			sections: ["verdicts.latest"],
		});
		if (!bounded.ok) throw bounded.error;
		expect(bounded.value.markdown).toContain("NEWEST_VERDICT");
		expect(bounded.value.markdown).not.toContain("## Discussion");
	});

	it("counts a latest section toward human steering only while a human wrote its newest entry", async () => {
		configureTestRuntime("", { modules: [verdicts] });
		const id = await createTask({ title: "Steered", kind: "issue" });
		const steering = async (sections: string[]) => {
			const page = await Planner.getContextPage(TEST_BASE, id, { sections });
			if (!page.ok) throw page.error;
			return page.value.completeness.humanSteeringComplete;
		};
		await entry(id, "verdicts", "AI_VERDICT");
		expect(await steering(["discussion"])).toBe(true);

		const human = await Planner.addEntry(TEST_BASE, {
			taskId: id,
			kind: "verdicts",
			author: "cabane://actor/human/ada",
			authorType: "human",
			content: "HUMAN_VERDICT",
		});
		if (!human.ok) throw human.error;
		expect(await steering(["discussion"])).toBe(false);
		expect(await steering(["verdicts.latest"])).toBe(false);
		expect(await steering(["discussion", "verdicts.latest"])).toBe(true);
	});

	it("decides steering from a timeline snapshot alone", () => {
		configureTestRuntime("", { modules: [verdicts] });
		const verdict = (authorType: "human" | "ai", id: string): TaskEntry => ({
			id,
			taskId: "no-such-task",
			kind: "verdicts",
			author: authorType === "human" ? "cabane://actor/human/ada" : AGENT,
			authorType,
			content: id,
			createdAt: "2026-11-11T12:00:00.000Z",
		});
		expect(steeringSections([])).toEqual(["discussion"]);
		expect(
			steeringSections([verdict("ai", "a"), verdict("human", "h")]),
		).toEqual(["discussion", "verdicts.latest"]);
		expect(
			steeringSections([verdict("human", "h"), verdict("ai", "a")]),
		).toEqual(["discussion"]);
	});

	it("takes steering from the timeline it rendered, even when an entry lands right after that read", async () => {
		const id = await createTask({ title: "Raced", kind: "issue" });
		const human = await Planner.addEntry(TEST_BASE, {
			taskId: id,
			kind: "verdicts",
			author: "cabane://actor/human/ada",
			authorType: "human",
			content: "HUMAN_VERDICT",
		});
		if (!human.ok) throw human.error;

		// Every read of the timeline is counted, and the first one is followed at
		// once by an AI verdict, newer than the human one: what another writer
		// landing between two reads would leave behind.
		let timelineReads = 0;
		let injected = false;
		const reads = /FROM task_comments\b(?!_)/;
		const racing = (db: Db): Db =>
			new Proxy(db, {
				get: (target, property) => {
					if (property !== "query") {
						const value = Reflect.get(target, property);
						return typeof value === "function" ? value.bind(target) : value;
					}
					return (sql: string) => {
						const statement = target.query(sql);
						if (!reads.test(sql)) return statement;
						return new Proxy(statement, {
							get: (inner, member) => {
								const value = Reflect.get(inner, member);
								if (member !== "all" || typeof value !== "function")
									return typeof value === "function"
										? value.bind(inner)
										: value;
								return (...params: unknown[]) => {
									const rows = Reflect.apply(value, inner, params);
									timelineReads++;
									if (!injected) {
										injected = true;
										target.run(
											`INSERT INTO ${TABLES.comments} (id, task_id, kind, author, author_type, content, created_at)
											 VALUES ('01LATEAIVERDICT', ?, 'verdicts', ?, 'ai', 'AI_VERDICT', '2999-01-01T00:00:00.000Z')`,
											[id, AGENT],
										);
									}
									return rows;
								};
							},
						});
					};
				},
			});
		const sqlite = SqliteDb.provider({ dbName: TEST_DB_NAME });
		const provider: DbProvider = {
			withDb: (path, fn) => sqlite.withDb(path, (db) => fn(racing(db))),
		};
		const configured = Runtime.configure({
			provider,
			modules: [verdicts],
			timezone: () => "UTC",
		});
		if (!configured.ok) throw configured.error;

		// The snapshot this read rendered from has a human verdict newest, so its
		// steering needs that verdict's section, which this read left out. A
		// second look at the store would find the AI verdict and wrongly call the
		// steering complete.
		const raced = await Planner.getContextPage(TEST_BASE, id, {
			sections: ["discussion"],
		});
		if (!raced.ok) throw raced.error;
		expect(timelineReads).toBe(1);
		expect(raced.value.completeness.humanSteeringComplete).toBe(false);

		// The AI verdict did land: the next read's snapshot has it newest.
		const after = await Planner.getContextPage(TEST_BASE, id, {
			sections: ["discussion", "verdicts.latest"],
		});
		if (!after.ok) throw after.error;
		expect(timelineReads).toBe(2);
		expect(after.value.markdown).toContain("AI_VERDICT");
		expect(after.value.completeness.humanSteeringComplete).toBe(true);
	});

	it("omits a latest kind's section while the issue has none of its entries", async () => {
		configureTestRuntime("", { modules: [verdicts] });
		const id = await createTask({ title: "None yet", kind: "issue" });
		await entry(id, "verdicts.note", "A_NOTE");
		const md = await assemble(id);
		expect(md).not.toContain("## Verdict");
		expect(md).toContain("A_NOTE");
	});

	it("shows a latest kind's entries in the Discussion, labelled, on a device without its module", async () => {
		const id = await createTask({ title: "Unregistered", kind: "issue" });
		await entry(id, "verdicts", "FIRST_VERDICT");
		await entry(id, "verdicts", "SECOND_VERDICT");
		const discussion = discussionOf(await assemble(id));
		expect(discussion).toContain("FIRST_VERDICT");
		expect(discussion).toContain("SECOND_VERDICT");
		expect(discussion).toContain("(verdicts, ai, ");
	});
});
