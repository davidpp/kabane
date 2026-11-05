import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDb } from "../runtime";
import type { Task } from "../schemas";
import { LocalRelay } from "../sync/local-relay";
import { Sync } from "../sync/namespace";
import "../testing";
import { Planner } from "./index";
import { Oplog } from "./oplog";

const bases: string[] = [];

afterEach(() => {
	setSystemTime();
	for (const base of bases) rmSync(base, { recursive: true, force: true });
	bases.length = 0;
});

const createDevice = async (deviceId: string): Promise<string> => {
	const base = mkdtempSync(join(tmpdir(), "planner-task-completion-"));
	bases.push(base);
	const init = await Planner.init(base);
	if (!init.ok) throw init.error;
	const armed = await withDb(base, (db) => Oplog.initDevice(db, deviceId));
	if (!armed.ok) throw armed.error;
	if (!armed.value.ok) throw armed.value.error;
	return base;
};

describe("task completion timestamps", () => {
	for (const state of [
		"done",
		"cancelled",
		"inbox",
		"next",
		"in_progress",
		"waiting",
		"someday",
	] as const) {
		it(`creating a ${state} task stamps only closed states`, async () => {
			const now = "2026-01-01T00:00:00.000Z";
			setSystemTime(new Date(now));
			const base = await createDevice("source");
			const added = await Planner.addTask(base, {
				title: "Created in state",
				state,
			});
			if (!added.ok) throw added.error;
			const expected =
				state === "done" || state === "cancelled" ? now : undefined;
			expect(added.value.completedAt).toBe(expected);
			const stored = await Planner.getTask(base, added.value.id);
			if (!stored.ok) throw stored.error;
			expect(stored.value?.state).toBe(state);
			expect(stored.value?.completedAt).toBe(expected);
		});
	}

	for (const closed of ["done", "cancelled"] as const) {
		for (const open of [
			"inbox",
			"next",
			"in_progress",
			"waiting",
			"someday",
		] as const) {
			it(`${closed} → ${open} → ${closed} clears and restamps on both devices`, async () => {
				setSystemTime(new Date("2025-12-31T00:00:00.000Z"));
				const source = await createDevice("source");
				const peer = await createDevice("peer");
				const relay = LocalRelay.create();
				const sourceTransport = LocalRelay.transportFor(relay, "source");
				const peerTransport = LocalRelay.transportFor(relay, "peer");
				const added = await Planner.addTask(source, { title: "Reopen me" });
				if (!added.ok) throw added.error;
				const id = added.value.id;

				const verify = async (state: Task["state"], completedAt?: string) => {
					const pushed = await Sync.push(source, sourceTransport);
					if (!pushed.ok) throw pushed.error;
					const pulled = await Sync.pull(peer, peerTransport);
					if (!pulled.ok) throw pulled.error;
					for (const base of [source, peer]) {
						const task = await Planner.getTask(base, id);
						if (!task.ok) throw task.error;
						expect(task.value?.state).toBe(state);
						expect(task.value?.completedAt).toBe(completedAt);
					}
				};

				const first = "2026-01-01T00:00:00.000Z";
				setSystemTime(new Date(first));
				expect(
					(await Planner.updateTask(source, id, { state: closed })).ok,
				).toBe(true);
				await verify(closed, first);

				setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
				expect(
					(await Planner.updateTask(source, id, { title: "Still closed" })).ok,
				).toBe(true);
				await verify(closed, first);

				setSystemTime(new Date("2026-01-03T00:00:00.000Z"));
				expect((await Planner.updateTask(source, id, { state: open })).ok).toBe(
					true,
				);
				await verify(open);

				const second = "2026-01-04T00:00:00.000Z";
				setSystemTime(new Date(second));
				expect(
					(await Planner.updateTask(source, id, { state: closed })).ok,
				).toBe(true);
				await verify(closed, second);
			});
		}
	}
});
