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
import { CopilotLog } from "../copilot-log";
import { CopilotPane, type CopilotPaneProps } from "../copilot-prompt";
import { DecisionForm } from "../decision-form";
import { DecisionPanel } from "../decision-panel";
import { BoardDecisions } from "../decisions";
import { Detail } from "../detail";
import { ElicitationForm } from "../elicitation-form";
import type { BoardNav } from "../nav";
import type { CopilotElicitation } from "../ports";
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
