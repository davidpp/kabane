import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ProjectDraft } from "../schemas";
import { Planner } from "./index";

const TEST_BASE = join(import.meta.dir, ".test-data-projects");

describe("Planner — Projects", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });

		await Planner.init(TEST_BASE);
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	// ----------------------------------------------------------
	// CRUD
	// ----------------------------------------------------------

	describe("addProject", () => {
		const draft: ProjectDraft = {
			title: "Auth Rewrite",
			description: "Rewrite the auth module for compliance",
		};

		it("should create a project with defaults", async () => {
			const result = await Planner.addProject(TEST_BASE, draft);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.id).toBeDefined();
				expect(result.value.shortId).toBeDefined();
				expect(result.value.title).toBe("Auth Rewrite");
				expect(result.value.state).toBe("active");
			}
		});

		it("should create a project with explicit state", async () => {
			const result = await Planner.addProject(TEST_BASE, {
				...draft,
				state: "someday",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.state).toBe("someday");
			}
		});

		it("should reject invalid draft (empty title)", async () => {
			const invalid = { title: "" } as ProjectDraft;
			const result = await Planner.addProject(TEST_BASE, invalid);
			expect(result.ok).toBe(false);
		});
	});

	describe("getProject", () => {
		it("should retrieve by ULID", async () => {
			const addResult = await Planner.addProject(TEST_BASE, {
				title: "Dashboard v2",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const result = await Planner.getProject(TEST_BASE, addResult.value.id);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value?.title).toBe("Dashboard v2");
			}
		});

		it("should retrieve by shortId", async () => {
			const addResult = await Planner.addProject(TEST_BASE, {
				title: "Dashboard v2",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;
			expect(addResult.value.shortId).toBeDefined();

			const result = await Planner.getProject(
				TEST_BASE,
				addResult.value.shortId as string,
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value?.title).toBe("Dashboard v2");
			}
		});

		it("should return null for nonexistent project", async () => {
			const result = await Planner.getProject(TEST_BASE, "nonexistent");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBeNull();
			}
		});
	});

	describe("updateProject", () => {
		it("should update title and state", async () => {
			const addResult = await Planner.addProject(TEST_BASE, {
				title: "Old Name",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const result = await Planner.updateProject(
				TEST_BASE,
				addResult.value.id,
				{ title: "New Name", state: "done" },
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value?.title).toBe("New Name");
				expect(result.value?.state).toBe("done");
			}
		});
	});

	describe("deleteProject", () => {
		it("should delete project and clear task references", async () => {
			const projResult = await Planner.addProject(TEST_BASE, {
				title: "To Delete",
			});
			expect(projResult.ok).toBe(true);
			if (!projResult.ok) return;

			// Create a task in this project
			const taskResult = await Planner.addTask(TEST_BASE, {
				title: "Task in project",
				projectId: projResult.value.id,
			});
			expect(taskResult.ok).toBe(true);

			// Delete project
			const delResult = await Planner.deleteProject(
				TEST_BASE,
				projResult.value.id,
			);
			expect(delResult.ok).toBe(true);

			// Project gone
			const getResult = await Planner.getProject(
				TEST_BASE,
				projResult.value.id,
			);
			expect(getResult.ok).toBe(true);
			if (getResult.ok) {
				expect(getResult.value).toBeNull();
			}

			// Task still exists but projectId cleared
			if (taskResult.ok) {
				const task = await Planner.getTask(TEST_BASE, taskResult.value.id);
				expect(task.ok).toBe(true);
				if (task.ok) {
					expect(task.value?.projectId).toBeUndefined();
				}
			}
		});
	});

	// ----------------------------------------------------------
	// Query
	// ----------------------------------------------------------

	describe("queryProjects", () => {
		it("should list active projects by default (exclude done/archived)", async () => {
			await Planner.addProject(TEST_BASE, { title: "Active" });
			await Planner.addProject(TEST_BASE, {
				title: "Done",
				state: "done",
			});
			await Planner.addProject(TEST_BASE, {
				title: "Archived",
				state: "archived",
			});

			const result = await Planner.queryProjects(TEST_BASE, {});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(1);
				expect(result.value[0]?.title).toBe("Active");
			}
		});

		it("should include closed with flag", async () => {
			await Planner.addProject(TEST_BASE, { title: "Active" });
			await Planner.addProject(TEST_BASE, {
				title: "Done",
				state: "done",
			});

			const result = await Planner.queryProjects(TEST_BASE, {
				includeClosed: true,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(2);
			}
		});

		it("should filter by state", async () => {
			await Planner.addProject(TEST_BASE, {
				title: "Active",
				state: "active",
			});
			await Planner.addProject(TEST_BASE, {
				title: "Someday",
				state: "someday",
			});

			const result = await Planner.queryProjects(TEST_BASE, {
				state: "someday",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(1);
				expect(result.value[0]?.title).toBe("Someday");
			}
		});

		it("should search by query", async () => {
			await Planner.addProject(TEST_BASE, { title: "Auth Rewrite" });
			await Planner.addProject(TEST_BASE, { title: "Dashboard v2" });

			const result = await Planner.queryProjects(TEST_BASE, {
				query: "Auth",
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(1);
				expect(result.value[0]?.title).toBe("Auth Rewrite");
			}
		});
	});

	// ----------------------------------------------------------
	// Task ↔ Project
	// ----------------------------------------------------------

	describe("task-project relationship", () => {
		it("should create a task with projectId", async () => {
			const projResult = await Planner.addProject(TEST_BASE, {
				title: "My Project",
			});
			expect(projResult.ok).toBe(true);
			if (!projResult.ok) return;

			const taskResult = await Planner.addTask(TEST_BASE, {
				title: "Task in project",
				projectId: projResult.value.id,
			});
			expect(taskResult.ok).toBe(true);
			if (taskResult.ok) {
				expect(taskResult.value.projectId).toBe(projResult.value.id);
			}
		});

		it("should filter tasks by projectId", async () => {
			const proj1 = await Planner.addProject(TEST_BASE, { title: "P1" });
			const proj2 = await Planner.addProject(TEST_BASE, { title: "P2" });
			expect(proj1.ok && proj2.ok).toBe(true);
			if (!proj1.ok || !proj2.ok) return;

			await Planner.addTask(TEST_BASE, {
				title: "T1",
				projectId: proj1.value.id,
			});
			await Planner.addTask(TEST_BASE, {
				title: "T2",
				projectId: proj2.value.id,
			});
			await Planner.addTask(TEST_BASE, { title: "T3" }); // no project

			const result = await Planner.queryTasks(TEST_BASE, {
				projectId: proj1.value.id,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.length).toBe(1);
				expect(result.value[0]?.title).toBe("T1");
			}
		});

		it("should update task projectId", async () => {
			const projResult = await Planner.addProject(TEST_BASE, {
				title: "Target Project",
			});
			expect(projResult.ok).toBe(true);
			if (!projResult.ok) return;

			const taskResult = await Planner.addTask(TEST_BASE, {
				title: "Loose task",
			});
			expect(taskResult.ok).toBe(true);
			if (!taskResult.ok) return;

			const updateResult = await Planner.updateTask(
				TEST_BASE,
				taskResult.value.id,
				{ projectId: projResult.value.id },
			);
			expect(updateResult.ok).toBe(true);
			if (updateResult.ok) {
				expect(updateResult.value?.projectId).toBe(projResult.value.id);
			}
		});

		it("should move a task from one project to another", async () => {
			const proj1 = await Planner.addProject(TEST_BASE, { title: "From" });
			const proj2 = await Planner.addProject(TEST_BASE, { title: "To" });
			expect(proj1.ok && proj2.ok).toBe(true);
			if (!proj1.ok || !proj2.ok) return;

			const taskResult = await Planner.addTask(TEST_BASE, {
				title: "Movable task",
				projectId: proj1.value.id,
			});
			expect(taskResult.ok).toBe(true);
			if (!taskResult.ok) return;

			const moveResult = await Planner.updateTask(
				TEST_BASE,
				taskResult.value.id,
				{ projectId: proj2.value.id },
			);
			expect(moveResult.ok).toBe(true);
			if (moveResult.ok) {
				expect(moveResult.value?.projectId).toBe(proj2.value.id);
			}
		});

		it("should remove a task from its project (projectId: null)", async () => {
			const projResult = await Planner.addProject(TEST_BASE, {
				title: "Detach me",
			});
			expect(projResult.ok).toBe(true);
			if (!projResult.ok) return;

			const taskResult = await Planner.addTask(TEST_BASE, {
				title: "Attached task",
				projectId: projResult.value.id,
			});
			expect(taskResult.ok).toBe(true);
			if (!taskResult.ok) return;

			const clearResult = await Planner.updateTask(
				TEST_BASE,
				taskResult.value.id,
				{ projectId: null },
			);
			expect(clearResult.ok).toBe(true);
			if (clearResult.ok) {
				expect(clearResult.value?.projectId).toBeUndefined();
			}
		});
	});

	// ----------------------------------------------------------
	// ID Resolution
	// ----------------------------------------------------------

	describe("resolveProjectId", () => {
		it("should resolve by shortId", async () => {
			const addResult = await Planner.addProject(TEST_BASE, {
				title: "Test",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;
			expect(addResult.value.shortId).toBeDefined();

			const result = await Planner.resolveProjectId(
				TEST_BASE,
				addResult.value.shortId as string,
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(addResult.value.id);
			}
		});

		it("should resolve by full ULID", async () => {
			const addResult = await Planner.addProject(TEST_BASE, {
				title: "Test",
			});
			expect(addResult.ok).toBe(true);
			if (!addResult.ok) return;

			const result = await Planner.resolveProjectId(
				TEST_BASE,
				addResult.value.id,
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(addResult.value.id);
			}
		});

		it("should return error for nonexistent ID", async () => {
			const result = await Planner.resolveProjectId(TEST_BASE, "JALL-999");
			expect(result.ok).toBe(false);
		});
	});
});
