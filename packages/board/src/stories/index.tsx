/** @jsxImportSource @opentui/react */
// The gallery's stories: a name, the real component over made-up props, and the terminal it opens
// at. No story-authoring layer: a story is the JSX a render test would mount. A copilot surface is
// shown in its place on the board, because its height is the terminal's business (a third of it for
// an ask) and reads wrong on its own.
import { ok } from "@kabane/core";
import type {
	ActivityCard,
	ActivityEvent,
	ActivityLeft,
	ActivitySource,
	ActivityStep,
	Header,
	HeaderPart,
} from "@kabane/extension";
import type { QuestionView } from "@kabane/questions";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { createRef, type ReactNode, useEffect, useMemo, useRef } from "react";
import { BoardActivity } from "../activity";
import { Board } from "../board";
import { CardHeader } from "../card-header";
import { CardTab } from "../card-tab";
import { BoardChecklist } from "../checklist";
import { CopilotLog } from "../copilot-log";
import { CopilotPane, type CopilotPaneProps } from "../copilot-prompt";
import { DecisionForm } from "../decision-form";
import { DecisionPanel } from "../decision-panel";
import { BoardDecisions } from "../decisions";
import { Detail } from "../detail";
import { DetailModel } from "../detail-model";
import { ElicitationForm } from "../elicitation-form";
import { EventView, Stream } from "../event-view";
import { BoardJobs } from "../jobs";
import { JobPanel, JobsView } from "../jobs-view";
import { type LiftedReader, LiftedReaderSheet } from "../lifted-reader";
import { BoardNav } from "../nav";
import { NowFeed } from "../now-feed";
import {
	type CopilotElicitation,
	type CopilotUpdate,
	noActivity,
} from "../ports";
import { SettingsOverlay } from "../settings-overlay";
import { SettingsView } from "../settings-view";
import { SPINNER_IDLE } from "../spinner";
import { CardTabQuestion, PinnedQuestion, TabBar } from "../tab-bar";
import { BoardTabs } from "../tabs";
import { TriggerForm } from "../trigger-form";
import { TriggerFormView } from "../trigger-form-view";
import { Fixtures } from "./fixtures";

export type Story = {
	name: string;
	/** One line for the list: what state of the component this is. */
	about: string;
	width: number;
	height: number;
	render: () => ReactNode;
};

const CLAUDE = "kabane://actor/agent/claude";
const { task, section } = Fixtures;

const SECTIONS = [
	section("inbox", [
		{
			task: task({
				id: "i1",
				shortId: "JREP-9",
				title: "Board flickers on resize",
				state: "inbox",
				priority: "normal",
			}),
			children: [],
		},
	]),
	section("next", [
		{
			task: task({
				id: "n1",
				shortId: "JREP-1",
				title: "Session tokens survive a restart",
				tags: ["cache"],
			}),
			children: [
				task({
					id: "n1a",
					shortId: "JREP-2",
					title: "Pick the store",
					parentTaskId: "n1",
					priority: "normal",
				}),
				task({
					id: "n1b",
					shortId: "JREP-3",
					title: "Migrate the readers",
					parentTaskId: "n1",
					state: "done",
					priority: "normal",
				}),
			],
		},
		{
			task: task({
				id: "n2",
				shortId: "JREP-4",
				title: "Runner replays a dropped turn",
				priority: "urgent",
			}),
			children: [],
		},
		{
			task: task({
				id: "n3",
				shortId: "JREP-5",
				title: "Write the deploy notes",
				kind: "task",
				priority: "low",
			}),
			children: [],
		},
	]),
	section("someday", [
		{
			task: task({
				id: "s1",
				shortId: "JREP-6",
				title: "Light theme for the event view",
				state: "someday",
				priority: "normal",
			}),
			children: [],
		},
	]),
];

type PaneProps = Partial<CopilotPaneProps> & {
	copilot: BoardNav.CopilotState;
};

const Pane = (props: PaneProps): ReactNode => (
	<CopilotPane
		chip="JREP-1 · next"
		focused={false}
		log={null}
		spinnerFrame="⠋"
		askInHand
		textareaRef={createRef<TextareaRenderable>()}
		onSubmit={() => {}}
		onContentChange={() => {}}
		{...props}
	/>
);

// The board as the app lays it out: the list, then the copilot's surface over the footer.
const OnBoard = ({
	pane,
	focus = "board",
	announcement,
}: {
	pane: ReactNode;
	focus?: BoardNav.Focus;
	announcement?: string;
}): ReactNode => (
	<Board
		sections={SECTIONS}
		expanded={new Set(["n1"])}
		selectedId="n1"
		scopeLabel="acme/widget"
		focus={focus}
		pane={pane}
		announcement={announcement}
	/>
);

const form = (
	request: CopilotElicitation,
	draft: Partial<ElicitationForm.Draft> = {},
	pane: Partial<PaneProps> = {},
): ReactNode => (
	<OnBoard
		pane={
			<Pane
				{...pane}
				copilot={Fixtures.copilot({
					turn: "running",
					actor: CLAUDE,
					asks: [
						{
							type: "elicitation",
							request,
							draft: { ...ElicitationForm.start(), ...draft },
						},
					],
				})}
			/>
		}
	/>
);

// A turn part way through its plan, a minute in, with the agent's last words under it.
const planLog = (): CopilotLog.Log => {
	const at = new Date(Date.now() - 64_000).toISOString();
	const updates = [
		{
			type: "plan" as const,
			entries: [
				{
					content: "Read JREP-1 and its subtasks",
					status: "completed" as const,
				},
				{ content: "Compare Redis and Memory", status: "completed" as const },
				{ content: "Draft the migration plan", status: "in_progress" as const },
				{ content: "File the reader migration", status: "pending" as const },
				{ content: "Comment on JREP-1", status: "pending" as const },
			],
			at,
		},
		{
			type: "text" as const,
			summary: "Redis keeps tokens across restarts; drafting the steps now.",
			at,
		},
		{ type: "tool_call" as const, summary: "kabane_context JREP-1", at },
	];
	return updates.reduce(
		CopilotLog.apply,
		CopilotLog.start(null, "plan the token store", at),
	);
};

const foldedTools = (): ReactNode => {
	const at = (seconds: number) =>
		new Date(Fixtures.JOBS_NOW + seconds * 1000).toISOString();
	const updates: CopilotUpdate[] = [
		{ type: "thought", summary: "\n\n**Checking 503 logs**", at: at(0) },
		{ type: "tool_call", summary: "Read server.log", callId: "log", at: at(0) },
		{
			type: "tool_result",
			summary: "Read server.log",
			callId: "log",
			at: at(2),
		},
		{ type: "tool_call", summary: "curl /health", callId: "probe", at: at(2) },
		{
			type: "tool_failed",
			summary: "curl /health",
			callId: "probe",
			at: at(13),
		},
		{ type: "text", summary: "The health check timed out.", at: at(13) },
		{ type: "done", summary: "", at: at(13) },
	];
	const log = updates.reduce(
		CopilotLog.apply,
		CopilotLog.start(null, "Check the failing requests.", at(0)),
	);
	return (
		<EventView
			cardId={CopilotLog.CARD_ID}
			initialCard={log.current.card}
			source={CopilotLog.source(noActivity, () => log)}
			resolveShortId={() => undefined}
			scrollRef={createRef<ScrollBoxRenderable>()}
		/>
	);
};

const question = Fixtures.question(2, ["Yes", "No"]);

// An issue an agent left waiting on two decisions: a single choice it recommends one of, then a
// multi-select that also takes a typed answer.
const WAITING = task({
	id: "w1",
	shortId: "JREP-7",
	title: "Cache the session tokens",
	state: "waiting",
	description:
		"Tokens expire on every restart; keep them somewhere that survives one.",
});
const STORE_DECISION = Fixtures.decision(
	WAITING,
	1,
	"Which store should hold the session tokens?",
	{
		choices: ["SQLite", "Redis", "Memory"],
		recommended: "SQLite",
		allowFreeform: false,
	},
	{ why: "Local first: the board has to work without a network." },
);
const CHECKS_DECISION = Fixtures.decision(
	WAITING,
	2,
	"Which checks should gate a merge?",
	{
		choices: ["Lint", "Types", "Tests"],
		multiSelect: true,
		allowFreeform: true,
	},
);

// The issue's detail as the app lays it out, the decision on screen under its header, on the tab
// its records open on.
const onDetail = (
	questions: QuestionView[],
	asked?: BoardDecisions.Shown,
): ReactNode => {
	const records = Fixtures.records(WAITING, { questions });
	return (
		<Detail
			taskId={WAITING.id}
			task={WAITING}
			records={ok(records)}
			tab={DetailModel.openingTab(records)}
			scrollRef={createRef<ScrollBoxRenderable>()}
			keys={{ context: "detail", situation: { deciding: asked !== undefined } }}
			decision={
				asked ? (
					<DecisionPanel asked={asked} inHand onSubmit={() => {}} />
				) : undefined
			}
		/>
	);
};

// An issue an agent broke into steps of one change, two of four ticked.
const STEPWISE = task({
	id: "k1",
	shortId: "JREP-8",
	title: "Move the session store to SQLite",
	state: "in_progress",
	description:
		"Sessions live in memory today. Move them to SQLite so a restart keeps them.",
});
const STEPS = [
	Fixtures.item(STEPWISE, 1, "Add the sessions table and its migration", true),
	Fixtures.item(STEPWISE, 2, "Write through the store on every change", true),
	Fixtures.item(STEPWISE, 3, "Read the store back on startup"),
	Fixtures.item(STEPWISE, 4, "Drop the in-memory map"),
];

// Its timeline: a person's comment, the agent's handoff, and a review in a kind no module declares.
const TIMELINE = [
	Fixtures.entry(
		STEPWISE,
		1,
		"comment",
		"ada",
		"Keep the map until the store reads back.",
	),
	Fixtures.entry(
		STEPWISE,
		2,
		"handoff",
		CLAUDE,
		"## Summary\n\nThe store writes through on every change; reading it back on startup is next.\n\n## Not verified\n\n- a restart under load",
	),
	Fixtures.entry(
		STEPWISE,
		3,
		"review",
		"kabane://actor/agent/codex",
		"The migration is idempotent. `write` misses one error path.",
	),
];

// Agents whose actor names are dated model ids, longer than a narrow pane allows: a plain comment,
// then a handoff.
const LONG_COMMENT = Fixtures.entry(
	STEPWISE,
	3,
	"comment",
	"kabane://actor/agent/claude-sonnet-4-5-20250929-preview",
	"Starting on the read path.",
);
const LONG_HANDOFF = Fixtures.entry(
	STEPWISE,
	4,
	"handoff",
	"kabane://actor/agent/claude-sonnet-4-20250514",
	"Picked up where the first pass stopped.",
);

// A wave's parent the size of a real one (JCAB-213): its real handoff, three steps of the merge
// with one ticked, a decision made on it, and five subtasks, four done.
const WAVE = task({
	id: "w1",
	shortId: "JREP-1",
	title:
		"An issue has a timeline of typed entries, and a handoff is the first kind built on it",
	state: "in_progress",
	description:
		"Parent of the wave. Its measure is dogfooding: the dispatch skill uses it now.\n\n**The model.** Research and context are an issue's inputs. The issue is the ask. Comments, decisions and handoffs are **entries** on the issue's **timeline**, each with a **kind**.",
});
// Every block the brief renders apart from prose: the code, quote and rule blockOnSurface paints,
// and a table as columns, beside the inline ink.
const MARKDOWN = task({
	id: "m1",
	shortId: "JREP-9",
	title: "The board's markdown keeps its panels on OpenTUI 0.9",
	state: "next",
	description: [
		"## Finding",
		"",
		"`renderNode` is gone from `MarkdownOptions`; see the [0.9 notes](https://github.com/anomalyco/opentui/releases).",
		"",
		"- [x] bump the group",
		"- [ ] port the block renderer",
		"",
		"> A quote sits on raised, with no bar beside it.",
		"",
		"```sh",
		"bun run gallery --print detail-markdown",
		"```",
		"",
		"---",
		"",
		"| check | width |",
		"| --- | --- |",
		"| gallery | 40 |",
		"| tmux | 100 |",
		"",
		"After the rule and the table.",
	].join("\n"),
});
const MARKDOWN_RECORDS = Fixtures.records(MARKDOWN);
// The blocks OpenTUI builds inside another and never hands the renderer: a quote and a rule inside
// a quote, and a quote inside a list item.
const NESTED = task({
	id: "m2",
	shortId: "JREP-10",
	title: "Nested quotes and rules keep no line",
	state: "next",
	description: [
		"> The outer quote, on raised.",
		">",
		"> > A quote inside it, with no bar.",
		">",
		"> ---",
		">",
		"> After a rule inside the quote.",
		"",
		"- A list item",
		"",
		"  > and a quote inside it, on raised.",
		"",
		"After the list.",
	].join("\n"),
});
const NESTED_RECORDS = Fixtures.records(NESTED);
const WAVE_RECORDS = Fixtures.records(WAVE, {
	kinds: [...Fixtures.KINDS],
	entries: [
		Fixtures.entry(WAVE, 1, "comment", "david", "Keep the jcab-214 branch."),
		Fixtures.entry(WAVE, 2, "handoff", CLAUDE, Fixtures.REAL_HANDOFF),
	],
	checklist: [
		Fixtures.item(WAVE, 1, "Merge JCAB-217", true),
		Fixtures.item(WAVE, 2, "Merge JCAB-218 and 219"),
		Fixtures.item(WAVE, 3, "Closing review of the combined diff"),
	],
	questions: [
		Fixtures.decision(
			WAVE,
			1,
			"Does a handoff get a table of its own?",
			{ choices: ["A table", "An entry kind"], allowFreeform: false },
			{
				status: "answered",
				answer: "An entry kind",
				answeredBy: "kabane://actor/human/david",
				reasoning: "one timeline",
			},
		),
	],
	subtasks: [
		...[
			"Core seam: comments gain a kind",
			"Handoff module",
			"Dispatch skill hands off",
			"Board labels kinds",
		].map((title, n) =>
			task({
				id: `w1-${n}`,
				shortId: `JREP-${n + 2}`,
				title,
				state: "done",
				parentTaskId: WAVE.id,
			}),
		),
		task({
			id: "w1-4",
			shortId: "JREP-6",
			title: "Kinds from extensions and project config",
			state: "someday",
			parentTaskId: WAVE.id,
		}),
	],
	contextRefs: [
		{
			id: "r1",
			taskId: WAVE.id,
			uri: "wiki/timeline-entries.md",
			kind: "design",
			label: "Timeline entries",
			addedAt: "2026-10-10T00:00:00.000Z",
		},
	],
});
const WAVE_CHECKLIST = BoardChecklist.view(
	WAVE_RECORDS.checklist,
	null,
	undefined,
	DetailModel.openable(WAVE_RECORDS),
);

// One of the wave's issues and where it sits: its parent, a blocker in progress and one done, three
// issues waiting on it (one of them by `follows`), two related (one gone from the tracker), and the
// external issue it mirrors.
const SITTING = task({
	id: "s1",
	shortId: "JREP-12",
	title: "The detail's header shows relations as one trail",
	state: "next",
	parentTaskId: WAVE.id,
});
const BLOCKER = task({
	id: "s2",
	shortId: "JREP-11",
	title: "The detail opens another issue over itself",
	state: "in_progress",
});
const CLEARED = task({
	id: "s3",
	shortId: "JREP-9",
	title: "Freshness marks on now",
	state: "done",
});
const FIRST = task({
	id: "s4",
	shortId: "JREP-13",
	title: "Relations on board cards",
});
const SECOND = task({
	id: "s5",
	shortId: "JREP-14",
	title: "Add and remove links from the board",
	state: "someday",
});
const THIRD = task({
	id: "s6",
	shortId: "JREP-15",
	title: "Sync links with the upstream tracker",
	state: "inbox",
});
const DEPENDENTS = [FIRST, SECOND, THIRD];
const RELATED = task({
	id: "s7",
	shortId: "JREP-7",
	title: "The now tab",
	state: "done",
});
const GONE = task({ id: "01HZZGONE0000000000000000" });
const TRAIL_RECORDS = Fixtures.records(SITTING, {
	links: [
		Fixtures.link(1, SITTING, "blocked_by", BLOCKER),
		Fixtures.link(2, CLEARED, "blocks", SITTING),
		Fixtures.link(3, SITTING, "blocks", FIRST),
		Fixtures.link(4, SECOND, "blocked_by", SITTING),
		Fixtures.link(5, THIRD, "follows", SITTING),
		Fixtures.link(6, SITTING, "related", RELATED),
		Fixtures.link(7, GONE, "related", SITTING),
	],
	neighbors: [WAVE, BLOCKER, CLEARED, ...DEPENDENTS, RELATED],
	upstream: [
		Fixtures.upstream(SITTING, "linear", "ENG-412", "Relations in the header"),
	],
});
// The same issue with only the trail the brief names: a parent, a blocker open, three waiting on it.
const TRAIL_ONLY = Fixtures.records(SITTING, {
	links: [
		Fixtures.link(1, SITTING, "blocked_by", BLOCKER),
		Fixtures.link(3, SITTING, "blocks", FIRST),
		Fixtures.link(4, SECOND, "blocked_by", SITTING),
		Fixtures.link(5, THIRD, "follows", SITTING),
	],
	neighbors: [WAVE, BLOCKER, ...DEPENDENTS],
});

// The reader over the wave's detail, moved `jumps` headings down the way `]` moves it, once the
// markdown has laid out. Under the screen's tab bar, as the board draws it: the reader sits a row
// down, under that bar.
const ReaderOver = ({ jumps }: { jumps: number }): ReactNode => {
	const handle = useRef<LiftedReader.Handle | null>(null);
	useEffect(() => {
		const timers = Array.from({ length: jumps }, (_, n) =>
			setTimeout(() => handle.current?.jump(1), 60 * (n + 1)),
		);
		return () => {
			for (const timer of timers) clearTimeout(timer);
		};
	}, [jumps]);
	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<TabBar tabs={BoardTabs.NONE} cards={[]} spinnerFrame={SPINNER_IDLE} />
			<box style={{ flexDirection: "column", flexGrow: 1 }}>
				<Detail
					taskId={WAVE.id}
					task={WAVE}
					records={ok(WAVE_RECORDS)}
					scrollRef={createRef<ScrollBoxRenderable>()}
					checklist={WAVE_CHECKLIST}
					covered
				/>
			</box>
			<LiftedReaderSheet
				entries={DetailModel.lifted(WAVE_RECORDS)}
				handleRef={handle}
			/>
		</box>
	);
};

// Checklist progress on the board's rows: one under way, one complete.
const PROGRESS = new Map([
	["n1", { done: 2, total: 4 }],
	["n2", { done: 3, total: 3 }],
]);

const asking = (
	row: QuestionView,
	draft: Partial<ElicitationForm.Draft> = {},
	waiting = 0,
): BoardDecisions.Shown => ({
	decision: DecisionForm.of(row),
	draft: { ...ElicitationForm.start(), ...draft },
	started: false,
	waiting,
});

// The `,` view over Fixtures.SETTINGS, on `loop.gates.test`.
const settingsView = (detail: boolean): SettingsView.View => {
	const rows = SettingsView.ordered(Fixtures.SETTINGS);
	return {
		rows: { type: "ready", rows },
		selected: rows.findIndex((row) => row.key === "loop.gates.test"),
		detail,
	};
};

// The `,` view on `key`, its editor at `edit` or a save's word under it.
const settingsEdit = (
	key: string,
	over: Pick<SettingsView.View, "edit" | "said">,
): SettingsView.View => {
	const rows = SettingsView.ordered(Fixtures.SETTINGS);
	return {
		rows: { type: "ready", rows },
		selected: rows.findIndex((row) => row.key === key),
		detail: over.edit !== undefined,
		...over,
	};
};

const headerStory = async () => ok(Fixtures.HEADER);
const HeaderStory = (): ReactNode => {
	const { width } = useTerminalDimensions();
	return (
		<CardHeader
			header={headerStory}
			card={Fixtures.loop(1)}
			width={width - 1}
			expanded={false}
		/>
	);
};

// The Jobs tab on screen under the bar, its waiting job selected.
const JOBS_TABS: BoardTabs.Tabs = {
	...BoardTabs.NONE,
	active: BoardTabs.JOBS,
	jobs: BoardJobs.withList(BoardTabs.NONE.jobs, Fixtures.JOBS),
};

const JobsStory = (): ReactNode => (
	<box style={{ flexDirection: "column", flexGrow: 1 }}>
		<TabBar tabs={JOBS_TABS} cards={[]} spinnerFrame={SPINNER_IDLE} />
		<JobsView jobs={JOBS_TABS.jobs} now={Fixtures.JOBS_NOW} />
	</box>
);

const [WIKI_JOB] = Fixtures.JOBS;

// The top of a loop run's tab with its map: the tab bar, the run row, the map and what needs the
// human, from a made-up review run shaped like a real one (five rechecks after the fixer). The
// stream under them is the event view's and is not drawn here.
const DONE: ActivityStep[] = [
	{
		name: "implement",
		state: "done",
		result: "1 of 1 done",
		durationMs: 122_000,
	},
	{
		name: "gates",
		state: "done",
		result: "check·test·build · 3 passes · 12s gate time",
	},
	{
		name: "triage",
		state: "done",
		result: "2 review sessions",
		durationMs: 14_000,
	},
	{
		name: "review",
		state: "done",
		result: "21 findings filed",
		durationMs: 429_000,
		sessions: [
			{
				name: "functional+quality+architecture",
				state: "done",
				lane: "functional+quality+architecture-lens",
				result: "14 findings filed",
				durationMs: 358_000,
			},
			{
				name: "docs+design",
				state: "done",
				lane: "docs+design-lens",
				result: "7 findings filed",
				durationMs: 429_000,
			},
		],
	},
	{ name: "fixer", state: "done", result: "21 settled", durationMs: 1_618_000 },
];

const minutesAgo = (minutes: number): string =>
	new Date(Date.now() - minutes * 60_000).toISOString();

const RECHECK_LIVE: ActivityStep = {
	name: "recheck",
	state: "running",
	result: "2 of 5 done · 2 live",
	startedAt: minutesAgo(4),
	sessions: [
		{
			name: "functional",
			state: "done",
			lane: "functional-recheck",
			result: "4 confirmed · 1 reopened",
			durationMs: 191_000,
		},
		{
			name: "quality",
			state: "done",
			lane: "quality-recheck",
			result: "5 confirmed · 1 reopened",
			durationMs: 125_000,
		},
		{
			name: "docs",
			state: "running",
			lane: "docs-recheck",
			result: "5 findings",
			startedAt: minutesAgo(1),
		},
		{
			name: "architecture",
			state: "running",
			lane: "architecture-recheck",
			result: "3 findings",
			startedAt: minutesAgo(1),
		},
		{
			name: "design",
			state: "pending",
			result: "2 findings · waits for a slot",
		},
	],
};

const LIVE: ActivityCard = {
	id: "loop:r5",
	kind: "loops",
	label: "loop",
	status: "running",
	taskShortId: "PROJ-5",
	startedAt: minutesAgo(40),
	detail: [],
	hasEvents: true,
	tab: true,
	lanes: (RECHECK_LIVE.sessions ?? []).flatMap((s) => (s.lane ? [s.lane] : [])),
	liveLanes: ["architecture-recheck", "docs-recheck"],
	facts: [
		{ label: "slots", value: "2/2" },
		{ label: "continuations", value: "0/3" },
		{ label: "spend", value: "$17.50 (codex unpriced)" },
		{ label: "implementer", value: "claude opus" },
		{ label: "verifier", value: "codex" },
		{ label: "review", value: "triage" },
		{ label: "gates", value: "check·test·build" },
		{ label: "lenses", value: "functional·quality·docs·architecture·design" },
		{ label: "land", value: "none" },
	],
	steps: [
		...DONE,
		RECHECK_LIVE,
		{
			name: "land",
			state: "pending",
			result: "none: the branch stays for review",
		},
	],
};

const FINISHED: ActivityCard = {
	...LIVE,
	status: "completed",
	liveLanes: undefined,
	steps: [
		...DONE,
		{
			name: "recheck",
			state: "done",
			result: "18 confirmed · 3 reopened · 3 filed",
			durationMs: 635_000,
		},
		{ name: "land", state: "done", result: "none: kept for review" },
	],
	left: [
		["PROJ-22", "reopened by functional", "a stale cursor survives a resize"],
		["PROJ-27", "reopened by quality", "the retry loop swallows its error"],
		["PROJ-38", "reopened by docs", "the README names a removed flag"],
		["PROJ-42", "filed by architecture", "the store reaches past its port"],
		["PROJ-43", "filed by docs", "the guide skips the new setting"],
		["PROJ-44", "filed by design", "the empty state has no hint"],
	]
		.map(([id = "", how = "", reason = ""]): ActivityLeft => ({
			taskId: `01${id}`,
			taskShortId: id,
			how,
			reason,
		}))
		.concat({ how: "branch proj-5-reader", reason: "land: none" }),
};

const ASKED: BoardTabs.Question = {
	id: "q1",
	cardId: LIVE.id,
	lane: "docs-recheck",
	taskShortId: "PROJ-5",
	question: "Run `bun run docs:check` in the worktree?",
	choices: ["Allow once", "Reject"],
	multiSelect: false,
	allowFreeform: false,
	permission: true,
	agent: "codex",
	askedAt: minutesAgo(1),
};

// The run row as the loop lays it out at `width`: the parent on the left, the state on the right.
const runRow = (
	width: number,
	state: HeaderPart,
	facts: readonly string[],
): HeaderPart[] => {
	const title = "slice 1: the reader keeps its place";
	let rest = "";
	for (const fact of facts) {
		const next = `${rest} · ${fact}`;
		if (6 + 2 + state.text.length + next.length > width) break;
		rest = next;
	}
	const right = state.text.length + rest.length;
	const room = width - 6 - 4 - right;
	const shown =
		room < 8
			? ""
			: title.length <= room
				? title
				: `${title.slice(0, room - 1)}…`;
	return [
		{ text: "PROJ-5", tone: "default", bold: true },
		...(shown ? [{ text: `  ${shown}`, tone: "secondary" as const }] : []),
		{
			text: " ".repeat(Math.max(2, width - 8 - shown.length - right)),
			tone: "muted",
		},
		state,
		{ text: rest, tone: "muted" },
	];
};

// A card that never changes, as a host's source would serve it: the event view polls it as it would
// a live one.
const staticSource = (
	card: ActivityCard,
	events: readonly ActivityEvent[],
): ActivitySource => ({
	load: async () => ok([card]),
	card: async () => ok(card),
	events: async (_id, after) => ok(events.filter((e) => e.seq > after)),
});

// A loop run's tab as the board mounts it: the tab bar over the event view, with the run row, the map
// (`view` is how the human left it), what needs the human, "now" or a log, the copilot's row and the
// footer. Stacked under 160 columns, split from there.
const RunTab = ({
	card,
	queue = [],
	events = [],
	state,
	facts,
	view: patch = {},
}: {
	card: ActivityCard;
	queue?: readonly BoardTabs.Question[];
	events?: readonly ActivityEvent[];
	state: HeaderPart;
	facts: readonly string[];
	view?: Partial<BoardTabs.CardView>;
}): ReactNode => {
	const { tabs } = BoardTabs.withActivity(
		BoardNav.init([], { scoped: false }),
		[card],
		queue,
	);
	const onTab = { ...tabs, active: card.id };
	const view = { ...CardTab.view(onTab, card.id), ...patch };
	const source = useMemo(() => staticSource(card, events), [card, events]);
	const header = useMemo(
		(): Header => async (_card, at) => ok([runRow(at.width, state, facts)]),
		[state, facts],
	);
	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<TabBar tabs={onTab} cards={[card]} spinnerFrame="⠋" />
			<EventView
				cardId={card.id}
				initialCard={card}
				source={source}
				resolveShortId={() => undefined}
				scrollRef={createRef<ScrollBoxRenderable>()}
				tabbed
				lane={view.lane}
				header={header}
				map={{ view, asking: CardTab.asking(onTab, card.id) }}
				banner={<CardTabQuestion tabs={onTab} onAnswer={() => {}} />}
				keys={{
					context: "cardTab",
					situation: { map: true, log: view.lane !== null },
				}}
				pane={<Pane copilot={Fixtures.copilot()} chip={card.taskShortId} />}
			/>
		</box>
	);
};

const LIVE_ROW: HeaderPart = { text: "● recheck", tone: "working", bold: true };
const LIVE_FACTS = ["2 of 5 done", "2/2 live", "40m28s", "$17.50"];
const ASKED_ROW: HeaderPart = {
	text: "? docs-recheck waits on you",
	tone: "accent",
	bold: true,
};
const ASKED_FACTS = ["recheck 2 of 5 done", "2/2 live", "40m28s", "$17.50"];
const FINISHED_ROW: HeaderPart = {
	text: "✓ completed",
	tone: "done",
	bold: true,
};
const FINISHED_FACTS = ["6 findings left for you", "46m52s", "$17.50"];

const RUN_MAP_STORIES: readonly Story[] = [
	{
		name: "run-map-live",
		about:
			"a run mid-recheck: the live step open, the cursor on the newest live session",
		width: 100,
		height: 30,
		render: () => (
			<RunTab
				card={LIVE}
				events={NOW_EVENTS}
				state={LIVE_ROW}
				facts={LIVE_FACTS}
			/>
		),
	},
	{
		name: "run-map-question",
		about:
			"a session waits on the human: its row and the run row say so, the question names it",
		width: 100,
		height: 30,
		render: () => (
			<RunTab
				card={LIVE}
				queue={[ASKED]}
				events={NOW_EVENTS}
				state={ASKED_ROW}
				facts={ASKED_FACTS}
			/>
		),
	},
	{
		name: "run-map-finished",
		about: "a finished run: every step folded, and what it left for the human",
		width: 100,
		height: 30,
		render: () => (
			<RunTab
				card={TRACE_CARD}
				events={TRACE_EVENTS}
				state={FINISHED_ROW}
				facts={FINISHED_FACTS}
			/>
		),
	},
	{
		name: "run-map-short",
		about:
			"a finished run on a short pane, a step opened: the map windows and the footer stays",
		width: 100,
		height: 22,
		render: () => (
			<RunTab
				card={TRACE_CARD}
				events={TRACE_EVENTS}
				state={FINISHED_ROW}
				facts={FINISHED_FACTS}
				view={{
					folds: new Map([["recheck", true]]),
					cursor: "step:recheck",
					follow: false,
				}}
			/>
		),
	},
	{
		name: "cockpit-live",
		about:
			"from 160 columns: the map, the question and the run on the left, now over the cursor's log",
		width: 200,
		height: 50,
		render: () => (
			<RunTab
				card={LIVE}
				queue={[ASKED]}
				events={NOW_EVENTS}
				state={ASKED_ROW}
				facts={ASKED_FACTS}
			/>
		),
	},
	{
		name: "cockpit-finished",
		about:
			"a finished run split: what it left on the left, the trace over every session on the right",
		width: 200,
		height: 50,
		render: () => (
			<RunTab
				card={TRACE_CARD}
				events={TRACE_EVENTS}
				state={FINISHED_ROW}
				facts={FINISHED_FACTS}
			/>
		),
	},
	{
		name: "cockpit-narrow",
		about: "the split at its threshold, 160 columns, mid-run",
		width: 160,
		height: 40,
		render: () => (
			<RunTab
				card={LIVE}
				events={NOW_EVENTS}
				state={LIVE_ROW}
				facts={LIVE_FACTS}
			/>
		),
	},
];

const feedEvent = (
	seq: number,
	type: string,
	summary: string,
	lane?: string,
	callId?: string,
): ActivityEvent => ({
	seq,
	at: new Date(2026, 10, 20, 9, 15, seq).toISOString(),
	type,
	summary,
	lane,
	callId,
});
const docs = "docs-recheck";
const arch = "architecture-recheck";
const NOW_EVENTS: ActivityEvent[] = [
	{
		...feedEvent(1, "done", "gates · check, test, build", "PROJ-41"),
		run: true,
	},
	{
		...feedEvent(
			2,
			"progress",
			"PROJ-41 merged into the run branch",
			"PROJ-41",
		),
		run: true,
	},
	{
		...feedEvent(3, "progress", "codex claims the docs recheck", docs),
		run: true,
	},
	feedEvent(4, "phase", "codex rechecks the docs findings", docs),
	feedEvent(5, "phase", "codex rechecks the architecture findings", arch),
	feedEvent(6, "tool_call", "Read guide", docs, "a"),
	feedEvent(7, "thought", "**Checking the storage boundary**", arch),
	feedEvent(8, "tool_call", "Run examples", docs, "b"),
	feedEvent(9, "tool_failed", "Run examples", docs, "b"),
	feedEvent(10, "tool_completed", "Read guide", docs, "a"),
	feedEvent(
		11,
		"text",
		"The guide still names the removed flag. I'll check the replacement.",
		docs,
	),
	feedEvent(12, "tool_call", "Read adapter", arch, "a"),
	feedEvent(13, "permission", "Run the updated example?", docs),
];
const traceEnd: ActivityEvent = {
	...feedEvent(18, "progress", "completed: plan-done"),
	run: true,
};
const TRACE_CARD: ActivityCard = {
	...FINISHED,
	finishedAt: traceEnd.at,
	steps: [
		{
			name: "gates",
			state: "done",
			result: "check · test · build",
			durationMs: 14_000,
		},
		{
			name: "recheck",
			state: "done",
			result: "8 confirmed · 1 reopened",
			durationMs: 635_000,
			sessions: [
				{ name: "docs", state: "done", lane: docs },
				{ name: "architecture", state: "done", lane: arch },
			],
		},
		{ name: "land", state: "done", result: "merged into HEAD" },
	],
};
const TRACE_EVENTS: ActivityEvent[] = [
	...NOW_EVENTS,
	feedEvent(14, "done", "docs checked", docs),
	feedEvent(15, "done", "architecture checked", arch),
	feedEvent(17, "done", "land · merged into HEAD"),
	traceEnd,
	{
		...feedEvent(
			19,
			"done",
			"pruned · worktree and branch removed: branch merged into HEAD",
		),
		run: true,
	},
];
const SessionLog = (): ReactNode => {
	const { width } = useTerminalDimensions();
	const claim = "codex claims PROJ-41: update the guide";
	const launch = "codex-acp";
	const mode = "mode: review";
	const events: ActivityEvent[] = [
		{ ...feedEvent(1, "progress", claim, docs), run: true },
		feedEvent(2, "progress", launch, docs),
		feedEvent(3, "progress", mode, docs),
		{
			...feedEvent(4, "phase", claim, docs),
			includes: [1, 2, 3],
			detail: { input: [launch, mode].join("\n") },
		},
		feedEvent(5, "text", "Updated the example in the guide.", docs),
		{
			...feedEvent(6, "done", "gates · storage check passed", arch),
			run: true,
		},
		{ ...feedEvent(7, "done", "gates · docs check passed", docs), run: true },
	];
	return (
		<Stream
			card={LIVE}
			events={events}
			lane={docs}
			lanes={[]}
			width={width}
			scrollRef={createRef<ScrollBoxRenderable>()}
			tabbed
			spinnerFrame="⠋"
			toolDetails={false}
		/>
	);
};

const FeedStory = ({
	card,
	events,
}: {
	card: ActivityCard;
	events: readonly ActivityEvent[];
}): ReactNode => {
	const { width } = useTerminalDimensions();
	return (
		<NowFeed
			card={card}
			events={events}
			width={width}
			scrollRef={useRef<ScrollBoxRenderable>(null)}
			spinnerFrame="⠋"
		/>
	);
};
const nowStory = (
	name: string,
	about: string,
	card: ActivityCard,
	events = NOW_EVENTS,
): Story => ({
	name,
	about,
	width: 100,
	height: 12,
	render: () => <FeedStory card={card} events={events} />,
});

export const STORIES: readonly Story[] = [
	{
		name: "folded-tools",
		about: "a thought and a mixed run of successful and failed tool calls",
		width: 40,
		height: 10,
		render: foldedTools,
	},
	{
		name: "jobs",
		about:
			"the Jobs tab: two scopes, a run waiting on the human, a paused job, one no source describes",
		width: 100,
		height: 14,
		render: () => <JobsStory />,
	},
	{
		name: "job-detail",
		about:
			"a job's detail: its schedule, recipe, folder and runs with their attach command",
		width: 100,
		height: 24,
		render: () =>
			WIKI_JOB ? (
				<Detail
					taskId={WIKI_JOB.task.id}
					task={WIKI_JOB.task}
					records={ok(Fixtures.records(WIKI_JOB.task))}
					scrollRef={createRef<ScrollBoxRenderable>()}
					job={
						<JobPanel
							facts={WIKI_JOB.facts}
							paused={false}
							now={Fixtures.JOBS_NOW}
						/>
					}
					keys={{ context: "detail", situation: {} }}
				/>
			) : null,
	},
	{
		name: "card-header",
		about: "Toned data rows, a series color, bold text and a clipped line",
		width: 40,
		height: 8,
		render: () => <HeaderStory />,
	},
	{
		name: "trigger-advised",
		about: "run settings with a wrapped advice reason and the original setting",
		width: 80,
		height: 24,
		render: () => (
			<TriggerFormView
				shortId="JCAB-2"
				form={TriggerForm.open(Fixtures.ADVISED_RUN)}
			/>
		),
	},
	{
		name: "trigger-recipe",
		about:
			"a recipe's launcher: the harness it will start and where from, a choice, a required text input",
		width: 100,
		height: 24,
		render: () => (
			<TriggerFormView
				shortId="JCAB-443"
				form={TriggerForm.open(Fixtures.RECIPE_RUN)}
			/>
		),
	},
	{
		name: "trigger-recipe-typing",
		about:
			"the same launcher with the required text input in hand and typed, the harness edited",
		width: 100,
		height: 24,
		render: () => {
			const form = TriggerForm.open(Fixtures.RECIPE_RUN);
			return (
				<TriggerFormView
					shortId="JCAB-443"
					form={{
						...form,
						field: 2,
						values: {
							...form.values,
							"@harness": "claude --model opus",
							focus: "the auth flow",
						},
						edited: ["@harness", "focus"],
					}}
				/>
			);
		},
	},
	{
		name: "board",
		about: "a few cards, a parent expanded, the copilot's row collapsed",
		width: 100,
		height: 20,
		render: () => (
			<OnBoard pane={<Pane copilot={Fixtures.copilot({ actor: CLAUDE })} />} />
		),
	},
	{
		name: "update-notice",
		about: "the host's announcement, a newer release, over the copilot's row",
		width: 80,
		height: 16,
		render: () => (
			<OnBoard
				announcement="kabane 1.0.0 is out · run kabane update"
				pane={<Pane copilot={Fixtures.copilot({ actor: CLAUDE })} />}
			/>
		),
	},
	{
		name: "settings-view",
		about:
			"every setting under its namespace and group, with the layer it comes from",
		width: 80,
		height: 24,
		render: () => <SettingsOverlay view={settingsView(false)} />,
	},
	{
		name: "settings-view-detail",
		about: "a local gate's detail: its file, and the shared value it hides",
		width: 80,
		height: 30,
		render: () => <SettingsOverlay view={settingsView(true)} />,
	},
	{
		name: "settings-view-narrow",
		about: "the settings view in forty columns, the gate's detail open",
		width: 40,
		height: 30,
		render: () => <SettingsOverlay view={settingsView(true)} />,
	},
	{
		name: "settings-edit",
		about:
			"the stall limit stepped to 4 with l, to be saved to local, what local means",
		width: 80,
		height: 30,
		render: () => (
			<SettingsOverlay
				view={settingsEdit("loop.stallAfter", {
					edit: {
						key: "loop.stallAfter",
						layer: "local",
						change: { type: "step", value: 4 },
					},
				})}
			/>
		),
	},
	{
		name: "settings-edit-typed",
		about:
			"9 typed for sessions at once, refused beside the field: nothing is written",
		width: 80,
		height: 30,
		render: () => (
			<SettingsOverlay
				view={settingsEdit("loop.budget.concurrency", {
					edit: {
						key: "loop.budget.concurrency",
						layer: "local",
						change: { type: "type", text: "9" },
						error: '"9" is not a whole number from 1 to 8',
					},
				})}
			/>
		),
	},
	{
		name: "settings-edit-protected",
		about:
			"a new hub token typed write-only, the protected key's y/n before it saves",
		width: 80,
		height: 30,
		render: () => (
			<SettingsOverlay
				view={settingsEdit("sync.token", {
					edit: {
						key: "sync.token",
						layer: "global",
						change: { type: "type", text: "hunter22" },
						confirm: true,
					},
				})}
			/>
		),
	},
	{
		name: "settings-edit-shadowed",
		about: "6 saved to global while local still decides, and when it applies",
		width: 80,
		height: 24,
		render: () => (
			<SettingsOverlay
				view={settingsEdit("loop.stallAfter", {
					said: {
						key: "loop.stallAfter",
						lines: [
							"saved 6 to global",
							"local still decides: 4 (/Users/ada/.kabane/projects/-Users-ada-acme-widget-8380ae31/loop.json)",
						],
						warn: true,
					},
				})}
			/>
		),
	},
	{
		name: "settings-saved-unresolved",
		about:
			"6 saved to global, but a broken shared file keeps the settings from resolving",
		width: 80,
		height: 12,
		render: () => {
			const error =
				"/Users/ada/acme/widget/.kabane/loop.json: JSON Parse error: Expected '}'";
			return (
				<SettingsOverlay
					view={{
						rows: { type: "failed", error },
						selected: 0,
						detail: false,
						said: SettingsView.outcome("loop.stallAfter", {
							key: "loop.stallAfter",
							layer: "global",
							from: "/Users/ada/.kabane/config.json",
							value: 6,
							unresolved: error,
							restart: "resolve",
						}),
					}}
				/>
			);
		},
	},
	{
		name: "copilot-collapsed",
		about: "the copilot's one row, idle",
		width: 80,
		height: 2,
		render: () => <Pane copilot={Fixtures.copilot()} />,
	},
	{
		name: "copilot-collapsed-asking",
		about: "the one row while a permission waits on you",
		width: 80,
		height: 2,
		render: () => (
			<Pane
				copilot={Fixtures.copilot({
					turn: "running",
					actor: CLAUDE,
					asks: [Fixtures.PERMISSION],
				})}
			/>
		),
	},
	{
		name: "form-described",
		about: "a single choice whose options carry descriptions",
		width: 80,
		height: 30,
		render: () => form(Fixtures.DELIVERY),
	},
	{
		name: "form-undescribed",
		about: "a single choice with bare labels",
		width: 80,
		height: 30,
		render: () => form(Fixtures.UNDESCRIBED),
	},
	{
		name: "form-multi",
		about: "a multi-select with one option toggled",
		width: 80,
		height: 30,
		render: () => form(Fixtures.TAGS, { picked: [1] }),
	},
	{
		name: "form-multi-cursor",
		about: "a multi-select with its cursor moved down past a toggled option",
		width: 80,
		height: 30,
		render: () => form(Fixtures.TAGS, { picked: [0], cursor: 2 }),
	},
	{
		name: "form-not-in-hand",
		about: "a form while an open prompt holds the keys, saying how to reach it",
		width: 80,
		height: 30,
		render: () =>
			form(
				Fixtures.TAGS,
				{},
				{ askInHand: false, reach: { key: "esc", holder: "the prompt" } },
			),
	},
	{
		name: "form-text",
		about: "a text field, typed into the form's input",
		width: 80,
		height: 30,
		render: () => form(Fixtures.SLUG),
	},
	{
		name: "permission",
		about: "a permission ask in the open copilot pane",
		width: 80,
		height: 30,
		render: () => (
			<OnBoard
				focus="copilot"
				pane={
					<Pane
						focused
						copilot={Fixtures.copilot({
							turn: "running",
							actor: CLAUDE,
							asks: [Fixtures.PERMISSION],
						})}
					/>
				}
			/>
		),
	},
	{
		name: "plan",
		about: "a turn part way through its plan, in the open pane",
		width: 80,
		height: 24,
		render: () => (
			<OnBoard
				focus="copilot"
				pane={
					<Pane
						focused
						log={planLog()}
						copilot={Fixtures.copilot({
							turn: "running",
							actor: CLAUDE,
							hasLog: true,
						})}
					/>
				}
			/>
		),
	},
	{
		name: "banner-waiting",
		about: "a session's question on a card's tab, one more behind it",
		width: 80,
		height: 8,
		render: () => {
			const card = Fixtures.loop(1);
			return (
				<CardTabQuestion
					tabs={{
						...BoardTabs.NONE,
						open: [card.id],
						active: card.id,
						cards: new Map([[card.id, { label: card.label, finished: false }]]),
						queue: [question, Fixtures.question(3, ["Yes", "No"])],
					}}
					onAnswer={() => {}}
				/>
			);
		},
	},
	{
		name: "question-open",
		about:
			"an agent's decision on its issue's detail: a single choice, one recommended",
		width: 80,
		height: 30,
		render: () =>
			onDetail(
				[STORE_DECISION, CHECKS_DECISION],
				asking(STORE_DECISION, {}, 1),
			),
	},
	{
		name: "question-multi",
		about: "a multi-select decision with an Other box behind it, two toggled",
		width: 80,
		height: 30,
		render: () =>
			onDetail([CHECKS_DECISION], asking(CHECKS_DECISION, { picked: [0, 2] })),
	},
	{
		name: "question-answered",
		about:
			"the decisions made, read in the description as the brief reads them",
		width: 80,
		height: 16,
		render: () =>
			onDetail([
				{
					...STORE_DECISION,
					status: "answered",
					answer: "SQLite",
					answeredBy: "kabane://actor/human/david",
					reasoning: "the hub syncs it anyway",
				},
				{
					...CHECKS_DECISION,
					status: "answered",
					answer: "Lint, Tests",
					answeredBy: "kabane://actor/human/david",
				},
			]),
	},
	{
		name: "board-decisions-filter",
		about: "`u` on: only the issues with an open decision, each with its count",
		width: 80,
		height: 14,
		render: () => (
			<Board
				sections={SECTIONS}
				expanded={new Set()}
				selectedId="n1"
				scopeLabel="acme/widget"
				decisions={{
					...BoardDecisions.NONE,
					only: true,
					counts: new Map([
						["n1a", 1],
						["n2", 2],
					]),
				}}
				keys={{
					context: "board",
					situation: { selection: true, decisions: true, clearable: true },
				}}
				pane={<Pane copilot={Fixtures.copilot({ actor: CLAUDE })} />}
			/>
		),
	},
	{
		name: "board-checklist",
		about:
			"checklist progress on the cards, `2/4` under way and `3/3` complete",
		width: 80,
		height: 20,
		render: () => (
			<Board
				sections={SECTIONS}
				expanded={new Set(["n1"])}
				selectedId="n1"
				scopeLabel="acme/widget"
				progress={PROGRESS}
				decisions={{ ...BoardDecisions.NONE, counts: new Map([["n2", 1]]) }}
				pane={<Pane copilot={Fixtures.copilot({ actor: CLAUDE })} />}
			/>
		),
	},
	{
		name: "board-badge-narrow",
		about:
			"a paused run's badge cut with … at forty columns, the title at its floor",
		width: 40,
		height: 8,
		render: () => {
			const probe = task({
				id: "b1",
				shortId: "JREP-1",
				title: "Probe the badge at forty columns",
			});
			return (
				<Board
					sections={[section("next", [{ task: probe, children: [] }])]}
					expanded={new Set()}
					selectedId={null}
					activity={BoardActivity.indexCards([Fixtures.waitingRun(probe)])}
				/>
			);
		},
	},
	{
		name: "detail-checklist",
		about:
			"an issue that opens on now: its checklist, the cursor on the first open item",
		width: 80,
		height: 24,
		render: () => (
			<Detail
				taskId={STEPWISE.id}
				task={STEPWISE}
				records={ok(Fixtures.records(STEPWISE, { checklist: STEPS }))}
				scrollRef={createRef<ScrollBoxRenderable>()}
				checklist={BoardChecklist.view(STEPS)}
				keys={{ context: "detail", situation: { checklist: true } }}
			/>
		),
	},
	{
		name: "detail-handoff",
		about:
			"the latest handoff under the checklist as a digest, one earlier counted",
		width: 40,
		height: 40,
		render: () => (
			<Detail
				taskId={STEPWISE.id}
				task={STEPWISE}
				records={ok(
					Fixtures.records(STEPWISE, {
						entries: [
							Fixtures.entry(
								STEPWISE,
								0,
								"handoff",
								CLAUDE,
								"The sessions table and its migration.",
							),
							...TIMELINE,
						],
						kinds: [...Fixtures.KINDS],
						checklist: STEPS,
					}),
				)}
				scrollRef={createRef<ScrollBoxRenderable>()}
				checklist={BoardChecklist.view(STEPS)}
				keys={{ context: "detail", situation: { checklist: true } }}
			/>
		),
	},
	{
		name: "detail-now",
		about:
			"a wave's parent on now: its checklist, its real handoff as a digest, a decision made, five subtasks",
		width: 40,
		height: 40,
		render: () => (
			<Detail
				taskId={WAVE.id}
				task={WAVE}
				records={ok(WAVE_RECORDS)}
				scrollRef={createRef<ScrollBoxRenderable>()}
				checklist={WAVE_CHECKLIST}
				keys={{ context: "detail", situation: { checklist: true } }}
			/>
		),
	},
	{
		name: "detail-trail",
		about:
			"where an issue sits, one row under its summary: its parent, a blocker in progress in the accent, what it blocks counted",
		width: 40,
		height: 16,
		render: () => (
			<Detail
				taskId={SITTING.id}
				task={SITTING}
				tab="description"
				records={ok(TRAIL_ONLY)}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>
		),
	},
	{
		name: "detail-run-waiting",
		about:
			"a recipe run on its issue, waiting on the human: paused, its inputs, machine and attach command",
		width: 80,
		height: 12,
		render: () => (
			<Detail
				taskId={SITTING.id}
				task={SITTING}
				tab="description"
				records={ok(TRAIL_ONLY)}
				cards={[Fixtures.waitingRun(SITTING)]}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>
		),
	},
	{
		name: "detail-run-silent",
		about:
			"a recipe run whose harness reports no status: no spinner and no pause, `no status reported`",
		width: 80,
		height: 12,
		render: () => (
			<Detail
				taskId={SITTING.id}
				task={SITTING}
				tab="description"
				records={ok(TRAIL_ONLY)}
				cards={[Fixtures.silentRun(SITTING)]}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>
		),
	},
	{
		name: "detail-run-stop",
		about:
			"the same run at forty columns: it has no tab, so its issue's footer offers X to stop it",
		width: 40,
		height: 12,
		render: () => (
			<Detail
				taskId={SITTING.id}
				task={SITTING}
				tab="description"
				records={ok(TRAIL_ONLY)}
				cards={[Fixtures.waitingRun(SITTING)]}
				keys={{ context: "detail", situation: { cardStop: "research" } }}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>
		),
	},
	{
		name: "detail-links",
		about:
			"every link on now, grouped by how it relates, the cursor on an issue it blocks: enter opens it",
		width: 40,
		height: 34,
		render: () => (
			<Detail
				taskId={SITTING.id}
				task={SITTING}
				records={ok(TRAIL_RECORDS)}
				scrollRef={createRef<ScrollBoxRenderable>()}
				checklist={BoardChecklist.view(
					[],
					`link:blocks:${FIRST.id}`,
					undefined,
					DetailModel.openable(TRAIL_RECORDS),
				)}
				keys={{
					context: "detail",
					situation: { cursor: true, openable: true },
				}}
			/>
		),
	},
	{
		name: "detail-description",
		about: "the same issue's description tab: the ask and its curated context",
		width: 40,
		height: 24,
		render: () => (
			<Detail
				taskId={WAVE.id}
				task={WAVE}
				tab="description"
				records={ok(WAVE_RECORDS)}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>
		),
	},
	{
		name: "detail-markdown",
		about:
			"a description with every markdown block: a code block and a quote on raised, a rule as a blank line, a table as columns",
		width: 40,
		height: 40,
		render: () => (
			<Detail
				taskId={MARKDOWN.id}
				task={MARKDOWN}
				tab="description"
				records={ok(MARKDOWN_RECORDS)}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>
		),
	},
	{
		name: "detail-markdown-nested",
		about:
			"a quote and a rule inside a quote, and a quote inside a list item: no bar, no line, one panel",
		width: 40,
		height: 24,
		render: () => (
			<Detail
				taskId={NESTED.id}
				task={NESTED}
				tab="description"
				records={ok(NESTED_RECORDS)}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>
		),
	},
	{
		name: "reader",
		about:
			"`r` over the same issue: its real handoff in full, in the reader over the detail",
		width: 40,
		height: 40,
		render: () => <ReaderOver jumps={0} />,
	},
	{
		name: "reader-heading",
		about: "the reader moved two headings down by `]`, Evidence at its top",
		width: 40,
		height: 40,
		render: () => <ReaderOver jumps={2} />,
	},
	{
		name: "detail-now-fresh",
		about:
			"now while a handoff and a tick that landed are not yet seen: each block's header carries the fresh ✦",
		width: 40,
		height: 40,
		render: () => (
			<Detail
				taskId={WAVE.id}
				task={WAVE}
				records={ok(WAVE_RECORDS)}
				scrollRef={createRef<ScrollBoxRenderable>()}
				checklist={WAVE_CHECKLIST}
				keys={{ context: "detail", situation: { checklist: true } }}
				fresh={{
					blocks: new Set(["checklist", "lifted:handoff"]),
					seen: () => {},
				}}
			/>
		),
	},
	{
		name: "detail-description-fresh",
		about:
			"the description tab while a change on now is not yet seen: the now label carries the fresh ✦",
		width: 40,
		height: 12,
		render: () => (
			<Detail
				taskId={WAVE.id}
				task={WAVE}
				tab="description"
				records={ok(WAVE_RECORDS)}
				scrollRef={createRef<ScrollBoxRenderable>()}
				fresh={{ blocks: new Set(["decisions"]), seen: () => {} }}
			/>
		),
	},
	{
		name: "detail-timeline",
		about:
			"the comments tab: a comment, a handoff, and a review no module declares, each kind named",
		width: 40,
		height: 30,
		render: () => (
			<Detail
				taskId={STEPWISE.id}
				task={STEPWISE}
				tab="comments"
				records={ok(Fixtures.records(STEPWISE, { entries: TIMELINE }))}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>
		),
	},
	{
		name: "detail-handoff-long-author",
		about:
			"a handoff on now whose author's name outruns forty columns: the name is cut, the age kept",
		width: 40,
		height: 24,
		render: () => (
			<Detail
				taskId={STEPWISE.id}
				task={STEPWISE}
				records={ok(
					Fixtures.records(STEPWISE, {
						entries: [LONG_HANDOFF],
						kinds: [...Fixtures.KINDS],
					}),
				)}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>
		),
	},
	{
		name: "detail-timeline-long-author",
		about:
			"the comments tab at forty columns: each band cuts the long name and keeps the kind and the age",
		width: 40,
		height: 16,
		render: () => (
			<Detail
				taskId={STEPWISE.id}
				task={STEPWISE}
				tab="comments"
				records={ok(
					Fixtures.records(STEPWISE, { entries: [LONG_COMMENT, LONG_HANDOFF] }),
				)}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>
		),
	},
	{
		name: "banner-answered",
		about: "the banner over a task once this board answered it",
		width: 80,
		height: 8,
		render: () => (
			<PinnedQuestion
				tabs={BoardTabs.NONE}
				banner={{ question, answer: "Yes" }}
				cards={[]}
				onAnswer={() => {}}
			/>
		),
	},
	...RUN_MAP_STORIES,
	{
		name: "session-log",
		about: "One session's start details and gate in a concurrent run",
		width: 100,
		height: 10,
		render: () => <SessionLog />,
	},
	nowStory(
		"now-two",
		"Two sessions interleave while a tool fold updates in place",
		LIVE,
	),
	nowStory("now-one", "The remaining live session drops its tag", {
		...LIVE,
		liveLanes: [docs],
	}),
	nowStory("now-between", "The run moves between steps", {
		...LIVE,
		liveLanes: [],
	}),
	nowStory(
		"run-trace",
		"The finished steps, landing and pruning",
		TRACE_CARD,
		TRACE_EVENTS,
	),
];

export const storyNamed = (name: string): Story | undefined =>
	STORIES.find((story) => story.name === name);
