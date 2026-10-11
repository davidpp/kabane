// Run state is device-local files beside the device's sessions, never the tracker:
//
//   $KABANE_HOME/loops/<runId>/run.json      config, status, runner pid, claims, usage
//   $KABANE_HOME/loops/<runId>/events.jsonl  the trace, and the board's event source
//   $KABANE_HOME/loops/<runId>/inbox.jsonl   requests to the runner, append-only
//   $KABANE_HOME/loops/<runId>/runner.log    the detached runner's stdout and stderr
//
// One writer per file while a run is live: the runner owns run.json and events.jsonl, anyone
// may append to the inbox. `run.json` is replaced by rename, so a reader never sees half of it.
// A run whose runner is gone reads as `failed`: a status that says "running" with nobody running
// it is the one lie this store refuses to tell.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { err, ok, type Result, trySync } from "@cabane/core";
import { z } from "zod";
import { Budget } from "./budget";
import { LoopConfig } from "./config";
import { Gates } from "./gates";
import { Stall } from "./stall";
import { Steering } from "./steering";

export namespace RunStore {
	export const STATUSES = [
		"pending",
		"running",
		"completed",
		"stopped",
		"failed",
	] as const;
	export const StatusSchema = z.enum(STATUSES);
	export type Status = z.infer<typeof StatusSchema>;

	const LIVE: ReadonlySet<Status> = new Set(["pending", "running"]);
	export const isLive = (status: Status): boolean => LIVE.has(status);

	export const OUTCOMES = [
		"done",
		"incomplete",
		"error",
		"cancelled",
		"interrupted",
	] as const;

	/**
	 * One subtask claimed by one session, or one lens run on the parent. A subtask claimed twice
	 * has two claims.
	 */
	export const ClaimSchema = z.object({
		taskId: z.string(),
		shortId: z.string(),
		harness: z.string(),
		/** The event lane: harness and subtask, numbered from the second attempt on. */
		lane: z.string(),
		/** The core `agent_session` this claim's ACP session is mirrored into. */
		sessionId: z.string(),
		startedAt: z.string(),
		endedAt: z.string().optional(),
		outcome: z.enum(OUTCOMES).optional(),
		detail: z.string().optional(),
		continuations: z.number().int().min(0).default(0),
		/** The verifier lens this session ran, on the parent; absent for an implementing one. */
		lens: z.string().optional(),
	});
	export type Claim = z.infer<typeof ClaimSchema>;

	export const RunSchema = z.object({
		version: z.literal(1),
		id: z.string(),
		parentId: z.string(),
		parentShortId: z.string(),
		/** The parent issue's scope: each session's `kabane mcp --scope`. */
		scopeUri: z.string().optional(),
		/** The directory the loop was started from: the project checkout it works on. */
		projectDir: z.string(),
		/** A worktree of `projectDir` the run works in instead, when one is enabled. */
		worktree: z.string().optional(),
		config: LoopConfig.Schema,
		status: StatusSchema,
		exit: z
			.object({ reason: z.string(), detail: z.string().optional() })
			.optional(),
		/** The runner process; written by the runner itself when it boots. */
		pid: z.number().int().positive().optional(),
		createdAt: z.string(),
		startedAt: z.string().optional(),
		endedAt: z.string().optional(),
		claims: z.array(ClaimSchema).default([]),
		usage: Budget.MeterSchema.default({}),
		continuationsUsed: z.number().int().min(0).default(0),
		stall: Stall.StateSchema.optional(),
		/** Inbox lines already handled. */
		inboxRead: z.number().int().min(0).default(0),
		/** What the human said about claiming: paused, skipped, next. */
		steering: Steering.StateSchema.default({}),
		/** Every pass over the gates, oldest first; the last says whether they are green. */
		gateRuns: z.array(Gates.RunSchema).default([]),
		/** When the human closed the run's board tab: the board stops listing it. */
		dismissedAt: z.string().optional(),
	});
	export type Run = z.infer<typeof RunSchema>;

	/** The `externalRef` of every core session run `runId` opens: how a session finds its run. */
	export const sessionRef = (runId: string): string => `loop:${runId}`;

	/** The run a core session belongs to, from its `externalRef`; undefined for any other session. */
	export const runOfSession = (
		externalRef: string | undefined,
	): string | undefined =>
		externalRef?.startsWith("loop:") ? externalRef.slice(5) : undefined;

	/** The checkpoints committed in the run's worktree, oldest first. */
	export const checkpoints = (run: Run): string[] =>
		run.gateRuns.flatMap((g) => (g.checkpoint ? [g.checkpoint] : []));

	/** Where the run's sessions work: its worktree when it has one, else the project. */
	export const sessionDir = (run: Run): string =>
		run.worktree ?? run.projectDir;

	export const EventSchema = z.object({
		seq: z.number().int().positive(),
		at: z.string(),
		type: z.string(),
		summary: z.string(),
		lane: z.string().optional(),
		/** The core session id, for an event that came from one. */
		session: z.string().optional(),
		task: z.string().optional(),
		/** Machine-readable fields behind the summary, for an event that has some. */
		data: z.record(z.union([z.string(), z.number()])).optional(),
	});
	export type Event = z.infer<typeof EventSchema>;
	export type EventDraft = Omit<Event, "seq" | "at">;

	// The runner reads every kind but `answered`, which the permission relay reads for itself.
	export const InboxEntrySchema = z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("stop"), at: z.string() }),
		...Steering.DirectiveSchemas,
		// Text for one session: into its running turn, or its next prompt (`Dispatch.inject`).
		z.object({
			kind: z.literal("inject"),
			at: z.string(),
			/** The core session the text is for, and the lane it was aimed at on the board. */
			session: z.string(),
			lane: z.string(),
			text: z.string(),
		}),
		// Who answered one of the run's questions. The answer itself is the core `decision`; core
		// records no author on activities, so the answering surface notes its actor here.
		z.object({
			kind: z.literal("answered"),
			questionId: z.string(),
			by: z.string(),
			at: z.string(),
		}),
		// `kabane loop rollback` reset the worktree of a live run; the runner puts it on the trace,
		// which only it writes while the run is live.
		z.object({
			kind: z.literal("rolled_back"),
			sha: z.string(),
			by: z.string(),
			at: z.string(),
		}),
	]);
	export type InboxEntry = z.infer<typeof InboxEntrySchema>;

	// A run id names a directory, so it can never climb out of `loops/`.
	const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

	export const loopsDir = (home: string): string => join(home, "loops");

	const dirOf = (home: string, runId: string): Result<string> =>
		RUN_ID.test(runId)
			? ok(join(loopsDir(home), runId))
			: err(new Error(`Invalid run id: ${JSON.stringify(runId)}`));

	export const paths = (home: string, runId: string) => {
		const dir = join(loopsDir(home), runId);
		return {
			dir,
			run: join(dir, "run.json"),
			events: join(dir, "events.jsonl"),
			inbox: join(dir, "inbox.jsonl"),
			log: join(dir, "runner.log"),
		};
	};

	/** A short id plus a time suffix: readable in a listing, unique per device. */
	export const newRunId = (parentShortId: string, now: Date): string =>
		`${parentShortId.replace(/[^A-Za-z0-9-]/g, "")}-${now.getTime().toString(36)}`;

	export const create = (home: string, run: Run): Result<Run> => {
		const dir = dirOf(home, run.id);
		if (!dir.ok) return dir;
		if (existsSync(dir.value))
			return err(new Error(`Run ${run.id} already exists`));
		const made = trySync(() => mkdirSync(dir.value, { recursive: true }));
		if (!made.ok) return made;
		return write(home, run);
	};

	export const write = (home: string, run: Run): Result<Run> => {
		const dir = dirOf(home, run.id);
		if (!dir.ok) return dir;
		const file = paths(home, run.id).run;
		const tmp = `${file}.${process.pid}.tmp`;
		const written = trySync(() => {
			writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`);
			renameSync(tmp, file);
		});
		return written.ok ? ok(run) : written;
	};

	/** The run as written, with no liveness judgement. */
	export const readRaw = (home: string, runId: string): Result<Run> => {
		const dir = dirOf(home, runId);
		if (!dir.ok) return dir;
		const file = paths(home, runId).run;
		if (!existsSync(file)) return err(new Error(`No loop run ${runId}`));
		const text = trySync(() => readFileSync(file, "utf8"));
		if (!text.ok) return text;
		const json = trySync((): unknown => JSON.parse(text.value));
		if (!json.ok) return err(new Error(`${file}: ${json.error.message}`));
		const parsed = RunSchema.safeParse(json.value);
		return parsed.success
			? ok(parsed.data)
			: err(new Error(`${file}: ${parsed.error.message}`));
	};

	/** Whether a process with this pid exists. EPERM means it does, owned by someone else. */
	export const pidAlive = (pid: number): boolean => {
		const probed = trySync(() => process.kill(pid, 0));
		if (probed.ok) return true;
		return "code" in probed.error && probed.error.code === "EPERM";
	};

	/**
	 * What the run is, as opposed to what it last said: a live status whose runner pid is
	 * gone is `failed`. A pending run with no pid yet is left pending; its runner may still
	 * be booting.
	 */
	export const effective = (
		run: Run,
		alive: (pid: number) => boolean = pidAlive,
	): Run =>
		isLive(run.status) && run.pid !== undefined && !alive(run.pid)
			? {
					...run,
					status: "failed",
					exit: {
						reason: "runner-died",
						detail: `runner pid ${run.pid} exited without finishing the run`,
					},
				}
			: run;

	export const read = (
		home: string,
		runId: string,
		alive: (pid: number) => boolean = pidAlive,
	): Result<Run> => {
		const raw = readRaw(home, runId);
		return raw.ok ? ok(effective(raw.value, alive)) : raw;
	};

	/**
	 * Record that the human closed the run's tab. Only a run that is over: the runner owns
	 * run.json while it is live, and a live run has a tab for a reason. A run whose runner died
	 * is over, and its runner is not there to race the write.
	 */
	export const dismiss = (
		home: string,
		runId: string,
		now: Date,
		alive: (pid: number) => boolean = pidAlive,
	): Result<Run> => {
		const raw = readRaw(home, runId);
		if (!raw.ok) return raw;
		if (isLive(effective(raw.value, alive).status))
			return err(new Error(`Run ${runId} is still running; stop it first`));
		if (raw.value.dismissedAt) return raw;
		return write(home, { ...raw.value, dismissedAt: now.toISOString() });
	};

	/** Every run on this device, newest first. A run that cannot be read is skipped. */
	export const list = (home: string): Result<Run[]> => {
		const dir = loopsDir(home);
		if (!existsSync(dir)) return ok([]);
		const names = trySync(() => readdirSync(dir));
		if (!names.ok) return names;
		const runs = names.value.flatMap((name) => {
			const run = read(home, name);
			return run.ok ? [run.value] : [];
		});
		return ok(runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
	};

	const readText = (file: string): Result<string> =>
		existsSync(file) ? trySync(() => readFileSync(file, "utf8")) : ok("");

	const nonBlank = (text: string): string[] =>
		text.split("\n").filter((line) => line.trim() !== "");

	// The lines a writer has finished: a tail with no newline yet is an append still in progress,
	// left for the next read rather than taken for a broken line and skipped for good.
	const lines = (file: string): Result<string[]> => {
		const text = readText(file);
		if (!text.ok) return text;
		return ok(nonBlank(text.value.slice(0, text.value.lastIndexOf("\n") + 1)));
	};

	const parseLine = <T>(schema: z.ZodType<T>, line: string): T | undefined => {
		const json = trySync((): unknown => JSON.parse(line));
		if (!json.ok) return undefined;
		const parsed = schema.safeParse(json.value);
		return parsed.success ? parsed.data : undefined;
	};

	export type EventLog = {
		append: (event: EventDraft) => Result<Event>;
	};

	/**
	 * The runner's appender. Numbering resumes after whatever the file already holds. A last line
	 * with no newline is what a runner that died mid-append left: the first append ends it first,
	 * so the new event starts a line of its own rather than being glued onto the torn one.
	 */
	export const eventLog = (
		home: string,
		runId: string,
		now: () => Date = () => new Date(),
	): Result<EventLog> => {
		const file = paths(home, runId).events;
		const existing = readText(file);
		if (!existing.ok) return existing;
		let seq = nonBlank(existing.value).length;
		let torn = existing.value !== "" && !existing.value.endsWith("\n");
		return ok({
			append: (draft) => {
				const event: Event = {
					...draft,
					seq: seq + 1,
					at: now().toISOString(),
				};
				const appended = trySync(() =>
					appendFileSync(file, `${torn ? "\n" : ""}${JSON.stringify(event)}\n`),
				);
				if (!appended.ok) return appended;
				torn = false;
				seq += 1;
				return ok(event);
			},
		});
	};

	/** Events after `afterSeq`. A line that does not parse is skipped. */
	export const readEvents = (
		home: string,
		runId: string,
		afterSeq = 0,
	): Result<Event[]> => {
		const dir = dirOf(home, runId);
		if (!dir.ok) return dir;
		const all = lines(paths(home, runId).events);
		if (!all.ok) return all;
		return ok(
			all.value.flatMap((line) => {
				const event = parseLine(EventSchema, line);
				return event && event.seq > afterSeq ? [event] : [];
			}),
		);
	};

	export const appendInbox = (
		home: string,
		runId: string,
		entry: InboxEntry,
	): Result<void> => {
		const dir = dirOf(home, runId);
		if (!dir.ok) return dir;
		return trySync(() =>
			appendFileSync(paths(home, runId).inbox, `${JSON.stringify(entry)}\n`),
		);
	};

	/**
	 * Inbox lines from `from` on, and the cursor to persist once they are handled. A line no
	 * schema accepts is returned in `invalid` rather than dropped, so the runner can say so.
	 */
	export const readInbox = (
		home: string,
		runId: string,
		from: number,
	): Result<{ entries: InboxEntry[]; invalid: string[]; next: number }> => {
		const dir = dirOf(home, runId);
		if (!dir.ok) return dir;
		const all = lines(paths(home, runId).inbox);
		if (!all.ok) return all;
		const entries: InboxEntry[] = [];
		const invalid: string[] = [];
		for (const line of all.value.slice(from)) {
			const entry = parseLine(InboxEntrySchema, line);
			if (entry) entries.push(entry);
			else invalid.push(line);
		}
		return ok({ entries, invalid, next: all.value.length });
	};
}
