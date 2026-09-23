import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Planner, ScopeUri, type Task, type TaskDraft } from "@cabane/core";
import { BoardData } from "./data";
import { dropDb, freshDb } from "./test-db";

const TEST_BASE = join(import.meta.dir, ".test-data");

const draft = (over: Partial<TaskDraft> = {}): TaskDraft => ({
	title: "A task",
	...over,
});

const sectionFor = (
	sections: BoardData.BoardSection[],
	state: BoardData.SectionState,
): BoardData.BoardSection | undefined =>
	sections.find((s) => s.state === state);

// Minimal Task for the pure-assembly tests (no DB).
const task = (over: Partial<Task> = {}): Task => ({
	id: "01H000000000000000000000AA",
	shortId: "JAKE-1",
	title: "A task",
	kind: "issue",
	state: "next",
	priority: "normal",
	provenance: { source: "human", discoveredAt: new Date().toISOString() },
	needsReview: false,
	tags: [],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	...over,
});

describe("BoardData.assembleSections (pure)", () => {
	it("groups top-level tasks into their state sections, dropping empty ones", () => {
		const sections = BoardData.assembleSections(
			{
				in_progress: [task({ id: "a", state: "in_progress" })],
				next: [task({ id: "b", state: "next" })],
			},
			[],
		);
		expect(sections.map((s) => s.state)).toEqual(["in_progress", "next"]);
		expect(sectionFor(sections, "in_progress")?.rows).toHaveLength(1);
		expect(sectionFor(sections, "inbox")).toBeUndefined();
	});

	it("orders sections in the display order (in_progress → next → inbox → waiting → done)", () => {
		const sections = BoardData.assembleSections(
			{
				inbox: [task({ id: "i", state: "inbox" })],
				next: [task({ id: "n", state: "next" })],
				in_progress: [task({ id: "p", state: "in_progress" })],
				waiting: [task({ id: "w", state: "waiting" })],
				done: [task({ id: "d", state: "done" })],
			},
			[],
		);
		expect(sections.map((s) => s.state)).toEqual([
			"in_progress",
			"next",
			"inbox",
			"waiting",
			"done",
		]);
	});

	it("attaches a subtask under its visible parent and dedupes it from its own section", () => {
		const parent = task({ id: "p", state: "in_progress" });
		const child = task({ id: "c", state: "next", parentTaskId: "p" });
		const sections = BoardData.assembleSections(
			// The child also came back in its own state query (next); it must not appear there.
			{ in_progress: [parent], next: [child] },
			[child],
		);
		expect(sectionFor(sections, "next")).toBeUndefined();
		const row = sectionFor(sections, "in_progress")?.rows[0];
		expect(row?.task.id).toBe("p");
		expect(row?.children.map((t) => t.id)).toEqual(["c"]);
	});

	it("keeps an orphan subtask (parent not visible) as a top-level row in its own section", () => {
		const child = task({ id: "c", state: "next", parentTaskId: "missing" });
		const sections = BoardData.assembleSections({ next: [child] }, []);
		const row = sectionFor(sections, "next")?.rows[0];
		expect(row?.task.id).toBe("c");
		expect(row?.children).toEqual([]);
	});

	// JCAB-30: a closed parent is never a subtask root, so its children are never fetched and nothing
	// re-attaches them. Deduping on "the parent exists" dropped them from BOTH places.
	it("keeps an open subtask of a DONE parent as a top-level row in its own section", () => {
		const parent = task({ id: "p", state: "done" });
		const child = task({ id: "c", state: "next", parentTaskId: "p" });
		// The parent is within the archive cap (so it IS in visibleIds), but loadBoard skipped it as a
		// subtask root — hence the empty subtask list.
		const sections = BoardData.assembleSections(
			{ next: [child], done: [parent] },
			[],
		);
		const row = sectionFor(sections, "next")?.rows[0];
		expect(row?.task.id).toBe("c");
		expect(sectionFor(sections, "done")?.rows[0]?.children).toEqual([]);
	});

	it("keeps an open subtask of a CANCELLED parent as a top-level row in its own section", () => {
		const parent = task({ id: "p", state: "cancelled" });
		const child = task({ id: "c", state: "in_progress", parentTaskId: "p" });
		const sections = BoardData.assembleSections(
			{ in_progress: [child], cancelled: [parent] },
			[],
		);
		expect(sectionFor(sections, "in_progress")?.rows[0]?.task.id).toBe("c");
	});

	it("still dedupes only the child that was actually attached, not every child of that parent", () => {
		const parent = task({ id: "p", state: "in_progress" });
		const attached = task({ id: "c1", state: "next", parentTaskId: "p" });
		// Came back in its own section query but NOT in the parent's subtask fetch (past its limit).
		const unattached = task({ id: "c2", state: "next", parentTaskId: "p" });
		const sections = BoardData.assembleSections(
			{ in_progress: [parent], next: [attached, unattached] },
			[attached],
		);
		expect(sectionFor(sections, "in_progress")?.rows[0]?.children).toHaveLength(
			1,
		);
		// c2 renders nowhere else, so it must survive in its own section.
		expect(sectionFor(sections, "next")?.rows.map((r) => r.task.id)).toEqual([
			"c2",
		]);
	});

	it("shows a done subtask under an open parent even when it is not in any section query (done cap)", () => {
		const parent = task({ id: "p", state: "in_progress" });
		const doneChild = task({ id: "c", state: "done", parentTaskId: "p" });
		// `next`/`done` section queries didn't return the child (past the done cap); the subtask fetch did.
		const sections = BoardData.assembleSections({ in_progress: [parent] }, [
			doneChild,
		]);
		const row = sectionFor(sections, "in_progress")?.rows[0];
		expect(row?.children.map((t) => t.id)).toEqual(["c"]);
		expect(sectionFor(sections, "done")).toBeUndefined();
	});
});

describe("BoardData", () => {
	beforeEach(async () => {
		await freshDb(TEST_BASE);
	});

	afterEach(() => {
		dropDb(TEST_BASE);
	});

	describe("loadBoard", () => {
		it("returns only the non-empty sections, in display order", async () => {
			await Planner.addTask(TEST_BASE, draft({ title: "in inbox" }));
			await Planner.addTask(
				TEST_BASE,
				draft({ title: "working", state: "in_progress" }),
			);

			const result = await BoardData.loadBoard(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			// in_progress renders before inbox in the display order; empty sections are hidden.
			expect(result.value.map((s) => s.state)).toEqual([
				"in_progress",
				"inbox",
			]);
		});

		it("groups tasks by state", async () => {
			await Planner.addTask(TEST_BASE, draft({ title: "in inbox" }));
			await Planner.addTask(
				TEST_BASE,
				draft({ title: "up next", state: "next" }),
			);

			const result = await BoardData.loadBoard(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(sectionFor(result.value, "inbox")?.rows).toHaveLength(1);
			expect(sectionFor(result.value, "next")?.rows).toHaveLength(1);
			expect(sectionFor(result.value, "inbox")?.rows[0]?.task.title).toBe(
				"in inbox",
			);
		});

		it("includes done tasks (a closed state) in the done section", async () => {
			await Planner.addTask(
				TEST_BASE,
				draft({ title: "finished", state: "done" }),
			);

			const result = await BoardData.loadBoard(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(sectionFor(result.value, "done")?.rows).toHaveLength(1);
			expect(sectionFor(result.value, "done")?.rows[0]?.task.title).toBe(
				"finished",
			);
		});

		it("loads someday and cancelled — the states the board could once write but never read", async () => {
			await Planner.addTask(
				TEST_BASE,
				draft({ title: "parked", state: "someday" }),
			);
			await Planner.addTask(
				TEST_BASE,
				draft({ title: "abandoned", state: "cancelled" }),
			);

			const result = await BoardData.loadBoard(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(sectionFor(result.value, "someday")?.rows[0]?.task.title).toBe(
				"parked",
			);
			expect(sectionFor(result.value, "cancelled")?.rows[0]?.task.title).toBe(
				"abandoned",
			);
		});

		it("orders all seven sections unresolved-first, archive last", async () => {
			for (const state of BoardData.SECTION_STATES) {
				await Planner.addTask(TEST_BASE, draft({ title: `a ${state}`, state }));
			}

			const result = await BoardData.loadBoard(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.map((s) => s.state)).toEqual([
				"in_progress",
				"next",
				"inbox",
				"waiting",
				"someday",
				"done",
				"cancelled",
			]);
		});

		it("nests a subtask under a someday parent — parked is a tree, not archive", async () => {
			const parent = await Planner.addTask(
				TEST_BASE,
				draft({ title: "parked parent", state: "someday" }),
			);
			expect(parent.ok).toBe(true);
			if (!parent.ok) return;
			await Planner.addTask(
				TEST_BASE,
				draft({
					title: "parked child",
					state: "someday",
					parentTaskId: parent.value.id,
				}),
			);

			const result = await BoardData.loadBoard(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const rows = sectionFor(result.value, "someday")?.rows;
			expect(rows).toHaveLength(1);
			expect(rows?.[0]?.children.map((c) => c.title)).toEqual(["parked child"]);
		});

		it("leaves the closed archive FLAT — a cancelled parent gets no subtask query", async () => {
			const parent = await Planner.addTask(
				TEST_BASE,
				draft({ title: "killed parent", state: "cancelled" }),
			);
			expect(parent.ok).toBe(true);
			if (!parent.ok) return;
			await Planner.addTask(
				TEST_BASE,
				draft({
					title: "killed child",
					state: "cancelled",
					parentTaskId: parent.value.id,
				}),
			);

			const result = await BoardData.loadBoard(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			// Cancelled joins done on the archive path: no per-parent query, so no children are
			// attached. Skipping archive parents as subtask roots is what keeps two 50-row windows
			// from adding 100 per-parent queries to every 5s poll.
			const rows = sectionFor(result.value, "cancelled")?.rows;
			expect(rows?.every((r) => r.children.length === 0)).toBe(true);
			expect(rows?.map((r) => r.task.title)).toContain("killed parent");
		});

		it("loads all recent done rows inside the tier-1 search window (FTS owns the deep archive)", async () => {
			for (let i = 0; i < 15; i++) {
				await Planner.addTask(
					TEST_BASE,
					draft({ title: `done ${i}`, state: "done" }),
				);
			}

			const result = await BoardData.loadBoard(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			// 15 < the 50-row tier-1 window, so all load; FTS tier 2 surfaces the full
			// archive beyond this cap (see nav.test.ts withSearchResults).
			expect(sectionFor(result.value, "done")?.rows).toHaveLength(15);
		});

		it("nests a subtask under its parent row", async () => {
			const parent = await Planner.addTask(
				TEST_BASE,
				draft({ title: "parent", state: "in_progress" }),
			);
			expect(parent.ok).toBe(true);
			if (!parent.ok) return;
			await Planner.addTask(
				TEST_BASE,
				draft({ title: "child", state: "next", parentTaskId: parent.value.id }),
			);

			const result = await BoardData.loadBoard(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const inProgress = sectionFor(result.value, "in_progress");
			expect(inProgress?.rows).toHaveLength(1);
			expect(inProgress?.rows[0]?.children.map((t) => t.title)).toEqual([
				"child",
			]);
			// The child must NOT also appear as a top-level row in the next section.
			expect(sectionFor(result.value, "next")).toBeUndefined();
		});

		it("filters by kind", async () => {
			await Planner.addTask(
				TEST_BASE,
				draft({ title: "a task", kind: "task" }),
			);
			await Planner.addTask(
				TEST_BASE,
				draft({ title: "an issue", kind: "issue" }),
			);

			const result = await BoardData.loadBoard(TEST_BASE, { kind: "issue" });
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const inbox = sectionFor(result.value, "inbox")?.rows ?? [];
			expect(inbox).toHaveLength(1);
			expect(inbox[0]?.task.title).toBe("an issue");
		});

		it("filters by scope", async () => {
			const scoped = ScopeUri.fromScopeId("github.com/acme/widget");
			await Planner.addTask(
				TEST_BASE,
				draft({ title: "scoped", scopeUri: scoped }),
			);
			await Planner.addTask(TEST_BASE, draft({ title: "unscoped" }));

			const result = await BoardData.loadBoard(TEST_BASE, { scopeUri: scoped });
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const inbox = sectionFor(result.value, "inbox")?.rows ?? [];
			expect(inbox).toHaveLength(1);
			expect(inbox[0]?.task.title).toBe("scoped");
		});
	});

	describe("searchBoard", () => {
		it("returns FTS matches from the planner", async () => {
			await Planner.addTask(
				TEST_BASE,
				draft({ title: "authentication flow", description: "OAuth2 login" }),
			);
			await Planner.addTask(TEST_BASE, draft({ title: "unrelated task" }));

			const result = await BoardData.searchBoard(TEST_BASE, "authentication");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value).toHaveLength(1);
			expect(result.value[0]?.title).toBe("authentication flow");
		});

		it("finds tasks by description content (what tier-1 substring search misses)", async () => {
			await Planner.addTask(
				TEST_BASE,
				draft({
					title: "deploy pipeline",
					description: "kubernetes rollout strategy",
				}),
			);

			const result = await BoardData.searchBoard(TEST_BASE, "kubernetes");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value).toHaveLength(1);
			expect(result.value[0]?.title).toBe("deploy pipeline");
		});
	});

	describe("detailStamp", () => {
		// Timestamps are ISO to the millisecond; two writes inside one would read as one moment.
		const tick = () => Bun.sleep(5);
		const stampNow = async (id: string): Promise<string> => {
			const stamp = await BoardData.detailStamp(TEST_BASE, id);
			if (!stamp.ok) throw stamp.error;
			return stamp.value;
		};

		it("holds while nothing lands, and moves for a comment, a work log and session activity", async () => {
			const added = await Planner.addTask(TEST_BASE, draft());
			if (!added.ok) throw added.error;
			const id = added.value.id;
			const quiet = await stampNow(id);
			expect(await stampNow(id)).toBe(quiet);

			await Planner.addComment(TEST_BASE, {
				taskId: id,
				author: "claude",
				authorType: "ai",
				content: "found the cause",
			});
			const commented = await stampNow(id);
			expect(commented).not.toBe(quiet);

			await tick();
			await Planner.addWorkLog(TEST_BASE, {
				taskId: id,
				refs: [{ uri: "commit:abc1234" }],
			});
			const logged = await stampNow(id);
			expect(logged).not.toBe(commented);

			await tick();
			const session = await Planner.startSession(TEST_BASE, {
				taskId: id,
				agent: "claude",
			});
			if (!session.ok) throw session.error;
			const started = await stampNow(id);
			expect(started).not.toBe(logged);

			await tick();
			await Planner.addActivity(TEST_BASE, {
				sessionId: session.value.id,
				type: "progress",
				body: "halfway",
			});
			expect(await stampNow(id)).not.toBe(started);
		});

		it("agrees with the stamp of the records taskDetail loads", async () => {
			const added = await Planner.addTask(TEST_BASE, draft());
			if (!added.ok) throw added.error;
			const id = added.value.id;
			await Planner.addComment(TEST_BASE, {
				taskId: id,
				author: "david",
				authorType: "human",
				content: "looks right",
			});
			const records = await BoardData.taskDetail(TEST_BASE, id);
			if (!records.ok) throw records.error;
			expect(BoardData.recordsStamp(records.value)).toBe(await stampNow(id));
		});
	});

	describe("markDone", () => {
		it("moves a task to done", async () => {
			const added = await Planner.addTask(TEST_BASE, draft({ state: "next" }));
			expect(added.ok).toBe(true);
			if (!added.ok) return;

			const done = await BoardData.markDone(TEST_BASE, added.value.id);
			expect(done.ok).toBe(true);
			if (!done.ok) return;
			expect(done.value?.state).toBe("done");
		});
	});

	describe("setTaskState", () => {
		it("transitions a task to a new state", async () => {
			const added = await Planner.addTask(TEST_BASE, draft());
			expect(added.ok).toBe(true);
			if (!added.ok) return;

			const moved = await BoardData.setTaskState(
				TEST_BASE,
				added.value.id,
				"in_progress",
			);
			expect(moved.ok).toBe(true);
			if (!moved.ok) return;
			expect(moved.value?.state).toBe("in_progress");
		});

		it("moves a task to cancelled and someday (the direct-jump targets)", async () => {
			const added = await Planner.addTask(TEST_BASE, draft());
			expect(added.ok).toBe(true);
			if (!added.ok) return;

			const cancelled = await BoardData.setTaskState(
				TEST_BASE,
				added.value.id,
				"cancelled",
			);
			expect(cancelled.ok).toBe(true);
			if (!cancelled.ok) return;
			expect(cancelled.value?.state).toBe("cancelled");

			const someday = await BoardData.setTaskState(
				TEST_BASE,
				added.value.id,
				"someday",
			);
			expect(someday.ok).toBe(true);
			if (!someday.ok) return;
			expect(someday.value?.state).toBe("someday");
		});
	});

	describe("markReviewed", () => {
		it("clears the review flag and stamps the verification record", async () => {
			const added = await Planner.addTask(
				TEST_BASE,
				draft({ needsReview: true }),
			);
			expect(added.ok).toBe(true);
			if (!added.ok) return;
			expect(added.value.needsReview).toBe(true);

			const reviewed = await BoardData.markReviewed(TEST_BASE, added.value.id);
			expect(reviewed.ok).toBe(true);
			if (!reviewed.ok) return;
			expect(reviewed.value?.needsReview).toBe(false);
			expect(reviewed.value?.verification?.status).toBe("passed");
			expect(reviewed.value?.verification?.method).toBe("manual");
			expect(reviewed.value?.verification?.verifiedBy).toBe("human");
			expect(reviewed.value?.verification?.verifiedAt).toBeTruthy();
		});
	});
});
