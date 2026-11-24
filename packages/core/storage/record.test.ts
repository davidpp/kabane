import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/port";
import { withDb } from "../runtime";
import { RecordId } from "../schemas";
import { Planner } from "./index";
import { RecordRead } from "./record";

const TEST_BASE = join(import.meta.dir, ".test-data-record");
const T0 = "2026-01-01T00:00:00.000Z";

const insert = (db: Db, table: string, row: Record<string, string | null>) => {
	const columns = Object.keys(row);
	db.run(
		`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		Object.values(row),
	);
};

const thread = (
	db: Db,
	id: string,
	parentId: string | null = null,
	deletedAt: string | null = null,
) =>
	insert(db, "threads", {
		id,
		kind: "issue",
		title: id,
		parent_id: parentId,
		created_at: T0,
		updated_at: T0,
		state_updated_at: T0,
		deleted_at: deletedAt,
	});

const entry = (
	db: Db,
	id: string,
	kind: "claim" | "release",
	author: string,
	at: string,
	threadId = "thread",
) =>
	insert(db, "entries", {
		id,
		thread_id: threadId,
		kind,
		author,
		created_at: at,
	});

const read = async <T>(fn: (db: Db) => T): Promise<T> => {
	const result = await withDb(TEST_BASE, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

const holderOf = (threadId = "thread") =>
	read((db) => {
		const held = RecordRead.claimHolder(db, threadId);
		if (!held.ok) throw held.error;
		return held.value?.id;
	});

const at = (second: number) =>
	new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

describe("RecordRead", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });
		const init = await Planner.init(TEST_BASE);
		if (!init.ok) throw init.error;
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	describe("claimHolder", () => {
		it("is the earliest claim, by time and then id, and passes on when its author releases", async () => {
			await read((db) => {
				thread(db, "thread");
				entry(db, "claim-b", "claim", "codex", at(1));
				entry(db, "claim-a", "claim", "claude", at(1));
				entry(db, "claim-c", "claim", "gemini", at(0));
			});
			expect(await holderOf()).toBe("claim-c");

			await read((db) => entry(db, "release-c", "release", "gemini", at(2)));
			expect(await holderOf()).toBe("claim-a");

			// A release by someone else, or one older than the claim, frees nothing.
			await read((db) => {
				entry(db, "release-by-other", "release", "codex", at(3));
				entry(db, "release-too-early", "release", "claude", at(0));
			});
			expect(await holderOf()).toBe("claim-a");
		});

		it("is no one on a thread that is deleted or has not arrived", async () => {
			await read((db) => {
				thread(db, "deleted", null, at(5));
				entry(db, "claim-on-deleted", "claim", "claude", at(1), "deleted");
				entry(db, "claim-on-missing", "claim", "claude", at(1), "missing");
			});
			expect(await holderOf("deleted")).toBeUndefined();
			expect(await holderOf("missing")).toBeUndefined();
		});
	});

	it("shows a thread whose parent has not arrived at the root, and hides everything under a deleted one", async () => {
		const linkId = await RecordId.link("orphan", "grandchild", "blocks");
		if (!linkId.ok) throw linkId.error;
		const visible = await read((db) => {
			thread(db, "orphan", "not-arrived");
			thread(db, "grandparent", null, at(1));
			thread(db, "parent", "grandparent");
			thread(db, "grandchild", "parent");
			insert(db, "links", {
				id: linkId.value,
				source_id: "orphan",
				target_id: "grandchild",
				type: "blocks",
				updated_at: T0,
			});
			const threads = RecordRead.threads(db);
			const links = RecordRead.links(db);
			if (!threads.ok) throw threads.error;
			if (!links.ok) throw links.error;
			return { threads: threads.value, links: links.value };
		});
		expect(visible.threads).toMatchObject([{ id: "orphan", parent_id: null }]);
		expect(visible.links).toEqual([]);
	});
});

describe("RecordId", () => {
	it("derives one id per key, apart per table, never mistaken for a ULID or a label", async () => {
		const ids = await Promise.all([
			RecordId.link("a", "b", "blocks"),
			RecordId.link("a", "b", "blocks"),
			RecordId.link("b", "a", "blocks"),
			RecordId.attribute("a", "b"),
			RecordId.ref("a", "b"),
			RecordId.ref("a", "upstream"),
			RecordId.upstreamRef("a", "github", "7"),
		]);
		const values = ids.map((id) => {
			if (!id.ok) throw id.error;
			return id.value;
		});
		expect(values[0]).toBe(values[1] ?? "");
		expect(new Set(values).size).toBe(values.length - 1);
		for (const id of values) {
			expect(id).toMatch(/^(link|attr|ref)_[0-9a-f]{32}$/);
			expect(id).not.toHaveLength(26);
		}
		// A change here would split every derived row in two.
		expect(values[0]).toBe("link_177e2e9e8bb05da0f650bab09d03511a");
	});
});
