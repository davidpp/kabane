// The board's `Copilot` port over a real harness: one lazily started ACP session whose only tool
// server is `kabane mcp`, so everything the agent writes is stamped with this session's agent actor
// and lands in the database the board is already reading. The board hands us what the human is
// looking at as a `BoardContext`; we render it ahead of every prompt and map the harness's updates
// back into the port's small union. Nothing here parses a tool RESULT: the adapters disagree on
// where those land, so a write is recognised by the tool call's title and the board reloads.
import { resolve } from "node:path";
import { BoardContext } from "@cabane/board/context";
import type {
	Copilot,
	CopilotElicitationAnswer,
	CopilotShortcut,
	CopilotStep,
	CopilotUpdate,
	PlanEntry,
} from "@cabane/board/ports";
import { err, ok, type Result } from "@cabane/core";
import { AcpClient } from "./client";
import type { Harnesses } from "./harnesses";
import { CopilotInstructions } from "./instructions";
import { Mailbox } from "./mailbox";

export namespace BoardCopilot {
	export type Options = {
		harness: Harnesses.Id;
		// The session's cwd: the scope's directory, so the harness picks up the project's own
		// CLAUDE.md / AGENTS.md the way it would if the human had started it there.
		scopeDir: string;
		// Passed to `kabane mcp --scope`. Absent when the board is open on every scope, and then
		// writes take the scope of `scopeDir` the way any CLI command there would.
		scopeUri?: string;
		// The `kabane` executable the MCP server runs as. Defaults to this process's own entry
		// script, which is what `kabane board` is.
		kabaneBin?: string;
		// The board's KABANE_HOME, set on the MCP server explicitly: Codex starts a stdio server
		// with only a short allow list of the environment, so an inherited one never arrives.
		home: string;
		overrides?: Harnesses.Overrides;
		// The mode the session starts in; the harness's own auto mode when absent.
		mode?: Harnesses.Mode;
		// This device's config, which the copilot is told it may edit when asked to set kabane up.
		setup: CopilotInstructions.Setup;
		// How the harness is reached. Defaults to spawning it; tests pass an in-process transport,
		// and it is the seam for a connection opened elsewhere.
		connect?: Connector;
	};

	// The two callbacks the human answers through. Passing `onElicitation` is what advertises forms,
	// so a connector hands both to the client as they are.
	export type Handlers = Pick<
		AcpClient.ConnectOptions,
		"onPermission" | "onElicitation"
	>;

	export type Connector = (
		handlers: Handlers,
	) => Promise<Result<AcpClient.Connection>>;

	// The port, plus the teardown a port of three methods has no business carrying: the board's
	// shutdown kills the harness process through this.
	export type Handle = Copilot & { close: () => void };

	// Tools that change tracker state. A completed call to one of these is what makes the board
	// reload; everything else the agent runs is its own business.
	const WRITE_TOOLS = [
		"kabane_add",
		"kabane_edit",
		"kabane_done",
		"kabane_link",
		"kabane_comment",
		"kabane_log",
		"kabane_contextAdd",
		"kabane_contextRemove",
		"kabane_upstream_link",
		"kabane_upstream_unlink",
	] as const;

	// Harnesses title an MCP tool call differently — the bare name, a namespaced `mcp__kabane__…`,
	// or a label with the arguments folded in — so the title is scanned, not compared.
	const namesWrite = (title: string): boolean =>
		WRITE_TOOLS.some((tool) => title.includes(tool));

	const isCompletedWrite = (
		status: string | undefined,
		title: string,
	): boolean => status === "completed" && namesWrite(title);

	// The two update kinds ACP streams as DELTAS rather than as whole values.
	type Prose = Extract<AcpClient.Update, { type: "text" | "thought" }>;

	// The board's answer as the client's: the same shape, with its read-only lists copied out.
	const toAnswer = (
		answer: CopilotElicitationAnswer,
	): AcpClient.ElicitationAnswer =>
		answer.action === "decline"
			? answer
			: {
					action: "accept",
					content: Object.fromEntries(
						Object.entries(answer.content).map(([key, value]) => [
							key,
							typeof value === "object" ? [...value] : value,
						]),
					),
				};

	// Whether `prompt` opens with `/name` for one of the harness's commands.
	const runsCommand = (
		prompt: string,
		commands: readonly AcpClient.Command[],
	): boolean => {
		const name = /^\/(\S+)/.exec(prompt.trimStart())?.[1];
		return name !== undefined && commands.some((c) => c.name === name);
	};

	const defaultBin = (): string => {
		const entry = process.argv[1];
		return entry ? resolve(entry) : "kabane";
	};

	export const create = (options: Options): Handle => {
		const actor = CopilotInstructions.actorUri(options.harness);
		let connection: AcpClient.Connection | null = null;
		let session: AcpClient.Session | null = null;
		// The instruction block rides the first prompt of the session and only that one.
		let instructed = false;
		// Updates that do not come off the harness's stream — the permission requests and forms,
		// which arrive on their own call while that stream is necessarily quiet.
		const outbox = Mailbox.create<CopilotUpdate>();
		// Requests the harness is blocked on — permissions by tool call id, forms by the id given
		// them here — each holding the resolver of the promise the ACP callback is awaiting.
		// Answering one is what lets the turn continue.
		const blocked = new Map<string, (answer: Result<string>) => void>();
		const forms = new Map<
			string,
			(answer: Result<AcpClient.ElicitationAnswer>) => void
		>();
		// A form carries no id of its own (its tool call id is optional), so it is numbered here.
		let formsAsked = 0;
		// The harness's slash commands as it last listed them, so a prompt that runs one goes to it
		// as written.
		let commands: readonly AcpClient.Command[] = [];

		// Never answers by itself: it puts the question on the stream and waits. A request nobody
		// answers keeps the turn waiting for as long as the human leaves it, which is what `cancel`
		// is for — a board that guessed here would be deciding on their behalf.
		const onPermission: AcpClient.OnPermission = (request, withdrawn) => {
			whenWithdrawn(
				withdrawn,
				() => blocked.delete(request.toolCallId),
				request.toolCallId,
				request.title,
			);
			outbox.push({
				type: "permission",
				request: {
					id: request.toolCallId,
					title: request.title,
					options: request.options.map((option) => ({
						id: option.id,
						label: option.name,
					})),
				},
				at: at(),
			});
			return new Promise<Result<string>>((resolve) =>
				blocked.set(request.toolCallId, resolve),
			);
		};

		// The harness took a request back (`$/cancel_request`) before anyone answered it. The client has
		// already told it `cancelled`; what is left is to stop asking the human, so it leaves the
		// waiting map, where a late answer then finds nothing, and the board is told. One the human
		// answered, or a cancel or close let go of first, is no longer waiting: `release` is false and
		// nothing is said.
		const whenWithdrawn = (
			signal: AbortSignal,
			release: () => boolean,
			id: string,
			asked: string,
		): void =>
			signal.addEventListener(
				"abort",
				() => {
					if (!release()) return;
					outbox.push({
						type: "withdrawn",
						id,
						summary: `withdrawn by the harness: ${asked}`,
						at: at(),
					});
				},
				{ once: true },
			);

		// The same for a form: on the stream, and nothing filled in on the human's behalf.
		const onElicitation: AcpClient.OnElicitation = (request, withdrawn) => {
			const id = `form-${++formsAsked}`;
			whenWithdrawn(withdrawn, () => forms.delete(id), id, request.message);
			outbox.push({
				type: "elicitation",
				request: { id, message: request.message, fields: request.fields },
				at: at(),
			});
			return new Promise<Result<AcpClient.ElicitationAnswer>>((resolve) =>
				forms.set(id, resolve),
			);
		};

		// Let go of every outstanding question: a permission declined, a form cancelled. A cancelled
		// or closed session has nobody left to answer, and the harness would otherwise sit on a
		// promise that never settles.
		const unblockAll = (): void => {
			const cancelled = err(new Error("cancelled"));
			for (const resolve of blocked.values()) resolve(cancelled);
			for (const resolve of forms.values()) resolve(cancelled);
			blocked.clear();
			forms.clear();
		};

		const mcpServer = (): AcpClient.StdioServer => ({
			name: CopilotInstructions.SERVER_NAME,
			command: options.kabaneBin ?? defaultBin(),
			args: [
				"mcp",
				...(options.scopeUri ? ["--scope", options.scopeUri] : []),
				"--as",
				actor,
			],
			env: { KABANE_HOME: options.home },
		});

		const connect: Connector =
			options.connect ??
			((handlers) =>
				AcpClient.spawn(options.harness, options.scopeDir, {
					...handlers,
					...(options.overrides ? { overrides: options.overrides } : {}),
				}));

		// Lazy on purpose: no harness process exists until the human actually asks for something,
		// so opening the board costs nothing.
		const instructions = CopilotInstructions.systemPrompt(options.setup);

		const start = async (): Promise<Result<AcpClient.Session>> => {
			if (session) return ok(session);
			const opened = await connect({ onPermission, onElicitation });
			if (!opened.ok) return opened;
			const started = await AcpClient.newSession(opened.value, {
				cwd: options.scopeDir,
				mcpServers: [mcpServer()],
				// Honoured by the Claude adapter only. Every harness gets the same text as the first
				// prompt below, because an adapter that ignores `_meta` would otherwise run with no
				// instructions at all.
				systemPromptAppend: instructions,
				...(options.mode ? { mode: options.mode } : {}),
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
				// State too: the footer's reading of the context window.
				case "usage":
					return [
						{
							type: "usage",
							used: incoming.used,
							size: incoming.size,
							...(incoming.cost ? { cost: incoming.cost } : {}),
							at: at(),
						},
					];
				case "mode":
					return [
						update("mode", `mode ${incoming.id}: moved there by the harness`),
					];
				// ACP's severity is open-ended; the board tells a warning from the rest, and an error the
				// harness only notifies about (the turn carries on) is a warning to it.
				case "commands":
					commands = incoming.commands;
					return [
						{
							type: "commands",
							source: options.harness,
							commands: incoming.commands,
							at: at(),
						},
					];
				case "notice":
					return [
						{
							type: "notice",
							severity:
								incoming.severity === "warning" || incoming.severity === "error"
									? "warning"
									: "info",
							summary: `${options.harness} ${incoming.severity}: ${incoming.text}`,
							at: at(),
						},
					];
				case "stop":
					return [update("done", incoming.reason)];
				case "error":
					return [update("error", incoming.message)];
			}
		};

		// What one prompt goes to the harness as, and whether it carries the instruction block. A
		// harness reads a slash command off the start of the prompt's first block, so one of its own
		// goes alone and as written: no instructions, no board context ahead of it.
		const compose = (
			prompt: string,
			context: BoardContext.Context,
		): { blocks: AcpClient.PromptBlock[]; instructing: boolean } => {
			const asked = { type: "text" as const, text: prompt };
			if (runsCommand(prompt, commands))
				return { blocks: [asked], instructing: false };
			const shown = {
				type: "text" as const,
				text: BoardContext.render(context),
			};
			return instructed
				? { blocks: [shown, asked], instructing: false }
				: {
						blocks: [{ type: "text", text: instructions }, shown, asked],
						instructing: true,
					};
		};

		const run = async function* (
			prompt: string,
			context: BoardContext.Context,
		): AsyncIterable<CopilotUpdate> {
			const started = await start();
			if (!started.ok) {
				// The copilot cannot fix its own harness, so the way out is spelled here.
				yield update(
					"error",
					`${started.error.message} · another harness: copilot.harness in ${options.setup.configPath}, or kabane board --copilot <harness>`,
				);
				return;
			}
			// The session's first turn opens on the mode it runs in, so the human can tell whether
			// the harness or they decide what it asks.
			if (!instructed) yield update("mode", started.value.mode.note);
			const { blocks, instructing } = compose(prompt, context);
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
			// The harness's stream and the outbox are drained together rather than one inside the
			// other: a permission request arrives while the stream is quiet BECAUSE of it, so the
			// generator has to be woken by the outbox itself. Whichever settles first is taken, and
			// a stream read the outbox beat stays pending for the next pass rather than being
			// reissued (an iterator has one next() in flight at a time).
			const stream = AcpClient.prompt(started.value, blocks)[
				Symbol.asyncIterator
			]();
			let reading: Promise<IteratorResult<AcpClient.Update>> | null = null;
			// Anything still in the box belongs to a turn that is over — a question the board
			// abandoned by cancelling — and must not open this one.
			outbox.drain();
			try {
				for (;;) {
					const mail = outbox.drain();
					if (mail.length > 0) {
						// Prose said before the question belongs before it.
						yield* flushed();
						yield* mail;
						continue;
					}
					reading ??= stream.next();
					const settled = await Promise.race([
						reading.then((result) => ({ from: "harness" as const, result })),
						outbox.filled().then(() => ({ from: "outbox" as const })),
					]);
					if (settled.from === "outbox") continue;
					reading = null;
					if (settled.result.done) break;
					const incoming = settled.result.value;
					// A turn cancelled before it was dispatched never reached the agent, so the
					// instruction block it carried has to ride the next one.
					if (first) {
						first = false;
						instructed ||=
							instructing &&
							!(incoming.type === "stop" && incoming.reason === "cancelled");
					}
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
			} finally {
				// The board drops this generator mid-stream whenever a turn is cancelled or a new
				// prompt starts, which used to close the harness's iterator for us — a `for await`
				// did it on the way out. Driving it by hand, we owe it the same close, so its own
				// cleanup runs. Not awaited: a close queued behind a read that never settles must
				// not hold up the teardown of the turn that gave up on it.
				void stream.return?.();
			}
			yield* flushed();
			yield* outbox.drain();
		};

		return {
			run,
			// What `kabane mcp --as` stamps every write of this session with, so the board can glyph
			// the rows this copilot changed rather than every row an agent ever touched.
			actor,
			// The port returns void: a cancel that fails has nothing left to tell the board, which
			// has already ended the turn on its side. A turn blocked on a question it never got an
			// answer to is cancelled the same way — letting go of the question first is what lets
			// the harness notice.
			cancel: async () => {
				unblockAll();
				if (session) await AcpClient.cancel(session);
			},
			answerPermission: (id, optionId) => {
				const resolve = blocked.get(id);
				if (!resolve) return;
				blocked.delete(id);
				resolve(optionId === null ? err(new Error("declined")) : ok(optionId));
			},
			answerElicitation: (id, answer) => {
				const resolve = forms.get(id);
				if (!resolve) return;
				forms.delete(id);
				resolve(ok(toAnswer(answer)));
			},
			shortcuts: (): CopilotShortcut[] => [...CopilotInstructions.SHORTCUTS],
			close: () => {
				unblockAll();
				if (connection) AcpClient.close(connection);
				connection = null;
				session = null;
				instructed = false;
			},
		};
	};
}
