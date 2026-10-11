import { describe, expect, test } from "bun:test";
import { err, ok } from "@cabane/core";
import { Activity, Dispatchers } from "./merge";
import type {
	ActivityCard,
	ActivitySource,
	Dispatcher,
	DispatchTarget,
	TriggerDescriptor,
} from "./ports";

const card = (id: string, startedAt: string): ActivityCard => ({
	id,
	kind: "runs",
	label: id,
	status: "running",
	startedAt,
	detail: [],
});

const trigger = (id: string): TriggerDescriptor => ({
	id,
	label: id,
	inputs: {},
	satisfiable: true,
});

const target: DispatchTarget = {
	id: "01TASK",
	shortId: "T-1",
	title: "t",
	brief: "b",
};

describe("Activity.merge", () => {
	const a: ActivitySource = {
		load: async () => ok([card("1", "2026-10-10T10:00:00.000Z")]),
		card: async (id) => ok(card(id, "2026-10-10T10:05:00.000Z")),
		events: async (id, afterSeq) =>
			ok([{ seq: afterSeq + 1, at: "", type: "t", summary: id }]),
	};
	const b: ActivitySource = {
		load: async () => ok([card("1", "2026-10-10T11:00:00.000Z")]),
	};

	test("prefixes card ids by contributor and keeps newest first", async () => {
		const loaded = await Activity.merge({ a, b }).load();
		expect(loaded.ok && loaded.value.map((c) => c.id)).toEqual(["b:1", "a:1"]);
	});

	test("routes card and events back with the contributor's own id", async () => {
		const merged = Activity.merge({ a, b });
		const refreshed = await merged.card?.("a:1");
		expect(refreshed?.ok && refreshed.value?.id).toBe("a:1");
		const events = await merged.events?.("a:1", 4);
		expect(events?.ok && events.value).toEqual([
			{ seq: 5, at: "", type: "t", summary: "1" },
		]);
	});

	test("a contributor without card or events reads as loaded and eventless", async () => {
		const merged = Activity.merge({ a, b });
		expect(await merged.card?.("b:1")).toEqual(ok(null));
		expect(await merged.events?.("b:1", 0)).toEqual(ok([]));
	});

	test("an id no contributor minted is an error", async () => {
		const merged = Activity.merge({ a });
		expect((await merged.card?.("c:1"))?.ok).toBe(false);
	});

	test("a failing contributor drops out without blanking the rest", async () => {
		const broken: ActivitySource = {
			load: async () => err(new Error("down")),
		};
		const loaded = await Activity.merge({ a, broken }).load();
		expect(loaded.ok && loaded.value.map((c) => c.id)).toEqual(["a:1"]);
	});
});

describe("Dispatchers.merge", () => {
	const seen: string[] = [];
	const named = (name: string): Dispatcher => ({
		triggers: async () => ok([trigger("start")]),
		dispatch: async (triggerId) => {
			seen.push(`${name}/${triggerId}`);
			return ok(`${name} started`);
		},
	});

	test("prefixes trigger ids and dispatch routes to their owner", async () => {
		const merged = Dispatchers.merge({ loop: named("loop"), hi: named("hi") });
		const triggers = await merged.triggers("01TASK");
		expect(triggers.ok && triggers.value.map((t) => t.id)).toEqual([
			"loop:start",
			"hi:start",
		]);
		expect(await merged.dispatch("hi:start", target)).toEqual(ok("hi started"));
		expect(seen).toEqual(["hi/start"]);
		expect((await merged.dispatch("nope:start", target)).ok).toBe(false);
	});

	test("a failing contributor's triggers are reported by name", async () => {
		const broken: Dispatcher = {
			triggers: async () => err(new Error("no config")),
			dispatch: async () => ok(""),
		};
		const triggers = await Dispatchers.merge({
			loop: named("loop"),
			broken,
		}).triggers("01TASK");
		expect(!triggers.ok && triggers.error.message).toBe("broken: no config");
	});
});
