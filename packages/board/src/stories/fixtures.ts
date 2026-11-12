// Made-up props the render tests and the gallery's stories share, so a component is drawn from the
// same data in both: what a test pins is what David looks at.
import type { ChecklistItemView } from "@cabane/checklist";
import {
	type LinkType,
	TASK_STATE_DISPLAY,
	type Task,
	type TaskEntry,
	type TaskLink,
	type UpstreamLink,
} from "@cabane/core";
import { handoffModule } from "@cabane/handoff";
import {
	type DecisionMeta,
	formatDecisionBody,
	type QuestionView,
} from "@cabane/questions";
import type { BoardData } from "../data";
import type { BoardNav } from "../nav";
import type {
	ActivityCard,
	TriggerDescriptor,
	CopilotElicitation,
	SettingKind,
	SettingRow,
} from "../ports";
import type { BoardTabs } from "../tabs";

export namespace Fixtures {
	/** A described single choice with an `Other` text field behind it, as claude-agent-acp sends one. */
	export const STORE: CopilotElicitation = {
		id: "form-1",
		message: "Which store should the cache use for the session tokens?",
		fields: [
			{
				key: "question_0",
				title: "Store",
				required: false,
				type: "choice",
				options: [
					{
						value: "Redis",
						label: "Redis",
						description: "Shared, survives restarts",
					},
					{ value: "Memory", label: "Memory" },
				],
			},
			{
				key: "question_0_custom",
				title: "Other",
				required: false,
				type: "text",
			},
		],
	};

	/** The same question with bare labels: no descriptions, nothing behind it. */
	export const UNDESCRIBED: CopilotElicitation = {
		...STORE,
		fields: [
			{
				key: "question_0",
				title: "Store",
				required: true,
				type: "choice",
				options: [
					{ value: "Redis", label: "Redis" },
					{ value: "Memory", label: "Memory" },
				],
			},
		],
	};

	export const TAGS: CopilotElicitation = {
		id: "form-2",
		message: "Which tags apply?",
		fields: [
			{
				key: "tags",
				title: "Tags",
				required: true,
				type: "choices",
				options: [
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
					{ value: "c", label: "Gamma" },
				],
			},
		],
	};

	/** A described choice whose message and descriptions wrap at 80 columns. */
	export const DELIVERY: CopilotElicitation = {
		id: "form-3",
		message:
			"Which delivery contract should the runner hold to when a harness drops its session?",
		fields: [
			{
				key: "delivery",
				title: "Delivery",
				required: true,
				type: "choice",
				options: [
					{
						value: "most",
						label: "At most once",
						description: "Drop the turn and report it failed",
					},
					{
						value: "least",
						label: "At least once",
						description: "Replay the turn from its last checkpoint",
					},
					{ value: "ask", label: "Ask the human" },
				],
			},
		],
	};

	export const SLUG: CopilotElicitation = {
		id: "form-4",
		message: "What should the new scope be called?",
		fields: [
			{
				key: "slug",
				title: "Slug",
				description: "Lowercase letters, used in every issue id",
				required: true,
				type: "text",
				maxLength: 12,
			},
		],
	};

	export const PERMISSION: BoardNav.CopilotAsk = {
		type: "permission",
		request: {
			id: "p1",
			title: "kabane_edit JREP-1",
			options: [
				{ id: "once", label: "Allow once" },
				{ id: "always", label: "Allow always" },
				{ id: "no", label: "Reject" },
			],
		},
	};

	/** The copilot before its first prompt: nothing typed, nothing asked. */
	export const copilot = (
		over: Partial<BoardNav.CopilotState> = {},
	): BoardNav.CopilotState => ({
		text: "",
		paletteAt: 0,
		history: [],
		historyAt: 0,
		turn: "idle",
		hasLog: false,
		shortcuts: [],
		commands: [],
		actor: null,
		asks: [],
		...over,
	});

	export const task = (over: Partial<Task> = {}): Task => ({
		id: "01H000000000000000000000AA",
		shortId: "MILL-42",
		title: "Wire the board",
		kind: "issue",
		state: "next",
		priority: "high",
		provenance: { source: "human", discoveredAt: new Date().toISOString() },
		needsReview: false,
		tags: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...over,
	});

	export const section = (
		state: BoardData.SectionState,
		rows: BoardData.BoardRow[],
	): BoardData.BoardSection => ({
		state,
		label: TASK_STATE_DISPLAY[state].label,
		rows,
	});

	/** A loop's finished card with a tab of its own, numbered `n`. */
	export const loop = (n: number): ActivityCard => ({
		id: `loop:r${n}`,
		kind: "loops",
		label: "loop",
		status: "completed",
		taskShortId: `JREP-${n}`,
		startedAt: `2026-10-10T00:0${n}:00.000Z`,
		detail: [],
		hasEvents: true,
		tab: true,
		sessionIds: [`s${n}`],
	});

	/**
	 * A decision an agent filed on `on`, its `n`th: open unless `over` answers it. `meta` is what
	 * `kabane_ask` records beside the question (choices, recommended, multi-select, freeform).
	 */
	export const decision = (
		on: Task,
		n: number,
		question: string,
		meta: DecisionMeta,
		over: Partial<QuestionView> = {},
	): QuestionView => ({
		id: `01H00000000000000000000Q${n}0`,
		taskId: on.id,
		status: "open",
		askedBy: "cabane://actor/agent/claude",
		createdAt: "2026-10-10T00:00:00.000Z",
		updatedAt: "2026-10-10T00:00:00.000Z",
		updatedBy: "cabane://actor/agent/claude",
		version: 1,
		visibility: "shared",
		body: formatDecisionBody(question, meta),
		handle: `${on.shortId ?? on.id}:${n}`,
		ordinal: n,
		title: on.title,
		priority: on.priority,
		state: on.state,
		shortId: on.shortId,
		...over,
	});

	/** The `n`th checklist item on `on`, open unless `done`. */
	export const item = (
		on: Task,
		n: number,
		text: string,
		done = false,
	): ChecklistItemView => ({
		id: `01H00000000000000000000K${n}0`,
		taskId: on.id,
		text,
		done,
		...(done
			? {
					doneAt: "2026-10-10T00:00:00.000Z",
					doneBy: "cabane://actor/agent/claude",
				}
			: {}),
		rank: `a${n}`,
		createdAt: "2026-10-10T00:00:00.000Z",
		updatedAt: "2026-10-10T00:00:00.000Z",
		updatedBy: "cabane://actor/agent/claude",
		version: 1,
		visibility: "shared",
		handle: `${on.shortId ?? on.id}.${n}`,
		ordinal: n,
		shortId: on.shortId,
	});

	/**
	 * The `n`th entry on `on`'s timeline, `n` hours into the day, so a later `n` is a newer entry.
	 * An author that is a bare name is a person; an actor URI is an agent.
	 */
	export const entry = (
		on: Task,
		n: number,
		kind: string,
		author: string,
		content: string,
	): TaskEntry => ({
		id: `01H00000000000000000000E${n}0`,
		taskId: on.id,
		kind,
		author,
		authorType: author.startsWith("cabane://actor/agent/") ? "ai" : "human",
		content,
		createdAt: `2026-10-10T${String(n).padStart(2, "0")}:00:00.000Z`,
	});

	/** The `n`th link, `source` to `target` as core stores it: `link(n, a, "blocks", b)` reads a blocks b. */
	export const link = (
		n: number,
		source: Task,
		type: LinkType,
		target: Task,
	): TaskLink => ({
		id: `01H00000000000000000000L${n}0`,
		sourceId: source.id,
		targetId: target.id,
		type,
		createdAt: `2026-10-10T${String(n).padStart(2, "0")}:00:00.000Z`,
	});

	/** `on` pointing at `identifier` in `provider`'s tracker. */
	export const upstream = (
		on: Task,
		provider: string,
		identifier: string,
		title: string,
	): UpstreamLink => ({
		id: `upstream-${identifier}`,
		taskId: on.id,
		provider,
		externalId: `${provider}-${identifier}`,
		identifier,
		url: `https://example.com/${identifier}`,
		title,
		createdAt: "2026-10-10T00:00:00.000Z",
		updatedAt: "2026-10-10T00:00:00.000Z",
	});

	/** The kinds the CLI's modules declare: the handoff, which the brief lifts under the description. */
	export const KINDS = handoffModule.kinds ?? [];

	/**
	 * A handoff the size of a real one: the one JCAB-213's wave closed with, 37 lines under the four
	 * headings of the template. The gallery's six-line handoffs hid how much a real one takes.
	 */
	export const REAL_HANDOFF = `### Summary

The wave is merged on local \`main\` at \`1519458\`, not pushed. An issue's comments are now a timeline of entries with a kind; a handoff is the first kind built on it.

- JCAB-217: comments carry a \`kind\` (migration 9); \`Planner.addEntry\`, \`getEntries\`, \`latestEntry\`; entries are append-only; a module declares kinds as data; the brief keeps every typed entry and lifts a kind projected as \`latest\` into its own section. \`kabane_comment\` and \`kabane comment\` take a kind.
- JCAB-218: \`@cabane/handoff\`, with no table: the \`handoff\` kind, a four-heading template, \`kabane_handoff(id, body)\`, \`kabane handoff <id> [--all] [--json] | --from <file|-> | --template\`. \`kabane show\` and \`kabane context --help\` follow the registered sections through one core helper.
- JCAB-219: every instruction that told an agent to report finished work in a comment now says to hand off: this repo's dispatch skill, the shipped template, the first-run Tracker block and its copy in the docs, the copilot's \`/setup-dispatch\`.
- JCAB-221: the board's comments tab names an entry's kind, and the description tab shows the latest handoff under the description. A band never wraps: it cuts a long author first.
- JCAB-224: an upgrade note for someone coming from \`1.0.0-beta.0\`.

Cancelled on the way: JCAB-212 (verdicts bound to a digest), JCAB-214 to 216 (a handoff module with its own table and typed fields). Filed for later under this parent: JCAB-220, 222, 225, 226, 227. Separate: JCAB-223 (Jake cleanup, two questions open).

### Evidence

- Final \`main\` (\`1519458\`), run by the dispatcher after the last merge: \`bun run check\` exit 0, \`bun run typecheck\` exit 0, \`bun test packages/board\` 889 pass, 0 fail. The full suite was last run by the board's implementer on its branch tip (\`28dd4d7\`): 2459 bun tests pass, 0 fail, worker vitest 81 of 81; \`main\` differs from that tree only by JCAB-224's two docs files.
- Each branch merged with a tree identical to the one its implementer tested, except JCAB-221, merged after the docs-only JCAB-224.
- Migration 9 on a real \`1.0.0-beta.0\` database, run three times by different agents: the beta's tarball built a store with a comment; \`main\` opened it; the comment reads back as \`kind: "comment"\`; the beta then refuses the store with "newer than this kabane knows (7)".
- Real MCP over stdio in the sandbox: \`tools/list\` shows \`kabane_handoff\`; \`initialize\` carries the instructions paragraph; a call records the handoff under the calling agent; \`kabane_context\` shows it under the description.
- The real board under tmux at 100 and 40 columns: a handoff written from another shell appears in an open detail within one poll (up to 5 seconds).
- Reviews: one Claude review and three Codex rounds on JCAB-217; three Codex rounds on JCAB-218 and 219; two each on JCAB-221 and JCAB-224; one Codex closing review of the combined diff. Every blocking finding was fixed on its branch before merge; the last fix on JCAB-217, 218, 221 and 224 was read and its tests run by the dispatcher instead of a further Codex round.
- The installed \`kabane\` reports \`source: main@1519458\`; this handoff was written with it.

### Not verified

Checks only a person can make, or that no agent ran. Agents drove the CLI and the board through \`bun run sandbox\`, never \`~/.kabane\`.

1. A fresh agent session, on its own, hands off with \`kabane_handoff\` when it finishes an issue.
2. Mouse behaviour over the board's lifted block and the labelled bands.
3. The hub: the module is registered there and the Worker's tests pass, but nothing was run against a deployed hub, and deploying is a manual step.
4. \`/setup-dispatch\` in a real harness: that it finishes with a handoff, and that running it again rewrites an existing skill.
5. Three claims in the upgrade note rest on the beta's code, not on a run: a beta board left running across the update, the sync stop with two devices or a hub, and a sync in flight sending comments on without their kind.
6. A \`latest\` kind other than \`handoff\`, and a host with no lifting module, on the live board (tests only).
7. Codex itself: the Homebrew cask's helper binaries are held at launch after today's upgrade; reviews ran with the daemon's copy. \`brew reinstall --cask codex\`, then clear the quarantine flag on the two helpers before first use.

### Risk

Mostly easy to walk back, with one exception: a database opened by this build has migration 9 and can no longer be opened by \`1.0.0-beta.0\`; going back takes a backup. That has already happened to the maintainer's own tracker on this machine. Entries can no longer be edited or deleted on their own, by design, so a wrong handoff is corrected by writing another one. Nothing was pushed or deployed. If the kinds contract (\`EntryKind\`: name, title, template, projection) turns out wrong, the cost is in every module that declares a kind; today that is one.`;

	/** A task's detail records with nothing on them but `over`. */
	export const records = (
		on: Task,
		over: Partial<BoardData.DetailRecords> = {},
	): BoardData.DetailRecords => ({
		task: on,
		entries: [],
		kinds: [],
		workLogs: [],
		sessions: [],
		links: [],
		neighbors: [],
		upstream: [],
		subtasks: [],
		contextRefs: [],
		questions: [],
		checklist: [],
		...over,
	});

	/** A session's question about JREP-`n`; no choices makes it a freeform one. */
	export const question = (
		n: number,
		choices: string[],
	): BoardTabs.Question => ({
		taskId: `t${n}`,
		taskShortId: `JREP-${n}`,
		sessionId: "s1",
		questionActivityId: `q${n}`,
		question: `Install dependencies ${n}?`,
		choices,
		multiSelect: false,
		allowFreeform: choices.length === 0,
		agent: "claude",
		askedAt: `2026-10-10T00:0${n}:00.000Z`,
	});

	const setting = (
		key: string,
		kind: SettingKind,
		over: Partial<SettingRow> & Pick<SettingRow, "label" | "group">,
	): SettingRow => {
		const [head = "", ...rest] = key.split(".");
		const namespace = over.namespace;
		return {
			key,
			value: null,
			layer: "default",
			hides: [],
			field: {
				optional: true,
				...kind,
				path: namespace === undefined ? [head, ...rest] : rest,
			},
			description: "",
			layers:
				namespace === undefined ? ["global"] : ["global", "shared", "local"],
			target: namespace === undefined ? "global" : "local",
			secret: false,
			restart: namespace === undefined ? "start" : "resolve",
			readOnly: false,
			protected: false,
			...over,
		};
	};

	const HOME = "/Users/ada/.kabane";
	const LOCAL = `${HOME}/projects/-Users-ada-acme-widget-8380ae31/loop.json`;
	const SHARED = "/Users/ada/acme/widget/.kabane/loop.json";

	/**
	 * `kabane config list --json` in acme/widget: the device's keys, then the loop's, the test gate
	 * set in the repo and again, for this project only, locally.
	 */
	export const SETTINGS: readonly SettingRow[] = [
		setting(
			"actor",
			{ kind: "string" },
			{
				label: "actor",
				group: "Identity",
				value: "cabane://actor/human/ada",
				layer: "global",
				from: `${HOME}/config.json`,
				readOnly: true,
				description: "Who this device's writes are stamped with.",
			},
		),
		setting("sync", { kind: "group" }, { label: "sync", group: "Sync" }),
		setting(
			"sync.enabled",
			{ kind: "boolean" },
			{
				label: "sync on",
				group: "Sync",
				value: true,
				layer: "global",
				from: `${HOME}/config.json`,
				protected: true,
			},
		),
		setting(
			"sync.token",
			{ kind: "string" },
			{
				label: "hub token",
				group: "Sync",
				value: "<set>",
				layer: "global",
				from: `${HOME}/config.json`,
				secret: true,
				protected: true,
			},
		),
		setting(
			"copilot.harness",
			{ kind: "enum", values: ["claude", "codex"] },
			{
				label: "harness",
				group: "Copilot",
				options: ["claude", "codex"],
				none: "claude",
			},
		),
		setting(
			"timezone",
			{ kind: "string" },
			{
				label: "timezone",
				group: "Board",
				value: "America/Toronto",
				layer: "global",
				from: `${HOME}/config.json`,
			},
		),
		setting(
			"loop.implementer",
			{ kind: "string" },
			{
				namespace: "loop",
				label: "implementer",
				group: "Agents",
				value: "claude",
			},
		),
		setting(
			"loop.budget.continuations",
			{ kind: "number", integer: true },
			{
				namespace: "loop",
				label: "continuations",
				group: "Limits",
				value: 5,
				layer: "global",
				from: `${HOME}/config.json`,
				hides: [],
			},
		),
		setting(
			"loop.budget.concurrency",
			{ kind: "number", integer: true, minimum: 1, maximum: 8 },
			{
				namespace: "loop",
				label: "sessions at once",
				group: "Limits",
				options: [1, 2, 3, 4, 5, 6, 7, 8],
				none: "by isolation",
			},
		),
		setting(
			"loop.stallAfter",
			{ kind: "number", integer: true, minimum: 1 },
			{
				field: {
					optional: false,
					default: 3,
					kind: "number",
					integer: true,
					minimum: 1,
					path: ["stallAfter"],
				},
				namespace: "loop",
				label: "stall after (attempts)",
				group: "Limits",
				value: 3,
				options: [1, 2, 3, 4, 5, 6],
			},
		),
		setting(
			"loop.gates",
			{ kind: "record", value: { optional: false, kind: "string" } },
			{
				namespace: "loop",
				label: "gates",
				group: "Checks",
				value: { test: "bun test --bail" },
				layer: "local",
				from: LOCAL,
				description: "Named shell commands run after each finished subtask.",
			},
		),
		setting(
			"loop.gates.test",
			{ kind: "string" },
			{
				namespace: "loop",
				label: "gates.test",
				group: "Checks",
				value: "bun test --bail",
				layer: "local",
				from: LOCAL,
				hides: [{ layer: "shared", from: SHARED, value: "bun test" }],
				description: "Named shell commands run after each finished subtask.",
			},
		),
		setting(
			"loop.lenses",
			{ kind: "list", item: { optional: false, kind: "string" } },
			{
				namespace: "loop",
				label: "lenses",
				group: "Checks",
				value: ["quality"],
				layer: "shared",
				from: SHARED,
			},
		),
	];
	export const ADVISED_RUN: TriggerDescriptor = {
		id: "start",
		label: "start loop",
		satisfiable: true,
		inputs: {
			"budget.concurrency": {
				type: "number",
				required: false,
				default: "1",
				options: ["1", "2", "3"],
				label: "sessions at once",
				group: "Limits",
				hint: "advised: JCAB-3 and JCAB-4 both touch packages/core/lint/risks.ts (your setting: 3)",
			},
			isolation: {
				type: "string",
				required: false,
				default: "worktree",
				options: ["worktree", "shared"],
				label: "isolation",
				group: "Workspace",
			},
		},
		preview: [
			[{ text: "Plan  2 subtasks · 0 links · 2 ready", bold: true }],
			[{ text: "Advised", bold: true }],
			[{ text: "budget.concurrency = 1 · shared files", tone: "muted" }],
		],
	};
}
