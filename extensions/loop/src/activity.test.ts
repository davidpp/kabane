import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActivity } from "./activity";
import { LoopConfig } from "./config";
import { RunStore } from "./store";

let home = "";
const ACTOR = "cabane://actor/human/david";

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
		steering: { paused: false, skipped: [], next: [] },
		gateRuns: [],
		...overrides,
	};
};

describe("LoopActivity", () => {
	it("a run is a tabbed card on its parent, owning the sessions it claimed", () => {
		expect(LoopActivity.card(run())).toEqual({
			id: "KAB-1-abc",
			kind: "loops",
			label: "loop",
			status: "stopped",
			taskId: "01PARENT",
			taskShortId: "KAB-1",
			startedAt: "2026-10-10T12:00:00.500Z",
			finishedAt: "2026-10-10T12:05:00.000Z",
			detail: ["2 sessions"],
			error: "stalled (no progress across 3 session ends)",
			hasEvents: true,
			tab: true,
			sessionIds: ["s1", "s2"],
			lanes: ["claude:KAB-2", "claude:KAB-2#2"],
			laneNoun: "agents",
		});
	});

	it("reads the runs and their events off disk on every call", async () => {
		const source = LoopActivity.source({ home, basePath: home, actor: ACTOR });
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
		const events = await source.events?.("KAB-1-abc", 0);
		expect(
			events?.ok && events.value.map((e) => [e.seq, e.summary, e.lane]),
		).toEqual([
			[1, "started", "x"],
			[2, "claude claims KAB-2", undefined],
		]);
	});

	it("a dismissed run is not listed again, and a live one cannot be dismissed", async () => {
		const source = LoopActivity.source({ home, basePath: home, actor: ACTOR });
		RunStore.create(home, run({ status: "running", pid: process.pid }));
		const refused = await source.dismiss?.("KAB-1-abc");
		expect(refused?.ok).toBe(false);
		expect((await source.load()).ok).toBe(true);

		RunStore.write(home, run());
		expect(await source.dismiss?.("KAB-1-abc")).toEqual({
			ok: true,
			value: undefined,
		});
		expect(await source.load()).toEqual({ ok: true, value: [] });
		const kept = RunStore.read(home, "KAB-1-abc");
		expect(kept.ok && kept.value.dismissedAt).toBeString();
	});

	it("lists every live run, however many newer runs are over, and fills the rest with the newest", async () => {
		const source = LoopActivity.source({ home, basePath: home, actor: ACTOR });
		RunStore.create(
			home,
			run({
				id: "old-live",
				status: "running",
				pid: process.pid,
				exit: undefined,
				createdAt: "2026-10-01T00:00:00.000Z",
			}),
		);
		for (let day = 10; day <= 21; day++)
			RunStore.create(
				home,
				run({ id: `over-${day}`, createdAt: `2026-10-${day}T00:00:00.000Z` }),
			);

		const loaded = await source.load();
		const ids = loaded.ok ? loaded.value.map((c) => c.id) : [];
		expect(ids).toHaveLength(10);
		expect(ids.at(-1)).toBe("old-live");
		expect(ids[0]).toBe("over-21");
		expect(ids).not.toContain("over-12");
	});

	it("a live run offers stop, inject and steering; a finished one offers nothing", () => {
		const live = LoopActivity.card(run({ status: "running", exit: undefined }));
		expect(live.actions?.map((a) => [a.id, a.key])).toEqual([
			["stop", "x"],
			["inject", "i"],
			["pause", "p"],
			["skip", "s"],
			["next", "n"],
		]);
		const paused = LoopActivity.card(
			run({
				status: "running",
				exit: undefined,
				steering: { paused: true, skipped: [], next: [] },
			}),
		);
		expect(paused.actions?.find((a) => a.key === "p")?.id).toBe("resume");
		expect(LoopActivity.card(run()).actions).toBeUndefined();
	});

	it("inject goes to the inbox for the session behind the lane; an ended one is refused", async () => {
		const live = run({
			status: "running",
			exit: undefined,
			pid: process.pid,
			claims: [
				{ ...claim("s1", "claude:KAB-2"), endedAt: "2026-10-10T12:01:00.000Z" },
				claim("s2", "claude:KAB-2#2"),
			],
		});
		RunStore.create(home, live);
		const sent = await LoopActivity.act(
			{ home, basePath: home },
			live.id,
			"inject",
			{
				text: "  use the LRU  ",
				lane: "claude:KAB-2#2",
			},
		);
		expect(sent).toEqual({
			ok: true,
			value: "inject queued for claude:KAB-2#2",
		});
		const ended = await LoopActivity.act(
			{ home, basePath: home },
			live.id,
			"inject",
			{
				text: "hi",
				lane: "claude:KAB-2",
			},
		);
		expect(!ended.ok && ended.error.message).toBe("claude:KAB-2 has ended");
		const inbox = RunStore.readInbox(home, live.id, 0);
		expect(inbox.ok && inbox.value.entries).toEqual([
			{
				kind: "inject",
				at: expect.any(String),
				session: "s2",
				lane: "claude:KAB-2#2",
				text: "use the LRU",
			},
		]);
	});

	it("stop asks the runner through the inbox; a run that is over takes no action", async () => {
		const live = run({ status: "running", exit: undefined, pid: process.pid });
		RunStore.create(home, live);
		const asked = await LoopActivity.act(
			{ home, basePath: home },
			live.id,
			"stop",
			{},
		);
		expect(asked).toEqual({ ok: true, value: `stop requested for ${live.id}` });
		const inbox = RunStore.readInbox(home, live.id, 0);
		expect(inbox.ok && inbox.value.entries.map((e) => e.kind)).toEqual([
			"stop",
		]);
		RunStore.write(home, run());
		const over = await LoopActivity.act(
			{ home, basePath: home },
			live.id,
			"stop",
			{},
		);
		expect(!over.ok && over.error.message).toBe(`${live.id} is stopped`);
	});

	it("a run whose runner died is over, so it can be dismissed", () => {
		RunStore.create(home, run({ status: "running", pid: 999_999 }));
		const dismissed = RunStore.dismiss(
			home,
			"KAB-1-abc",
			new Date("2026-10-11T00:00:00.000Z"),
			() => false,
		);
		expect(dismissed.ok && dismissed.value.dismissedAt).toBe(
			"2026-10-11T00:00:00.000Z",
		);
	});
});
