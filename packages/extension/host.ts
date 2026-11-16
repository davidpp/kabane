/** The versioned host supplied to an extension factory. */
import type {
	ProjectScope,
	Db,
	defineTool,
	err,
	ok,
	Result,
	Row,
	TaskUpdate,
	tryCatch,
	trySync,
	Task,
	TaskEntry,
	TaskLink,
	TaskWorkLog,
	UpstreamLink,
	ItemKind,
	TaskPriority,
	TaskState,
} from "@cabane/core";
import type { z } from "zod";
import type { flagBool, flagCsv, flagList, flagString } from "./args";
import type { conciseSuccess, failure, success, usage } from "./outcome";
import type { Settings } from "./settings";

export type Host = {
	readonly api: 1;
	readonly kabane: { readonly version: string; readonly executable: string };
	readonly record: Host.Record;
	readonly scope: {
		detect(dir: string): Promise<Result<ProjectScope | null>>;
		idOf(uri: string): Result<string>;
	};
	readonly harnessMode: "auto" | "default";
	/** For the extension's own data modules (the manifest's modules entry). */
	readonly store: Host.Store;
	readonly z: typeof z;
	readonly result: {
		ok: typeof ok;
		err: typeof err;
		tryCatch: typeof tryCatch;
		trySync: typeof trySync;
	};
	readonly args: {
		flagBool: typeof flagBool;
		flagString: typeof flagString;
		flagList: typeof flagList;
		flagCsv: typeof flagCsv;
	};
	readonly outcome: {
		success: typeof success;
		conciseSuccess: typeof conciseSuccess;
		failure: typeof failure;
		usage: typeof usage;
	};
	readonly settings: Pick<
		typeof Settings,
		"fields" | "groupsOf" | "lookOf" | "options"
	>;
	readonly defineTool: typeof defineTool;
};

export namespace Host {
	export type ListInput = {
		state?: TaskState;
		kind?: ItemKind;
		priority?: TaskPriority;
		assignee?: string;
		scopeUri?: string;
		tag?: string;
		parentTaskId?: string;
		includeDeferred?: boolean;
		includeClosed?: boolean;
		limit?: number;
		offset?: number;
	};
	export type EditInput = {
		id: string;
		title?: string;
		description?: string;
		state?: TaskState;
		needsReview?: boolean;
		priority?: TaskPriority;
		kind?: ItemKind;
		assignee?: string;
		scopeUri?: string;
		parentTaskId?: string;
		tags?: string[];
		dueDate?: string;
	};
	export type ContextInput = {
		id: string;
		deref?: boolean;
		includeSubtasks?: boolean;
	};
	export type UpstreamLinkInput = {
		id: string;
		provider: string;
		externalId: string;
		identifier?: string;
		url: string;
		title: string;
	};
	export type Record = {
		/** kabane_get; null when absent, err only when the read fails. */
		get(input: { id: string }): Promise<Result<Task | null>>;
		/** kabane_list */
		list(input: ListInput): Promise<Result<Task[]>>;
		/** kabane_edit */
		edit(input: EditInput): Promise<Result<Task>>;
		/** kabane_done */
		done(input: { id: string }): Promise<Result<Task>>;
		/** kabane_comment */
		comment(input: {
			id: string;
			body: string;
			kind?: string;
		}): Promise<Result<TaskEntry>>;
		/** kabane_log */
		log(input: {
			id: string;
			refs?: { uri: string; label?: string }[];
			commit?: string;
			note?: string;
		}): Promise<Result<TaskWorkLog>>;
		/** kabane_context, full format. */
		context(
			input: ContextInput,
		): Promise<Result<{ id: string; markdown: string }>>;
		/** kabane_upstream_link */
		upstreamLink(input: UpstreamLinkInput): Promise<Result<UpstreamLink>>;
		/** kabane_linkList */
		links(input: { id: string }): Promise<Result<TaskLink[]>>;
		/** kabane_upstreamList */
		upstreamLinks(input: { id: string }): Promise<Result<UpstreamLink[]>>;
		/** kabane_logList */
		workLogs(input: {
			id: string;
			limit?: number;
		}): Promise<Result<TaskWorkLog[]>>;
		/** Any registered tool, including data modules; input passes through unchanged. */
		call(tool: string, input: unknown): Promise<Result<unknown>>;
	};
	/**
	 * Storage for the extension's data modules. Both calls return the "not configured yet" `err`
	 * until the store is open and this host's factory has returned.
	 */
	export type Store = {
		/** Reads, on a connection that refuses writes. */
		read<T>(fn: (db: Db) => Result<T> | Promise<Result<T>>): Promise<Result<T>>;
		/**
		 * One transaction. An `err` returned from `fn`, a throw, or an `err` from any `tx` call
		 * rolls everything back. After the commit, and only then, the host emits `TASK_UPDATED`
		 * for every task `tx.updateTask` changed.
		 *
		 * `fn` runs inside the database's write lock: do not await I/O, a timer or another write
		 * in it. A `store.write` nested in it, from any host, and a `host.record` call that writes
		 * return an `err` at once; `record` reads work and see what was committed before this write
		 * began. A callback `fn` schedules may write once this write has ended.
		 *
		 * What takes turns: every `store.write` and every `host.record` write in the process, each
		 * waiting at most 5000 ms (SQLite's busy timeout) and then returning an `err` naming the
		 * write that holds the turn, without ever running. What does not: kabane's own writes (CLI
		 * commands, MCP tools, the board) open their own connection and wait in SQLite's busy
		 * handler, which blocks the thread `fn` would resume on; so while `fn` awaits, a
		 * first-party write in the same process stalls for that timeout. Awaiting inside `fn` is
		 * the misuse that causes both.
		 */
		write<T>(
			fn: (tx: Tx) => Result<T> | Promise<Result<T>>,
		): Promise<Result<T>>;
	};
	/**
	 * A write transaction, valid only while `fn` runs. Capture calls exist only here, and only
	 * they are checked against the tables the extension's modules declare.
	 */
	export type Tx = {
		/** A raw handle on the open transaction: nothing checks which tables SQL on it touches. */
		readonly db: Db;
		/** Capture a row of one of the extension's tables after an insert or update. */
		afterWrite(
			table: string,
			op: "insert" | "update",
			id: string,
		): Result<void>;
		/** The row as it is, read before a delete. */
		snapshot(table: string, id: string): Result<Row | undefined>;
		/** Capture deleted rows of the extension's tables, children first. */
		afterDelete(rows: readonly { tbl: string; row: Row }[]): Result<void>;
		/** The one way to change a task: runs every module's `onTaskStateChange` on a state change. */
		updateTask(id: string, updates: TaskUpdate): Result<Task | null>;
	};
}
