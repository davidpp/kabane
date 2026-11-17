import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, backupFile, decide, livePath } from "./live";

const TMP = mkdtempSync(join(tmpdir(), "kabane-live-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("live", () => {
	it("leaves a worktree already at origin/main alone and moves one that is not", () => {
		expect(decide("a1b2", "a1b2")).toBe("up-to-date");
		expect(decide("a1b2", "c3d4")).toBe("move");
	});

	it("puts the worktree beside the main checkout unless KABANE_LIVE names it", () => {
		expect(livePath("/src/kabane", {})).toBe("/src/kabane-live");
		expect(livePath("/src/kabane", { KABANE_LIVE: "/elsewhere" })).toBe(
			"/elsewhere",
		);
	});

	it("copies a database another connection holds open in WAL mode, over the previous copy", () => {
		const home = join(TMP, "home");
		mkdirSync(home);
		const open = new Database(join(home, "kabane.db"));
		open.run("PRAGMA journal_mode = WAL");
		open.run("CREATE TABLE tasks (title TEXT)");
		open.run("INSERT INTO tasks VALUES ('first')");
		expect(backupDatabase(home)).toBe(backupFile(home));
		open.run("INSERT INTO tasks VALUES ('second')");

		backupDatabase(home);

		const copy = new Database(backupFile(home), { readonly: true });
		expect(copy.query("SELECT title FROM tasks").all()).toEqual([
			{ title: "first" },
			{ title: "second" },
		]);
		copy.close();
		open.close();
	});

	it("keeps the previous backup when a copy fails", () => {
		const home = join(TMP, "failing");
		mkdirSync(home);
		const db = new Database(join(home, "kabane.db"));
		db.run("CREATE TABLE tasks (title TEXT)");
		db.run("INSERT INTO tasks VALUES ('kept')");
		db.close();
		backupDatabase(home);
		writeFileSync(join(home, "kabane.db"), "not a database");

		expect(() => backupDatabase(home)).toThrow();

		const copy = new Database(backupFile(home), { readonly: true });
		expect(copy.query("SELECT title FROM tasks").all()).toEqual([
			{ title: "kept" },
		]);
		copy.close();
	});

	it("skips the copy when the home has no database", () => {
		const home = join(TMP, "empty");
		mkdirSync(home);
		expect(backupDatabase(home)).toBeNull();
		expect(existsSync(join(home, "backups"))).toBe(false);
	});
});
