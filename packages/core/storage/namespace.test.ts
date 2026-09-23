import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskDraft, TaskLinkDraft, TaskUpdate } from "../schemas";
import { configureTestRuntime } from "../testing";
import { Planner } from "./index";

const TEST_BASE = join(import.meta.dir, ".test-data");

describe("Planner", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });

		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	// ----------------------------------------------------------
	// Init
	// ----------------------------------------------------------

	describe("init", () => {
		it("should initialize the database", async () => {
			const result = await Planner.init(TEST_BASE);
			expect(result.ok).toBe(true);
		});

		it("should be idempotent", async () => {
			await Planner.init(TEST_BASE);
			const result = await Planner.init(TEST_BASE);
			expect(result.ok).toBe(true);
		});
	});

	// ----------------------------------------------------------
	// Tasks
	// ----------------------------------------------------------

	describe("addTask", () => {
		const draft: TaskDraft = {
			title: "Fix authentication bug",
			description: "Users are getting logged out randomly",
			tags: ["auth", "bug"],
		};

		it("should create a task with defaults", async () => {
			const result = await Planner.addTask(TEST_BASE, draft);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.id).toBeDefined();
				expect(result.value.title).toBe("Fix authentication bug");
				expect(result.value.state).toBe("inbox");
				expect(result.value.priority).toBe("normal");
				expect(result.value.provenance.source).toBe("human");
				expect(result.value.tags).toEqual(["auth", "bug"]);
			}
		});

		it("should create a task with explicit state and priority", async () => {
			const result = await Planner.addTask(TEST_BASE, {
				...draft,
				state: "next",
				priority: "high",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.state).toBe("next");
				expect(result.value.priority).toBe("high");
			}
		});

		it("should create a task with provenance", async () => {
			const result = await Planner.addTask(TEST_BASE, {
				...draft,
				provenance: {
					source: "linear",
					sourceId: "LIN-123",
					sourceUrl: "https://linear.app/team/LIN-123",
					discoveredAt: new Date().toISOString(),
					discoveredBy: "linear-sync",
				},
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.provenance.source).toBe("linear");
				expect(result.value.provenance.sourceId).toBe("LIN-123");
			}
		});

		it("should reject invalid draft", async () => {
			const invalid = { description: "No title!" } as TaskDraft;
			const result = await Planner.addTask(TEST_BASE, invalid);
			expect(result.ok).toBe(false);
		});

		it("should prefix the short ID from a normalized scope", async () => {
			const result = await Planner.addTask(TEST_BASE, {
				...draft,
				scopeUri: "jake://scope/jake",
			});
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.shortId).toStartWith("JJAK-");
		});

		// Storage owns normalization: recipes, workflows and the intelligence
		// module call addTask directly, so a bare id they forward has to work
		// here, not only behind the tRPC router.
		it("should normalize a bare scope ID passed straight to storage", async () => {
			for (const [scope, expected, prefix] of [
				["acme", "jake://scope/acme", "JACM-"],
				["work", "jake://scope/work", "JWOR-"],
			]) {
				const result = await Planner.addTask(TEST_BASE, {
					...draft,
					scopeUri: scope,
				});
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value.scopeUri).toBe(expected);
					expect(result.value.shortId).toStartWith(prefix);
				}
			}
		});

		it("should canonicalize near-miss scopes so a canonical filter finds them", async () => {
			for (const scope of [
				"jake",
				"jake://scope/jake",
				"jake://scope/jake/",
				" jake",
				"JAKE",
				"Jake",
			]) {
				const result = await Planner.addTask(TEST_BASE, {
					...draft,
					scopeUri: scope,
				});
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.value.scopeUri).toBe("jake://scope/jake");
			}

			const found = await Planner.queryTasks(TEST_BASE, {
				scopeUri: "jake://scope/jake",
			});
			expect(found.ok).toBe(true);
			if (found.ok) expect(found.value).toHaveLength(6);
		});

		// Path ids are cascade-derived (ADR-009 step 4) even when passed bare, so
		// they keep their case AND their leading slash — folding or stripping
		// would orphan the live rows filed under them.
		it("should keep a path-shaped bare scope ID byte-identical", async () => {
			const path = "/Users/alex/Projects/acme";
			const stored = `jake://scope/${encodeURIComponent(path)}`;

			const result = await Planner.addTask(TEST_BASE, {
				...draft,
				scopeUri: path,
			});
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.scopeUri).toBe(stored);

			// Found both by the URI an existing row holds and by the bare path.
			for (const filter of [stored, path]) {
				const found = await Planner.queryTasks(TEST_BASE, { scopeUri: filter });
				expect(found.ok).toBe(true);
				if (found.ok) expect(found.value).toHaveLength(1);
			}
		});

		it("should reject a scope with no usable ID instead of writing a JALL row", async () => {
			const result = await Planner.addTask(TEST_BASE, {
				...draft,
				scopeUri: "jake://scope/",
			});
			expect(result.ok).toBe(false);

			const stored = await Planner.queryTasks(TEST_BASE, {});
			expect(stored.ok).toBe(true);
			if (stored.ok) expect(stored.value).toHaveLength(0);
		});
	});

	describe("getTask", () => {
		it("should get a task by ID", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Test task",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const result = await Planner.getTask(TEST_BASE, addResult.value.id);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value?.title).toBe("Test task");
			}
		});

		it("should return null for non-existent ID", async () => {
			const result = await Planner.getTask(TEST_BASE, "nonexistent");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBeNull();
			}
		});
	});

	describe("external reference lookup", () => {
		it("should find by sourceId", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Email follow-up task",
				provenance: {
					source: "email",
					sourceId: "msg-123",
					discoveredAt: new Date().toISOString(),
				},
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const result = await Planner.findBySourceId(TEST_BASE, "msg-123");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value?.id).toBe(addResult.value.id);
			}
		});

		it("should find by source + sourceId", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Linear ticket expansion",
				provenance: {
					source: "linear",
					sourceId: "DESK-999",
					discoveredAt: new Date().toISOString(),
				},
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const result = await Planner.findByExternalRef(TEST_BASE, {
				source: "linear",
				sourceId: "DESK-999",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value?.id).toBe(addResult.value.id);
			}
		});

		it("should not match same sourceId from different source", async () => {
			const emailTask = await Planner.addTask(TEST_BASE, {
				title: "Email task",
				provenance: {
					source: "email",
					sourceId: "SHARED-1",
					discoveredAt: new Date().toISOString(),
				},
			});
			expect(emailTask.ok).toBe(true);

			const linearTask = await Planner.addTask(TEST_BASE, {
				title: "Linear task",
				provenance: {
					source: "linear",
					sourceId: "SHARED-1",
					discoveredAt: new Date().toISOString(),
				},
			});
			expect(linearTask.ok).toBe(true);
			if (!emailTask.ok || !linearTask.ok) return;

			const result = await Planner.findByExternalRef(TEST_BASE, {
				source: "linear",
				sourceId: "SHARED-1",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value?.id).toBe(linearTask.value.id);
				expect(result.value?.id).not.toBe(emailTask.value.id);
			}
		});
	});

	describe("queryTasks with sourceId filter", () => {
		it("should filter tasks by sourceId", async () => {
			await Planner.addTask(TEST_BASE, {
				title: "Email task A",
				provenance: {
					source: "email",
					sourceId: "msg-abc",
					discoveredAt: new Date().toISOString(),
				},
			});
			await Planner.addTask(TEST_BASE, {
				title: "Email task B",
				provenance: {
					source: "email",
					sourceId: "msg-xyz",
					discoveredAt: new Date().toISOString(),
				},
			});

			const result = await Planner.queryTasks(TEST_BASE, {
				sourceId: "msg-abc",
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(1);
			expect(result.value[0].title).toBe("Email task A");
		});

		it("should return empty when sourceId not found", async () => {
			const result = await Planner.queryTasks(TEST_BASE, {
				sourceId: "nonexistent",
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(0);
		});
	});

	describe("findDuplicatesBySourceId", () => {
		it("should find duplicate source IDs", async () => {
			// Create two tasks with the same source ID (simulating the bug)
			await Planner.addTask(TEST_BASE, {
				title: "Task 1 from email",
				provenance: {
					source: "email",
					sourceId: "19dfa060b02f01c1",
					discoveredAt: new Date().toISOString(),
				},
			});
			await Planner.addTask(TEST_BASE, {
				title: "Task 2 from email (dupe)",
				provenance: {
					source: "email",
					sourceId: "19dfa060b02f01c1",
					discoveredAt: new Date().toISOString(),
				},
			});
			// A unique task should NOT appear
			await Planner.addTask(TEST_BASE, {
				title: "Unique email task",
				provenance: {
					source: "email",
					sourceId: "unique-msg-id",
					discoveredAt: new Date().toISOString(),
				},
			});

			const result = await Planner.findDuplicatesBySourceId(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(1);
			expect(result.value[0].sourceId).toBe("19dfa060b02f01c1");
			expect(result.value[0].tasks.length).toBe(2);
		});

		it("should return empty when no duplicates exist", async () => {
			await Planner.addTask(TEST_BASE, {
				title: "Unique task",
				provenance: {
					source: "email",
					sourceId: "unique-1",
					discoveredAt: new Date().toISOString(),
				},
			});

			const result = await Planner.findDuplicatesBySourceId(TEST_BASE);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.length).toBe(0);
		});
	});

	// ----------------------------------------------------------
	// ID Resolution
	// ----------------------------------------------------------

	describe("resolveTaskId", () => {
		it("should pass through full 26-char ULID unchanged", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Test task",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const fullId = addResult.value.id;
			expect(fullId.length).toBe(26); // ULID is 26 chars

			const result = await Planner.resolveTaskId(TEST_BASE, fullId);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(fullId);
			}
		});

		it("should resolve 8-char prefix to full ID", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Test task",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const fullId = addResult.value.id;
			const prefix = fullId.slice(0, 8);

			const result = await Planner.resolveTaskId(TEST_BASE, prefix);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(fullId);
			}
		});

		it("should resolve any length prefix uniquely", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Test task",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const fullId = addResult.value.id;

			// Try various prefix lengths
			for (const len of [4, 6, 10, 15, 20]) {
				const prefix = fullId.slice(0, len);
				const result = await Planner.resolveTaskId(TEST_BASE, prefix);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value).toBe(fullId);
				}
			}
		});

		it("should error on non-existent prefix", async () => {
			const result = await Planner.resolveTaskId(TEST_BASE, "ZZZZZZZZ");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.message).toContain("No task found with ID prefix");
			}
		});

		it("should error on ambiguous prefix with multiple matches", async () => {
			// Create two tasks - ULIDs are time-based so tasks created close together
			// may share prefix characters. We'll create tasks and check if they collide.
			const task1 = await Planner.addTask(TEST_BASE, { title: "Task One" });
			const task2 = await Planner.addTask(TEST_BASE, { title: "Task Two" });
			expect(task1.ok).toBe(true);
			expect(task2.ok).toBe(true);
			if (!task1.ok || !task2.ok) return;

			// Find the shortest common prefix
			const id1 = task1.value.id;
			const id2 = task2.value.id;

			let commonPrefixLen = 0;
			while (
				commonPrefixLen < id1.length &&
				id1[commonPrefixLen] === id2[commonPrefixLen]
			) {
				commonPrefixLen++;
			}

			// If there's a common prefix, test that it returns ambiguous error
			if (commonPrefixLen >= 1) {
				const commonPrefix = id1.slice(0, commonPrefixLen);
				const result = await Planner.resolveTaskId(TEST_BASE, commonPrefix);
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.message).toContain("Ambiguous ID prefix");
					expect(result.error.message).toContain("matches");
				}
			}
		});
	});

	// ----------------------------------------------------------
	// Short ID Generation
	// ----------------------------------------------------------

	describe("short ID generation", () => {
		it("should generate short ID on task creation", async () => {
			const result = await Planner.addTask(TEST_BASE, { title: "Test task" });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.shortId).toBeDefined();
				expect(result.value.shortId).toMatch(/^J[A-Z0-9]{3}-\d+$/);
			}
		});

		it("should generate JALL prefix for unscoped tasks", async () => {
			const result = await Planner.addTask(TEST_BASE, {
				title: "Unscoped task",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.shortId).toMatch(/^JALL-\d+$/);
			}
		});

		it("should derive prefix from scope URI", async () => {
			const result = await Planner.addTask(TEST_BASE, {
				title: "Scoped task",
				scopeUri: "jake://scope/github.com/user/jake",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.shortId).toMatch(/^JJAK-\d+$/);
			}
		});

		it("should truncate long repo names to 4 chars", async () => {
			const result = await Planner.addTask(TEST_BASE, {
				title: "Task in long repo",
				scopeUri: "jake://scope/github.com/org/verylongreponame",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.shortId).toMatch(/^JVER-\d+$/);
			}
		});

		it("should increment sequence for same prefix", async () => {
			const result1 = await Planner.addTask(TEST_BASE, { title: "Task 1" });
			const result2 = await Planner.addTask(TEST_BASE, { title: "Task 2" });
			const result3 = await Planner.addTask(TEST_BASE, { title: "Task 3" });

			expect(result1.ok && result2.ok && result3.ok).toBe(true);
			if (result1.ok && result2.ok && result3.ok) {
				expect(result1.value.shortId).toBe("JALL-1");
				expect(result2.value.shortId).toBe("JALL-2");
				expect(result3.value.shortId).toBe("JALL-3");
			}
		});

		it("should maintain separate sequences per prefix", async () => {
			// Create ALL tasks
			const all1 = await Planner.addTask(TEST_BASE, { title: "All 1" });
			const all2 = await Planner.addTask(TEST_BASE, { title: "All 2" });

			// Create JAKE tasks
			const jake1 = await Planner.addTask(TEST_BASE, {
				title: "Jake 1",
				scopeUri: "jake://scope/github.com/user/jake",
			});
			const jake2 = await Planner.addTask(TEST_BASE, {
				title: "Jake 2",
				scopeUri: "jake://scope/github.com/user/jake",
			});

			expect(all1.ok && all2.ok && jake1.ok && jake2.ok).toBe(true);
			if (all1.ok && all2.ok && jake1.ok && jake2.ok) {
				expect(all1.value.shortId).toBe("JALL-1");
				expect(all2.value.shortId).toBe("JALL-2");
				expect(jake1.value.shortId).toBe("JJAK-1");
				expect(jake2.value.shortId).toBe("JJAK-2");
			}
		});

		it("should resolve short ID to ULID", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Test task",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const shortId = addResult.value.shortId;
			if (!shortId) {
				throw new Error("Expected shortId to be defined");
			}
			const fullId = addResult.value.id;

			const result = await Planner.resolveTaskId(TEST_BASE, shortId);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(fullId);
			}
		});

		it("should resolve short ID case-insensitively", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Test task",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const fullId = addResult.value.id;

			// Try lowercase
			const lowercaseResult = await Planner.resolveTaskId(TEST_BASE, "jall-1");
			expect(lowercaseResult.ok).toBe(true);
			if (lowercaseResult.ok) {
				expect(lowercaseResult.value).toBe(fullId);
			}

			// Try mixed case
			const mixedResult = await Planner.resolveTaskId(TEST_BASE, "JaLl-1");
			expect(mixedResult.ok).toBe(true);
			if (mixedResult.ok) {
				expect(mixedResult.value).toBe(fullId);
			}
		});

		it("should return error for non-existent short ID", async () => {
			const result = await Planner.resolveTaskId(TEST_BASE, "FAKE-999");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.message).toContain("No task found with ID");
			}
		});
	});

	describe("updateTask", () => {
		it("should update task fields", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Original title",
				state: "inbox",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const updateResult = await Planner.updateTask(
				TEST_BASE,
				addResult.value.id,
				{
					title: "Updated title",
					state: "next",
					priority: "high",
				},
			);
			expect(updateResult.ok).toBe(true);
			if (updateResult.ok) {
				expect(updateResult.value?.title).toBe("Updated title");
				expect(updateResult.value?.state).toBe("next");
				expect(updateResult.value?.priority).toBe("high");
			}
		});

		it("should normalize a scope change and re-prefix the short ID", async () => {
			const addResult = await Planner.addTask(TEST_BASE, { title: "Rescope" });
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;
			expect(addResult.value.shortId).toStartWith("JALL-");

			const updateResult = await Planner.updateTask(
				TEST_BASE,
				addResult.value.id,
				{ scopeUri: " jake/ " },
			);
			expect(updateResult.ok).toBe(true);
			if (updateResult.ok) {
				expect(updateResult.value?.scopeUri).toBe("jake://scope/jake");
				expect(updateResult.value?.shortId).toStartWith("JJAK-");
			}
		});

		it("should reject a scope change with no usable ID", async () => {
			const addResult = await Planner.addTask(TEST_BASE, { title: "Keep me" });
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const updateResult = await Planner.updateTask(
				TEST_BASE,
				addResult.value.id,
				{ scopeUri: "jake://scope/" },
			);
			expect(updateResult.ok).toBe(false);

			const unchanged = await Planner.getTask(TEST_BASE, addResult.value.id);
			expect(unchanged.ok).toBe(true);
			if (unchanged.ok) expect(unchanged.value?.scopeUri).toBeUndefined();
		});

		it("should set completedAt when state is done", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Complete me",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const updateResult = await Planner.updateTask(
				TEST_BASE,
				addResult.value.id,
				{
					state: "done",
				},
			);
			expect(updateResult.ok).toBe(true);
			if (updateResult.ok) {
				expect(updateResult.value?.state).toBe("done");
				expect(updateResult.value?.completedAt).toBeDefined();
			}
		});

		it("should reject a non-canonical state", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Guarded",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const updateResult = await Planner.updateTask(
				TEST_BASE,
				addResult.value.id,
				{ state: "backlog" } as unknown as TaskUpdate,
			);
			expect(updateResult.ok).toBe(false);
			if (!updateResult.ok) {
				expect(updateResult.error.message).toContain("Invalid updates");
			}
		});
	});

	describe("deleteTask", () => {
		it("should delete a task", async () => {
			const addResult = await Planner.addTask(TEST_BASE, {
				title: "Delete me",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const deleteResult = await Planner.deleteTask(
				TEST_BASE,
				addResult.value.id,
			);
			expect(deleteResult.ok).toBe(true);

			const getResult = await Planner.getTask(TEST_BASE, addResult.value.id);
			expect(getResult.ok).toBe(true);
			if (getResult.ok) {
				expect(getResult.value).toBeNull();
			}
		});
	});

	describe("queryTasks", () => {
		beforeEach(async () => {
			await Planner.addTask(TEST_BASE, {
				title: "Inbox task 1",
				state: "inbox",
			});
			await Planner.addTask(TEST_BASE, {
				title: "Inbox task 2",
				state: "inbox",
			});
			await Planner.addTask(TEST_BASE, {
				title: "Next task",
				state: "next",
				priority: "high",
			});
			await Planner.addTask(TEST_BASE, { title: "Done task", state: "done" });
		});

		it("should query all open tasks", async () => {
			const result = await Planner.queryTasks(TEST_BASE);
			expect(result.ok).toBe(true);
			if (result.ok) {
				// Should exclude done tasks by default
				expect(result.value.length).toBe(3);
			}
		});

		it("should filter by state", async () => {
			const result = await Planner.queryTasks(TEST_BASE, { state: "inbox" });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(2);
				expect(result.value.every((t) => t.state === "inbox")).toBe(true);
			}
		});

		it("should filter by multiple states", async () => {
			const result = await Planner.queryTasks(TEST_BASE, {
				states: ["inbox", "next"],
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(3);
			}
		});

		it("should include closed tasks when requested", async () => {
			const result = await Planner.queryTasks(TEST_BASE, {
				includeClosed: true,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(4);
			}
		});

		it("should filter by priority", async () => {
			const result = await Planner.queryTasks(TEST_BASE, { priority: "high" });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(1);
				expect(result.value[0].title).toBe("Next task");
			}
		});

		it("should match scope family by scopeId (ignoring query params)", async () => {
			const baseScope = "jake://scope/shop";
			const scopedVariant =
				"jake://scope/shop?branch=main&package=shop-storefront";

			await Planner.addTask(TEST_BASE, {
				title: "Shop base",
				scopeUri: baseScope,
			});
			await Planner.addTask(TEST_BASE, {
				title: "Shop variant",
				scopeUri: scopedVariant,
			});

			const result = await Planner.queryTasks(TEST_BASE, {
				scopeUri: baseScope,
				includeClosed: true,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const titles = result.value.map((task) => task.title);
				expect(titles).toContain("Shop base");
				expect(titles).toContain("Shop variant");
			}
		});
	});

	describe("searchTasks", () => {
		beforeEach(async () => {
			await Planner.addTask(TEST_BASE, {
				title: "Fix authentication bug",
				description: "Users are getting logged out",
				tags: ["auth", "security"],
			});
			await Planner.addTask(TEST_BASE, {
				title: "Add login rate limiting",
				description: "Prevent brute force attacks",
				tags: ["auth", "security"],
			});
			await Planner.addTask(TEST_BASE, {
				title: "Update documentation",
				description: "Add API reference",
			});
		});

		it("should search by title", async () => {
			const result = await Planner.searchTasks(TEST_BASE, "authentication");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBeGreaterThan(0);
				expect(result.value[0].title).toContain("authentication");
			}
		});

		it("should search by description", async () => {
			const result = await Planner.searchTasks(TEST_BASE, "brute force");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(1);
				expect(result.value[0].title).toBe("Add login rate limiting");
			}
		});

		it("should return empty for no matches", async () => {
			const result = await Planner.searchTasks(TEST_BASE, "xyznonexistent");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(0);
			}
		});

		it("should search across scope variants sharing the same scopeId", async () => {
			await Planner.addTask(TEST_BASE, {
				title: "Shop scoped auth issue",
				scopeUri: "jake://scope/shop",
			});
			await Planner.addTask(TEST_BASE, {
				title: "Shop branch auth issue",
				scopeUri: "jake://scope/shop?branch=main&package=shop-storefront",
			});

			const result = await Planner.searchTasks(TEST_BASE, "auth", {
				scopeUri: "jake://scope/shop",
				limit: 50,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const titles = result.value.map((task) => task.title);
				expect(titles).toContain("Shop scoped auth issue");
				expect(titles).toContain("Shop branch auth issue");
			}
		});
	});

	describe("getToday", () => {
		beforeEach(async () => {
			const today = new Date().toISOString();
			const yesterday = new Date(Date.now() - 86400000).toISOString();
			const tomorrow = new Date(Date.now() + 86400000).toISOString();

			await Planner.addTask(TEST_BASE, {
				title: "Overdue task",
				deadline: yesterday,
			});
			await Planner.addTask(TEST_BASE, { title: "Due today", deadline: today });
			await Planner.addTask(TEST_BASE, { title: "Next action", state: "next" });
			await Planner.addTask(TEST_BASE, {
				title: "Future task",
				deadline: tomorrow,
			});
		});

		it("should return overdue, due today, and next tasks", async () => {
			const result = await Planner.getToday(TEST_BASE);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.overdue.length).toBeGreaterThanOrEqual(1);
				expect(result.value.next.length).toBeGreaterThanOrEqual(1);
			}
		});

		it("buckets a calendar-date deadline by its day, like a datetime due that day", async () => {
			const day = (offset: number): string =>
				new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
			await Planner.addTask(TEST_BASE, {
				title: "Date today",
				deadline: day(0),
			});
			await Planner.addTask(TEST_BASE, {
				title: "Date yesterday",
				deadline: day(-1),
			});
			await Planner.addTask(TEST_BASE, {
				title: "Date tomorrow",
				state: "next",
				deadline: day(1),
			});

			const result = await Planner.getToday(TEST_BASE);
			expect(result.ok).toBe(true);
			if (result.ok) {
				const titles = (tasks: Task[]) => tasks.map((task) => task.title);
				expect(titles(result.value.dueToday)).toContain("Date today");
				expect(titles(result.value.overdue)).not.toContain("Date today");
				expect(titles(result.value.overdue)).toContain("Date yesterday");
				expect(titles(result.value.next)).toContain("Date tomorrow");
			}
		});

		it("should apply scope filter by scope family", async () => {
			const today = new Date().toISOString();
			await Planner.addTask(TEST_BASE, {
				title: "Shop today base",
				deadline: today,
				scopeUri: "jake://scope/shop",
			});
			await Planner.addTask(TEST_BASE, {
				title: "Shop today variant",
				deadline: today,
				scopeUri: "jake://scope/shop?branch=main&package=shop-storefront",
			});

			const result = await Planner.getToday(TEST_BASE, {
				scopeUri: "jake://scope/shop",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const dueTodayTitles = result.value.dueToday.map((task) => task.title);
				expect(dueTodayTitles).toContain("Shop today base");
				expect(dueTodayTitles).toContain("Shop today variant");
			}
		});
	});

	describe("deadline ordering and filters", () => {
		it("sorts and filters a calendar date as the end of that day", async () => {
			await Planner.addTask(TEST_BASE, {
				title: "Date only",
				deadline: "2026-02-06",
			});
			await Planner.addTask(TEST_BASE, {
				title: "Morning of",
				deadline: "2026-02-06T10:00:00.000Z",
			});
			await Planner.addTask(TEST_BASE, {
				title: "Next day",
				deadline: "2026-02-07T01:00:00.000Z",
			});

			const sorted = await Planner.queryTasks(TEST_BASE, {
				orderBy: "deadline",
				orderDir: "asc",
			});
			expect(sorted.ok).toBe(true);
			if (sorted.ok)
				expect(sorted.value.map((task) => task.title)).toEqual([
					"Morning of",
					"Date only",
					"Next day",
				]);

			const dueByNoon = await Planner.queryTasks(TEST_BASE, {
				dueBefore: "2026-02-06T12:00:00.000Z",
			});
			expect(dueByNoon.ok).toBe(true);
			if (dueByNoon.ok)
				expect(dueByNoon.value.map((task) => task.title)).toEqual([
					"Morning of",
				]);
		});
	});

	describe("deadlines in the owner's zone", () => {
		const MONTREAL = "America/Montreal";
		// 23:30 on 2026-02-06 in Montreal, already 2026-02-07 in UTC.
		const lateEvening = Date.parse("2026-02-07T04:30:00.000Z");
		const titles = (tasks: Task[]) => tasks.map((task) => task.title);

		afterEach(() => configureTestRuntime());

		const seed = async (): Promise<void> => {
			const drafts: TaskDraft[] = [
				{ title: "date on the 6th", deadline: "2026-02-06" },
				{ title: "17:00 on the 6th", deadline: "2026-02-06T22:00:00.000Z" },
				{ title: "22:00 on the 6th", deadline: "2026-02-07T03:00:00.000Z" },
				{ title: "date on the 5th", deadline: "2026-02-05" },
				{ title: "23:00 on the 5th", deadline: "2026-02-06T04:00:00.000Z" },
				{ title: "date on the 7th", state: "next", deadline: "2026-02-07" },
				{
					title: "01:00 on the 7th",
					state: "next",
					deadline: "2026-02-07T06:00:00.000Z",
				},
			];
			for (const draft of drafts) await Planner.addTask(TEST_BASE, draft);
		};

		it("today is the owner's local day: at 23:30 a date due today is not overdue", async () => {
			await seed();
			const montreal = await Planner.getToday(TEST_BASE, {
				now: lateEvening,
				zone: MONTREAL,
			});
			expect(montreal.ok).toBe(true);
			if (montreal.ok) {
				expect(titles(montreal.value.dueToday)).toEqual([
					"17:00 on the 6th",
					"22:00 on the 6th",
					"date on the 6th",
				]);
				expect(titles(montreal.value.overdue)).toEqual([
					"23:00 on the 5th",
					"date on the 5th",
				]);
				expect(titles(montreal.value.next).sort()).toEqual([
					"01:00 on the 7th",
					"date on the 7th",
				]);
			}

			const utc = await Planner.getToday(TEST_BASE, {
				now: lateEvening,
				zone: "UTC",
			});
			expect(utc.ok).toBe(true);
			if (utc.ok) {
				expect(titles(utc.value.dueToday)).toEqual([
					"22:00 on the 6th",
					"01:00 on the 7th",
					"date on the 7th",
				]);
				expect(titles(utc.value.overdue)).toContain("date on the 6th");
			}
		});

		it("sorts by when each falls due in the runtime's zone, DST-aware", async () => {
			await seed();
			configureTestRuntime("", { timezone: () => MONTREAL });
			const sorted = await Planner.queryTasks(TEST_BASE, {
				orderBy: "deadline",
				orderDir: "asc",
			});
			expect(sorted.ok).toBe(true);
			if (sorted.ok)
				expect(titles(sorted.value)).toEqual([
					"23:00 on the 5th",
					"date on the 5th",
					"17:00 on the 6th",
					"22:00 on the 6th",
					"date on the 6th",
					"01:00 on the 7th",
					"date on the 7th",
				]);
		});

		it("a date bound covers its whole local day, and a date deadline ends with its day", async () => {
			await seed();
			configureTestRuntime("", { timezone: () => MONTREAL });
			const byThe6th = await Planner.queryTasks(TEST_BASE, {
				dueAfter: "2026-02-06",
				dueBefore: "2026-02-06",
				orderBy: "deadline",
				orderDir: "asc",
			});
			expect(byThe6th.ok).toBe(true);
			if (byThe6th.ok)
				expect(titles(byThe6th.value)).toEqual([
					"17:00 on the 6th",
					"22:00 on the 6th",
					"date on the 6th",
				]);

			// 20:00 local on the 6th: the date on the 6th is not due by then.
			const byEight = await Planner.queryTasks(TEST_BASE, {
				dueAfter: "2026-02-06",
				dueBefore: "2026-02-07T01:00:00.000Z",
			});
			expect(byEight.ok).toBe(true);
			if (byEight.ok)
				expect(titles(byEight.value)).toEqual(["17:00 on the 6th"]);
		});

		it("compares instants stored at different precisions as the same instant", async () => {
			await Planner.addTask(TEST_BASE, {
				title: "seconds",
				deadline: "2026-02-06T21:00:00Z",
			});
			const due = await Planner.queryTasks(TEST_BASE, {
				dueBefore: "2026-02-06T21:00:00.000Z",
			});
			expect(due.ok).toBe(true);
			if (due.ok) expect(titles(due.value)).toEqual(["seconds"]);
		});
	});

	// ----------------------------------------------------------
	// Task Links
	// ----------------------------------------------------------

	describe("links", () => {
		let taskAId: string;
		let taskBId: string;

		beforeEach(async () => {
			const resultA = await Planner.addTask(TEST_BASE, { title: "Task A" });
			const resultB = await Planner.addTask(TEST_BASE, { title: "Task B" });
			if (resultA.ok) taskAId = resultA.value.id;
			if (resultB.ok) taskBId = resultB.value.id;
		});

		it("should create a link between tasks", async () => {
			const draft: TaskLinkDraft = {
				sourceId: taskAId,
				targetId: taskBId,
				type: "blocks",
				note: "A blocks B",
			};
			const result = await Planner.addLink(TEST_BASE, draft);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.type).toBe("blocks");
				expect(result.value.sourceId).toBe(taskAId);
				expect(result.value.targetId).toBe(taskBId);
			}
		});

		it("should get links for a task", async () => {
			await Planner.addLink(TEST_BASE, {
				sourceId: taskAId,
				targetId: taskBId,
				type: "parent",
			});

			const result = await Planner.getLinksForTask(TEST_BASE, taskAId);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(1);
				expect(result.value[0].type).toBe("parent");
			}
		});

		it("should delete a link", async () => {
			const linkResult = await Planner.addLink(TEST_BASE, {
				sourceId: taskAId,
				targetId: taskBId,
				type: "related",
			});
			expect(linkResult.ok).toBe(true);
			if (!linkResult.ok) return;

			const deleteResult = await Planner.deleteLink(
				TEST_BASE,
				linkResult.value.id,
			);
			expect(deleteResult.ok).toBe(true);

			const linksResult = await Planner.getLinksForTask(TEST_BASE, taskAId);
			expect(linksResult.ok).toBe(true);
			if (linksResult.ok) {
				expect(linksResult.value.length).toBe(0);
			}
		});
	});

	// ----------------------------------------------------------
	// Stats & Utilities
	// ----------------------------------------------------------

	describe("stats", () => {
		beforeEach(async () => {
			await Planner.addTask(TEST_BASE, { title: "Task 1", state: "inbox" });
			await Planner.addTask(TEST_BASE, { title: "Task 2", state: "inbox" });
			await Planner.addTask(TEST_BASE, { title: "Task 3", state: "next" });
			await Planner.addTask(TEST_BASE, {
				title: "Task 4",
				state: "done",
				scopeUri: "jake://scope/github.com/user/repo",
			});
		});

		it("should return statistics", async () => {
			const result = await Planner.stats(TEST_BASE);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.totalTasks).toBe(4);
				expect(result.value.byState.inbox).toBe(2);
				expect(result.value.byState.next).toBe(1);
				expect(result.value.byState.done).toBe(1);
				expect(result.value.byScope["github.com/user/repo"]).toBe(1);
			}
		});

		it("merges scope_uri variants into one scope in listScopes", async () => {
			await Planner.addTask(TEST_BASE, {
				title: "Branch variant",
				scopeUri: "jake://scope/github.com/user/repo?branch=main&package=repo",
			});
			await Planner.addTask(TEST_BASE, {
				title: "Encoded variant",
				scopeUri: "jake://scope/github.com%2Fuser%2Frepo",
			});

			const result = await Planner.listScopes(TEST_BASE);
			expect(result.ok).toBe(true);
			if (result.ok) {
				const repoScopes = result.value.filter(
					(s) => s.scopeId === "github.com/user/repo",
				);
				expect(repoScopes).toHaveLength(1);
				expect(repoScopes[0]?.count).toBe(3);
				expect(repoScopes[0]?.scopeUri).toBe(
					"jake://scope/github.com%2Fuser%2Frepo",
				);
			}
		});
	});
});
