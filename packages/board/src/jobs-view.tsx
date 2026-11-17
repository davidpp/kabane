/** @jsxImportSource @opentui/react */
// The Jobs tab: every open job on this device in one bay per scope, a strip each, and the panel a
// job's detail shows under its header (schedule, recipe, harness, folder, runs). A strip leads with
// its newest run's state, so a run waiting on the human stands out from any distance: `?` and
// `? waiting` in the accent, the one hue that means a human is needed. A run is never shown here:
// its row carries the command that opens it in a terminal.
import type { JobFacts, JobRunState } from "@cabane/extension";
import { TextAttributes } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { rowStyle } from "./board";
import { noticeFg, StatusBar } from "./footer";
import { BoardJobs } from "./jobs";
import { Keymap } from "./keymap";
import type { BoardNav } from "./nav";
import { type Theme, useTheme } from "./theme";

// Columns held back for the scrollbar and a margin, as the tracker's rows do, so a strip never wraps.
const RESERVED_COLS = 2;
// The title keeps this many columns before the meta takes any.
const TITLE_FLOOR = 12;

/** The time "in 3h" is read against, moved on every half minute. */
const useClock = (): number => {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);
	return now;
};

const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/** A run state's glyph and hue: the strip notation's, `?` in the accent for a run that waits. */
const runGlyph = (
	state: JobRunState | undefined,
	described: boolean,
	theme: Theme.Tokens,
): { text: string; fg: string } => {
	switch (state) {
		case "waiting":
			return { text: "?", fg: theme.accent };
		case "running":
			return { text: "●", fg: theme.working };
		case "live":
			return { text: "●", fg: theme.muted };
		case "idle":
			return { text: "•", fg: theme.done };
		case "ended":
			return { text: "✓", fg: theme.done };
		case undefined:
			// Never run, or no source to say: a pending ring only when a source described it.
			return { text: described ? "○" : " ", fg: theme.muted };
	}
};

const JobRow = ({
	job,
	selected,
	available,
	now,
	onSelect,
}: {
	job: BoardJobs.Job;
	selected: boolean;
	available: number;
	now: number;
	onSelect?: (id: string) => void;
}): ReactNode => {
	const theme = useTheme();
	const { task } = job;
	const paused = BoardJobs.paused(task);
	const style = rowStyle(selected, theme.secondary, theme);
	const glyph = runGlyph(
		BoardJobs.lastRun(job),
		job.facts !== undefined,
		theme,
	);
	const shortId = task.shortId ?? task.id.slice(0, 8);
	const fixed = 2 + shortId.length + 2;
	const parts = BoardJobs.fitMeta(
		BoardJobs.meta(job, now),
		available - fixed - Math.min(task.title.length, TITLE_FLOOR),
	);
	const metaWidth = parts.reduce((sum, part) => sum + part.length + 3, 0);
	const title = truncate(
		task.title,
		Math.max(4, available - fixed - metaWidth),
	);
	return (
		<box
			id={`job-${task.id}`}
			onMouseDown={onSelect ? () => onSelect(task.id) : undefined}
			style={{ flexDirection: "row", flexShrink: 0, backgroundColor: style.bg }}
		>
			<text bg={style.bg} fg={style.titleFg} wrapMode="none">
				<span fg={selected ? style.titleFg : glyph.fg}>{glyph.text}</span>{" "}
				<span fg={style.idFg}>{shortId}</span>
				{"  "}
				<span fg={paused && !selected ? theme.muted : style.titleFg}>
					{title}
				</span>
				{parts.map((part) => (
					<span
						key={part}
						fg={part === "? waiting" && !selected ? theme.accent : style.metaFg}
						attributes={part === "? waiting" ? TextAttributes.BOLD : 0}
					>
						{` · ${part}`}
					</span>
				))}
			</text>
		</box>
	);
};

export type JobsViewProps = {
	jobs: BoardJobs.Jobs;
	scrollRef?: RefObject<ScrollBoxRenderable | null>;
	notice?: BoardNav.Notice | null;
	keys?: Keymap.Live;
	pane?: ReactNode;
	onSelect?: (id: string) => void;
	// Milliseconds, for how far off each next fire is. Absent → Date.now().
	now?: number;
};

/** The tab's header: what it is, how many jobs, and how many runs wait on the human. */
const JobsHeader = ({ jobs }: { jobs: BoardJobs.Jobs }): ReactNode => {
	const theme = useTheme();
	const waiting = BoardJobs.waitingCount(jobs);
	return (
		<text fg={theme.defaultFg} style={{ flexShrink: 0 }}>
			<span attributes={TextAttributes.BOLD}>kabane · jobs</span>
			<span fg={theme.muted}>{` · ${jobs.list.length}`}</span>
			{waiting > 0 ? (
				<span fg={theme.accent}>{` · ${waiting} waiting`}</span>
			) : null}
		</text>
	);
};

export const JobsView = ({
	jobs,
	scrollRef,
	notice,
	keys,
	pane,
	onSelect,
	now,
}: JobsViewProps): ReactNode => {
	const theme = useTheme();
	const clock = useClock();
	const { width } = useTerminalDimensions();
	const available = width - RESERVED_COLS;
	const live: Keymap.Live = keys ?? {
		context: "jobs",
		situation: { selection: jobs.selectedId !== null },
	};
	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<JobsHeader jobs={jobs} />
			<scrollbox ref={scrollRef} style={{ flexGrow: 1, marginTop: 1 }}>
				{jobs.list.length === 0 ? (
					<text fg={theme.muted}>no jobs</text>
				) : (
					BoardJobs.byScope(jobs.list).map((group) => (
						<box
							key={group.jobs[0]?.task.id ?? group.scope}
							style={{
								flexDirection: "column",
								flexShrink: 0,
								marginBottom: 1,
							}}
						>
							<text>
								<span fg={theme.defaultFg} attributes={TextAttributes.BOLD}>
									{group.scope}
								</span>
								<span fg={theme.muted}>{` · ${group.jobs.length}`}</span>
							</text>
							{group.jobs.map((job) => (
								<JobRow
									key={job.task.id}
									job={job}
									selected={job.task.id === jobs.selectedId}
									available={available}
									now={now ?? clock}
									onSelect={onSelect}
								/>
							))}
						</box>
					))
				)}
			</scrollbox>
			{pane}
			{notice ? (
				<StatusBar
					text={notice.undoable ? `${notice.text} · ⌃z undo` : notice.text}
					fg={noticeFg(notice.tone, theme)}
				/>
			) : (
				<StatusBar hints={Keymap.footer(live.context, live.situation)} />
			)}
		</box>
	);
};

// A label column wide enough for the longest label, so the values line up.
const LABEL = 9;

const Line = ({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}): ReactNode => {
	const theme = useTheme();
	// Two cells, so a long value (a folder) wraps under itself rather than under its label.
	return (
		<box style={{ flexDirection: "row", flexShrink: 0 }}>
			<text fg={theme.muted} style={{ flexShrink: 0 }}>
				{label.padEnd(LABEL)}
			</text>
			<text fg={theme.defaultFg} style={{ flexShrink: 1 }}>
				{children}
			</text>
		</box>
	);
};

const inputsLine = (inputs: JobFacts["inputs"]): string => {
	const pairs = Object.entries(inputs).map(
		([name, value]) =>
			`${name}=${typeof value === "string" ? value : JSON.stringify(value)}`,
	);
	return pairs.length > 0 ? pairs.join(" ") : "none";
};

/**
 * What a job's detail shows under its header that an issue has no equivalent of: when it fires,
 * what it starts and where, and its newest runs, each with the command that opens it in a terminal.
 * Nothing when no source describes the job.
 */
export const JobPanel = ({
	facts,
	paused,
	now,
}: {
	facts: JobFacts | undefined;
	paused: boolean;
	now?: number;
}): ReactNode => {
	const theme = useTheme();
	const { width } = useTerminalDimensions();
	const clock = useClock();
	if (!facts) return null;
	const at = now ?? clock;
	const next = paused
		? "paused"
		: facts.next
			? `${BoardJobs.whenLabel(facts.next)} · ${BoardJobs.untilLabel(facts.next, at)}`
			: (facts.problem ?? "never fires");
	// A run is one line where its command fits beside it, else the command goes under it.
	const runWidth = (open: string): number => 3 + 9 + 13 + open.length;
	return (
		<box
			style={{
				flexDirection: "column",
				flexShrink: 0,
				marginTop: 1,
				paddingLeft: 1,
			}}
		>
			<Line label="schedule">{facts.schedule}</Line>
			<Line label="next">
				<span fg={paused ? theme.muted : theme.defaultFg}>{next}</span>
			</Line>
			<Line label="recipe">{facts.recipe}</Line>
			<Line label="inputs">{inputsLine(facts.inputs)}</Line>
			<Line label="harness">
				{facts.harness ? (
					facts.harness.join(" ")
				) : (
					<span fg={theme.muted}>the configured default</span>
				)}
			</Line>
			<Line label="session">
				{facts.session === "keep"
					? "keep · wakes the idle one"
					: "fresh · a new one each fire"}
			</Line>
			<Line label="folder">
				{facts.folder ?? (
					<span fg={theme.muted}>
						none on this machine · run kabane job list in it
					</span>
				)}
			</Line>
			<Line label="runs">
				{facts.runs.length === 0 ? (
					<span fg={theme.muted}>none yet</span>
				) : null}
			</Line>
			{facts.runs.map((run) => {
				const glyph = runGlyph(run.state, true, theme);
				const oneLine = runWidth(run.open) <= width - 2;
				return (
					<box
						key={run.id}
						style={{
							flexDirection: oneLine ? "row" : "column",
							flexShrink: 0,
							paddingLeft: 2,
						}}
					>
						<text fg={theme.defaultFg} style={{ flexShrink: 0 }}>
							<span fg={glyph.fg}>{glyph.text}</span>
							<span
								fg={run.state === "waiting" ? theme.accent : theme.defaultFg}
							>{` ${run.state.padEnd(8)}`}</span>
							<span fg={theme.muted}>{BoardJobs.whenLabel(run.startedAt)}</span>
						</text>
						{/* The command to copy, which wraps under itself in a narrow pane. */}
						<text fg={theme.defaultFg} style={{ marginLeft: 2, flexShrink: 1 }}>
							{run.open}
						</text>
					</box>
				);
			})}
		</box>
	);
};
