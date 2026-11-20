# The loop tab is a transcript, and the job needs a run cockpit

Design review, 2026-11-20, for JCAB-615. This note critiques the board's loop tab as a whole and
proposes three new designs for it, one recommended. Nothing here is built. How it was made is at
the end.

The run studied here comes from a private project, so its content is elided. Its issue ids read
`PROJ-n`. Its issue title, findings, agent messages, thoughts, shell commands, paths and commit
ids are placeholders in `‹ ›` that keep their shape. Counts, timings, step and session names,
glyphs and kabane's own text are as the run recorded them.

## Decided with the maintainer

A first draft of this note proposed small changes inside today's layout and asked three
questions. The maintainer's answers, 2026-11-20:

- **What the tab shows by default.** None of the offered options fit: "well with concurrency
  there can be more than one live still though", then "Mix, think copilot cockpit, default is
  overview of where we are in the full map, a few lines of what is happening, ability to jump in
  a specific session for details, etc".
- **Tool calls in a session's log fold** into one row per run of calls, as recommended.
- **A wide terminal splits** from about 160 columns, steps and map on the left and the log on the
  right, overruling the draft's recommendation to stay stacked.
- **The scope:** "it's more than just being narrow on smaller screens and all, it's a
  revamp/critique that is needed. I'm expecting a new design, not just small improvements.
  columns / usage of the space can be reviewed, etc. not trying to keep the UI exactly as is."

The maintainer's terminal is about 200×50. This note designs for that size first and keeps 40
columns working as a fallback, which reverses the board's usual order (see "Rules this changes").

Terms, as the code names them today. A run's **sessions** are its claims, one harness session
each, and the board calls each one a **lane**. The **strip** is the header's second row, the run's
steps joined by `›`. The **chips** are the row of lane names under the header, one per session plus
`all agents · live`. On the all-lanes stream each line starts with its lane's name, the **tag**, in
one of six **series hues**. herdr is the terminal multiplexer the board usually sits in. `PROJ-41` is a subtask filed during the run, which an implementing session took after the fixer.
DESIGN.md's rules named below: the Selection Rule paints the row under the cursor on the
selected surface; the raised surface is the first painted step above the terminal's background,
used for docked panels; the No-Line Rule forbids box-drawing borders. `loop.land` is the run's
landing setting; `none` keeps the branch for review.

## Three findings

1. **The tab is built around the event stream, the least processed thing a run produces.** Its
   largest region is a transcript of 1335 events, and the run's own structure is squeezed into
   two clipped header rows: steps, sessions, findings, what needs the human. PROJ-5's run has
   seven steps, ten sessions and six findings left open. None of those is an object on the
   screen that the human can point at.
2. **"Which step, what is happening, what needs me" each take work to answer.** The step sits on
   the header's second row and clips silently: at 40 columns it ends `◐ gates ru`. What is
   happening means reading ten sessions interleaved behind 36-column tags. A question names the
   harness, not the session that asked. A finished run's six open findings are named nowhere.
3. **Past and live look the same.** Every session the run ever had keeps a chip and a tag, told
   apart by six hues cycling over ten lanes. `▸ all agents · live` still reads `live` on a run
   that finished 47 minutes in.

The recommended design is a cockpit. A map of the run's steps, with the live one opened to its
sessions, is the anchor. Beside it on a wide terminal, or under it on a narrow one, a few lines
interleave what the live sessions are doing now. What needs the human has a region of its own.
A cursor on the map opens any session's full log.

## The job the tab does

`docs/loop.md` says a run's tab "says what the run is doing: working its subtasks, then, once they
are done, its closing gates, each lens's review, the fixer, the rechecks and the landing". The
board's role for agent work, as the maintainer set it, is to manage jobs and past-session logs
and to reopen a live session through a command. Live terminal UI belongs to herdr or a similar
app, and kabane never renders a harness's screen. A session's log is the record the runner keeps
(`events.jsonl`), so showing it is the board's job; drawing the harness's own terminal is not.

The tab answers four questions, and the design follows from them:

- **Where is the run in the whole map?** Seven steps, the live one, how far through it, what
  comes next. From three feet away, as `PRODUCT.md` puts it for the board as a whole.
- **What is happening right now?** Usually one session is live: in PROJ-5 the fixer ran alone for
  27 of the 47 minutes. With concurrency, more than one can be: two were live together for about
  10 minutes (the two reviews, then the rechecks in pairs). The answer is a few lines across the
  live sessions, in the order they happened, not every session's transcript.
- **What needs me?** A question a session is blocked on (in practice, a harness permission), and
  once the run ends, what it left: PROJ-5 left six findings, three reopened and three new, and a
  branch that `loop.land none` keeps for review.
- **What did this one session do?** Why the fixer took 27 minutes, or what a lens checked. This is
  the drill-down: one key from the cursor, and one key back.

## What a run emits

The run in the maintainer's screenshot (completed, 1335 events) is not the run id JCAB-615's
description names. That one is the first attempt (`stopped`, `gates-red`, 1183 events). The
screenshot's run restarted in its worktree 42 seconds later and ran the review half. It matches the screenshot: 10 sessions,
`completed · 46m52s`, `plan-done (6 findings left open for a human)`, 1335 events.

| Session | Harness, model | Ran | What it ended with |
|---|---|---|---|
| `triage` | codex `gpt-6.1-terra` | 08:36:18, 14s | two review groups, none skipped |
| `functional+quality+architecture-lens` | codex `gpt-6.2-astra` | 08:36:32, 5m58s | "Filed 14 findings under PROJ-5 — 8 p1, 5 p2, and 1 p3." |
| `docs+design-lens` | codex `gpt-6.2-sol` | 08:36:32, 7m9s | "Filed 4 p1, 3 p2, and 0 p3 findings." |
| `fixer` | claude `opus` | 08:43:41, 26m58s | "settled all 21 findings", $16.17 |
| `PROJ-41` | claude `opus` | 09:10:20, 2m2s | merged at `‹commit sha›`, $1.32 |
| `functional-recheck` | codex `gpt-6.2-sol` | 09:12:28, 3m11s | "4 findings confirmed, 1 reopened (PROJ-22), 0 filed." |
| `quality-recheck` | codex `gpt-6.2-sol` | 09:12:28, 2m5s | "5 findings confirmed, 1 reopened (PROJ-27), 0 filed." |
| `docs-recheck` | codex `gpt-6.2-sol` | 09:15:39, 3m13s | "4 findings confirmed, 1 reopened (PROJ-38), and 1 filed (PROJ-43)." |
| `architecture-recheck` | codex `gpt-6.2-sol` | 09:15:39, 1m25s | "3 findings confirmed, 0 reopened, 1 filed (PROJ-42)" |
| `design-recheck` | codex `gpt-6.2-sol` | 09:18:52, 4m11s | "2 findings confirmed, 0 reopened, 1 filed (PROJ-44)." |

The six left open are PROJ-22, PROJ-27 and PROJ-38 (reopened) and PROJ-42, PROJ-43 and PROJ-44
(filed by a recheck).

By type, the 1335 events split into three layers:

| Layer | Events | Types |
|---|---|---|
| The run's own spine | 86 | `claim`, `launch`, `model`, `mode`, `session_start`, `prompt`, `session_end` (10 each), `gates`, `gate_passed`, `checkpoint` (3 each), `review` (2), `workspace`, `run_start`, `merged`, `run_end`, `pruned` |
| What the agents said | 134 | `text` 64, `thought` 70 |
| Tool calls | 1115 | `tool_call` 566, `tool_completed` 501, `tool_failed` 48 |

The fixer alone wrote 480 of the 1335 events. The most frequent tool titles are `Terminal`
(140), `Guardian Review` (79, a title codex gives some of its calls), and `mcp.kabane-session.kabane_context` (66). The spine is 6%
of the stream and holds nearly everything the tab's four questions (below) need. The board draws it as glyphless
muted rows, at the same weight as the tool calls around it.

## What the tab looks like today

Frames are `tmux capture-pane` from the real board in `bun run sandbox`, so colour is lost. The
PROJ-5 frames are that run's `run.json` and `events.jsonl`, copied into the sandbox's home. The
sandbox tracker has no PROJ-5, so `LoopHeader.make` gets no plan. The title, `11/11 done`, the
findings count and the recheck step are missing from those frames. In the real board they appear
on the same rows and make the second row longer still. The JGIT frames are live runs on the
scripted agent. Their `kabane_done answered {...}` walls are the scripted agent's own output,
not something a harness writes.

PROJ-5, finished, 200×50, the top seven rows. The chips wrap onto a second row even here:

```text
 1 tracker │ 2 ✓ PROJ-5
 PROJ-5     ✓ plan done
 ✓ implement ×1 session  ›  ✓ gates check·test·build · 1 checkpoint  ›  ✓ lenses functional·quality·docs·architecture·design  ›  ✓ fixer   0/2 slots · claude balanced
 context ▰▰▰▰▱▱▱▱▱▱ 40%   continuations ▱▱▱▱▱▱▱▱▱▱ 0/3
 ▸ all agents · live    triage    functional+quality+architecture-lens    docs+design-lens    fixer    PROJ-41    functional-recheck    quality-recheck    docs-recheck    architecture-recheck
   design-recheck

```

PROJ-5, finished, 40×30. The chips take seven rows, and the stream gets ten:

```text
 1 tracker │ 2 ✓ PROJ-5
 PROJ-5     ✓ plan done
 ✓ implement ×1 session  ›  ✓ gates che
 context ▰▰▰▰▱▱▱▱▱▱ 40%   continuations
 ▸ all agents · live    triage
   functional+quality+architecture-lens
   docs+design-lens    fixer    PROJ-41
   functional-recheck
   quality-recheck    docs-recheck
   architecture-recheck
   design-recheck

design-re… ✓ Guardian Review · 2.4s
design-re…   2 findings confirmed, 0
             reopened, 1 filed (PROJ-
             44).
design-re…   done: the design lens
             finished its recheck
  completed: plan-done (6 findings left
  open for a human)
  worktree ~/.kabane/
  loops/‹first run id›/worktree and
  branch ‹branch name, 2 rows›
  ‹…› removed: branch ‹branch
  name, 2 rows›
  ‹…› is merged into HEAD

completed · 46m52s                     ▄
▸ tab to ask the copilot
o its issue · w close tab · ? help
```

PROJ-5, finished, 100×30. The strip loses `docs·architecture·design` and the fixer with no `…`:

```text
 1 tracker │ 2 ✓ PROJ-5
 PROJ-5     ✓ plan done
 ✓ implement ×1 session  ›  ✓ gates check·test·build · 1 checkpoint  ›  ✓ lenses functional·quality
 context ▰▰▰▰▱▱▱▱▱▱ 40%   continuations ▱▱▱▱▱▱▱▱▱▱ 0/3
 ▸ all agents · live    triage    functional+quality+architecture-lens    docs+design-lens    fixer
   PROJ-41    functional-recheck    quality-recheck    docs-recheck    architecture-recheck
   design-recheck

                            ‹agent message, last line›
design-recheck            ✓ ‹shell command› · 3.9s
design-recheck            ✓ Guardian Review · 3.1s
design-recheck

                            **‹thought heading›**
design-recheck            ✓ Guardian Review · 2.3s
design-recheck            ✓ Guardian Review · 3.0s
design-recheck            ✓ ‹shell command, cut to the row› · 2.8s
design-recheck            ✓ Guardian Review · 2.6s
design-recheck            ✓ mcp.kabane-session.kabane_comment · 2.4s
design-recheck            ✓ Guardian Review · 2.4s
design-recheck              2 findings confirmed, 0 reopened, 1 filed (PROJ-44).
design-recheck              done: the design lens finished its recheck
  completed: plan-done (6 findings left open for a human)
```

The `design-recheck` rows with nothing after them come from thoughts. Codex's thought summaries
start with `\n\n` (`'\n\n**‹thought heading›**'` in `events.jsonl`), so the tag lands on one row
and the text two rows below it, with its `**` showing, because `EventRow` draws a thought as
plain text and only `text` as markdown.

The top of the same stream at 200 columns shows how each session opens: five muted rows with no
glyph (`claim`, `launch`, `model`, `mode`, `session_start`), then the prompt block, then the
triage's JSON answer verbatim:

```text
triage                                 codex at tier fast triages the review of PROJ-5: 74 files and 3345 lines changed, through the functional, quality, docs, architecture and design lenses
triage                                 npx -y @agentclientprotocol/codex-acp@2.5.0 · CODEX_PATH=/opt/homebrew/bin/codex
triage                                 gpt-6.1-terra
triage                                 mode agent: codex's auto mode
triage                                 codex triages the review of PROJ-5
```

A live run (JGIT-1, scripted), 40×30, while the closing gates run. The step is in the first
row this time, and cut: `● closing gates fo`. The second row repeats it, cut further. The footer
has dropped `x stop`:

```text
 1 tracker │ 2 ✓ PROJ-5 │ 3 ⠧ JGIT-1
 JGIT-1   3/3 done   ● closing gates fo
 ○ implement ×3 sessions  ›  ◐ gates ru
 context ▱▱▱▱▱▱▱▱▱▱ 0%   continuations
 ▸ all agents · live    JGIT-2
   JGIT-3    JGIT-4
 …
p pause · s skip · n next · ? help
```

A live run (JGIT-5) at 200 columns, after both subtasks' sessions committed and while each one's
gates run. The first row says `● running` in the done hue (`header.ts` gives it
`tone: "done"`). The second row shows implement working and gates running at once:

```text
 JGIT-5  revise a brief across agents   2/2 done   ● running
 ● implement ×2 sessions  ›  ◐ gates running for JGIT-6, JGIT-7  ›  ○ lenses functional·quality   2/2 slots · claude
 context ▱▱▱▱▱▱▱▱▱▱ 0%   continuations ▱▱▱▱▱▱▱▱▱▱ 0/3
 ▸ all agents · live    JGIT-6    JGIT-7
```

`e` is the closest thing the tab has to the answer. It lists each session with its outcome:

```text
 sessions  0/2 slots in use
  triage                                done · triage answered
  functional+quality+architecture-lens  done · the functional, quality and architecture lenses finished their review
  docs+design-lens                      done · the docs and design lenses finished their review
  fixer                                 done · settled all 21 findings
  PROJ-41                               done · PROJ-41 is done
  functional-recheck                    done · the functional lens finished its recheck
```

On the JGIT-5 run (two lanes, so one row of chips), `e` at 40 columns puts twelve rows above the
stream, which keeps fourteen.

A scripted run whose triage skipped `quality` ends on `✓ plan done` with
`○ lenses functional·quality`. `lensStep` asks `Lenses.status` about every configured lens, and a
lens triage skipped has no claim, so it reads as pending forever. `docs/loop.md` says a skipped
lens "counts as reviewed".

The question banner (gallery `banner-waiting`, 40 columns) names the harness and the parent
issue, not the session:

```text
 waiting on you · claude asks about
 JREP-2 · +1 more
 ? Install dependencies 2?
 1 Yes · 2 No
```

On a loop run, every review session asks "about PROJ-5", so the banner does not say which of
the seven review sessions asked.

## Critique: the tab's model of a run

### The tab is the copilot's transcript with lanes added

The loop tab is `EventView`, the component that draws the board copilot's transcript, given a
host header and a lane strip (`packages/board/src/event-view.tsx`). A copilot turn is one
conversation, so a transcript is its natural form. A run is a different object: a pipeline of
steps, sessions running in parallel inside a step, gates between steps, findings that come out of
reviews, questions that block a session, and a branch that lands or waits. The tab has no region
for any of these. They reach the screen as strings: the header's strip
(`✓ gates check·test·build · 1 checkpoint`), a count in a meter row, a chip per session, a plain
line at the bottom of the stream.

The region with the most rows (the stream: about 20 of 30 rows at 100
columns, about 40 of 50 at 200) holds the rawest data, 566 tool calls among 1335 events. The facts the
human came for share two header rows, which `CardHeader` draws with `wrapMode="none"` and so clips
without saying so. At 200 columns the strip fits; at 100 it drops the fixer; at 40 it ends
`✓ gates che`.

The tab presents a run as a log with several speakers. A run is a pipeline with live sessions in
it.

### The four questions, answered today

- **Where is the run?** Row 1 says `● running` during implement and `● closing gates for JGIT-1`
  while closing, so where the run is depends on which step it is in. Row 2 has the steps, as a
  strip that can show implement working and gates running at once
  (`● implement ×2 sessions  ›  ◐ gates running for JGIT-6, JGIT-7`). Finished implement turns
  back to `○`, the pending glyph.
- **What is happening now?** The default view interleaves every session, live and ended, and the
  newest lines are what the last session to write left: on PROJ-5 finished, 25 rows of
  `design-recheck` tool calls, eight of them `✓ Guardian Review`. Each session opens with five
  muted, glyphless rows (`claim`, `launch`, `model`, `mode`, `session_start`), then its whole
  prompt.
- **What needs me?** A question pins a banner that names the harness and the parent
  (`claude asks about PROJ-5`). Every review session asks about the parent, so it does not say
  which one asked. On a finished run nothing does: the tab bar and row 1 are a green `✓`, and
  `completed: plan-done (6 findings left open for a human)` is a plain line at the end of the
  stream. The six findings are not listed.
- **What did one session do?** `h/l` walks eleven chips, including `all agents · live`, ten
  session names and no step names. `e` opens a sessions table that is the best debrief on the
  screen (`fixer  done · settled all 21 findings`) but hides behind a key, and at 40 columns its
  lane column (36 cells) pushes every outcome off screen.

### Space at the maintainer's 200×50

At 200 columns the header and chips take five rows and the stream about 40. Prose stops at the 80-column
measure after a 36-column lane tag, so about 80 columns of every message row are empty.

### Scores

The design review behind this section ran in a separate agent that saw the frames and the code
but not this note's findings. Its scores against Nielsen's ten heuristics, kept for comparison
with a later review:

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | The step the run is on is on row 2, clipped at 100 and 40. |
| 2 | Match with the real world | 2 | One state has three names: `✓ plan done`, `completed: plan-done`, `completed · 46m52s`. |
| 3 | User control and freedom | 3 | Pause, stop, skip, next, message, restart, `h/l` and `w` are all there. |
| 4 | Consistency and standards | 2 | `● running` in the done hue; `● implement` in the working hue on the row below. |
| 5 | Error prevention | 3 | `s` and `n` refuse an empty id. |
| 6 | Recognition rather than recall | 2 | At 40 the live footer drops `x stop`, `h/l`, `e` and `o`. |
| 7 | Flexibility and efficiency | 3 | Every action has a key; no key jumps to what needs the human. |
| 8 | Aesthetic and minimalist design | 1 | 566 tool-call rows and every session's launch rows bury the 86 events of the run's own spine. |
| 9 | Recognise and recover from errors | 3 | Each failure state carries its remedy (`· r restarts`), when it is not clipped. |
| 10 | Help and documentation | 2 | Nothing explains `continuations`, `slots` or `checkpoint` in place. |
| | **Total** | **23/40** | **Acceptable** |

What works and should survive any redesign: row 1 gives way in the right order (`headline()`
drops the parent's title before the state); each state names its remedy
(`⏸ paused · 2 sessions finishing · p resumes`, `⏸ waiting on JCAB-64 (someday) · set it to next
or close it`); a stop reads as a muted `⏹`, not a failure; and the `e` sessions table.

### Bugs, whatever the design

- `● running` is drawn in the done hue (`header.ts`, `state()` gives `tone: "done"`).
- A lens that triage skipped reads as pending forever: a scripted run ends `✓ plan done` beside
  `○ lenses functional·quality`, because `lensStep` asks `Lenses.status` about every configured
  lens. `docs/loop.md` says a skipped lens "counts as reviewed".
- `○ implement` once its sessions ended and the run goes on (`steps()` falls through to `○`).
- `◐` is not in DESIGN.md's glyph table.
- Header rows clip with no `…` (`card-header.tsx`, `wrapMode="none"`).
- The meters turn the accent at 80%, though context occupancy is not a request for the human.
- `Theme.seriesOf` cycles six hues, so `triage` and `functional-recheck` share one.
- Codex thoughts start with `\n\n`, so the lane tag sits alone on a row and the text lands two
  rows down with its `**` showing; `EventRow` draws a thought as plain text.
- The `e` table pads its lane column to the widest lane with no cap.
- For a few seconds after a run ends, the tab bar still spins and the footer still offers
  `p pause · s skip · n next`. It settles on the next poll.

## What comparable tools do

### What to show

Each pattern below is from a primary source. Those marked ✓ were fetched again for this note.

- **One list of steps, one selected log.** Turborepo 2.0 built its TUI because "the intermixed
  logs made it difficult to understand what was going on with a specific task"; you "select
  individual tasks using your arrow keys to inspect their logs one at a time" ✓ [1]. Nx 21 says
  the same of its old output, "all the output from any continuous tasks mixed together in one
  giant stream", and replaced it with "a clear list of all project tasks" ✓ [2]. Buildkite opens
  a step's log in a panel beside the build [3].
- **The list is ordered by what needs the human.** Turborepo's PR #8650: "running tasks are first
  in the list, then planned tasks, then done tasks" ✓ [4]. Claude Code's agent view puts
  "`Ready for review` and `Needs input` above `Working` and `Completed`" ✓ [5].
- **Finished work folds; failure and input break out.** Buildkite: "Group steps on the build
  canvas are now collapsed by default", and "Groups containing failed steps or steps waiting for
  user input are automatically expanded" ✓ [6]. GitHub Actions: "Any failed steps are
  automatically expanded to display the results" ✓ [7]. `gh run watch --compact` shows "only
  relevant/failed steps" [17]. Dagger's TUI drops a finished span "after a brief pause" unless
  `-v` "keeps spans visible after they complete" [18]. Claude Code removes a subagent's row
  "immediately" when it finishes successfully and keeps a failed one for 30 seconds ✓ [8].
- **The live view follows the running work.** Turborepo users asked for it:
  "the active elements chosen by default seems random", and the TUI "could follow active tasks"
  ✓ [9]. BuildKit's tty display gives log lines only to steps still running, and lets finished
  steps scroll away first when rows run out [10].
- **The finished summary is its own artifact.** GitHub Actions groups step summaries "into a
  single job summary" on the run page [11]. Buildkite's advice is to "Summarize failures with a
  build annotation so readers don't need to search the full log" [12]. In the same Turborepo
  thread: "after termination it's very hard when there's many tasks" ✓ [9].
- **Repeated work collapses into one counted row.** Temporal's compact view groups concurrent
  events of one type "under a single line with a count" [13]. Codex CLI 0.169: "Group consecutive
  tool calls in the full-screen conversation" [14]. The Claude Code backlash over
  `Read 3 files (ctrl+o to expand)` [15] says the folded row has to keep what identifies the work.
- **On a short or narrow terminal, finished rows go first.** Claude Code's agent view: "On a short
  terminal, the header compacts to a single summary line so sessions that are working or need
  input stay visible", and "Completed sessions that don't fit on screen fold into a `… N more`
  row" ✓ [5].

No primary source was found for k9s, lazygit, Earthly, Prefect, OpenHands, Devin's live step,
herdr or Cursor's background agents. Cursor has a forum request for "a dedicated agent progress
board" because "tool calls, diffs, and code stream by so quickly that it is hard to follow what
is happening" [16], with no staff reply.

### How full-screen tools lay out the same job

The patterns above are about what to show. These are about where it goes on a full screen, and
what each direction below takes from them.

- **A side column of lists beside one main pane, with the split chosen from the measured size.**
  lazygit stacks its panels in a side column a third of the width wide and puts the selected
  item's content in the main pane. Whether the main pane splits side by side is decided in code:
  `if args.Width < 200 && args.Height > 30 { // 2 80 character width panels + 40 width for side
  panel` ✓ [19]. Below a minimum height the side panels squash to one or three rows each and the
  focused one takes the rest ✓ [19]. gh-dash puts the preview of "the selected work item" on the
  right, and moves it to the bottom "when the main content would have fewer than 80 columns"
  [20]. Direction A takes the side column, the selection driving the main pane, and a threshold
  set deliberately from widths that hold an 80-column log.
- **Parallel work collapses under its step and opens on demand.** Buildkite's sidebar "collapses
  parallel jobs into single steps", and keeps steps "Waiting for input" near the top [3]. Its
  waterfall nests "Group, matrix, and parallel steps" as "nested rows underneath a 'parent' row",
  the parent's bar spanning its children ✓ [21]. Temporal's compact view groups concurrent work
  "under a single line with a count" [13]. A's map, with only the live step open, takes this.
- **A clock for the whole run.** Temporal's timeline stacks event groups vertically "with
  clock-time durations as the length of each line", a pending one "dashed and animates forward",
  and states the trade-off: "The Compact view does not take clock time into consideration" [13].
  Buildkite's waterfall splits each bar into waiting, dispatching and running time, but "only
  displays data for finished steps" ✓ [21]. Direction C draws live bars, as Temporal's timeline
  does and Buildkite's waterfall does not.
- **herdr rolls agent state up to its workspace and keeps unseen apart from seen.** Its sidebar state "rolls up from the
  agents inside it, so you can see which project needs attention"; an agent is `blocked` ("needs
  input, approval, or a decision"), `working`, `done` ("finished and you have not looked at it
  yet") or `idle` ("finished or waiting and has been seen") ✓ [22]. The map's step rows roll up
  their sessions the same way; a finished run stays "done, unseen" until its left-for-you list has
  been on screen.
- **Agents as panels or tabs.** Vibe Kanban ("a flexible four-panel layout") [23], Sculptor (a tab
  per agent) [24] and Conductor (a sidebar "organized by status") [25] give each agent a pane of its
  own. Direction B is this family.
- **Show the latest line, not the transcript.** Claude Code's agent view peek shows "the session's
  most recent output, or the question it's waiting on, rather than the full transcript" ✓ [5].
  A's "now" is one row per entry for the same reason.

Turborepo's reason for its TUI ("the intermixed logs made it difficult to understand what was
going on with a specific task") argues against interleaving, and the maintainer asked for "a few
lines of what is happening" across live sessions. The two fit if "now" interleaves only live
sessions, one row per entry, beside one session's whole log. Turborepo's complaint was about every
task's full output in one stream, which is today's tab.

Three more, read by the research agent and not fetched again here:

- **k9s** acts on the selected row with single keys (describe, view, edit, `l` for logs), and its
  header can be hidden (`headless`) [26]. A takes the model of one cursor and keys that act on the
  row under it.
- **btop** gives each box a share of the screen with a minimum size, and a hidden box's space goes
  to its neighbours [27]. A's regions follow it: the needs-you region takes rows only while it has
  something, and the run block gives its rows to the map below 160 columns.
- **The GitHub Actions graph** shows dependencies as lines ("Lines between jobs indicate
  dependencies"), and selecting a job opens its log [28]. A takes the selection opening the log, not the graph: a loop run's steps
  are a fixed chain and its parallel sessions live inside one step, so dependency lines would say
  nothing a list does not.

No primary source was found for the layout of k9s's Pulses view, whether btop hides boxes by
itself on a small terminal, how the GitHub Actions graph draws matrix jobs, or Conductor's and Sculptor's screens
beyond the lines quoted.

## Three directions

All three answer the same four questions with the same data, and all three take the maintainer's
answers as given: tool calls fold, the default is not one session's transcript, and a wide
terminal splits. They differ in what they make the primary object on screen: the pipeline, the
live sessions, or time.

The mockups show PROJ-5 at two moments. Mid-run is 09:16:40, 40 minutes in: `functional-recheck`
and `quality-recheck` have ended, `docs-recheck` and `architecture-recheck` are live, and
`design-recheck` waits for a slot. Each live session's lines are its real events up to that
second, folded and elided. A session's time counts from its claim (`docs-recheck` at 09:15:39);
its `▶` row is when the harness answered, 19 seconds later. Spend sums the unrounded costs
($16.174 + $1.324). No run still on disk has a question, so the one `docs-recheck` asks is
a placeholder, as is the tool call that asked it. Finished is 09:25, after the maintainer merged
the branch. Glyphs are DESIGN.md's: `●` a live step, a spinner a live session, `?` waiting on the
human, `○` pending or open, `✓` done, `▸` a folded row, `▶` a session's start, `›` the cursor (the
gutter DESIGN.md gives a focused field). Two are new: `▰`, a span of time (the meters' glyph today, not in the glyph table), and `▲`, the now
mark on C's clock.

### A. Cockpit: the map is the anchor, the live sessions talk beside it

**Thesis: the run is a pipeline; show where it is in the whole map, and let the live sessions
talk beside it.**

At 200 columns the tab splits. The left column, on the raised surface, holds the map, what needs
the human, and the run's settings. The map has one row per step; the live step opens to one row
per session, with its findings and its time. The right column holds the "now" feed, a few lines
interleaved across the live sessions only, and under it the log of the session under the map's
cursor. Moving the cursor changes the log; nothing needs a key to see a session.

Mid-run, a question waiting, 200×50:

```text
 1 tracker │ 2 ⠋ PROJ-5 ?1
 PROJ-5  R1 slice 1: ‹issue title›                                                                                              ? docs-recheck waits on you · recheck 2 of 5 · 2 live · 40m28s · $17.50

 map                                                               now · 2 live sessions
 ✓ implement     1 session · PROJ-41                       2m2s    09:15:58 arch ▶ codex rechecks the fixer's diff on PROJ-5 through the architecture lens
 ✓ gates         check·test·build · 3 passes                12s    09:15:58 docs ▶ codex rechecks the fixer's diff on PROJ-5 through the docs lens
 ✓ triage        2 review sessions                          14s    09:16:03 arch   ‹agent message, cut to one row›
 ✓ review        21 findings filed                         7m9s    09:16:03 docs   ‹agent message, cut to one row›
 ✓ fixer         21 settled                              26m58s    09:16:16 arch ▸ 10 tools · 3 failed · 13s
 ● recheck       2 of 5 done · 2 live                              09:16:17 docs ▸ 14 tools · 6 failed · 13s
   ✓ functional    4 confirmed · 1 reopened               3m11s    09:16:25 docs   ‹thought heading›
   ✓ quality       5 confirmed · 1 reopened                2m5s    09:16:25 docs ▸ 2 tools · 0s
 › ? docs          5 findings · asks you                   1m1s    09:16:27 arch   ‹thought heading› · ‹thought heading›
   ⠋ architecture  3 findings                              1m1s    09:16:28 arch ▸ 2 tools · 0s
   ○ design        2 findings · waits for a slot                   09:16:32 docs   ‹thought heading›
 ○ land          none: the branch stays for review                 09:16:32 docs   ‹agent message, cut to one row›
                                                                   09:16:36 docs ▸ 3 tools · 2 failed · 4s
 needs you                                                         09:16:38 arch   ‹thought heading›
 ? docs-recheck (codex) asks about PROJ-5                          09:16:38 arch ▸ 1 tool · 0s
   ‹the question as codex asked it›                                09:16:40 docs ? ‹the tool call that asked› · waits on you
   1 ‹option›
   2 ‹option›                                                      docs-recheck · codex gpt-6.2-sol · balanced · since 09:15:39 · the cursor's session
                                                                   ▶ codex rechecks the fixer's diff on PROJ-5 through the docs lens · PROJ-33, PROJ-34, PROJ-38, PROJ-39, PROJ-40
 run                                                               ▸ prompt · ‹n› rows
 slots 2/2 · continuations 0/3 · spend $17.50 (codex unpriced)       ‹agent message, 1 row›
 implementer claude opus · verifier codex · review by triage       ▸ 14 tools · 6 failed · 13s
 gates check·test·build · land none                                  ‹thought heading›
 lenses functional·quality·docs·architecture·design                ▸ 2 tools · 0s
                                                                     ‹thought heading›
                                                                     ‹agent message, 2 rows›
                                                                     ‹…›
                                                                   ▸ 3 tools · 2 failed · 4s
                                                                   ? ‹the tool call that asked›















▸ tab to ask the copilot
1-2 answer · ↑↓ session · enter full log · i message · p pause · s skip · n next · x stop · o its issue · ? help
```

Finished, 200×50. "Needs you" becomes "left for you"; the feed becomes the run's trace; the log
pane becomes the sessions table that `e` hides today:

```text
 1 tracker │ 2 ✓ PROJ-5
 PROJ-5  R1 slice 1: ‹issue title›                                                                                                              ✓ completed · 46m52s · 6 findings left for you · $17.50

 map                                                               run trace
 ✓ implement     1 session · PROJ-41                       2m2s    08:36  ✓ gates    check·test·build passed
 ✓ gates         check·test·build · 3 passes                12s    08:36  ✓ triage   2 review sessions at tiers frontier and balanced
 ✓ triage        2 review sessions                          14s    08:43  ✓ review   21 findings filed (12 p1, 8 p2, 1 p3)
 ✓ review        21 findings filed                         7m9s    09:10  ✓ fixer    settled all 21 findings · $16.17
 ✓ fixer         21 settled                              26m58s    09:12  ✓ PROJ-41  merged · gates green
 ✓ recheck       18 confirmed · 3 reopened · 3 filed     10m35s    09:23  ✓ recheck  18 confirmed · 3 reopened · 3 filed
 ✓ land          none: kept for review; merged into HEAD 09:25     09:23  ✓ run      completed: plan-done (6 findings left open for a human)
                                                                   09:25  ✓ pruned   worktree and branch removed: branch merged into HEAD
 left for you · 6 findings
 ○ PROJ-22  reopened by functional  ‹finding title›                sessions · 10 · $17.50 claude · codex unpriced
 ○ PROJ-27  reopened by quality     ‹finding title›                ✓ triage                               codex gpt-6.1-terra      14s          2 review sessions, no lens skipped
 ○ PROJ-38  reopened by docs        ‹finding title›                ✓ functional+quality+architecture-lens codex gpt-6.2-astra    5m58s          filed 14 findings
 ○ PROJ-42  filed by architecture   ‹finding title›                ✓ docs+design-lens                     codex gpt-6.2-sol       7m9s          filed 7 findings
 ○ PROJ-43  filed by docs           ‹finding title›                ✓ fixer                                claude opus           26m58s  $16.17  settled all 21 findings
 ○ PROJ-44  filed by design         ‹finding title›                ✓ PROJ-41                              claude opus             2m2s   $1.32  merged · gates green
                                                                   ✓ functional-recheck                   codex gpt-6.2-sol      3m11s          4 confirmed · 1 reopened (PROJ-22)
 branch ‹branch name› · land: none                                 ✓ quality-recheck                      codex gpt-6.2-sol       2m5s          5 confirmed · 1 reopened (PROJ-27)
   merged into HEAD at 09:25 · worktree removed                    ✓ docs-recheck                         codex gpt-6.2-sol      3m13s          4 confirmed · 1 reopened (PROJ-38) · 1 filed (PROJ-43)
                                                                   ✓ architecture-recheck                 codex gpt-6.2-sol      1m25s          3 confirmed · 1 filed (PROJ-42)
                                                                   ✓ design-recheck                       codex gpt-6.2-sol      4m11s          2 confirmed · 1 filed (PROJ-44)
























▸ tab to ask the copilot
↑↓ step or finding · enter open · o its issue · w close tab · ? help
```

At 100×30 the same regions stack in the same order: map, needs you, now. The session log is one
`enter` away and takes the rows under the map.

```text
 1 tracker │ 2 ⠋ PROJ-5 ?1
 PROJ-5  R1 slice 1: ‹issu… ? docs-recheck waits on you · recheck 2 of 5 · 2 live · 40m28s · $17.50
 ✓ implement     1 session · PROJ-41                                                           2m2s
 ✓ gates         check·test·build · 3 passes                                                    12s
 ✓ triage        2 review sessions                                                              14s
 ✓ review        21 findings filed                                                             7m9s
 ✓ fixer         21 settled                                                                  26m58s
 ● recheck       2 of 5 done · 2 live
   ✓ functional    4 confirmed · 1 reopened                                                   3m11s
   ✓ quality       5 confirmed · 1 reopened                                                    2m5s
 › ? docs          5 findings · asks you                                                       1m1s
   ⠋ architecture  3 findings                                                                  1m1s
   ○ design        2 findings · waits for a slot
 ○ land          none: the branch stays for review

 ? docs-recheck (codex) asks about PROJ-5
   ‹the question as codex asked it›
   1 ‹option› · 2 ‹option›

 now
 arch   ‹thought heading› · ‹thought heading›
 arch ▸ 2 tools · 0s
 docs   ‹thought heading›
 docs   ‹agent message, cut to one row›
 docs ▸ 3 tools · 2 failed · 4s
 arch   ‹thought heading›
 arch ▸ 1 tool · 0s
 docs ? ‹the tool call that asked› · waits on you
▸ tab to ask the copilot
1-2 answer · ↑↓ session · enter full log · i message · x stop · o its issue · ? help
```

```text
 1 tracker │ 2 ✓ PROJ-5
 PROJ-5  R1 slice 1: ‹issue title›          ✓ completed · 46m52s · 6 findings left for you · $17.50
 ✓ implement     1 session · PROJ-41                                                           2m2s
 ✓ gates         check·test·build · 3 passes                                                    12s
 ✓ triage        2 review sessions                                                              14s
 ✓ review        21 findings filed                                                             7m9s
 ✓ fixer         21 settled                                                                  26m58s
 ✓ recheck       18 confirmed · 3 reopened · 3 filed                                         10m35s
 ✓ land          none: kept for review; merged into HEAD 09:25

 left for you
 ○ PROJ-22  reopened by functional  ‹finding title›
 ○ PROJ-27  reopened by quality     ‹finding title›
 ○ PROJ-38  reopened by docs        ‹finding title›
 ○ PROJ-42  filed by architecture   ‹finding title›
 ○ PROJ-43  filed by docs           ‹finding title›
 ○ PROJ-44  filed by design         ‹finding title›
 branch ‹branch name› · land: none · merged into HEAD at 09:25

 run trace
 08:36  ✓ gates    check·test·build passed
 08:36  ✓ triage   2 review sessions at tiers frontier and balanced
 08:43  ✓ review   21 findings filed (12 p1, 8 p2, 1 p3)
 09:10  ✓ fixer    settled all 21 findings · $16.17
 09:12  ✓ PROJ-41  merged · gates green
 09:23  ✓ recheck  18 confirmed · 3 reopened · 3 filed
 09:23  ✓ run      completed: plan-done (6 findings left open for a human)
 09:25  ✓ pruned   worktree and branch removed: branch merged into HEAD
▸ tab to ask the copilot
↑↓ step or finding · enter open · o its issue · w close tab · ? help
```

### B. Session wall: one tile per live session

**Thesis: the work is the live sessions; give each one a tile, and squeeze the pipeline into a
row above them.**

The pipeline is the strip of today, one row, never clipped. Under it, a row or two of the
sessions that ended and the one that comes next. The rest of the screen is tiles, one per live session,
side by side at 200 columns and stacked at 100. Each tile is that session's recent lines, folded,
and a question shows at the foot of the tile that asked it. Finished, the tiles become one card
per session.

```text
 1 tracker │ 2 ⠋ PROJ-5 ?1
 PROJ-5  R1 slice 1: ‹issue title›                                                                                              ? docs-recheck waits on you · recheck 2 of 5 · 2 live · 40m28s · $17.50
 ✓ implement 2m2s  ›  ✓ gates ×3  ›  ✓ triage 14s  ›  ✓ review 21 filed  ›  ✓ fixer 21 settled  ›  ● recheck 2 of 5  ›  ○ land
 ended  ✓ triage 14s · ✓ functional+quality+architecture-lens 5m58s · ✓ docs+design-lens 7m9s · ✓ fixer 26m58s · ✓ PROJ-41 2m2s · ✓ functional-recheck 3m11s
        ✓ quality-recheck 2m5s   next  ○ design-recheck · waits for a slot

 ? docs-recheck · codex gpt-6.2-sol · 1m1s · PROJ-33, PROJ-34, PROJ-38, PROJ-39, PROJ-40             ⠋ architecture-recheck · codex gpt-6.2-sol · 1m1s · PROJ-29, PROJ-30, PROJ-31

   ‹agent message, 1 row›                                                                              ‹agent message, 2 rows›
 ▸ 14 tools · 6 failed · 13s                                                                           ‹…›
   ‹thought heading›                                                                                 ▸ 10 tools · 3 failed · 13s
 ▸ 2 tools · 0s                                                                                        ‹thought heading›
   ‹thought heading›                                                                                   ‹thought heading›
   ‹agent message, 2 rows›                                                                           ▸ 2 tools · 0s
   ‹…›                                                                                                 ‹thought heading›
 ▸ 3 tools · 2 failed · 4s                                                                           ▸ 1 tool · 0s
 ? ‹the tool call that asked›



























 ? docs-recheck (codex) asks about PROJ-5
   ‹the question as codex asked it›
   1 ‹option›
   2 ‹option›
▸ tab to ask the copilot
1-2 answer · ←→ tile · enter full log · i message · p pause · s skip · n next · x stop · o its issue · ? help
```

```text
 1 tracker │ 2 ✓ PROJ-5
 PROJ-5  R1 slice 1: ‹issue title›                                                                                                              ✓ completed · 46m52s · 6 findings left for you · $17.50
 ✓ implement 2m2s  ›  ✓ gates ×3  ›  ✓ triage 14s  ›  ✓ review 21 filed  ›  ✓ fixer 21 settled  ›  ✓ recheck 18 confirmed  ›  ○ land none

 ✓ triage                                ✓ functional+quality+architecture-lens  ✓ docs+design-lens                      ✓ fixer                                 ✓ PROJ-41
   codex gpt-6.1-terra · 14s               codex gpt-6.2-astra · 5m58s             codex gpt-6.2-sol · 7m9s                claude opus · 26m58s · $16.17           claude opus · 2m2s · $1.32
   2 review sessions, no lens skipped      filed 14 findings                       filed 7 findings                        settled all 21 findings                 merged · gates green

 ✓ functional-recheck                    ✓ quality-recheck                       ✓ docs-recheck                          ✓ architecture-recheck                  ✓ design-recheck
   codex gpt-6.2-sol · 3m11s               codex gpt-6.2-sol · 2m5s                codex gpt-6.2-sol · 3m13s               codex gpt-6.2-sol · 1m25s               codex gpt-6.2-sol · 4m11s
   4 confirmed · 1 reopened (PROJ-22)      5 confirmed · 1 reopened (PROJ-27)      4 confirmed · 1 reopened (PROJ-38) …    3 confirmed · 1 filed (PROJ-42)         2 confirmed · 1 filed (PROJ-44)


 left for you · 6 findings
 ○ PROJ-22  reopened by functional  ‹finding title›
 ○ PROJ-27  reopened by quality     ‹finding title›
 ○ PROJ-38  reopened by docs        ‹finding title›
 ○ PROJ-42  filed by architecture   ‹finding title›
 ○ PROJ-43  filed by docs           ‹finding title›
 ○ PROJ-44  filed by design         ‹finding title›

 branch ‹branch name› · land: none · merged into HEAD at 09:25 · worktree removed


























▸ tab to ask the copilot
←→↑↓ session · enter full log · o its issue · w close tab · ? help
```

```text
 1 tracker │ 2 ⠋ PROJ-5 ?1
 PROJ-5  R1 slice 1: ‹issu… ? docs-recheck waits on you · recheck 2 of 5 · 2 live · 40m28s · $17.50
 ✓ implement › ✓ gates › ✓ triage › ✓ review › ✓ fixer › ● recheck 2 of 5 › ○ land
 ended  ✓ functional-recheck 3m11s · ✓ quality-recheck 2m5s · +5 earlier   next  ○ design

 ? docs-recheck · gpt-6.2-sol · 1m1s
 ▸ 2 tools · 0s
   ‹thought heading›
   ‹agent message, 2 rows›
   ‹…›
 ▸ 3 tools · 2 failed · 4s
 ? ‹the tool call that asked›
 ? docs-recheck (codex) asks about PROJ-5
   ‹the question as codex asked it›
   1 ‹option› · 2 ‹option›

 ⠋ architecture-recheck · gpt-6.2-sol · 1m1s
   ‹agent message, 2 rows›
   ‹…›
 ▸ 10 tools · 3 failed · 13s
   ‹thought heading›
   ‹thought heading›
 ▸ 2 tools · 0s
   ‹thought heading›
 ▸ 1 tool · 0s



▸ tab to ask the copilot
1-2 answer · ↑↓ tile · enter full log · i message · x stop · ? help
```

```text
 1 tracker │ 2 ✓ PROJ-5
 PROJ-5  R1 slice 1: ‹issue title›          ✓ completed · 46m52s · 6 findings left for you · $17.50
 ✓ implement › ✓ gates › ✓ triage › ✓ review › ✓ fixer › ✓ recheck › ○ land none

 ✓ triage                                   14s          2 review sessions, no lens skipped
 ✓ functional+quality+architecture-lens   5m58s          filed 14 findings
 ✓ docs+design-lens                        7m9s          filed 7 findings
 ✓ fixer                                 26m58s  $16.17  settled all 21 findings
 ✓ PROJ-41                                 2m2s   $1.32  merged · gates green
 ✓ functional-recheck                     3m11s          4 confirmed · 1 reopened (PROJ-22)
 ✓ quality-recheck                         2m5s          5 confirmed · 1 reopened (PROJ-27)
 ✓ docs-recheck                           3m13s          4 confirmed · 1 reopened (PROJ-38) · 1 fil…
 ✓ architecture-recheck                   1m25s          3 confirmed · 1 filed (PROJ-42)
 ✓ design-recheck                         4m11s          2 confirmed · 1 filed (PROJ-44)

 left for you
 ○ PROJ-22  reopened by functional  ‹finding title›
 ○ PROJ-27  reopened by quality     ‹finding title›
 ○ PROJ-38  reopened by docs        ‹finding title›
 ○ PROJ-42  filed by architecture   ‹finding title›
 ○ PROJ-43  filed by docs           ‹finding title›
 ○ PROJ-44  filed by design         ‹finding title›






▸ tab to ask the copilot
↑↓ session · enter full log · o its issue · w close tab · ? help
```

### C. Timeline: every session on one clock

**Thesis: the run is a schedule; draw every session as a bar on one shared clock, grouped by
step, so where it is, what ran in parallel and where the time went read off one picture.**

Rows are the steps and their sessions, as in A's map, but each row carries a bar on a time axis
across the width. Live bars end at a `now` mark. Under the chart, what needs the human and the
same "now" feed as A.

```text
 1 tracker │ 2 ⠋ PROJ-5 ?1
 PROJ-5  R1 slice 1: ‹issue title›                                                                                              ? docs-recheck waits on you · recheck 2 of 5 · 2 live · 40m28s · $17.50

                                         08:40                         08:50                         09:00                         09:10                         09:20
 implement
   ✓ PROJ-41                                                                                                                        ▰▰▰▰▰▰▰                                                         2m2s
 gates
   ✓ gates ×3                 ▰                                                                                                           ▰                                                          12s
 triage
   ✓ triage                   ▰                                                                                                                                                                      14s
 review
   ✓ functional+quality+arch   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰                                                                                                                                                  5m58s
   ✓ docs+design               ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰                                                                                                                                               7m9s
 fixer
   ✓ fixer                                          ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰                                                            26m58s
 recheck
   ✓ functional                                                                                                                            ▰▰▰▰▰▰▰▰▰▰                                              3m11s
   ✓ quality                                                                                                                               ▰▰▰▰▰▰                                                   2m5s
   ? docs                                                                                                                                           ▰▰▰▰                                            1m1s
   ⠋ architecture                                                                                                                                   ▰▰▰▰                                            1m1s
   ○ design
 land
   ○ next
                                                                                                                                                       ▲ now 09:16:40

 needs you   docs-recheck (codex) asks about PROJ-5 · ‹the question as codex asked it› · 1 ‹option› · 2 ‹option›

 now · 2 live sessions
 09:15:58 arch ▶ codex rechecks the fixer's diff on PROJ-5 through the architecture lens
 09:15:58 docs ▶ codex rechecks the fixer's diff on PROJ-5 through the docs lens
 09:16:03 arch   ‹agent message, cut to one row›
 09:16:03 docs   ‹agent message, cut to one row›
 09:16:16 arch ▸ 10 tools · 3 failed · 13s
 09:16:17 docs ▸ 14 tools · 6 failed · 13s
 09:16:25 docs   ‹thought heading›
 09:16:25 docs ▸ 2 tools · 0s
 09:16:27 arch   ‹thought heading› · ‹thought heading›
 09:16:28 arch ▸ 2 tools · 0s
 09:16:32 docs   ‹thought heading›
 09:16:32 docs   ‹agent message, cut to one row›
 09:16:36 docs ▸ 3 tools · 2 failed · 4s
 09:16:38 arch   ‹thought heading›
 09:16:38 arch ▸ 1 tool · 0s
 09:16:40 docs ? ‹the tool call that asked› · waits on you




▸ tab to ask the copilot
1-2 answer · ↑↓ session · enter full log · i message · p pause · s skip · n next · x stop · o its issue · ? help
```

```text
 1 tracker │ 2 ✓ PROJ-5
 PROJ-5  R1 slice 1: ‹issue title›                                                                                                              ✓ completed · 46m52s · 6 findings left for you · $17.50

                                          08:40                             08:50                             09:00                             09:10                             09:20
 implement
   ✓ PROJ-41                                                                                                                                     ▰▰▰▰▰▰▰▰                                           2m2s
 gates
   ✓ gates ×3                 ▰                                                                                                                         ▰                                            12s
 triage
   ✓ triage                   ▰                                                                                                                                                                      14s
 review
   ✓ functional+quality+arch   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰                                                                                                                                                5m58s
   ✓ docs+design               ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰                                                                                                                                             7m9s
 fixer
   ✓ fixer                                             ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰                                               26m58s
 recheck
   ✓ functional                                                                                                                                         ▰▰▰▰▰▰▰▰▰▰▰▰                               3m11s
   ✓ quality                                                                                                                                            ▰▰▰▰▰▰▰▰                                    2m5s
   ✓ docs                                                                                                                                                          ▰▰▰▰▰▰▰▰▰▰▰▰                    3m13s
   ✓ architecture                                                                                                                                                  ▰▰▰▰▰▰                          1m25s
   ✓ design                                                                                                                                                                   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰      4m11s
 land
   ✓ none: kept for review

 left for you · 6 findings
 ○ PROJ-22  reopened by functional  ‹finding title›
 ○ PROJ-27  reopened by quality     ‹finding title›
 ○ PROJ-38  reopened by docs        ‹finding title›
 ○ PROJ-42  filed by architecture   ‹finding title›
 ○ PROJ-43  filed by docs           ‹finding title›
 ○ PROJ-44  filed by design         ‹finding title›

 branch ‹branch name› · land: none · merged into HEAD at 09:25 · worktree removed















▸ tab to ask the copilot
↑↓ session or finding · enter open · o its issue · w close tab · ? help
```

```text
 1 tracker │ 2 ⠋ PROJ-5 ?1
 PROJ-5  R1 slice 1: ‹issu… ? docs-recheck waits on you · recheck 2 of 5 · 2 live · 40m28s · $17.50
                              08:40       08:50        09:00       09:10       09:20
 implement
   ✓ PROJ-41                                                       ▰▰▰                          2m2s
 gates
   ✓ gates ×3             ▰                                           ▰                          12s
 triage
   ✓ triage               ▰                                                                      14s
 review
   ✓ functional+quality+… ▰▰▰▰▰▰▰▰                                                             5m58s
   ✓ docs+design          ▰▰▰▰▰▰▰▰▰                                                             7m9s
 fixer
   ✓ fixer                         ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰                          26m58s
 recheck
   ✓ functional                                                       ▰▰▰▰                     3m11s
   ✓ quality                                                          ▰▰▰                       2m5s
   ? docs                                                                 ▰▰                    1m1s
   ⠋ architecture                                                         ▰▰                    1m1s
   ○ design
 land
   ○ next
 ? docs-recheck asks · ‹the question as codex asked it› · 1 ‹option› · 2 ‹option›
 now
 docs ▸ 3 tools · 2 failed · 4s
 arch   ‹thought heading›
 arch ▸ 1 tool · 0s
 docs ? ‹the tool call that asked› · waits on you
▸ tab to ask the copilot
1-2 answer · ↑↓ session · enter full log · i message · x stop · ? help
```

```text
 1 tracker │ 2 ✓ PROJ-5
 PROJ-5  R1 slice 1: ‹issue title›          ✓ completed · 46m52s · 6 findings left for you · $17.50
                               08:40         08:50        09:00         09:10         09:20
 implement
   ✓ PROJ-41                                                             ▰▰▰                    2m2s
 gates
   ✓ gates ×3             ▰                                                ▰                     12s
 triage
   ✓ triage               ▰                                                                      14s
 review
   ✓ functional+quality+… ▰▰▰▰▰▰▰▰▰                                                            5m58s
   ✓ docs+design          ▰▰▰▰▰▰▰▰▰▰                                                            7m9s
 fixer
   ✓ fixer                          ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰                    26m58s
 recheck
   ✓ functional                                                             ▰▰▰▰               3m11s
   ✓ quality                                                                ▰▰▰                 2m5s
   ✓ docs                                                                       ▰▰▰▰▰          3m13s
   ✓ architecture                                                               ▰▰             1m25s
   ✓ design                                                                         ▰▰▰▰▰▰▰    4m11s
 land
   ✓ none: kept for review
 left for you
 ○ PROJ-22  reopened by functional  ‹finding title›
 ○ PROJ-27  reopened by quality     ‹finding title›
 ○ PROJ-38  reopened by docs        ‹finding title›
 ○ PROJ-42  filed by architecture   ‹finding title›
 … 2 more
▸ tab to ask the copilot
↑↓ session or finding · enter open · o its issue · w close tab · ? help
```

### Which one

**A, the cockpit.** It answers the four questions in four fixed places: the map, the feed, the
needs-you region and the cursor's log, which is the shape the maintainer asked for. It degrades
in order: the split stacks at 100 columns and the map folds its finished steps into one row at
40. The map and the feed are new components, but each is a kind the board already draws: a list
with a cursor under the Selection Rule, a raised panel, a scrollbox with folded rows.

What the others do better:

- **B shows each live session's own thread of thought** without interleaving, which reads better
  than A's feed once four or more sessions are live. PROJ-5 never had more than two, and had one
  for most of its 47 minutes, when B is a single tile, and it is the closest of the three to Claude
  Code's agent view and herdr's panes. It is also the closest to rendering live sessions, which
  the board leaves to herdr. It spends the screen on sessions and hides the pipeline in one row,
  and a single tile is a transcript again. At 40 columns it has no answer: a tile needs
  width.
- **C is the best post-mortem.** On PROJ-5 it shows at once that the fixer took 27 of the 47
  minutes, that the two reviews and the rechecks ran in pairs, and that `PROJ-41` ran after the
  fixer. A and B need the sessions table to say that. Mid-run it answers "where is the run" less
  directly than A, because the bars grow but the step's name sits in a narrow label column, and it
  needs at least 100 columns: at 40 the bars have no room. A could take C's chart later as a view
  of a finished run behind one key.

## The cockpit, in full

### Regions

| Region | Holds | 200×50 | 100×30 and 40 |
|---|---|---|---|
| Run row | Parent, title, the run's state in words, elapsed, spend | full width, row 1 | row 1 |
| Map | One row per step with its result and time; the live step opened to its sessions; `land` last | left column | under the run row; at 40 the finished steps share one row |
| Needs you | The question waiting, with the session that asked and its answers; once finished, the findings left open and the branch's state | left column, under the map | under the map, only while it has something |
| Now | A few lines from the live sessions, interleaved, each tagged | right column, top | under the needs-you region |
| Log | The cursor's session, whole, tool calls folded | right column, under "now" | `enter` from the map; `esc` back |
| Run | Slots, continuations, spend, harnesses, gates, lenses, landing | left column, bottom | `?` sheet |

What is always on screen: the run row, the map, and anything that needs the human. What sits
behind a key: a session's whole log at 100 columns and under, a tool call's input and output
(`t`, or a click on its folded row), the settings block below 160 columns, and the copilot.

### Decided here, overrule if you disagree

- **"Now" holds a few lines per live session, never each tool call.** A session's messages, cut to one
  row; its thought headings, muted; its start, as `▶` with kabane's own claim line; a run of tool
  calls, folded into one row that counts failures, its glyph spinning and its count updating while
  a call runs; a question, in the accent.
- **"Now" appears when two or more sessions are live.** With one, as for PROJ-5's 27 minutes of
  fixer, there is nothing to interleave: at 200 the right column is that session's log alone, and
  at 100 and 40 "now" shows its last lines with no tag. Between steps, when no session is live,
  "now" shows the run's own events (gates, merges, the next claim). Each row is tagged with a short name for its session (`docs`, `arch`), in its
  series hue.
- **How many lines.** At 200×50, the top of the right column, up to 16 rows, with the cursor's log
  under it. At 100×30 and 40, the rows the map and the needs-you region leave, at least 5. Newest
  last; older lines scroll off.
- **A session that ends leaves "now".** Its result moves to its row on the map
  (`✓ functional  4 confirmed · 1 reopened  3m11s`). Session lines in "now" come only from live
  sessions, so its hues are never reused between two of them: series hues go to live sessions only, and six covers
  any concurrency up to six.
- **A question** goes to the needs-you region with the session that asked, its question and its
  answers; the session's map row turns to the accent `?`, the run row says
  `? docs-recheck waits on you`, and the tab bar's `?1` counts it. "Now" keeps running for the
  other sessions. Its digits answer it, as the banner's do today.
- **Finished,** "now" becomes the run's trace (one row per step's result and the landing), the
  needs-you region lists what is left for the human, and at 200 the log pane shows the sessions
  table. The cursor walks the map's steps and then the findings left for you; `enter` on a step
  opens its sessions, and on a finding opens it on the tracker.
- **Where the cursor starts.** On the live session that started last, and it follows the run from
  there: a new session or a question moves it. Once the human moves it, it stays put until `f`
  (follow) puts it back, as Buildkite's follow mode does.
- **Reaching a finished session mid-run.** The cursor walks every map row, steps and sessions.
  On a folded step, `l` (or `→`) opens it to its sessions and `h` (or `←`) folds it again; on a
  session, `enter` opens its log. At 200 the log pane already follows the cursor, so the fixer's
  log at 09:16 is `↑` to the fixer row, `l`, and the log is on the right.
- **Keys, and what they displace.** Today `j/k`, `↑↓` and `g/G` scroll the stream, `⌃d/⌃u` page
  it, `h/l` walk the lane chips, `e` opens the sessions table, digits answer a question, and
  `esc`/`q` go back to the tracker. In the cockpit `j/k` and `↑↓` move the cursor, `h/l` open and
  fold a step, `enter` opens a session's log or a finding, and `esc` closes the log first and goes
  to the tracker second. Scrolling keeps `⌃d/⌃u` and `g/G`. `e` goes: the map is the sessions
  table. Digits still answer, and the run's own keys stay (`i` message, `p` pause, `s` skip,
  `n` next, `x` stop, `o` its issue, `w` close).
- **A finished run that left something** keeps the accent `?` on its tab until its left-for-you
  list has been on screen, as herdr keeps an agent `done` until it has been seen.
- **The split** starts at 160 columns. The left column is 66 wide, enough for the longest session
  name and its result at one row each; the right takes the rest.

### 40 columns

The fallback keeps the order. Finished steps share one row with no results, "now" loses its time
column, and the run settings live only in the `?` sheet.

```text
 1 tracker │ 2 ⠋ PROJ-5 ?1
 PROJ-5              ? docs waits · 40m
 ✓ implement gates triage review fixer
 ● recheck  2 of 5 done
   ✓ functional    1 reopened
   ✓ quality       1 reopened
 ▸ ? docs          asks you
   ⠋ architecture  1m1s
   ○ design
 ○ land  none

 ? docs-recheck (codex) asks
   ‹the question as codex asked it›
   1 ‹option› · 2 ‹option›

 now
 arch ▸ 10 tools · 3 failed · 13s
 docs ▸ 14 tools · 6 failed · 13s
 docs   ‹thought heading›
 docs ▸ 2 tools · 0s
 arch   ‹thought heading› · ‹thought he…
 arch ▸ 2 tools · 0s
 docs   ‹thought heading›
 docs   ‹agent message, cut to one row›
 docs ▸ 3 tools · 2 failed · 4s
 arch   ‹thought heading›
 arch ▸ 1 tool · 0s
 docs ? ‹the tool call that asked› · wa…
▸ tab to ask the copilot
1-2 answer · ↑↓ · enter log · x stop · ?
```

```text
 1 tracker │ 2 ✓ PROJ-5
 PROJ-5            ✓ completed · 6 left
 ✓ implement gates triage review fixer
 ✓ recheck  18 ok · 3 reopened · 3 new
 ✓ land  none · merged 09:25

 left for you
 ○ PROJ-22  reopened · functional
 ○ PROJ-27  reopened · quality
 ○ PROJ-38  reopened · docs
 ○ PROJ-42  filed · architecture
 ○ PROJ-43  filed · docs
 ○ PROJ-44  filed · design

 run trace
 08:36 ✓ gates check·test·build
 08:36 ✓ triage · 2 sessions
 08:43 ✓ review · 21 filed
 09:10 ✓ fixer · settled 21
 09:12 ✓ PROJ-41 merged
 09:23 ✓ recheck · 18 ok, 3 reopened
 09:23 ✓ run · plan-done, 6 left open
 09:25 ✓ pruned · branch merged
▸ tab to ask the copilot
↑↓ · enter open · o issue · w close · ?
```

### Rules this changes

- **DESIGN.md's "Forty columns is the design target; wider panes get more room, never a different
  layout"**, which PRODUCT.md's Design Principle 2 also states ("Wider panes get more room, never a
  different layout to learn") and `packages/board/AGENTS.md` repeats ("Check at 40 columns
  first"). For a card tab, the home is the maintainer's 200×50, and from 160 columns the tab
  splits into two columns. The regions and keys are the same at every width, so there is still
  one layout to learn; only its arrangement changes. Forty columns stays a checked fallback.
  PRODUCT.md's narrow pane still describes the tracker, where a person glances between edits; a
  run tab is opened to watch.
- **The Lane chips section goes.** The map replaces it. DESIGN.md gains a "Run map" component:
  steps as bays, sessions as strips under the live one, the Selection Rule on the cursor.
- **Series hues go to live sessions only.** Today each lane keeps its hue by its place in the
  card's list, so the seventh session repeats the first's.
- **The glyph table gains the folded tool row** (`▸ 14 tools · 6 failed · 13s`), and `▰` and `▲`
  if the timeline view of direction C comes later.
- **The No-Line Rule stays.** The two columns are told apart by the left one's raised surface.

## How it is built, decided here

These are internal choices behind the cockpit; overrule any of them.

- **The board draws the map from card data, not header strings.** A header row today is toned
  text, one line, clipped, with no cursor and no click. The map needs a cursor, a click per row,
  the Selection Rule and fitting at every width, which the board already does for strips and
  checklists. So `ActivityCard` (`packages/extension/ports.ts`) gains the card's steps: an ordered
  list, each with a name, a state, a one-line result and a time, and the lanes under it with the
  same. It also gains what is left for the human: issue ids with a one-line reason. Both are in
  words no loop term needs, so another host can fill them. A card with steps gets the cockpit; a
  card without keeps today's view. This adds fields to the extension contract, which
  `ARCHITECTURE.md` asks to be named, and which is outside JCAB-615's own territory.
- **The loop fills them from `run.json` and the plan.** `LoopActivity.card` (`activity.ts`) builds
  the steps from the claims (`triage`, `lenses`, `fixer`, `recheck` already say which step a claim
  belongs to) and the gate runs, and the left-for-you list from `LoopPlan.findings` and each
  recheck claim's `findings`. `header.ts` shrinks to the run row.
- **The loop maps its event types to the board's.** `session_start` becomes `phase`, with
  `launch`, `model` and `mode` as its detail; `session_end` and `gate_passed` become done rows;
  the rest `progress`. The board does not learn `claim` or `launch`.
- **"Now" is a filter over the events the board already polls:** the live lanes' events
  (`liveLanes` exists on the card), folded and cut to one row. No new port.
- **The run trace on a finished run** is the events with no lane plus each session's start and end.

## Slices

Each merges on its own. Listed in the order they can land; "after" names what must merge first.

1. **Tool calls fold between messages.** A run of tool calls with no message or thought between
   them becomes one row that counts failures, `▸ 14 tools · 6 failed · 13s`, opened by `t` or a
   click; while a call in the run is going, the row's glyph spins and its count updates. Thoughts trim their
   leading blank lines and render as markdown. Changes the copilot's transcript too, which shares
   the view. Territory: `packages/board/src/{tool-rows,event-view}.ts(x)`, `DESIGN.md` (glyph
   table). After: nothing.
2. **The map replaces the strip, the meters and the chips, stacked at every width.** The contract
   gains the card's steps and its left-for-you list; the loop fills them; the board draws the map
   with a cursor, the run row and the needs-you region (the question names the session that
   asked; a finished run lists what is left). `enter` opens the cursor's session over the stream
   and `esc` comes back; `h/l` now open and fold a step, and `e` goes. The meters go: slots and
   continuations move to the run row and the `?` sheet. The run-state bugs are fixed here
   (`● running` in the done hue, the skipped lens, `○ implement`, `◐`, clipping without `…`), and
   the tab bar's glyph reads the same state as the run row, so it stops spinning after the run
   ends. Territory:
   `packages/extension/ports.ts`, `extensions/loop/src/{activity,header}.ts`,
   `packages/board/src/` (a new map component, `event-view.tsx`, `card-tab.ts`, `card-header.tsx`,
   `tab-bar.tsx`, `keymap.ts`, `nav.ts`), `DESIGN.md` (Run map replaces Lane chips; the Question
   banner names the session), `docs/loop.md` (what a run's tab shows), and the extension and board
   READMEs (`packages/extension/README.md`, `packages/board/README.md`) for the new card fields. After: 1, since both change `event-view.tsx` and `DESIGN.md`.
3. **"Now" and the run trace.** Under the map, the live sessions' lines interleaved with short
   tags, hues for live sessions only; on a finished run, the trace. The loop maps its event types
   to the board's. Territory: `packages/board/src/` (a new "now" component, `event-view.tsx`,
   `theme.ts` for the hue rule), `extensions/loop/src/activity.ts`, `DESIGN.md` (Series).
   After: 1 and 2.
4. **The split from 160 columns.** The left column holds the map, needs you and the run block on
   the raised surface; the right holds "now" over the cursor's log, which follows the cursor with
   no key. Territory: `packages/board/src/` (the card tab's layout in `event-view.tsx` or a new
   cockpit component, `screen.tsx`), `DESIGN.md` (the wide-layout rule), `PRODUCT.md` (Design
   Principle 2), `packages/board/AGENTS.md` (which width to check first). After: 3.

Not proposed now: direction C's timeline as a view of a finished run. It would be a fifth slice,
after 2, if the sessions table turns out not to be enough for a post-mortem.

## Not verified

- No frame shows a lens, the fixer or a recheck in flight. The scripted agent's lenses file
  nothing, so its runs never reach the fixer, and its lens step passes in under five seconds. A
  copy of a live run would read as died, since `RunStore.read` checks the runner's pid. The
  mid-run header text for those steps is read from `header.ts`, not seen.
- No frame shows a loop question. No run under `~/.kabane/loops` has a `questions.jsonl`, and the
  scripted agent never asks in a loop. The banner frame is the gallery's `banner-waiting` story.
- The real header with PROJ-5's plan (title, `11/11 done`, findings, recheck step) was not
  rendered. Its content is read from `header.ts` and the brief's description of the screenshot.
- Colour. capture-pane keeps none, so the hue findings (`● running` in the done hue, series hues
  repeating) come from `header.ts` and `Theme.seriesOf`, not from a frame. A light terminal was
  not checked.
- The mockups of the three directions are drawn, not rendered. A script laid them out from the
  run's `run.json` and `events.jsonl` at fixed widths and checked each row's length; OpenTUI's
  real wrapping, the raised column's tone and the spinner were not seen.
- The cockpit's "now" was not tried with four or more live sessions. PROJ-5 never had more than
  two; with more, its interleaving gets harder to read, which is where direction B is stronger.
- Mouse: clicking a map row, a chip, or a folded tool row is a manual check.
- The research sources not marked ✓ were read by a research agent and not fetched again here.

## How this review was made

Read first: `AGENTS.md`, `DESIGN.md`, `PRODUCT.md` (North Stars, Users, Brand),
`packages/board/AGENTS.md`, `extensions/loop/AGENTS.md`, `docs/loop.md`. Code read:
`extensions/loop/src/{header,activity,dispatcher,lenses,store}.ts`,
`packages/board/src/{card-tab,run-activity,event-view,tool-rows,card-header,segments,screen,theme}.ts(x)`,
`packages/extension/ports.ts`.

The critique follows the `impeccable` skill's critique mode. Its design review ran in a separate
agent given the frames and the source paths, not this note's conclusions. Its second half, an
automated detector, reads web markup only: `impeccable detect --json
packages/board/src/event-view.tsx` returned `[]`. Its archive under `.impeccable/critique/` was
not written, since this issue may change only this file. A research agent gathered the patterns
in "What comparable tools do", and a second one the full-screen layouts; a third agent read the
first draft cold and its confusions were fixed. The three directions and their mockups were
drawn after the maintainer's answers and course correction, quoted at the top.

Frames were captured under tmux on a private socket at 40×30, 100×30 and 200×50, in
`bun run sandbox --scripted`. Local paths in them are shortened to `~`.

## Sources

1. Turborepo 2.0: https://turborepo.dev/blog/turbo-2-0
2. Nx 21 terminal UI: https://nx.dev/blog/nx-21-terminal-ui
3. Buildkite build page: https://buildkite.com/docs/pipelines/build-page
4. Turborepo PR #8650: https://github.com/vercel/turborepo/pull/8650
5. Claude Code agent view: https://code.claude.com/docs/en/agent-view.md
6. Buildkite changelog 342: https://buildkite.com/resources/changelog/342-collapsed-group-steps-on-the-build-canvas
7. GitHub Actions workflow run logs: https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs
8. Claude Code subagents: https://code.claude.com/docs/en/sub-agents
9. Turborepo discussion #8381: https://github.com/vercel/turborepo/discussions/8381
10. BuildKit progress UI: https://github.com/moby/buildkit/blob/master/util/progress/progressui/display.go
11. GitHub workflow commands (job summaries): https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
12. Buildkite log output: https://buildkite.com/docs/pipelines/configure/managing-log-output
13. Temporal, workflow exploration: https://temporal.io/blog/the-dark-magic-of-workflow-exploration
14. Codex CLI 0.169 release: https://github.com/openai/codex/releases/tag/rust-v0.169.0
15. The Register on Claude Code's collapsed reads: https://www.theregister.com/2026/02/16/anthropic_claude_ai_edits/
16. Cursor forum, agent progress board: https://forum.cursor.com/t/dedicated-agent-progress-board-in-the-agents-sidebar-like-claude-desktop-orca/174813
17. gh run watch: https://cli.github.com/manual/gh_run_watch
18. Dagger 0.17 visualization: https://devel.docs.dagger.io/0.17/features/visualization
19. lazygit window arrangement: https://raw.githubusercontent.com/jesseduffield/lazygit/master/pkg/gui/controllers/helpers/window_arrangement_helper.go
20. gh-dash defaults: https://www.gh-dash.dev/configuration/defaults/
21. Buildkite waterfall: https://buildkite.com/docs/pipelines/waterfall
22. herdr concepts: https://herdr.dev/tui/docs/concepts/
23. Vibe Kanban workspace interface: https://vibekanban.com/docs/workspaces/interface.md
24. Sculptor agents: https://raw.githubusercontent.com/imbue-ai/sculptor/main/docs/help/agents.md
25. Conductor changelog 0.35.0 and 0.44.0: https://www.conductor.build/changelog/0.35.0-workspace-status and https://www.conductor.build/changelog/0.44.0-new-sidebar-rebuilt-composer-codex-checkpoints
26. k9s commands: https://k9scli.io/topics/commands/
27. btop drawing code (box sizes): https://raw.githubusercontent.com/aristocratos/btop/main/src/btop_draw.cpp
28. GitHub Actions visualization graph: https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph
