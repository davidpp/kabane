# Kabane in herdr-app: a click lands in the board

Status: proposed 2026-11-07. Baseline: kabane `d842006` (1.0.0-beta.0), herdr-app 0.1.13 on
herdr-core 0.1.18, `~/Projects/kabane-herdr` as installed today. Self-use proof of concept: the
slices go for the quickest click that lands in kabane's own UI, and leave deeper restructuring
for later (see "Decomposition to brainstorm later").

## The problem

The herdr panel (`kabane-herdr/mods/kabane/main.js`) is a good glance. It shows what waits on
you, what is in progress and what is next for the focused folder, starts agents with a
`kabane.issue=<id>` label, and shows their status as chips. A click on a row, though, runs
`sh -c 'kabane show <id>; exec $SHELL'` in a split. In David's words: "I click on an issue and
the only thing it does is open a terminal and echo the issue."

Everything you would do next lives in the board, and the click skips it: the detail view, the
open decisions with their recommendation (answered in place and credited to you), checklists,
review, `O` to the upstream issue, search and the copilot. The panel should hand you to the
board, and the board should not grow a second panel.

## What the board supports today (verified)

| Question | Answer | How it was checked |
|---|---|---|
| A flag or deep link to open an issue | **None.** `kabane board [--scope <uri>] [--copilot <harness>]` only. The first state is always `BoardNav.init` on the board view (`board-feed.ts`). | `kabane board --help`, `packages/cli/src/commands/board.ts`, `board-runtime.ts`, `nav.ts` |
| Single instance, IPC, or any way to tell a running board something | **None.** No socket, signal handler or watched file. The board's only inputs are keys, mouse and its 5 s DB poll. | grep for `Bun.listen`, `createServer`, `SIGUSR`, `process.on` across board, cli, acp and loop |
| Keys sent from outside to bring up an issue | **Works mechanically, and lands on the wrong issue.** `hc keys <board> /`, then `hc send <board> JRET-1` (`hc send` also submits), then enter opened **JRET-12**. Search is a substring match on title and short id (`matchesQuery`), so `JRET-1` also matches JRET-10 to 12, and the first match wins. It also depends on what has the keys: the copilot's textarea, a decision's text field or an open overlay would swallow them, and `esc` on the board widens the scope. | sandbox, seeded JRET-1..12 |
| Can the detail view show any task by id? | **Only one in the loaded sections.** `BoardNav.taskById` walks `state.sections`, which are scoped and leave out done issues on the `open` filter. A deep link has to make sure the issue is loaded (its scope, its status filter) before it pushes the detail. | `nav.ts`, `detail-records.ts`, `screen.tsx` |
| The board's process from the host | hc's terminal record carries `pid` and `foreground.pid`. Both were the board's own process (`env … bun … board` execs through). | `hc get --json` |
| Cold start | Rows drawn in under 1.5 s from `hc run` (an upper bound; `hc read` itself takes 2 to 3 s to return, which is why a naive poll said 10.7 s). `kabane list --json` is about 0.09 s. | sandbox timing |

What herdr-app gives a host to put the board in front of you (all in the `rethink` sandbox,
screenshots read, sandbox since stopped):

- **`terminal.peek` on a terminal with no pane**, started with `hc run --bg --no-parent --label
  kabane.board=…`. It shows over the active tab with herdr's own **keep** (as a tab) and **close**
  controls. The board is resized to the peek (118x27), and closing the peek leaves it running
  (back to 200x120, `live`). Peeking it again shows the same process with its state intact.
- **That paneless board does not appear in herdr's Agents list or "Needs you"**, even while it
  reports `blocked`, `kind=question`, `app=kabane` (the scripted copilot's `ask form`). Neither
  does one parked with `terminal.park`. Adding a `herdr.space` label makes herdr adopt it as a
  new tab.
- **`terminal.peek` on a board that lives in a tab** shows it with a **go to** control, but the
  board keeps its tab's size (129x43), so the peek cuts off its top rows (the tab bar and
  header).
- In a tab, the board shows in "Needs you" while it is blocked (the JCAB-154 comment, re-seen here
  as `status`/`records` on the terminal).
- Inside an hc terminal, `HC_TERMINAL_ID` and `HC_SESSION` are set.

## Options weighed

**How a click reaches the board**

1. *Keys from the host* (`hc keys`/`hc send` or `tmux send-keys`). It needs no kabane change, but
   it is verified wrong on a substring collision and fragile against whatever has the keys. Even
   with an exact-id search, `esc` to "reset" widens the scope. Rejected.
2. *A new board per click with `--issue`.* It is correct, but each click spawns a process and
   throws the last board's state away (the copilot's session, its transcript, the view). This is
   what David asked not to have.
3. *`--issue` to start, plus a way to tell a running board to open an issue, addressed by pid.*
   Generic: tmux (`#{pane_pid}` when the board is the pane's command), a plain terminal and herdr
   (terminal `pid`) can all use it. Recommended.
4. *Restart the space's board with `--issue` when it is idle* (no 7501 status). A herdr-only
   stopgap on top of (2) that needs only `--issue`. It loses an idle board's in-memory state (a
   half-typed prompt, the copilot transcript). It is acceptable for a proof of concept, and
   removed once (3) lands.

Pid over the alternatives: a host-chosen name (`--name`) needs a naming scheme every host must
agree on. A single board per home or per scope guesses at intent. Writing UI requests into the
database would put view state in the replicated oplog (Principle 3, "Store identity, never
content"). The host already knows the pid of the terminal it started.

**Where the board lives in herdr**

- *Parked board, peeked on click* (recommended). It is one press away from any tab, over your
  agents, and closing it returns you to them. That fits PRODUCT.md's "glanced at, not sat in".
  The peek's **keep** turns it into a tab whenever you want one. Cost: herdr's "Needs you" does
  not list it, so the panel shows the board's own blocked state instead.
- *Board in a tab, focused on click* (what ⌘⇧K does today). It shows in "Needs you", but every
  click switches you away from the agent's tab.
- *Board in a tab, peeked from other tabs.* The clipping above rules it out for now; it is worth
  reporting to herdr.
- *A split beside the focused pane.* It takes columns from the agent, and with one board per
  space it would sit in one tab only.

## Recommendation

The panel stays the glance and the board stays the tool. A click on any row puts the board in
front of you, on that issue, and reuses one board per space folder.

**Division of labor**

| | herdr panel (the mod) | the board |
|---|---|---|
| Shows | counts and rows: waiting on you, in progress, next; agent chips from labels; the board's own `▲ blocked` when it waits on you | everything about an issue: brief, decisions, checklist, comments, log, review, upstream, search, copilot, loop tabs |
| Does | starts an agent on an issue (▶ start, `kabane.start`); jumps to an agent (chip); opens the board on an issue | moves, edits, answers decisions, dispatches, asks the copilot |
| Never | shows an issue's content or answers anything (the `kabane show` split goes) | lists herdr terminals or tracks herdr state |

**Mod, extension, core**

- **Core (generic, no herdr code):**
  - `kabane board --issue <id>` (slice 1);
  - telling a running board, by pid, to open an issue (slice 3).

  Both are open interfaces any host or person can use, which is the not-goal "A replacement for
  the tools around it" read the right way: herdr hosts, peeks and runs agents, and kabane tells
  it how to land on an issue.
- **The mod (kabane-herdr):** everything about where the board lives and how it is found:
  - one parked board per space folder, labelled `kabane.board=<folder>`, peeked on click;
  - question rows open their issue, where the decision form is waiting;
  - ⌘⇧K peeks the same board;
  - the panel shows the board's blocked state, because herdr's Agents list won't.
- **Extension `extensions/herdr` (later, off by default):** only what has to run inside the
  board. Its first and likely only piece is a Dispatcher trigger, "start an agent in a herdr
  tab", on `a`. It calls the mod's own command (`herdr-app do kabane.start:<id>`) rather than
  re-implementing ▶ start, so there is one implementation of starting an agent. It reaches herdr
  only through the `hc`/`herdr-app` CLIs, with no package dependency. Someone who stops using
  herdr removes `herdr` from `extensions`, and nothing else changes.

**The extension candidates, weighed**

- *Dispatcher "start in a herdr tab": yes, after the click works.* When you are in the board on
  an issue, `a` is where "work this" belongs, and today it offers only the loop. It starts a
  session and does nothing more: it does not drive, observe or relay. So it is not the engine
  JCAB-154 freezes, and it respects the thin-wrapper rule (herdr shows the agent's own
  permission prompts). If JCAB-154's seam later wants an hc engine (start with a brief, observe
  through 7501, stop), this extension is where it would live, and this trigger becomes its
  first caller.
- *ActivitySource of the herdr agents on each issue: not now.* It would show what the panel's
  chips and herdr's Agents list already show, and the card statuses (`running`, `paused`, …)
  have no `blocked`, so the most useful fact would be lost. It edges toward the anti-reference
  "Any design that mirrors another system", even though nothing would be stored. Revisit if you
  live in the board and miss the chips.
- *`kabane herdr open <id>`: no.* Keys and `herdr-app do` already reach the mod's commands
  (`kabane.open:<id>`, below). A CLI verb would be a second way in to the same thing.
- *Copilot knowledge of herdr: no.* North Star 1, "Helps you work well": herdr already teaches
  agents through `hc --skill` and its generated `AGENTS.md`, so kabane recommends theirs. There
  is also no seam for an extension to add to the copilot's instructions (see decomposition).

**North Stars**

- **2 Instant:** reusing the board turns a click into a peek of a live process. Cold start
  (under 1.5 s) is paid once per space.
- **5 Explains itself** and **6 The human stays in charge:** a decision answered in the board's
  form is recorded with who answered and why (`Questions.answer`), where the `kabane show` split
  only displayed the issue.
- **4 Yours, everywhere:** nothing of herdr's is stored, and the core seams work the same under
  tmux or a bare terminal.
- **3 Yours, by asking:** the core grows two flags and one listener, and the extension is opt-in.

## Generic core seams

1. **`kabane board --issue <id>`.**
   - Takes a short id or ULID, resolved with `Planner.resolveTaskId` before the renderer starts.
     An unknown id fails in one line, as `kabane show` does.
   - Opens on that issue's detail.
   - The board opens on the issue's own scope unless `--scope` says otherwise. When the issue is
     not on the `open` filter (done, cancelled), it opens on the filter that holds it, so
     `taskById` finds it.
   - `esc` goes back to the board as usual.
   - In `BoardDeps` it is an optional `open?: { taskId: string }`, so the board stays free of
     the CLI.
2. **Open an issue in a running board.**
   - At start, the board command listens on a Unix socket for its own pid, under
     `<KABANE_HOME>/run/board-<pid>.sock` (falling back to the temp dir when the path would pass
     macOS's 104-byte `sun_path` limit), and removes it on exit.
   - `kabane board --issue <id> --to <pid>` sends `{"open":"<id>"}`. It prints `{"opened":
     "<shortId>","pid":<pid>}`, or a one-line error (`no board running as pid 77516`,
     `JRET-99 not found`), and never starts a TUI.
   - The board takes the request through a port in `BoardDeps` (a subscribe function), so it
     stays protocol-free, the way `Copilot` is.
   - It applies the request the way `enter` on that row would. It first closes help, the
     dispatch picker or form and a `/` being typed. It keeps the copilot's draft and any pending
     copilot ask. The view changes and nothing is discarded. If the issue is not loaded, it
     widens to the issue's scope or filter first.
   - It ends at the board. Later, an MCP tool for an agent to "show the human this issue" could
     use the same port (Principle 4, "The agent surface is first class"), but nothing here needs
     it.

Neither seam knows herdr exists.

## Slices, in order

Each is one issue. The territory is the files it owns.

**1. `kabane board --issue <id>` (kabane).** Territory:
- `packages/cli/src/commands/board.ts`, `board-runtime.ts`;
- `packages/board/src/start.tsx` (`BoardDeps.open`), `board-feed.ts` (first state), `nav.ts`
  (an `openTask` transition that slice 3 reuses);
- `packages/board/README.md` ("Start it");
- tests beside each.

Done when, in `bun run sandbox` under tmux, `kabane board --issue <id>` opens on the detail for
an open issue, a done one and a subtask; an issue with a decision shows its form, answerable with
a digit; an unknown id fails before the renderer. Gate green.

**2. A click lands in the board (kabane-herdr).** Territory: `mods/kabane/main.js`, `keys.json`,
`RECIPE.md`, `README.md`, `preview.png`.
- A row click (a question row uses its issue) finds the live terminal labelled
  `kabane.board=<folder>` for the panel's folder:
  - None: `hc run --bg --json --no-parent --cwd <folder> --label kabane.board=<folder> -- kabane
    board --issue <id>`, then `run("terminal.peek", {terminal})`.
  - One with no status (idle): stopgap, kill it and start it again the same way, then peek.
  - One that is `working` or `blocked`: peek it as it is, with a warning toast `board is busy ·
    <id> not opened`.
- ⌘⇧K becomes the mod command `kabane.board`, which peeks the board (starting one without
  `--issue` if none is running). A `kabane.open:<id>` command does what a click does.
- The panel header ends with `▲ board` in the blocked colour while that board reports `blocked`.
  A click on it peeks the board.
- The `kabane show` split goes.

Done when it has been seen in a sandbox with `herdr-app shot`: a click peeks the board on the
issue, a second click on another issue reuses the board, the header chip appears while the
scripted copilot asks, and `herdr-app status` shows no errors. Clicks are a manual check for
David.

**3. Open an issue in a running board (kabane).** Territory:
- a new `packages/cli/src/commands/board-control.ts` and its test, plus `board-runtime.ts` for
  the listener and the `--to` client;
- `packages/board/src/ports.ts`, `start.tsx`, `board-feed.ts`, `nav.ts` (reusing slice 1's
  `openTask`);
- `packages/board/README.md`.

Done when, under tmux, with one board in window A, `kabane board --issue X --to <pid>` from
window B opens X in A. That is checked from a search being typed, with the copilot focused
holding a draft (the draft survives), and with the dispatch picker open. An issue in another
scope and a done one also open. The errors read as specified. The socket is gone after `q` and
after a crash.

**4. The mod tells the board instead of restarting it (kabane-herdr).** Territory:
`mods/kabane/main.js`, `RECIPE.md`, `README.md`. A click on a live board runs `exec("kabane",
["board", "--issue", id, "--to", String(pid), "--json"])` with the terminal's `pid`, then peeks.
The idle restart and the busy toast go. Done when it has been seen in a sandbox, as in slice 2,
including a click while the copilot is mid-turn.

**5. `extensions/herdr`: "start an agent in a herdr tab" on `a` (kabane), after David has used 1
to 4.**
- Territory: `extensions/herdr/*` (index, dispatcher, tests), `packages/cli/src/extensions.ts`
  (`OFFICIAL`), `packages/board/README.md` or the extension's own README.
- The trigger is satisfiable when `HC_SESSION` is set (inside herdr) and the issue is in
  progress or next. Otherwise its hint says why.
- `dispatch` runs `herdr-app do kabane.start:<shortId>` and returns herdr's answer as the footer
  notice.
- Done when, in a herdr sandbox with `extensions: ["herdr"]`, `a` → the trigger opens the
  agent's tab and the panel's chip appears.

## Open decisions for David

1. **Where the board lives in herdr.**
   - (a) Parked and peeked on click, with keep-as-tab when you want it.
   - (b) A tab, focused on click.
   - (c) A split.

   *Recommend (a):* it puts the board over your agents and gives it back with one key. The
   price is that "Needs you" doesn't list it, which the panel's `▲ board` chip covers.
2. **Ship slice 2 with the idle-restart stopgap, or wait for slice 3.** *Recommend the
   stopgap:* it is the quickest click that lands in the board. It only restarts a board with no
   7501 status, and slice 4 removes it.
3. **The flag names.**
   - (a) `kabane board --issue <id>` and `--to <pid>`.
   - (b) A subcommand, `kabane board open <id> [--pid <pid>]`.

   *Recommend (a):* `board` stays one command, and both read as "the board, on this issue".
4. **One board per what.**
   - (a) Per space folder (the label holds the folder).
   - (b) Per kabane scope.
   - (c) One per window.

   *Recommend (a):* it is what the panel already follows. (b) needs a scope the CLI does not
   expose in `--json` today.
5. **Build `extensions/herdr` (slice 5) now or later.** *Recommend later,* once you notice
   yourself leaving the board to press ▶ start.
6. **Herdr agents on the board (an ActivitySource).** *Recommend not now* (above).

## Decomposition to brainstorm later

These are places where this design wanted part of kabane to load or exist on its own. None is
designed here. Every slice above works with kabane as it is.

- **The board without the copilot.** A board started per space for peeking also wires the
  ACP copilot. Nothing spawns until `A` (`board-runtime.ts`), but it is all imported. A
  viewer-first board that loads the copilot on demand would make the peek path lighter (North
  Star 2, Instant), and "the board alone" is what the herdr panel actually wants to open.
  Today's under-1.5 s cold start means this doesn't block anything.
- **A board you can address.** Slice 3 puts the listener in the CLI's board command. If more
  surfaces want to steer a running board (an MCP "show the human this issue" for agents, a
  second host), the control channel is a capability of its own rather than a board flag.
- **Extensions contributing to the copilot.** The contract offers commands, settings and board
  ports, but nothing to add instructions or shortcuts to the copilot. Copilot knowledge of herdr
  was rejected on North Star 1, but any extension that wants the copilot to know about it will
  hit this.
- **The loop's engine (JCAB-154).** An hc engine would live in `extensions/herdr` only once the
  seam exists. It is not designed here.
