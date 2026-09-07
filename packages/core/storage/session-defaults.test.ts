import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureTestRuntime } from "../testing";

import { Planner as Store } from "./index";
import { Planner } from "./session-defaults";

const TEST_BASE = join(import.meta.dir, ".test-data-session-defaults");
const STATE_DIR = join(TEST_BASE, "state");

const ENV_KEYS = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("Planner — Session Defaults", () => {
	beforeEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	// ----------------------------------------------------------
	// resolveDefaultsKey precedence
	// ----------------------------------------------------------

	describe("resolveDefaultsKey", () => {
		it("prefers CLAUDE_CODE_SESSION_ID", async () => {
			process.env.CLAUDE_CODE_SESSION_ID = "aaa";
			process.env.CLAUDE_SESSION_ID = "bbb";
			const result = await Planner.resolveDefaultsKey(TEST_BASE);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value).toBe("session:aaa");
		});

		it("falls back to CLAUDE_SESSION_ID", async () => {
			process.env.CLAUDE_SESSION_ID = "bbb";
			const result = await Planner.resolveDefaultsKey(TEST_BASE);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value).toBe("session:bbb");
		});

		it("falls back to the host's scope resolver when no session env", async () => {
			configureTestRuntime("", {
				scopeResolver: async (cwd) => (cwd === "/repo" ? "cabane" : null),
			});
			try {
				const result = await Planner.resolveDefaultsKey("/repo");
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.value).toBe("scope:cabane");
			} finally {
				configureTestRuntime();
			}
		});

		it("returns null when neither session nor scope resolves", async () => {
			const orphan = mkdtempSync(join(tmpdir(), "cabane-no-project-"));
			try {
				const result = await Planner.resolveDefaultsKey(orphan);
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.value).toBeNull();
			} finally {
				rmSync(orphan, { recursive: true, force: true });
			}
		});
	});

	// ----------------------------------------------------------
	// set / get / clear roundtrip
	// ----------------------------------------------------------

	describe("set/get/clear", () => {
		const KEY = "session:test-1";

		it("returns null before anything is stored", async () => {
			const result = await Planner.getDefaults(TEST_BASE, KEY);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value).toBeNull();
		});

		it("sets and reads back defaults", async () => {
			const set = await Planner.setDefaults(TEST_BASE, KEY, {
				projectId: "proj-1",
				parentTaskId: "task-1",
			});
			expect(set.ok).toBe(true);
			if (set.ok) {
				expect(set.value.key).toBe(KEY);
				expect(set.value.projectId).toBe("proj-1");
				expect(set.value.parentTaskId).toBe("task-1");
				expect(set.value.updatedAt).toBeTruthy();
			}

			const get = await Planner.getDefaults(TEST_BASE, KEY);
			expect(get.ok).toBe(true);
			if (get.ok) {
				expect(get.value?.projectId).toBe("proj-1");
				expect(get.value?.parentTaskId).toBe("task-1");
			}
		});

		it("merges patches without dropping prior fields", async () => {
			await Planner.setDefaults(TEST_BASE, KEY, { projectId: "proj-1" });
			const merged = await Planner.setDefaults(TEST_BASE, KEY, {
				parentTaskId: "task-2",
			});
			expect(merged.ok).toBe(true);
			if (merged.ok) {
				expect(merged.value.projectId).toBe("proj-1");
				expect(merged.value.parentTaskId).toBe("task-2");
			}
		});

		it("clears stored defaults", async () => {
			await Planner.setDefaults(TEST_BASE, KEY, { projectId: "proj-1" });
			const cleared = await Planner.clearDefaults(TEST_BASE, KEY);
			expect(cleared.ok).toBe(true);

			const get = await Planner.getDefaults(TEST_BASE, KEY);
			expect(get.ok).toBe(true);
			if (get.ok) expect(get.value).toBeNull();
		});

		it("clear is a no-op when nothing is stored", async () => {
			const cleared = await Planner.clearDefaults(TEST_BASE, "session:missing");
			expect(cleared.ok).toBe(true);
		});
	});

	// ----------------------------------------------------------
	// key sanitization
	// ----------------------------------------------------------

	describe("sanitization", () => {
		it("stores keys with unsafe chars in a sanitized filename", async () => {
			const key = "scope:github.com/user/repo";
			await Planner.setDefaults(TEST_BASE, key, { projectId: "p" });

			expect(
				existsSync(
					join(STATE_DIR, "planner-defaults-scope_github_com_user_repo.json"),
				),
			).toBe(true);

			const get = await Planner.getDefaults(TEST_BASE, key);
			expect(get.ok).toBe(true);
			if (get.ok) expect(get.value?.projectId).toBe("p");
		});
	});

	// ----------------------------------------------------------
	// applySessionDefaults — the shared apply point consulted by BOTH
	// the CLI `add` handler and the tRPC `add` path (identical behavior).
	// ----------------------------------------------------------

	describe("applySessionDefaults", () => {
		const KEY = "session:apply-test";

		beforeEach(async () => {
			await Store.init(TEST_BASE);
		});

		it("bare (no defaults stored) leaves explicit placement untouched", async () => {
			const applied = await Planner.applySessionDefaults(TEST_BASE, KEY, {
				project: false,
				parent: false,
			});
			expect(applied).toEqual({
				projectId: undefined,
				parentTaskId: undefined,
				inheritedProject: false,
				inheritedParent: false,
				warnings: [],
			});
		});

		it("inherits a live default project", async () => {
			const proj = await Store.addProject(TEST_BASE, { title: "Live" });
			if (!proj.ok) throw new Error("failed to create project");
			await Planner.setDefaults(TEST_BASE, KEY, { projectId: proj.value.id });

			const applied = await Planner.applySessionDefaults(TEST_BASE, KEY, {
				project: false,
				parent: false,
			});
			expect(applied.projectId).toBe(proj.value.id);
			expect(applied.inheritedProject).toBe(true);
			expect(applied.warnings).toEqual([]);
		});

		it("explicit placement wins over a stored default (no inherit)", async () => {
			const proj = await Store.addProject(TEST_BASE, { title: "Live" });
			if (!proj.ok) throw new Error("failed to create project");
			await Planner.setDefaults(TEST_BASE, KEY, { projectId: proj.value.id });

			const applied = await Planner.applySessionDefaults(TEST_BASE, KEY, {
				project: true, // "none" sentinel
				parent: false,
			});
			expect(applied.projectId).toBeUndefined();
			expect(applied.inheritedProject).toBe(false);
		});

		it("stale (archived) default project warns, drops, and clears storage", async () => {
			const proj = await Store.addProject(TEST_BASE, {
				title: "Archived",
				state: "archived",
			});
			if (!proj.ok) throw new Error("failed to create project");
			await Planner.setDefaults(TEST_BASE, KEY, { projectId: proj.value.id });

			const applied = await Planner.applySessionDefaults(TEST_BASE, KEY, {
				project: false,
				parent: false,
			});
			expect(applied.projectId).toBeUndefined();
			expect(applied.inheritedProject).toBe(false);
			expect(applied.warnings).toHaveLength(1);

			// The stale default is cleared from storage so the hazard doesn't repeat.
			const got = await Planner.getDefaults(TEST_BASE, KEY);
			expect(got.ok).toBe(true);
			if (got.ok) expect(got.value).toBeNull();
		});
	});

	// ----------------------------------------------------------
	// Daemon-held MCP-surface defaults key (per-process, in-memory)
	// ----------------------------------------------------------

	describe("MCP-surface defaults key", () => {
		afterEach(() => Planner.clearMcpDefaultsKey());

		it("is undefined until stamped, then reads back the last-set key", () => {
			expect(Planner.getMcpDefaultsKey()).toBeUndefined();
			Planner.setMcpDefaultsKey("mcp:surface");
			expect(Planner.getMcpDefaultsKey()).toBe("mcp:surface");
			Planner.clearMcpDefaultsKey();
			expect(Planner.getMcpDefaultsKey()).toBeUndefined();
		});
	});
});
