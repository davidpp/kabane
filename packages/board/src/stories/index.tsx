/** @jsxImportSource @opentui/react */
// The gallery's stories: a name, the real component over made-up props, and the terminal it opens
// at. No story-authoring layer: a story is the JSX a render test would mount. A copilot surface is
// shown in its place on the board, because its height is the terminal's business (a third of it for
// an ask) and reads wrong on its own.
import { ok } from "@cabane/core";
import type { QuestionView } from "@cabane/questions";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { createRef, type ReactNode } from "react";
import { Board } from "../board";
import { BoardChecklist } from "../checklist";
import { CopilotLog } from "../copilot-log";
import { CopilotPane, type CopilotPaneProps } from "../copilot-prompt";
import { DecisionForm } from "../decision-form";
import { DecisionPanel } from "../decision-panel";
import { BoardDecisions } from "../decisions";
import { Detail } from "../detail";
import { ElicitationForm } from "../elicitation-form";
import type { BoardNav } from "../nav";
import type { CopilotElicitation } from "../ports";
import { SettingsOverlay } from "../settings-overlay";
import { SettingsView } from "../settings-view";
import { CardTabQuestion, PinnedQuestion } from "../tab-bar";
import { BoardTabs } from "../tabs";
import { Fixtures } from "./fixtures";

export type Story = {
	name: string;
	/** One line for the list: what state of the component this is. */
	about: string;
	width: number;
	height: number;
	render: () => ReactNode;
};

const CLAUDE = "cabane://actor/agent/claude";
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

// The issue's detail as the app lays it out, the decision on screen under its header.
const onDetail = (
	questions: QuestionView[],
	asked?: BoardDecisions.Shown,
): ReactNode => (
	<Detail
		taskId={WAITING.id}
		task={WAITING}
		records={ok(Fixtures.records(WAITING, { questions }))}
		scrollRef={createRef<ScrollBoxRenderable>()}
		keys={{ context: "detail", situation: { deciding: asked !== undefined } }}
		decision={
			asked ? (
				<DecisionPanel asked={asked} inHand onSubmit={() => {}} />
			) : undefined
		}
	/>
);

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
		"cabane://actor/agent/codex",
		"The migration is idempotent. `write` misses one error path.",
	),
];

// Agents whose actor names are dated model ids, longer than a narrow pane allows: a plain comment,
// then a handoff.
const LONG_COMMENT = Fixtures.entry(
	STEPWISE,
	3,
	"comment",
	"cabane://actor/agent/claude-sonnet-4-5-20250929-preview",
	"Starting on the read path.",
);
const LONG_HANDOFF = Fixtures.entry(
	STEPWISE,
	4,
	"handoff",
	"cabane://actor/agent/claude-sonnet-4-20250514",
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
				answeredBy: "cabane://actor/human/david",
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
const WAVE_CHECKLIST = BoardChecklist.view(WAVE_RECORDS.checklist);

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

export const STORIES: readonly Story[] = [
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
						cards: new Map([
							[card.id, { finished: false, sessionIds: ["s1"] }],
						]),
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
					answeredBy: "cabane://actor/human/david",
					reasoning: "the hub syncs it anyway",
				},
				{
					...CHECKS_DECISION,
					status: "answered",
					answer: "Lint, Tests",
					answeredBy: "cabane://actor/human/david",
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
];

export const storyNamed = (name: string): Story | undefined =>
	STORIES.find((story) => story.name === name);
