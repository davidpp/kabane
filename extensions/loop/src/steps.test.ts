import { describe, expect, it } from "bun:test";
import type { Task } from "@kabane/core";
import { LoopActivity } from "./activity";
import { LoopPlan } from "./plan";
import { RunSteps } from "./steps";
import { RunStore } from "./store";

// A finished review run as run.json holds it, its names and ids made up: two review sessions after
// triage, the fixer, a subtask filed during the review and claimed while the fixer worked, five
// rechecks, three gate passes and the branch kept for review.
const claim = (
	lane: string,
	startedAt: string,
	endedAt: string | undefined,
	extra: Record<string, unknown> = {},
) => ({
	taskId: "01PARENT",
	shortId: "PROJ-5",
	harness: "codex",
	lane,
	sessionId: `s-${lane}`,
	startedAt: `2026-11-20T${startedAt}.000Z`,
	...(endedAt
		? { endedAt: `2026-11-20T${endedAt}.000Z`, outcome: "done" }
		: {}),
	continuations: 0,
	...extra,
});

const pass = (at: string) => ({
	at: `2026-11-20T${at}.000Z`,
	results: ["check", "test", "build"].map((name) => ({
		name,
		command: `bun run ${name}`,
		ok: true,
		exit: 0,
		ms: 4000,
		tail: "",
	})),
	ok: true,
	tree: `tree-${at}`,
});

const RECHECKS = {
	functional: ["01F1", "01F2"],
	quality: ["01F3"],
	docs: ["01F4", "01F5"],
	architecture: ["01F6"],
	design: ["01F7", "01F8"],
} as const;

const RUN_JSON = {
	version: 1,
	id: "PROJ-5-run",
	parentId: "01PARENT",
	parentShortId: "PROJ-5",
	projectDir: "/repo",
	worktree: "/home/.kabane/loops/PROJ-5-run/worktree",
	branch: "proj-5-reader",
	base: { branch: "main", sha: "abc123" },
	config: {
		implementer: "claude",
		gates: {
			check: "bun run check",
			test: "bun run test",
			build: "bun run build",
		},
		lenses: ["functional", "quality", "docs", "architecture", "design"],
		recheck: true,
		review: { mode: "triage", tier: "fast" },
		verifier: "codex",
		land: "none",
		budget: { concurrency: 2, continuations: 3, currency: "USD" },
	},
	status: "completed",
	exit: { reason: "plan-done", detail: "6 findings left open for a human" },
	createdAt: "2026-11-20T08:35:00.000Z",
	startedAt: "2026-11-20T08:36:11.000Z",
	endedAt: "2026-11-20T09:23:03.000Z",
	claims: [
		claim("triage", "08:36:18", "08:36:32", { triage: true }),
		claim("functional+quality+architecture-lens", "08:36:32", "08:42:30", {
			lenses: ["functional", "quality", "architecture"],
		}),
		claim("docs+design-lens", "08:36:32", "08:43:41", {
			lenses: ["docs", "design"],
		}),
		claim("fixer", "08:43:41", "09:10:39", {
			harness: "claude",
			fixer: true,
			head: "def456",
			findings: Object.values(RECHECKS).flat(),
		}),
		claim("PROJ-41", "09:10:20", "09:12:22", {
			taskId: "01P41",
			shortId: "PROJ-41",
			harness: "claude",
		}),
		...Object.entries(RECHECKS).map(([lens, findings], index) =>
			claim(
				`${lens}-recheck`,
				index < 2 ? "09:12:28" : index < 4 ? "09:15:39" : "09:18:52",
				index < 2 ? "09:15:39" : index < 4 ? "09:18:52" : "09:23:03",
				{ recheck: lens, findings },
			),
		),
	],
	usage: {
		"s-fixer": { used: 1, size: 10, cost: { amount: 16.174, currency: "USD" } },
		"s-PROJ-41": {
			used: 1,
			size: 10,
			cost: { amount: 1.324, currency: "USD" },
		},
	},
	continuationsUsed: 0,
	inboxRead: 0,
	steering: { paused: false, skipped: [], next: [] },
	gateRuns: [pass("08:36:10"), pass("09:12:22"), pass("09:23:03")],
	review: {
		groups: [
			{
				lenses: ["functional", "quality", "architecture"],
				tier: "frontier",
				reason: "one code path",
			},
			{ lenses: ["docs", "design"], reason: "reader-facing" },
		],
		skipped: [],
	},
};

const finished = (over: Record<string, unknown> = {}): RunStore.Run =>
	RunStore.RunSchema.parse({ ...RUN_JSON, ...over });

const task = (
	id: string,
	state: Task["state"],
	tags: string[],
	createdAt: string,
): Task =>
	({
		id,
		shortId: id.replace(/^01/, "PROJ-"),
		title: `the ${id} title`,
		kind: "issue",
		state,
		tags,
		createdAt: `2026-11-20T${createdAt}.000Z`,
	}) as Task;

const finding = (
	id: string,
	lens: string,
	state: Task["state"],
	at = "08:40:00",
) => task(id, state, ["finding", "p1", lens], at);

// The parent's children once the run is over: the subtask done; of the findings the rechecks were
// given, three reopened; three more filed by the rechecks.
const CHILDREN: Task[] = [
	task("01P41", "done", [], "08:50:00"),
	finding("01F1", "functional", "next"),
	finding("01F2", "functional", "done"),
	finding("01F3", "quality", "next"),
	finding("01F4", "docs", "done"),
	finding("01F5", "docs", "next"),
	finding("01F6", "architecture", "done"),
	finding("01F7", "design", "done"),
	finding("01F8", "design", "done"),
	finding("01N1", "architecture", "next", "09:16:30"),
	finding("01N2", "docs", "next", "09:17:00"),
	finding("01N3", "design", "next", "09:20:00"),
];
const NODES = CHILDREN.map((t) => LoopPlan.node(t, []));
const NOW = new Date("2026-11-20T09:25:00.000Z");

const row = (step: { name: string; state: string; result?: string }) =>
	`${step.state} ${step.name}${step.result ? ` · ${step.result}` : ""}`;

describe("RunSteps", () => {
	it("a finished run's map: every step done in order, landing last, each with its result", () => {
		const steps = RunSteps.of(finished(), NODES, NOW);
		expect(steps.map(row)).toEqual([
			"done implement · 1 of 1 done",
			"done gates · check·test·build · 3 passes",
			"done triage · 2 review sessions",
			"done review · 8 findings filed",
			"done fixer · 5 settled",
			"done recheck · 5 confirmed · 3 reopened · 3 filed",
			"done land · none: kept for review",
		]);
		expect(steps.map((s) => s.durationMs)).toEqual([
			122_000,
			36_000,
			14_000,
			429_000,
			1_618_000,
			635_000,
			undefined,
		]);
		const recheck = steps.find((s) => s.name === "recheck");
		expect(recheck?.sessions?.map((s) => [s.name, s.lane, s.result])).toEqual([
			["functional", "functional-recheck", "1 confirmed · 1 reopened"],
			["quality", "quality-recheck", "0 confirmed · 1 reopened"],
			["docs", "docs-recheck", "1 confirmed · 1 reopened · 1 filed"],
			[
				"architecture",
				"architecture-recheck",
				"1 confirmed · 0 reopened · 1 filed",
			],
			["design", "design-recheck", "2 confirmed · 0 reopened · 1 filed"],
		]);
	});

	it("lists what the run left: the findings reopened or filed, then the branch it kept", () => {
		expect(RunSteps.left(finished(), NODES)).toEqual([
			{
				taskId: "01F1",
				taskShortId: "PROJ-F1",
				how: "reopened by functional",
				reason: "the 01F1 title",
			},
			{
				taskId: "01F3",
				taskShortId: "PROJ-F3",
				how: "reopened by quality",
				reason: "the 01F3 title",
			},
			{
				taskId: "01F5",
				taskShortId: "PROJ-F5",
				how: "reopened by docs",
				reason: "the 01F5 title",
			},
			{
				taskId: "01N1",
				taskShortId: "PROJ-N1",
				how: "filed by architecture",
				reason: "the 01N1 title",
			},
			{
				taskId: "01N2",
				taskShortId: "PROJ-N2",
				how: "filed by docs",
				reason: "the 01N2 title",
			},
			{
				taskId: "01N3",
				taskShortId: "PROJ-N3",
				how: "filed by design",
				reason: "the 01N3 title",
			},
			{ how: "branch proj-5-reader", reason: "land: none" },
		]);
		// A landed branch is not left; a live run has left nothing yet.
		expect(
			RunSteps.left(
				finished({
					landing: {
						at: "2026-11-20T09:24:00.000Z",
						ok: true,
						summary: "merged",
					},
				}),
				NODES,
			).some((item) => item.how.startsWith("branch")),
		).toBe(false);
		expect(RunSteps.left(finished({ status: "running" }), NODES)).toEqual([]);
	});

	it("mid-run: the live step and its sessions run, a recheck waiting for a slot is listed, and the land is to come", () => {
		const claims = RUN_JSON.claims
			.map((c) =>
				c.lane === "docs-recheck" || c.lane === "architecture-recheck"
					? { ...c, endedAt: undefined, outcome: undefined }
					: c,
			)
			.filter((c) => c.lane !== "design-recheck");
		const live = finished({
			status: "running",
			exit: undefined,
			endedAt: undefined,
			claims,
			gateRuns: RUN_JSON.gateRuns.slice(0, 2),
		});
		const open = NODES.filter(
			(n) => !["01N1", "01N2", "01N3"].includes(n.task.id),
		);
		const steps = RunSteps.of(live, open, NOW);
		expect(steps.map(row)).toEqual([
			"done implement · 1 of 1 done",
			"done gates · check·test·build · 2 passes",
			"done triage · 2 review sessions",
			"done review · 8 findings filed",
			"done fixer · 5 settled",
			"running recheck · 2 of 5 done · 2 live",
			"pending land · none: the branch stays for review",
		]);
		const recheck = steps.find((s) => s.name === "recheck");
		expect(recheck?.startedAt).toBe("2026-11-20T09:12:28.000Z");
		expect(recheck?.durationMs).toBeUndefined();
		expect(
			recheck?.sessions?.map((s) => `${s.state} ${s.name} · ${s.result ?? ""}`),
		).toEqual([
			"done functional · 1 confirmed · 1 reopened",
			"done quality · 0 confirmed · 1 reopened",
			"running docs · 2 findings",
			"running architecture · 1 finding",
			"pending design · 2 findings · waits for a slot",
		]);
		expect(RunSteps.current(steps)?.name).toBe("recheck");
	});

	it("implement is live again when a subtask filed during the review is claimed beside the fixer", () => {
		const claims = RUN_JSON.claims
			.slice(0, 5)
			.map((c) =>
				c.lane === "fixer" || c.lane === "PROJ-41"
					? { ...c, endedAt: undefined, outcome: undefined }
					: c,
			);
		const live = finished({
			status: "running",
			exit: undefined,
			endedAt: undefined,
			claims,
		});
		const nodes = [
			LoopPlan.node(task("01P41", "in_progress", [], "08:50:00"), []),
			...NODES.slice(1, 9),
		];
		const steps = RunSteps.of(live, nodes, NOW);
		expect(
			steps.filter((s) => s.state === "running").map((s) => s.name),
		).toEqual(["implement", "fixer"]);
		expect(steps.find((s) => s.name === "implement")?.result).toBe(
			"0 of 1 done · 1 live",
		);
		expect(RunSteps.current(steps)?.name).toBe("fixer");
	});

	it("a lens triage skipped counts as reviewed, never as pending", () => {
		const skipped = finished({
			config: {
				...RUN_JSON.config,
				lenses: ["functional", "quality"],
				recheck: false,
			},
			claims: [
				claim("triage", "08:36:18", "08:36:32", { triage: true }),
				claim("functional-lens", "08:36:32", "08:40:00", {
					lenses: ["functional"],
				}),
			],
			review: {
				groups: [{ lenses: ["functional"], reason: "the code" }],
				skipped: [{ lens: "quality", reason: "no code style change" }],
			},
		});
		const review = RunSteps.of(skipped, [], NOW).find(
			(s) => s.name === "review",
		);
		expect(review?.state).toBe("done");
		expect(
			review?.sessions?.map((s) => `${s.state} ${s.name} · ${s.result}`),
		).toEqual([
			"done functional · 0 findings filed",
			"done quality · skipped · no code style change",
		]);
	});

	it("a run that does not triage: its one lens's review is done once its session is", () => {
		const single = finished({
			config: { ...RUN_JSON.config, lenses: ["functional"], recheck: false },
			claims: [
				claim("functional-lens", "08:36:32", "08:40:00", {
					lenses: ["functional"],
				}),
			],
			review: undefined,
		});
		const steps = RunSteps.of(single, [], NOW);
		expect(steps.map((s) => `${s.state} ${s.name}`)).toEqual([
			"pending implement",
			"done gates",
			"done review",
			"done fixer",
			"done land",
		]);
		const live = finished({
			status: "running",
			exit: undefined,
			endedAt: undefined,
			config: single.config,
			review: undefined,
			claims: [
				claim("functional-lens", "08:36:32", undefined, {
					lenses: ["functional"],
				}),
			],
		});
		expect(
			RunSteps.of(live, [], NOW).find((s) => s.name === "review")?.state,
		).toBe("running");
	});

	it("a step the run stopped in reads stopped, and one it never reached stays to come", () => {
		const stopped = finished({
			status: "stopped",
			exit: { reason: "stop-requested" },
			claims: [
				claim("PROJ-41", "08:36:18", undefined, {
					taskId: "01P41",
					shortId: "PROJ-41",
				}),
			],
			gateRuns: [],
			review: undefined,
		});
		const nodes = [
			LoopPlan.node(task("01P41", "in_progress", [], "08:30:00"), []),
		];
		expect(
			RunSteps.of(stopped, nodes, NOW).map((s) => `${s.state} ${s.name}`),
		).toEqual([
			"stopped implement",
			"pending gates",
			"pending triage",
			"pending review",
			"pending fixer",
			"pending recheck",
			"pending land",
		]);
	});
});

describe("LoopActivity.card", () => {
	it("carries the steps and what is left, and leaves out an empty left list", () => {
		const card = LoopActivity.card(finished(), NODES, NOW);
		expect(card.steps?.map((s) => s.name)).toEqual([
			"implement",
			"gates",
			"triage",
			"review",
			"fixer",
			"recheck",
			"land",
		]);
		expect(card.left?.length).toBe(7);
		const landed = LoopActivity.card(
			finished({
				landing: {
					at: "2026-11-20T09:24:00.000Z",
					ok: true,
					summary: "merged",
				},
			}),
			[],
			NOW,
		);
		expect("left" in landed).toBe(false);
	});
});
