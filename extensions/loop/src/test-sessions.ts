// Real run-store setup and reads for session tests. Answers use the public command entry point.
import { mkdirSync } from "node:fs";
import type { Result } from "@kabane/core";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { ok } from "./result";
import { RunStore } from "./store";
import { testHost } from "./test-host";

export namespace TestSessions {
	export const open = async (
		home: string,
		input: { taskId: string; agent: string; externalRef?: string },
	): Promise<Result<{ id: string }>> => {
		const id = RunStore.newSessionId();
		const runId = input.externalRef?.slice(5) ?? "test-run";
		const task = await testHost(home).record.get({ id: input.taskId });
		if (!task.ok) return task;
		const config = LoopConfig.Schema.safeParse({});
		if (!config.success) throw config.error;
		const existing = RunStore.readRaw(home, runId);
		const run: RunStore.Run = existing.ok
			? existing.value
			: {
					version: 1,
					id: runId,
					parentId: input.taskId,
					parentShortId: task.value?.shortId ?? input.taskId,
					projectDir: home,
					config: config.data,
					status: "running",
					pid: process.pid,
					createdAt: new Date().toISOString(),
					claims: [],
					usage: {},
					continuationsUsed: 0,
					inboxRead: 0,
					steering: { paused: false, skipped: [], next: [] },
					gateRuns: [],
				};
		run.claims.push({
			sessionId: id,
			taskId: input.taskId,
			shortId: task.value?.shortId ?? input.taskId,
			harness: input.agent,
			lane: input.agent,
			startedAt: new Date().toISOString(),
			continuations: 0,
		});
		mkdirSync(RunStore.paths(home, runId).dir, { recursive: true });
		const written = RunStore.write(home, run);
		return written.ok ? ok({ id }) : written;
	};
	export const owner = (home: string, sessionId: string): RunStore.Run => {
		const runs = RunStore.list(home);
		if (!runs.ok) throw runs.error;
		const run = runs.value.find((r) =>
			r.claims.some((c) => c.sessionId === sessionId),
		);
		if (!run) throw new Error(`Missing run for ${sessionId}`);
		return run;
	};
	export const append = (
		home: string,
		draft: Omit<RunStore.QuestionEntry, "id" | "createdAt">,
	) => RunStore.recordQuestion(home, owner(home, draft.sessionId).id, draft);
	export const journal = (home: string, sessionId: string) => {
		const entries = RunStore.questionEntries(home, owner(home, sessionId).id);
		return entries.ok
			? ok(entries.value.filter((e) => e.sessionId === sessionId))
			: entries;
	};
	export const pending = async (home: string) => {
		const runs = RunStore.list(home);
		if (!runs.ok) return runs;
		const rows = [];
		for (const run of runs.value.filter((r) => RunStore.isLive(r.status))) {
			const entries = RunStore.pendingQuestions(home, run);
			if (!entries.ok) return entries;
			for (const { question, claim } of entries.value)
				rows.push({ session: { id: claim.sessionId }, question });
		}
		return ok(rows);
	};
	export const submit = (
		home: string,
		input: { questionId: string; answer: string },
	) =>
		Loop.answer(
			{
				home,
				basePath: home,
				host: testHost(home),
				actor: "cabane://actor/human/test",
			},
			input.questionId,
			input.answer,
		);
	export const close = (home: string, sessionId: string) => {
		const run = owner(home, sessionId);
		return RunStore.write(home, {
			...run,
			claims: run.claims.map((c) =>
				c.sessionId === sessionId
					? { ...c, endedAt: new Date().toISOString() }
					: c,
			),
		});
	};
}
