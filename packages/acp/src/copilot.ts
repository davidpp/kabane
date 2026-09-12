// The board's `Copilot` port over a real harness: one lazily started ACP session whose only tool
// server is `cabane mcp`, so everything the agent writes is stamped with this session's agent actor
// and lands in the database the board is already reading. The board hands us what the human is
// looking at as a `BoardContext`; we render it ahead of every prompt and map the harness's updates
// back into the port's small union. Nothing here parses a tool RESULT: the adapters disagree on
// where those land, so a write is recognised by the tool call's title and the board reloads.
import { resolve } from "node:path";
import { BoardContext } from "@cabane/board/context";
import type {
	Copilot,
	CopilotShortcut,
	CopilotStep,
	CopilotUpdate,
	PlanEntry,
} from "@cabane/board/ports";
import { err, ok, type Result } from "@cabane/core";
import { AcpClient } from "./client";
import type { Harnesses } from "./harnesses";
import { CopilotInstructions } from "./instructions";

export namespace BoardCopilot {
	export type Options = {
		harness: Harnesses.Id;
		// The session's cwd: the scope's directory, so the harness picks up the project's own
		// CLAUDE.md / AGENTS.md the way it would if the human had started it there.
		scopeDir: string;
		// Passed to `cabane mcp --scope`. Absent when the board is open on every scope, and then
		// writes take the scope of `scopeDir` the way any CLI command there would.
		scopeUri?: string;
		// The `cabane` executable the MCP server runs as. Defaults to this process's own entry
		// script, which is what `cabane board` is.
		cabaneBin?: string;
		overrides?: Harnesses.Overrides;
		// How the harness is reached. Defaults to spawning it; tests pass an in-process transport,
		// and it is the seam for a connection opened elsewhere.
		connect?: Connector;
	};

	export type Connector = (
		onPermission: AcpClient.OnPermission,
	) => Promise<Result<AcpClient.Connection>>;

	// The port, plus the teardown a port of three methods has no business carrying: the board's
	// shutdown kills the harness process through this.
	export type Handle = Copilot & { close: () => void };

	// Tools that change tracker state. A completed call to one of these is what makes the board
	// reload; everything else the agent runs is its own business.
	const WRITE_TOOLS = [
		"cabane_add",
		"cabane_edit",
		"cabane_done",
		"cabane_link",
		"cabane_comment",
		"cabane_log",
		"cabane_contextAdd",
		"cabane_contextRemove",
	] as const;

	// Harnesses title an MCP tool call differently — the bare name, a namespaced `mcp__cabane__…`,
	// or a label with the arguments folded in — so the title is scanned, not compared.
	const namesWrite = (title: string): boolean =>
		WRITE_TOOLS.some((tool) => title.includes(tool));

	const isCompletedWrite = (
		status: string | undefined,
		title: string,
	): boolean => status === "completed" && namesWrite(title);

	// The two update kinds ACP streams as DELTAS rather than as whole values.
	type Prose = Extract<AcpClient.Update, { type: "text" | "thought" }>;

	const defaultBin = (): string => {
		const entry = process.argv[1];
		return entry ? resolve(entry) : "cabane";
	};

	export const create = (options: Options): Handle => {
		const actor = CopilotInstructions.actorUri(options.harness);
		let connection: AcpClient.Connection | null = null;
		let session: AcpClient.Session | null = null;
		// The instruction block rides the first prompt of the session and only that one.
		let instructed = false;
		// Permission requests answered while a turn streams: pushed here by the callback, drained
		// into the same stream so the human sees in the transcript what was asked and declined.
		const notices: string[] = [];

		const onPermission: AcpClient.OnPermission = async (request) => {
			notices.push(
				`permission requested · ${request.title} · declined: the board cannot answer permission requests yet`,
			);
			return err(new Error("the board cannot answer permission requests"));
		};

		const mcpServer = (): AcpClient.StdioServer => ({
			name: "cabane",
			command: options.cabaneBin ?? defaultBin(),
			args: [
				"mcp",
				...(options.scopeUri ? ["--scope", options.scopeUri] : []),
				"--as",
				actor,
			],
			env: {},
		});

		const connect: Connector =
			options.connect ??
			((permission) =>
				AcpClient.spawn(options.harness, options.scopeDir, {
					onPermission: permission,
					...(options.overrides ? { overrides: options.overrides } : {}),
				}));

		// Lazy on purpose: no harness process exists until the human actually asks for something,
		// so opening the board costs nothing.
		const start = async (): Promise<Result<AcpClient.Session>> => {
			if (session) return ok(session);
			const opened = await connect(onPermission);
			if (!opened.ok) return opened;
			const started = await AcpClient.newSession(opened.value, {
				cwd: options.scopeDir,
				mcpServers: [mcpServer()],
				// Honoured by the Claude adapter only. Every harness gets the same text as the first
				// prompt below, because an adapter that ignores `_meta` would otherwise run with no
				// instructions at all.
				systemPromptAppend: CopilotInstructions.BLOCK,
			});
			if (!started.ok) {
				AcpClient.close(opened.value);
				return started;
			}
			connection = opened.value;
			session = started.value;
			return ok(started.value);
		};

		const at = (): string => new Date().toISOString();

		const update = (type: CopilotStep, summary: string): CopilotUpdate => ({
			type,
			summary,
			at: at(),
		});

		const plan = (entries: readonly PlanEntry[]): CopilotUpdate => ({
			type: "plan",
			entries,
			at: at(),
		});

		const drainNotices = (): CopilotUpdate[] =>
			notices.splice(0).map((text) => update("error", text));

		// One harness update becomes zero, one or two port updates: a tool call shows in the
		// transcript AND, when it completed a write, tells the board to reload. Prose never reaches
		// here — `run` buffers it — and the parameter type is what keeps that true.
		const toUpdates = (
			incoming: Exclude<AcpClient.Update, Prose>,
			titles: Map<string, string>,
		): CopilotUpdate[] => {
			switch (incoming.type) {
				case "tool_call": {
					titles.set(incoming.id, incoming.title);
					const out = [update("tool_call", incoming.title)];
					if (isCompletedWrite(incoming.status, incoming.title))
						out.push(update("tool_result", incoming.title));
					return out;
				}
				case "tool_call_update": {
					// The update carries a title only when it changed, so the call's own title stands in.
					if (incoming.title) titles.set(incoming.id, incoming.title);
					const title = titles.get(incoming.id) ?? "";
					return isCompletedWrite(incoming.status, title)
						? [update("tool_result", title)]
						: [];
				}
				// State, not a step: the board replaces its copy and counts it, and nothing lands in
				// the transcript.
				case "plan":
					return [plan(incoming.entries)];
				case "stop":
					return [update("done", incoming.reason)];
				case "error":
					return [update("error", incoming.message)];
			}
		};

		const run = async function* (
			prompt: string,
			context: BoardContext.Context,
		): AsyncIterable<CopilotUpdate> {
			const started = await start();
			if (!started.ok) {
				yield update("error", started.error.message);
				return;
			}
			const blocks: AcpClient.PromptBlock[] = [];
			if (!instructed)
				blocks.push({ type: "text", text: CopilotInstructions.BLOCK });
			blocks.push({ type: "text", text: BoardContext.render(context) });
			blocks.push({ type: "text", text: prompt });
			const titles = new Map<string, string>();
			let first = true;
			// ACP streams prose as DELTAS: `agent_message_chunk` arrives mid-word, so one sentence is
			// a dozen of them. Held as a run and emitted as ONE update when something else happens or
			// the turn ends — otherwise the transcript gets a row per fragment, split where the
			// tokenizer happened to break, and the footer flashes whatever syllable landed last. The
			// cost is that a message appears when it finishes rather than as it types; the plan and
			// the tool calls carry progress in the meantime.
			let prose: Prose | null = null;
			const flushed = (): CopilotUpdate[] => {
				if (!prose) return [];
				const out = update(prose.type, prose.text);
				prose = null;
				return [out];
			};
			for await (const incoming of AcpClient.prompt(started.value, blocks)) {
				// A turn cancelled before it was dispatched never reached the agent, so the
				// instruction block it carried has to ride the next one.
				if (first) {
					first = false;
					instructed ||= !(
						incoming.type === "stop" && incoming.reason === "cancelled"
					);
				}
				yield* drainNotices();
				if (incoming.type === "text" || incoming.type === "thought") {
					// A thought does not continue a message, or the other way round.
					if (prose && prose.type !== incoming.type) yield* flushed();
					prose = prose
						? { type: prose.type, text: prose.text + incoming.text }
						: { type: incoming.type, text: incoming.text };
					continue;
				}
				// Whatever ended the run goes after it, so a tool call the prose introduced reads
				// in the order it was said.
				yield* flushed();
				for (const mapped of toUpdates(incoming, titles)) yield mapped;
			}
			yield* flushed();
			yield* drainNotices();
		};

		return {
			run,
			// What `cabane mcp --as` stamps every write of this session with, so the board can glyph
			// the rows this copilot changed rather than every row an agent ever touched.
			actor,
			// The port returns void: a cancel that fails has nothing left to tell the board, which
			// has already ended the turn on its side.
			cancel: async () => {
				if (session) await AcpClient.cancel(session);
			},
			shortcuts: (): CopilotShortcut[] => [...CopilotInstructions.SHORTCUTS],
			close: () => {
				if (connection) AcpClient.close(connection);
				connection = null;
				session = null;
				instructed = false;
			},
		};
	};
}
