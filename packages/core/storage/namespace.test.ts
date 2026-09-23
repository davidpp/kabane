import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withDb } from "../runtime";

import type {
	FocusListDraft,
	ProposalDraft,
	TaskDraft,
	TaskLinkDraft,
	TaskUpdate,
} from "../schemas";
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
			const path = "/Users/davidpaquet/Projects/botpress";
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
			const baseScope = "jake://scope/desk";
			const scopedVariant =
				"jake://scope/desk?branch=main&package=botpress-support-desk";

			await Planner.addTask(TEST_BASE, {
				title: "Desk base",
				scopeUri: baseScope,
			});
			await Planner.addTask(TEST_BASE, {
				title: "Desk variant",
				scopeUri: scopedVariant,
			});

			const result = await Planner.queryTasks(TEST_BASE, {
				scopeUri: baseScope,
				includeClosed: true,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const titles = result.value.map((task) => task.title);
				expect(titles).toContain("Desk base");
				expect(titles).toContain("Desk variant");
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
				title: "Desk scoped auth issue",
				scopeUri: "jake://scope/desk",
			});
			await Planner.addTask(TEST_BASE, {
				title: "Desk branch auth issue",
				scopeUri: "jake://scope/desk?branch=main&package=botpress-support-desk",
			});

			const result = await Planner.searchTasks(TEST_BASE, "auth", {
				scopeUri: "jake://scope/desk",
				limit: 50,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const titles = result.value.map((task) => task.title);
				expect(titles).toContain("Desk scoped auth issue");
				expect(titles).toContain("Desk branch auth issue");
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

		it("should apply scope filter by scope family", async () => {
			const today = new Date().toISOString();
			await Planner.addTask(TEST_BASE, {
				title: "Desk today base",
				deadline: today,
				scopeUri: "jake://scope/desk",
			});
			await Planner.addTask(TEST_BASE, {
				title: "Desk today variant",
				deadline: today,
				scopeUri: "jake://scope/desk?branch=main&package=botpress-support-desk",
			});

			const result = await Planner.getToday(TEST_BASE, {
				scopeUri: "jake://scope/desk",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				const dueTodayTitles = result.value.dueToday.map((task) => task.title);
				expect(dueTodayTitles).toContain("Desk today base");
				expect(dueTodayTitles).toContain("Desk today variant");
			}
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
	// Focus Lists
	// ----------------------------------------------------------

	describe("focus lists", () => {
		it("should save a focus list", async () => {
			const draft: FocusListDraft = {
				period: "daily",
				items: [
					{ taskId: "task-1", order: 0, completed: false },
					{ taskId: "task-2", order: 1, completed: false },
				],
				theme: "Shipping features",
			};

			const result = await Planner.saveFocusList(TEST_BASE, draft);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.period).toBe("daily");
				expect(result.value.items.length).toBe(2);
				expect(result.value.theme).toBe("Shipping features");
			}
		});

		it("should get a focus list by period", async () => {
			await Planner.saveFocusList(TEST_BASE, {
				period: "daily",
				items: [{ taskId: "task-1", order: 0, completed: false }],
			});

			const result = await Planner.getFocusList(TEST_BASE, "daily");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).not.toBeNull();
				expect(result.value?.items.length).toBe(1);
			}
		});

		it("should update a focus list", async () => {
			await Planner.saveFocusList(TEST_BASE, {
				period: "daily",
				items: [{ taskId: "task-1", order: 0, completed: false }],
			});

			const updateResult = await Planner.updateFocusList(TEST_BASE, "daily", {
				items: [{ taskId: "task-1", order: 0, completed: true }],
				reflection: "Good progress today!",
			});
			expect(updateResult.ok).toBe(true);
			if (updateResult.ok) {
				expect(updateResult.value?.items[0].completed).toBe(true);
				expect(updateResult.value?.reflection).toBe("Good progress today!");
			}
		});

		it("should return null for non-existent focus list", async () => {
			// Weekly focus hasn't been created in this test
			const result = await Planner.getFocusList(TEST_BASE, "weekly");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBeNull();
			}
		});
	});

	// ----------------------------------------------------------
	// Proposals
	// ----------------------------------------------------------

	describe("proposals", () => {
		const draft: ProposalDraft = {
			action: "ask_question",
			confidence: 0.85,
			summary: "Which client should we prioritize?",
			reasoning: "Ambiguity detected in transcript",
			payload: {
				action: "ask_question",
				question: "Which client should we prioritize?",
			},
		};

		it("should create a proposal", async () => {
			const result = await Planner.addProposal(TEST_BASE, draft);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.id).toBeDefined();
				expect(result.value.status).toBe("pending");
				expect(result.value.action).toBe("ask_question");
				expect(result.value.confidence).toBe(0.85);
			}
		});

		it("should get a proposal by ID", async () => {
			const addResult = await Planner.addProposal(TEST_BASE, draft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const result = await Planner.getProposal(TEST_BASE, addResult.value.id);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value?.summary).toBe(
					"Which client should we prioritize?",
				);
			}
		});

		it("should query pending proposals", async () => {
			await Planner.addProposal(TEST_BASE, draft);
			await Planner.addProposal(TEST_BASE, {
				...draft,
				summary: "Another proposal",
			});

			const result = await Planner.queryProposals(TEST_BASE, {
				status: "pending",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(2);
				expect(result.value.every((p) => p.status === "pending")).toBe(true);
			}
		});

		it("should filter by minimum confidence", async () => {
			await Planner.addProposal(TEST_BASE, { ...draft, confidence: 0.5 });
			await Planner.addProposal(TEST_BASE, { ...draft, confidence: 0.9 });

			const result = await Planner.queryProposals(TEST_BASE, {
				minConfidence: 0.8,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(1);
				expect(result.value[0].confidence).toBeGreaterThanOrEqual(0.8);
			}
		});

		it("should approve a proposal", async () => {
			const addResult = await Planner.addProposal(TEST_BASE, draft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const approveResult = await Planner.approveProposal(
				TEST_BASE,
				addResult.value.id,
				"Looks good!",
			);
			expect(approveResult.ok).toBe(true);
			if (approveResult.ok) {
				expect(approveResult.value?.status).toBe("approved");
				expect(approveResult.value?.reviewedAt).toBeDefined();
				expect(approveResult.value?.reviewNotes).toBe("Looks good!");
			}
		});

		it("should reject a proposal", async () => {
			const addResult = await Planner.addProposal(TEST_BASE, draft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const rejectResult = await Planner.rejectProposal(
				TEST_BASE,
				addResult.value.id,
				"Not relevant",
			);
			expect(rejectResult.ok).toBe(true);
			if (rejectResult.ok) {
				expect(rejectResult.value?.status).toBe("rejected");
				expect(rejectResult.value?.reviewNotes).toBe("Not relevant");
			}
		});

		it("should reopen an approved proposal back to pending", async () => {
			const addResult = await Planner.addProposal(TEST_BASE, draft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			// Approve it
			await Planner.approveProposal(
				TEST_BASE,
				addResult.value.id,
				"Looks good",
			);

			// Reopen it
			const reopenResult = await Planner.reopenProposal(
				TEST_BASE,
				addResult.value.id,
			);
			expect(reopenResult.ok).toBe(true);
			if (reopenResult.ok) {
				expect(reopenResult.value?.status).toBe("pending");
				expect(reopenResult.value?.reviewedAt).toBeFalsy();
				expect(reopenResult.value?.reviewNotes).toBeFalsy();
			}
		});

		it("should reopen a rejected proposal back to pending", async () => {
			const addResult = await Planner.addProposal(TEST_BASE, draft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			// Reject it
			await Planner.rejectProposal(TEST_BASE, addResult.value.id, "Not now");

			// Reopen it
			const reopenResult = await Planner.reopenProposal(
				TEST_BASE,
				addResult.value.id,
			);
			expect(reopenResult.ok).toBe(true);
			if (reopenResult.ok) {
				expect(reopenResult.value?.status).toBe("pending");
				expect(reopenResult.value?.reviewedAt).toBeFalsy();
				expect(reopenResult.value?.reviewNotes).toBeFalsy();
			}
		});

		it("should return null when reopening nonexistent proposal", async () => {
			const reopenResult = await Planner.reopenProposal(
				TEST_BASE,
				"nonexistent-id",
			);
			expect(reopenResult.ok).toBe(true);
			if (reopenResult.ok) {
				expect(reopenResult.value).toBe(null);
			}
		});

		it("should fail when reopening an already-pending proposal", async () => {
			const addResult = await Planner.addProposal(TEST_BASE, draft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			// Try to reopen a pending proposal - should fail
			const reopenResult = await Planner.reopenProposal(
				TEST_BASE,
				addResult.value.id,
			);
			expect(reopenResult.ok).toBe(false);
			if (!reopenResult.ok) {
				expect(reopenResult.error.message).toContain("Cannot reopen proposal");
				expect(reopenResult.error.message).toContain("pending");
			}
		});

		it("should fail when reopening an expired proposal", async () => {
			const addResult = await Planner.addProposal(TEST_BASE, draft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			// Set status to 'expired' directly via DB (bypassing the storage API)
			await withDb(TEST_BASE, (db) => {
				db.run("UPDATE proposals SET status = 'expired' WHERE id = ?", [
					addResult.value.id,
				]);
			});

			// Try to reopen an expired proposal - should fail
			const reopenResult = await Planner.reopenProposal(
				TEST_BASE,
				addResult.value.id,
			);
			expect(reopenResult.ok).toBe(false);
			if (!reopenResult.ok) {
				expect(reopenResult.error.message).toContain("Cannot reopen proposal");
				expect(reopenResult.error.message).toContain("expired");
			}
		});

		it("should fail when reopening a superseded proposal", async () => {
			const addResult = await Planner.addProposal(TEST_BASE, draft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			// Set status to 'superseded' directly via DB (bypassing the storage API)
			await withDb(TEST_BASE, (db) => {
				db.run("UPDATE proposals SET status = 'superseded' WHERE id = ?", [
					addResult.value.id,
				]);
			});

			// Try to reopen a superseded proposal - should fail
			const reopenResult = await Planner.reopenProposal(
				TEST_BASE,
				addResult.value.id,
			);
			expect(reopenResult.ok).toBe(false);
			if (!reopenResult.ok) {
				expect(reopenResult.error.message).toContain("Cannot reopen proposal");
				expect(reopenResult.error.message).toContain("superseded");
			}
		});

		it("should create ask_question proposal with choices", async () => {
			const askQuestionDraft: ProposalDraft = {
				action: "ask_question",
				confidence: 1.0,
				summary: "What priority should this task have?",
				payload: {
					action: "ask_question",
					question: "What priority should this task have?",
					choices: ["high", "medium", "low"],
					allowFreeform: true,
					questionIndex: 1,
					totalQuestions: 3,
				},
				sessionId: "test-session-123",
			};

			const result = await Planner.addProposal(TEST_BASE, askQuestionDraft);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.action).toBe("ask_question");
				expect(result.value.payload.action).toBe("ask_question");
				if (result.value.payload.action === "ask_question") {
					expect(result.value.payload.question).toBe(
						"What priority should this task have?",
					);
					expect(result.value.payload.choices).toEqual([
						"high",
						"medium",
						"low",
					]);
					expect(result.value.payload.allowFreeform).toBe(true);
					expect(result.value.payload.questionIndex).toBe(1);
					expect(result.value.payload.totalQuestions).toBe(3);
				}
			}
		});

		it("should approve ask_question proposal with answer stored in reviewNotes", async () => {
			const askQuestionDraft: ProposalDraft = {
				action: "ask_question",
				confidence: 1.0,
				summary: "Pick a priority",
				payload: {
					action: "ask_question",
					question: "Pick a priority",
					choices: ["high", "medium", "low"],
				},
				sessionId: "test-session-456", // Added for consistency with first test
			};

			const addResult = await Planner.addProposal(TEST_BASE, askQuestionDraft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			// Approve with answer - the answer is stored in reviewNotes
			const approveResult = await Planner.approveProposal(
				TEST_BASE,
				addResult.value.id,
				"high", // This is the answer
			);
			expect(approveResult.ok).toBe(true);
			if (approveResult.ok) {
				expect(approveResult.value?.status).toBe("approved");
				expect(approveResult.value?.reviewNotes).toBe("high");
				expect(approveResult.value?.reviewedAt).toBeDefined();
			}
		});

		it("should create ask_question proposal with empty choices array (freeform only)", async () => {
			const freeformOnlyDraft: ProposalDraft = {
				action: "ask_question",
				confidence: 1.0,
				summary: "Describe the issue",
				payload: {
					action: "ask_question",
					question: "Please describe the issue in your own words",
					choices: [], // Empty choices - freeform only mode
					allowFreeform: true,
				},
				sessionId: "test-session-freeform",
			};

			const result = await Planner.addProposal(TEST_BASE, freeformOnlyDraft);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.action).toBe("ask_question");
				if (result.value.payload.action === "ask_question") {
					expect(result.value.payload.choices).toEqual([]);
					expect(result.value.payload.allowFreeform).toBe(true);
				}
			}
		});

		it("should create ask_question proposal without choices (undefined choices, freeform only)", async () => {
			const freeformOnlyDraft: ProposalDraft = {
				action: "ask_question",
				confidence: 1.0,
				summary: "Open-ended question",
				payload: {
					action: "ask_question",
					question: "What would you like to focus on today?",
					// No choices field - allowFreeform defaults at UI level when undefined
				},
				sessionId: "test-session-open",
			};

			const result = await Planner.addProposal(TEST_BASE, freeformOnlyDraft);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.action).toBe("ask_question");
				if (result.value.payload.action === "ask_question") {
					expect(result.value.payload.choices).toBeUndefined();
					// allowFreeform is undefined in storage; UI component defaults to true
					// See QuestionCard.tsx line 47: const allowFreeform = payload.allowFreeform ?? true;
					expect(result.value.payload.allowFreeform).toBeUndefined();
				}
			}
		});

		it("should reject ask_question proposal (skip functionality)", async () => {
			const askQuestionDraft: ProposalDraft = {
				action: "ask_question",
				confidence: 1.0,
				summary: "Skippable question",
				payload: {
					action: "ask_question",
					question: "Optional: Any additional context?",
					choices: ["Yes, let me explain", "No, continue"],
					allowFreeform: true,
				},
				sessionId: "test-session-skip",
			};

			const addResult = await Planner.addProposal(TEST_BASE, askQuestionDraft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			// Reject (skip) the question
			const rejectResult = await Planner.rejectProposal(
				TEST_BASE,
				addResult.value.id,
				"User skipped this question",
			);
			expect(rejectResult.ok).toBe(true);
			if (rejectResult.ok) {
				expect(rejectResult.value?.status).toBe("rejected");
				expect(rejectResult.value?.reviewNotes).toBe(
					"User skipped this question",
				);
				expect(rejectResult.value?.reviewedAt).toBeDefined();
			}
		});

		it("should approve ask_question with freeform text answer", async () => {
			const askQuestionDraft: ProposalDraft = {
				action: "ask_question",
				confidence: 1.0,
				summary: "Custom input question",
				payload: {
					action: "ask_question",
					question: "How should we proceed?",
					choices: ["Option A", "Option B"],
					allowFreeform: true,
				},
				sessionId: "test-session-freeform-answer",
			};

			const addResult = await Planner.addProposal(TEST_BASE, askQuestionDraft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			// Approve with custom freeform answer (not one of the choices)
			const freeformAnswer =
				"Actually, let's do something different: merge both options";
			const approveResult = await Planner.approveProposal(
				TEST_BASE,
				addResult.value.id,
				freeformAnswer,
			);
			expect(approveResult.ok).toBe(true);
			if (approveResult.ok) {
				expect(approveResult.value?.status).toBe("approved");
				expect(approveResult.value?.reviewNotes).toBe(freeformAnswer);
			}
		});

		it("should create proposal with taskId", async () => {
			const draftWithTask: ProposalDraft = {
				action: "ask_question",
				confidence: 1.0,
				summary: "Question for JJAK-123",
				taskId: "task-ulid-123",
				payload: {
					action: "ask_question",
					question: "Which approach should we use?",
					choices: ["A", "B", "C"],
				},
			};

			const result = await Planner.addProposal(TEST_BASE, draftWithTask);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.taskId).toBe("task-ulid-123");
			}
		});

		it("should filter proposals by taskId", async () => {
			// Create proposals for different tasks
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Question for task A",
				taskId: "task-a",
				payload: {
					action: "ask_question",
					question: "Q1?",
				},
			});
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Question for task A again",
				taskId: "task-a",
				payload: {
					action: "ask_question",
					question: "Q2?",
				},
			});
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Question for task B",
				taskId: "task-b",
				payload: {
					action: "ask_question",
					question: "Q3?",
				},
			});
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 0.8,
				summary: "Orphan proposal (no taskId)",
				payload: {
					action: "ask_question",
					question: "Orphan question?",
				},
			});

			// Query by taskId
			const taskAResult = await Planner.queryProposals(TEST_BASE, {
				taskId: "task-a",
			});
			expect(taskAResult.ok).toBe(true);
			if (taskAResult.ok) {
				expect(taskAResult.value.length).toBe(2);
				expect(taskAResult.value.every((p) => p.taskId === "task-a")).toBe(
					true,
				);
			}

			const taskBResult = await Planner.queryProposals(TEST_BASE, {
				taskId: "task-b",
			});
			expect(taskBResult.ok).toBe(true);
			if (taskBResult.ok) {
				expect(taskBResult.value.length).toBe(1);
				expect(taskBResult.value[0].taskId).toBe("task-b");
			}
		});

		it("should get all proposals for a task (pending + resolved)", async () => {
			// Create proposals for a task with different statuses
			const p1 = await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Pending question",
				taskId: "task-timeline",
				payload: {
					action: "ask_question",
					question: "Still pending?",
				},
			});

			const p2 = await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "To be approved",
				taskId: "task-timeline",
				payload: {
					action: "ask_question",
					question: "Approve this?",
				},
			});

			const p3 = await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "To be rejected",
				taskId: "task-timeline",
				payload: {
					action: "ask_question",
					question: "Reject this?",
				},
			});

			expect(p1.ok && p2.ok && p3.ok).toBe(true);
			if (!p1.ok || !p2.ok || !p3.ok) return;

			// Approve one, reject one
			await Planner.approveProposal(TEST_BASE, p2.value.id, "Yes");
			await Planner.rejectProposal(TEST_BASE, p3.value.id, "No");

			// getProposalsForTask should return all 3
			const result = await Planner.getProposalsForTask(
				TEST_BASE,
				"task-timeline",
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(3);
				const statuses = result.value.map((p) => p.status).sort();
				expect(statuses).toEqual(["approved", "pending", "rejected"]);
			}
		});

		it("should find proposals by ULID when stored with short ID (ID format mismatch)", async () => {
			// Create a real task so we have a ULID ↔ short ID mapping
			const taskResult = await Planner.addTask(TEST_BASE, {
				title: "Task for proposal ID test",
			});
			expect(taskResult.ok).toBe(true);
			if (!taskResult.ok) return;
			const task = taskResult.value;
			expect(task.shortId).toBeDefined();
			if (!task.shortId) return;

			// Simulate the old behavior: store proposal with short ID directly
			// (This is what the CLI did before the fix)
			const proposalResult = await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Question stored with short ID",
				taskId: task.shortId,
				payload: {
					action: "ask_question",
					question: "Will this be found by ULID?",
				},
			});
			expect(proposalResult.ok).toBe(true);

			// Query with ULID (as the dashboard does) — should find the proposal
			const result = await Planner.getProposalsForTask(TEST_BASE, task.id);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBeGreaterThanOrEqual(1);
				expect(
					result.value.some(
						(p) => p.summary === "Question stored with short ID",
					),
				).toBe(true);
			}

			// Query with short ID should also work
			const shortResult = await Planner.getProposalsForTask(
				TEST_BASE,
				task.shortId,
			);
			expect(shortResult.ok).toBe(true);
			if (shortResult.ok) {
				expect(shortResult.value.length).toBeGreaterThanOrEqual(1);
			}
		});

		it("addProposal should normalize short ID taskId to ULID", async () => {
			// Create a real task
			const taskResult = await Planner.addTask(TEST_BASE, {
				title: "Task for normalization test",
			});
			expect(taskResult.ok).toBe(true);
			if (!taskResult.ok) return;
			const task = taskResult.value;
			if (!task.shortId) return;

			// Add proposal with short ID — should be stored as ULID
			const proposalResult = await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Normalized proposal",
				taskId: task.shortId,
				payload: {
					action: "ask_question",
					question: "Is this normalized?",
				},
			});
			expect(proposalResult.ok).toBe(true);
			if (proposalResult.ok) {
				// The returned taskId should be the ULID, not the short ID
				expect(proposalResult.value.taskId).toBe(task.id);
			}
		});

		it("should support arbitrary taskId strings (for legacy proposals)", async () => {
			// Create a proposal with an arbitrary taskId (legacy behavior)
			// This tests that getProposalsForTask handles non-ULID, non-shortId strings
			const legacyTaskId = "custom-task-id-12345";
			const proposalResult = await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Legacy proposal with arbitrary taskId",
				taskId: legacyTaskId,
				payload: {
					action: "ask_question",
					question: "Will this work?",
				},
			});
			expect(proposalResult.ok).toBe(true);

			// Query with the same arbitrary string should find it
			const result = await Planner.getProposalsForTask(TEST_BASE, legacyTaskId);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(1);
				expect(result.value[0].summary).toBe(
					"Legacy proposal with arbitrary taskId",
				);
			}

			// Query with different arbitrary string returns empty (no match)
			const noMatchResult = await Planner.getProposalsForTask(
				TEST_BASE,
				"different-task-id",
			);
			expect(noMatchResult.ok).toBe(true);
			if (noMatchResult.ok) {
				expect(noMatchResult.value).toEqual([]);
			}
		});

		it("should create ask_question proposal with multiSelect enabled", async () => {
			const multiSelectDraft: ProposalDraft = {
				action: "ask_question",
				confidence: 1.0,
				summary: "Multi-select question",
				payload: {
					action: "ask_question",
					question: "Which features should we implement?",
					choices: ["Auth", "Dashboard", "API", "Docs"],
					multiSelect: true,
					allowFreeform: true,
				},
				sessionId: "test-session-multiselect",
			};

			const result = await Planner.addProposal(TEST_BASE, multiSelectDraft);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.action).toBe("ask_question");
				if (result.value.payload.action === "ask_question") {
					expect(result.value.payload.question).toBe(
						"Which features should we implement?",
					);
					expect(result.value.payload.choices).toEqual([
						"Auth",
						"Dashboard",
						"API",
						"Docs",
					]);
					expect(result.value.payload.multiSelect).toBe(true);
					expect(result.value.payload.allowFreeform).toBe(true);
				}
			}
		});

		it("should approve multi-select question with JSON array answer", async () => {
			const multiSelectDraft: ProposalDraft = {
				action: "ask_question",
				confidence: 1.0,
				summary: "Pick multiple options",
				payload: {
					action: "ask_question",
					question: "Select all that apply:",
					choices: ["Option A", "Option B", "Option C"],
					multiSelect: true,
				},
				sessionId: "test-session-multiselect-answer",
			};

			const addResult = await Planner.addProposal(TEST_BASE, multiSelectDraft);
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			// Multi-select answers are stored as JSON arrays
			const multiAnswer = JSON.stringify(["Option A", "Option C"]);
			const approveResult = await Planner.approveProposal(
				TEST_BASE,
				addResult.value.id,
				multiAnswer,
			);
			expect(approveResult.ok).toBe(true);
			if (approveResult.ok) {
				expect(approveResult.value?.status).toBe("approved");
				expect(approveResult.value?.reviewNotes).toBe(multiAnswer);
				// Verify it parses back to an array
				const parsed = JSON.parse(approveResult.value?.reviewNotes ?? "[]");
				expect(parsed).toEqual(["Option A", "Option C"]);
			}
		});

		it("should allow multiSelect to be undefined (UI defaults to false)", async () => {
			const defaultDraft: ProposalDraft = {
				action: "ask_question",
				confidence: 1.0,
				summary: "Single-select question",
				payload: {
					action: "ask_question",
					question: "Pick one:",
					choices: ["A", "B"],
					// multiSelect not specified - stored as undefined, UI defaults to false
				},
				sessionId: "test-session-default",
			};

			const result = await Planner.addProposal(TEST_BASE, defaultDraft);
			expect(result.ok).toBe(true);
			if (result.ok && result.value.payload.action === "ask_question") {
				// multiSelect is undefined when not specified (UI component defaults to false)
				// See QuestionCard.tsx: const multiSelect = payload.multiSelect ?? false;
				expect(result.value.payload.multiSelect).toBeUndefined();
			}
		});

		it("should add timeline comment when approving ask_question with taskId", async () => {
			// First create a task to attach the proposal to
			const taskResult = await Planner.addTask(TEST_BASE, {
				title: "Test task for proposal",
			});
			expect(taskResult.ok).toBe(true);
			if (!taskResult.ok) return;
			const taskId = taskResult.value.id;

			// Create ask_question proposal linked to the task
			const proposalResult = await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Question for timeline test",
				taskId,
				payload: {
					action: "ask_question",
					question: "Which approach should we use?",
					choices: ["A", "B"],
				},
			});
			expect(proposalResult.ok).toBe(true);
			if (!proposalResult.ok) return;

			// Approve the proposal
			const approveResult = await Planner.approveProposal(
				TEST_BASE,
				proposalResult.value.id,
				"Option A",
			);
			expect(approveResult.ok).toBe(true);

			// Check that a comment was added to the task
			const commentsResult = await Planner.getComments(TEST_BASE, taskId);
			expect(commentsResult.ok).toBe(true);
			if (commentsResult.ok) {
				expect(commentsResult.value.length).toBe(1);
				expect(commentsResult.value[0].author).toBe("system");
				expect(commentsResult.value[0].content).toContain(
					"**Question:** Which approach should we use?",
				);
				expect(commentsResult.value[0].content).toContain(
					"**Answer:** Option A",
				);
			}
		});

		it("should add timeline comment when rejecting ask_question with taskId", async () => {
			// First create a task to attach the proposal to
			const taskResult = await Planner.addTask(TEST_BASE, {
				title: "Test task for rejection",
			});
			expect(taskResult.ok).toBe(true);
			if (!taskResult.ok) return;
			const taskId = taskResult.value.id;

			// Create ask_question proposal linked to the task
			const proposalResult = await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Question to be skipped",
				taskId,
				payload: {
					action: "ask_question",
					question: "Should we continue?",
					choices: ["Yes", "No"],
				},
			});
			expect(proposalResult.ok).toBe(true);
			if (!proposalResult.ok) return;

			// Reject the proposal
			const rejectResult = await Planner.rejectProposal(
				TEST_BASE,
				proposalResult.value.id,
				"Not relevant",
			);
			expect(rejectResult.ok).toBe(true);

			// Check that a comment was added to the task
			const commentsResult = await Planner.getComments(TEST_BASE, taskId);
			expect(commentsResult.ok).toBe(true);
			if (commentsResult.ok) {
				expect(commentsResult.value.length).toBe(1);
				expect(commentsResult.value[0].author).toBe("system");
				expect(commentsResult.value[0].content).toContain(
					"**Question:** Should we continue?",
				);
				expect(commentsResult.value[0].content).toContain("*Skipped*");
				expect(commentsResult.value[0].content).toContain("Not relevant");
			}
		});

		it("should NOT add timeline comment for proposals without taskId", async () => {
			// Create ask_question proposal without taskId
			const proposalResult = await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Orphan question",
				payload: {
					action: "ask_question",
					question: "This has no task",
				},
			});
			expect(proposalResult.ok).toBe(true);
			if (!proposalResult.ok) return;

			// Approve the proposal - should not throw
			const approveResult = await Planner.approveProposal(
				TEST_BASE,
				proposalResult.value.id,
				"Some answer",
			);
			expect(approveResult.ok).toBe(true);
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
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 0.8,
				summary: "Pending proposal",
				payload: {
					action: "ask_question",
					question: "Pending question?",
				},
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
				expect(result.value.totalProposals).toBe(1);
				expect(result.value.pendingProposals).toBe(1);
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

	describe("getQuestionGroup", () => {
		it("should return proposals matching groupId sorted by questionIndex", async () => {
			const groupId = "test-group-123";

			// Create 3 proposals with the same groupId
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Question 3",
				payload: {
					action: "ask_question",
					question: "Question 3?",
					allowFreeform: true,
					multiSelect: false,
					groupId,
					questionIndex: 2,
					totalQuestions: 3,
				},
			});
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Question 1",
				payload: {
					action: "ask_question",
					question: "Question 1?",
					allowFreeform: true,
					multiSelect: false,
					groupId,
					questionIndex: 0,
					totalQuestions: 3,
				},
			});
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Question 2",
				payload: {
					action: "ask_question",
					question: "Question 2?",
					allowFreeform: true,
					multiSelect: false,
					groupId,
					questionIndex: 1,
					totalQuestions: 3,
				},
			});

			// Also create one with a different groupId (should not be returned)
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Other group",
				payload: {
					action: "ask_question",
					question: "Other?",
					allowFreeform: true,
					multiSelect: false,
					groupId: "other-group",
					questionIndex: 0,
					totalQuestions: 1,
				},
			});

			const result = await Planner.getQuestionGroup(TEST_BASE, groupId);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toHaveLength(3);
				expect(result.value[0].summary).toBe("Question 1");
				expect(result.value[1].summary).toBe("Question 2");
				expect(result.value[2].summary).toBe("Question 3");
			}
		});

		it("should return empty array for unknown groupId", async () => {
			const result = await Planner.getQuestionGroup(
				TEST_BASE,
				"nonexistent-group",
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toHaveLength(0);
			}
		});
	});

	describe("resolveQuestionGroup", () => {
		it("should approve pending proposals with defaultAnswer", async () => {
			const groupId = "resolve-test-group";

			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Q1",
				payload: {
					action: "ask_question",
					question: "Which DB?",
					allowFreeform: true,
					multiSelect: false,
					groupId,
					questionIndex: 0,
					totalQuestions: 2,
					defaultAnswer: "SQLite",
				},
			});
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Q2",
				payload: {
					action: "ask_question",
					question: "Which cache?",
					allowFreeform: true,
					multiSelect: false,
					groupId,
					questionIndex: 1,
					totalQuestions: 2,
					defaultAnswer: "Redis",
				},
			});

			const result = await Planner.resolveQuestionGroup(TEST_BASE, groupId);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.resolved).toBe(2);
				expect(result.value.skipped).toBe(0);
			}

			// Verify proposals are approved with default answers
			const group = await Planner.getQuestionGroup(TEST_BASE, groupId);
			expect(group.ok).toBe(true);
			if (group.ok) {
				expect(group.value[0].status).toBe("approved");
				expect(group.value[0].reviewNotes).toBe("SQLite");
				expect(group.value[1].status).toBe("approved");
				expect(group.value[1].reviewNotes).toBe("Redis");
			}
		});

		it("should skip proposals without defaultAnswer", async () => {
			const groupId = "skip-no-default";

			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Q with default",
				payload: {
					action: "ask_question",
					question: "Q1?",
					allowFreeform: true,
					multiSelect: false,
					groupId,
					questionIndex: 0,
					totalQuestions: 2,
					defaultAnswer: "Yes",
				},
			});
			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Q without default",
				payload: {
					action: "ask_question",
					question: "Q2?",
					allowFreeform: true,
					multiSelect: false,
					groupId,
					questionIndex: 1,
					totalQuestions: 2,
				},
			});

			const result = await Planner.resolveQuestionGroup(TEST_BASE, groupId);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.resolved).toBe(1);
				expect(result.value.skipped).toBe(1);
			}
		});

		it("should skip already-resolved proposals", async () => {
			const groupId = "skip-resolved";

			const p1 = await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Already answered",
				payload: {
					action: "ask_question",
					question: "Q1?",
					allowFreeform: true,
					multiSelect: false,
					groupId,
					questionIndex: 0,
					totalQuestions: 2,
					defaultAnswer: "Default 1",
				},
			});

			// Approve the first one manually
			if (p1.ok) {
				await Planner.approveProposal(TEST_BASE, p1.value.id, "Custom answer");
			}

			await Planner.addProposal(TEST_BASE, {
				action: "ask_question",
				confidence: 1.0,
				summary: "Still pending",
				payload: {
					action: "ask_question",
					question: "Q2?",
					allowFreeform: true,
					multiSelect: false,
					groupId,
					questionIndex: 1,
					totalQuestions: 2,
					defaultAnswer: "Default 2",
				},
			});

			const result = await Planner.resolveQuestionGroup(TEST_BASE, groupId);
			expect(result.ok).toBe(true);
			if (result.ok) {
				// First already approved (excluded from pending), second resolved from default
				expect(result.value.resolved).toBe(1);
				expect(result.value.skipped).toBe(0);
			}

			// Verify first proposal keeps its custom answer
			const group = await Planner.getQuestionGroup(TEST_BASE, groupId);
			if (group.ok) {
				expect(group.value[0].reviewNotes).toBe("Custom answer");
				expect(group.value[1].reviewNotes).toBe("Default 2");
			}
		});
	});
});
