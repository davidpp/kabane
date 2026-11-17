import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	backupDatabase,
	backupFile,
	defaultBin,
	links,
	replace,
} from "./main-build";

const TMP = mkdtempSync(join(tmpdir(), "kabane-main-build-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("main-build", () => {
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

	it("skips the copy when the home has no database", () => {
		const home = join(TMP, "empty");
		mkdirSync(home);
		expect(backupDatabase(home)).toBeNull();
		expect(existsSync(join(home, "backups"))).toBe(false);
	});

	it("installs where Bun puts kabane on PATH", () => {
		expect(defaultBin({ HOME: "/h" })).toBe("/h/.bun/bin/kabane");
		expect(defaultBin({ HOME: "/h", BUN_INSTALL: "/b" })).toBe("/b/bin/kabane");
		expect(defaultBin({ BUN_INSTALL_BIN: "/c", BUN_INSTALL: "/b" })).toBe(
			"/c/kabane",
		);
	});

	it("names the links in the way and replaces a link without touching what it pointed at", () => {
		const checkout = join(TMP, "checkout-loop");
		mkdirSync(checkout);
		writeFileSync(join(checkout, "index.ts"), "source");
		const extensions = join(TMP, "extensions");
		mkdirSync(extensions);
		const linked = join(extensions, "loop");
		symlinkSync(checkout, linked);
		const copied = join(extensions, "dispatch");
		mkdirSync(copied);
		writeFileSync(join(copied, "stale.js"), "old");

		expect(links([linked, copied, join(extensions, "absent")])).toEqual([
			`${linked} -> ${readlinkSync(linked)}`,
		]);

		const built = join(TMP, "dist");
		mkdirSync(built);
		writeFileSync(join(built, "index.js"), "built");
		replace(built, linked);
		replace(built, copied);

		expect(readFileSync(join(checkout, "index.ts"), "utf8")).toBe("source");
		expect(links([linked])).toEqual([]);
		expect(readFileSync(join(linked, "index.js"), "utf8")).toBe("built");
		expect(existsSync(join(copied, "stale.js"))).toBe(false);
		expect(readFileSync(join(copied, "index.js"), "utf8")).toBe("built");
	});
});
