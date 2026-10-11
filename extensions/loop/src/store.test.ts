import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopConfig } from "./config";
import { RunStore } from "./store";

let home = "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "loop-store-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const config = (): LoopConfig.Config => {
	const parsed = LoopConfig.Schema.safeParse({});
	if (!parsed.success) throw parsed.error;
	return parsed.data;
};

const draft = (overrides: Partial<RunStore.Run> = {}): RunStore.Run => ({
	version: 1,
	id: "KAB-1-abc",
	parentId: "01PARENT",
	parentShortId: "KAB-1",
	projectDir: "/repo",
	config: config(),
	status: "pending",
	createdAt: "2026-10-10T12:00:00.000Z",
	claims: [],
	usage: {},
	continuationsUsed: 0,
	inboxRead: 0,
	steering: { paused: false, skipped: [], next: [] },
	gateRuns: [],
	...overrides,
});

// A pid that existed and is gone: the exited child of a real spawn.
const deadPid = (): number => {
	const proc = Bun.spawnSync(["true"]);
	return proc.pid;
};

describe("RunStore files", () => {
	it("round-trips a run and refuses to create one twice", () => {
		expect(RunStore.create(home, draft()).ok).toBe(true);
		const read = RunStore.read(home, "KAB-1-abc");
		expect(read.ok && read.value).toEqual(draft());
		expect(RunStore.create(home, draft()).ok).toBe(false);
	});

	it("rejects a run.json the schema does not accept, naming the file", () => {
		RunStore.create(home, draft());
		writeFileSync(
			RunStore.paths(home, "KAB-1-abc").run,
			JSON.stringify({ id: "KAB-1-abc", status: "flying" }),
		);
		const read = RunStore.read(home, "KAB-1-abc");
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error.message).toContain("run.json");
	});

	it("rejects a run id that would leave the loops directory", () => {
		expect(RunStore.read(home, "../../etc").ok).toBe(false);
		expect(RunStore.create(home, draft({ id: "../escape" })).ok).toBe(false);
	});

	it("lists runs newest first and skips one it cannot read", () => {
		RunStore.create(
			home,
			draft({ id: "old", createdAt: "2026-10-01T00:00:00.000Z" }),
		);
		RunStore.create(
			home,
			draft({ id: "new", createdAt: "2026-10-09T00:00:00.000Z" }),
		);
		RunStore.create(home, draft({ id: "broken" }));
		writeFileSync(RunStore.paths(home, "broken").run, "{");
		const runs = RunStore.list(home);
		expect(runs.ok && runs.value.map((r) => r.id)).toEqual(["new", "old"]);
	});
});

describe("RunStore liveness", () => {
	it("reads a live run whose runner pid is gone as failed", () => {
		RunStore.create(home, draft({ status: "running", pid: deadPid() }));
		const read = RunStore.read(home, "KAB-1-abc");
		expect(read.ok && read.value.status).toBe("failed");
		expect(read.ok && read.value.exit?.reason).toBe("runner-died");
		// The file still says running: the judgement is the reader's, not a write.
		const raw = RunStore.readRaw(home, "KAB-1-abc");
		expect(raw.ok && raw.value.status).toBe("running");
	});

	it("keeps a live run whose runner is alive, and a pending run with no pid yet", () => {
		RunStore.create(home, draft({ status: "running", pid: process.pid }));
		const live = RunStore.read(home, "KAB-1-abc");
		expect(live.ok && live.value.status).toBe("running");
		expect(RunStore.effective(draft()).status).toBe("pending");
	});

	it("never rewrites a finished run, whatever its pid", () => {
		const done = draft({ status: "completed", pid: deadPid() });
		expect(RunStore.effective(done)).toEqual(done);
	});
});

describe("RunStore events and inbox", () => {
	it("numbers events and resumes numbering after what the file holds", () => {
		RunStore.create(home, draft());
		const first = RunStore.eventLog(home, "KAB-1-abc");
		if (!first.ok) throw first.error;
		first.value.append({ type: "run_start", summary: "a" });
		first.value.append({ type: "claim", summary: "b", lane: "claude:KAB-2" });
		const second = RunStore.eventLog(home, "KAB-1-abc");
		if (!second.ok) throw second.error;
		const appended = second.value.append({ type: "run_end", summary: "c" });
		expect(appended.ok && appended.value.seq).toBe(3);
		const events = RunStore.readEvents(home, "KAB-1-abc", 1);
		expect(
			events.ok && events.value.map((e) => [e.seq, e.type, e.lane]),
		).toEqual([
			[2, "claim", "claude:KAB-2"],
			[3, "run_end", undefined],
		]);
	});

	it("a runner that died mid-append does not take the next runner's first event with it", () => {
		RunStore.create(home, draft());
		const first = RunStore.eventLog(home, "KAB-1-abc");
		if (!first.ok) throw first.error;
		first.value.append({ type: "run_start", summary: "a" });
		appendFileSync(RunStore.paths(home, "KAB-1-abc").events, '{"seq":2,"at');
		const second = RunStore.eventLog(home, "KAB-1-abc");
		if (!second.ok) throw second.error;
		second.value.append({ type: "run_resume", summary: "b" });
		second.value.append({ type: "claim", summary: "c" });
		const events = RunStore.readEvents(home, "KAB-1-abc");
		expect(events.ok && events.value.map((e) => [e.seq, e.type])).toEqual([
			[1, "run_start"],
			[3, "run_resume"],
			[4, "claim"],
		]);
	});

	it("reads the inbox from a cursor and reports lines it cannot use", () => {
		RunStore.create(home, draft());
		RunStore.appendInbox(home, "KAB-1-abc", {
			kind: "stop",
			at: "2026-10-10T12:00:00.000Z",
		});
		appendFileSync(
			RunStore.paths(home, "KAB-1-abc").inbox,
			'{"kind":"dance"}\n',
		);
		const all = RunStore.readInbox(home, "KAB-1-abc", 0);
		expect(all.ok && all.value.entries.map((e) => e.kind)).toEqual(["stop"]);
		expect(all.ok && all.value.invalid).toEqual(['{"kind":"dance"}']);
		expect(all.ok && all.value.next).toBe(2);
		const rest = RunStore.readInbox(home, "KAB-1-abc", 2);
		expect(rest.ok && rest.value.entries).toEqual([]);
	});

	it("leaves a line still being appended for the next read", () => {
		RunStore.create(home, draft());
		const inbox = RunStore.paths(home, "KAB-1-abc").inbox;
		const line = JSON.stringify({
			kind: "stop",
			at: "2026-10-10T12:00:00.000Z",
		});
		appendFileSync(inbox, line.slice(0, 10));
		const early = RunStore.readInbox(home, "KAB-1-abc", 0);
		expect(early.ok && early.value).toEqual({
			entries: [],
			invalid: [],
			next: 0,
		});
		appendFileSync(inbox, `${line.slice(10)}\n`);
		const late = RunStore.readInbox(home, "KAB-1-abc", 0);
		expect(late.ok && late.value.entries.map((e) => e.kind)).toEqual(["stop"]);
		expect(late.ok && late.value.next).toBe(1);
	});
});
