// The event log's tool calls as rows: a call and its end fold into one row that knows how the call
// went, and a run of reads and searches with nothing said between them folds into one group. Pure,
// so the folding is asserted without a renderer; event-view.tsx draws what this returns.
//
// The caps follow opencode's util/collapse-tool-output.ts: a head cut by lines and by characters
// ending in `…`, and an output's tail kept behind an `(N earlier lines)` label, since a command's
// output says how it went at its end.
import type { ActivityEvent, ActivityToolDetail } from "./ports";

export namespace ToolRows {
	// `unknown` is a call nothing said the end of: a host that records only some ends, or a card that
	// stopped before the call did.
	type Status = "running" | "completed" | "failed" | "unknown";

	export type Call = {
		// What the view keys the row and its open state by: stable as the call's events arrive.
		key: string;
		at: string;
		endedAt?: string;
		summary: string;
		status: Status;
		lane?: string;
		detail: ActivityToolDetail;
	};

	type Group = { key: string; lane?: string; calls: readonly Call[] };

	export type Row =
		| { type: "event"; event: ActivityEvent }
		| { type: "call"; call: Call }
		| { type: "group"; group: Group };

	// A host names a call `tool_call` (ACP) or `tool_use` (the copilot), and its end `tool_completed`,
	// `tool_failed` or `tool_result`.
	const OPENS = new Set(["tool_call", "tool_use"]);
	const ENDS: Readonly<Record<string, Status>> = {
		tool_completed: "completed",
		tool_result: "completed",
		tool_failed: "failed",
	};

	const isTool = (type: string): boolean => OPENS.has(type) || type in ENDS;

	/**
	 * The events as rows, in order. A call's later events update the row its first one opened; an
	 * end with no call open to take it is a row of its own. On a card that is over (`live` false),
	 * a call still running never will be.
	 */
	export const rows = (
		events: readonly ActivityEvent[],
		live: boolean,
	): Row[] => {
		const out: Row[] = [];
		// Calls a later event can still reach: by lane and id, and those opened without an id.
		const byId = new Map<string, Call>();
		const unnamed: Call[] = [];
		for (const event of events) {
			if (!isTool(event.type)) {
				out.push({ type: "event", event });
				continue;
			}
			const end = ENDS[event.type];
			const idKey =
				event.callId === undefined
					? undefined
					: `${event.lane ?? ""}\u0000${event.callId}`;
			const open = idKey
				? byId.get(idKey)
				: end
					? unnamed.findLast(
							(call) =>
								call.lane === event.lane &&
								call.summary === event.summary &&
								call.status === "unknown",
						)
					: undefined;
			if (open) {
				open.summary = event.summary;
				open.detail = { ...open.detail, ...event.detail };
				if (end) {
					open.status = end;
					open.endedAt = event.at;
				}
				continue;
			}
			const call: Call = {
				key: idKey ?? `seq:${event.seq}`,
				at: event.at,
				summary: event.summary,
				status: end ?? (idKey ? "running" : "unknown"),
				...(end ? { endedAt: event.at } : {}),
				...(event.lane !== undefined ? { lane: event.lane } : {}),
				detail: event.detail ?? {},
			};
			if (idKey) byId.set(idKey, call);
			else if (!end) unnamed.push(call);
			out.push({ type: "call", call });
		}
		if (!live)
			for (const call of byId.values())
				if (call.status === "running") call.status = "unknown";
		return grouped(out);
	};

	// A run of two or more exploring calls of one lane becomes a group, keyed by its first call so
	// it keeps its open state as the run grows.
	const grouped = (rows: readonly Row[]): Row[] => {
		const out: Row[] = [];
		let run: Call[] = [];
		const close = (): void => {
			const first = run[0];
			if (run.length >= 2 && first)
				out.push({
					type: "group",
					group: {
						key: `group:${first.key}`,
						...(first.lane !== undefined ? { lane: first.lane } : {}),
						calls: run,
					},
				});
			else for (const call of run) out.push({ type: "call", call });
			run = [];
		};
		for (const row of rows) {
			const call =
				row.type === "call" && explores(row.call) !== null ? row.call : null;
			if (call && (run.length === 0 || run[0]?.lane === call.lane)) {
				run.push(call);
				continue;
			}
			close();
			if (call) run.push(call);
			else out.push(row);
		}
		close();
		return out;
	};

	type Noun = "read" | "search" | "fetch";

	// The harness's own kind when it gave one; otherwise the tool's name, as a copilot titles it.
	const KINDS: Readonly<Record<string, Noun>> = {
		read: "read",
		search: "search",
		fetch: "fetch",
	};
	const NAMES: Readonly<Record<string, Noun>> = {
		read: "read",
		ls: "read",
		glob: "search",
		grep: "search",
		find: "search",
		search: "search",
		websearch: "search",
		webfetch: "fetch",
		fetch: "fetch",
	};

	/** What a call looks around with, or null for one that does something. */
	export const explores = (call: Call): Noun | null =>
		call.detail.kind !== undefined
			? (KINDS[call.detail.kind] ?? null)
			: (NAMES[toolParts(call.summary).name.toLowerCase()] ?? null);

	const PLURALS: Readonly<Record<Noun, string>> = {
		read: "reads",
		search: "searches",
		fetch: "fetches",
	};

	const groupStatus = (group: Group): Status =>
		group.calls.some((call) => call.status === "running")
			? "running"
			: group.calls.some((call) => call.status === "failed")
				? "failed"
				: "completed";

	/** `exploring · 6 reads, 2 searches`, then `explored` once none is running. */
	export const groupLabel = (group: Group): string => {
		const counts = new Map<Noun, number>();
		for (const call of group.calls) {
			const noun = explores(call);
			if (noun) counts.set(noun, (counts.get(noun) ?? 0) + 1);
		}
		const parts = (["read", "search", "fetch"] as const).flatMap((noun) => {
			const count = counts.get(noun) ?? 0;
			return count === 0
				? []
				: [`${count} ${count === 1 ? noun : PLURALS[noun]}`];
		});
		const verb = groupStatus(group) === "running" ? "exploring" : "explored";
		return `${verb} · ${parts.join(", ")}`;
	};

	/** How long a call that ended took: `0.4s` under ten seconds, then `12s`, `2m5s`. */
	export const duration = (call: Call): string | undefined => {
		if (call.endedAt === undefined) return undefined;
		const ms = Date.parse(call.endedAt) - Date.parse(call.at);
		if (!Number.isFinite(ms) || ms < 0) return undefined;
		const seconds = ms / 1000;
		if (seconds < 10) return `${seconds.toFixed(1)}s`;
		if (seconds < 60) return `${Math.floor(seconds)}s`;
		return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`;
	};

	// A harness names a call `Read src/app.tsx` or `mcp__kabane__kabane_list`: the tool, then what it
	// was called on. Split there, so the tool reads as the label and its arguments as an aside. A title
	// that does not open on a tool-shaped word (a quoted shell command) stays whole. Only the first
	// line: a heredoc is the call's input, not its title.
	export const toolParts = (
		summary: string,
	): { name: string; args: string } => {
		const line = summary.trim().split("\n")[0] ?? "";
		const more = summary.trim().includes("\n") ? "…" : "";
		const match = /^([A-Za-z][\w.:-]*)\s+(.+)$/.exec(line);
		return match
			? { name: match[1] ?? line, args: `${match[2] ?? ""}${more}` }
			: { name: `${line}${more}`, args: "" };
	};

	/** The start of `text`, held to `maxLines` lines and `maxChars`, ending in `…` when cut. */
	export const head = (
		text: string,
		maxLines: number,
		maxChars: number,
	): string => {
		const lines = text.split("\n");
		if (lines.length <= maxLines && text.length <= maxChars) return text;
		const kept = lines.slice(0, maxLines).join("\n");
		return `${kept.length >= maxChars ? kept.slice(0, maxChars - 1) : kept}…`;
	};

	/**
	 * The end of `text`, held to `maxLines` lines and `maxChars`: what was cut is counted on a first
	 * line of its own, `(N earlier lines)`, or is a leading `…` when one long line was all there was.
	 */
	export const tail = (
		text: string,
		maxLines: number,
		maxChars: number,
	): string => {
		const lines = text.split("\n");
		if (lines.length <= maxLines && text.length <= maxChars) return text;
		if (lines.length <= maxLines)
			return `…${text.slice(text.length - maxChars + 1)}`;
		const keep = Math.max(1, maxLines - 1);
		const earlier = lines.length - keep;
		const label = `(${earlier} earlier ${earlier === 1 ? "line" : "lines"})`;
		const shown = lines.slice(-keep).join("\n");
		const room = Math.max(1, maxChars - label.length - 1);
		return `${label}\n${shown.length > room ? shown.slice(shown.length - room) : shown}`;
	};
}
