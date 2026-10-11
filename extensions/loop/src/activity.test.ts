import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActivity } from "./activity";
import { LoopConfig } from "./config";
import { RunStore } from "./store";

let home = "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "loop-activity-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const claim = (sessionId: string, lane: string): RunStore.Claim => ({
	taskId: "01CHILD",
	shortId: "KAB-2",
	harness: "claude",
	lane,
	sessionId,
	startedAt: "2026-10-10T12:00:01.000Z",
	continuations: 0,
});

const run = (overrides: Partial<RunStore.Run> = {}): RunStore.Run => {
	const config = LoopConfig.Schema.safeParse({});
	if (!config.success) throw config.error;
	return {
		version: 1,
		id: "KAB-1-abc",
		parentId: "01PARENT",
		parentShortId: "KAB-1",
		projectDir: "/repo",
		config: config.data,
		status: "stopped",
		exit: { reason: "stalled", detail: "no progress across 3 session ends" },
		createdAt: "2026-10-10T12:00:00.000Z",
		startedAt: "2026-10-10T12:00:00.500Z",
		endedAt: "2026-10-10T12:05:00.000Z",
		claims: [claim("s1", "claude:KAB-2"), claim("s2", "claude:KAB-2#2")],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		...overrides,
	};
};

describe("LoopActivity", () => {
	it("a run is a tabbed card on its parent, owning the sessions it claimed", () => {
		expect(LoopActivity.card(run())).toEqual({
			id: "KAB-1-abc",
			kind: "loops",
			label: "loop",
			status: "failed",
			taskId: "01PARENT",
			taskShortId: "KAB-1",
			startedAt: "2026-10-10T12:00:00.500Z",
			finishedAt: "2026-10-10T12:05:00.000Z",
			detail: ["2 sessions"],
			error: "stopped: stalled (no progress across 3 session ends)",
			hasEvents: true,
			tab: true,
			sessionIds: ["s1", "s2"],
		});
	});

	it("reads the runs and their events off disk on every call", async () => {
		const source = LoopActivity.source(home);
		expect(await source.load()).toEqual({ ok: true, value: [] });
		RunStore.create(home, run({ status: "pending", exit: undefined }));
		const log = RunStore.eventLog(home, "KAB-1-abc");
		if (!log.ok) throw log.error;
		log.value.append({ type: "run_start", summary: "started", lane: "x" });
		log.value.append({ type: "claim", summary: "claude claims KAB-2" });

		const loaded = await source.load();
		expect(loaded.ok && loaded.value.map((c) => [c.id, c.status])).toEqual([
			["KAB-1-abc", "pending"],
		]);
		const refreshed = await source.card?.("KAB-1-abc");
		expect(refreshed?.ok && refreshed.value?.status).toBe("pending");
		const events = await source.events?.("KAB-1-abc", 1);
		expect(events?.ok && events.value.map((e) => [e.seq, e.summary])).toEqual([
			[2, "claude claims KAB-2"],
		]);
	});
});
