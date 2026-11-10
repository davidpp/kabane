# Product

## North Stars

Getting good work out of agents is a craft that changes every few months, across vendors,
harnesses and models that come and go. Kabane makes that work go better, whichever agents do
it: it brings good practice to the work, lets any agent pick up where another left off, and
keeps a history that can explain what was done, when, by whom and why. It does this as one
piece that composes with the tools people already use, never as the whole of them.

In priority order; when two conflict, the higher one wins.

1. **Helps you work well.** Kabane brings current good practice to the whole of the work,
   from starting a project to closing an issue, and fits it to the project at hand. Where
   someone else already does a practice well, kabane recommends theirs instead of redoing it:
   bringing a practice to the work never means becoming the tool for every part of it.
   It learns from what happened to the work, never from how much of it got done, and proposes
   a better practice when one isn't working; the human decides.
   *Rests on:* good practice for agent-driven work changing faster than one person can follow;
   shared, tested practice beating each person rediscovering it; a piece that composes with
   the rest outliving a tool that tries to be all of it. *Revisit if:* the practices settle
   into the agent tools themselves, people stop taking kabane's recommendations, or carrying
   a practice keeps requiring kabane to own the job itself.
2. **Instant.** Every read and write, by a human or an agent, feels immediate. Nothing ships
   that puts a wait on the common path.
   *Rests on:* speed being what users feel first (it already feels instant next to hosted trackers).
   *Revisit if:* something users need cannot be had without making the common path wait.
3. **Yours, by asking.** Light defaults work untouched, without process. When you want it
   different, you ask and kabane adapts; nobody has to learn its
   configuration to make it theirs. The core stays small.
   *Rests on:* people adapting a tool rather than adopting someone's process; agents being
   able to do the adapting. *Revisit if:* making kabane yours takes more than asking, or the
   core grows to fit one workflow.
4. **Yours, everywhere.** Your work lives on your machine, and one machine is a complete
   setup. It stays yours across every device, vendor and harness: any agent you use,
   browser-only ones included, picks up where another left off.
   *Rests on:* people working across machines and agent surfaces, and mixing or switching
   vendors; people wanting to own their work rather than rent it. *Revisit if:* nobody reaches
   past one machine or one vendor once they can, or agent surfaces converge on hosted state.
5. **Explains itself.** Anyone, human or agent, can later learn what was done, when, by whom
   and why, without having been there.
   *Rests on:* more of the work being done by agents nobody watched; the reasons behind work
   outlasting the memory of the people and sessions that did it. *Revisit if:* the agent
   tools come to keep a history of their own that is portable across vendors.
6. **The human stays in charge.** Humans and agents share the work as peers. The human is
   brought in where their judgment matters. How often they are asked shifts as agents earn
   trust; their ability to steer does not.
   *Rests on:* agents growing more capable while accountability for the work stays with the
   human. *Revisit if:* that accountability moves to the agents themselves.

Two gates, both required: its author uses it daily, and a stranger who installs it watches an
agent close their first issue with no hub and no help.

Not goals:

- **A team tracker.** A team can adopt and extend it; the core grows no assignee pickers,
  sprints or permissions. The team's own tracker stays the team record.
- **An all-in-one, or a replacement for the tools around it.** Agent harnesses, runtimes, multiplexers and
  team trackers come and go. Where one already does a job well and people use it, kabane
  works with it instead of competing with it, and what kabane grows extends the tools people
  already chose. It composes with them through open interfaces, tells them its own state, and
  depends on none of them, so it outlives each one.
- **The factory line.** No velocity, throughput or "done today" counts.

**Still being refined (since 2026-11-07).** These are a working draft for the next few weeks,
not settled law. Question them, argue with them, propose a better one, but out loud: never
quietly work around one or rewrite it without telling the maintainer. Once settled, each one
should survive a complete rewrite of the software and change only when an assumption under it
breaks.

## Register

product

## Users

Developers who already run coding agents (Claude Code, Codex, Gemini CLI) every day and
live in a terminal. They install kabane on their own machine as the place for the work
their agents pick up and report back on. Its author is the first of them, and daily use by its
author is the floor: a tracker its author stops opening has failed however many others
install it.

The human's context is a narrow pane: a terminal split beside an editor, or a pane in
herdr (a terminal multiplexer for coding agents) next to the agent sessions doing the work.
It is glanced at between edits, not sat in. The job to be done is "see what is open in this
scope, move one thing, and get back to work" in under five seconds.

The agents are first-class authors and workers with no screen at all: the board's copilot
over ACP, coding sessions over stdio MCP on the device, and browser-only clients (ChatGPT,
Claude.ai) through an optional hub. They read `kabane_context` and write through
`kabane_*` tools. Every surface has to serve both without either one paying for the other's
affordances.

## Product Purpose

A local-first issue tracker and kanban for one person and their agents. Issues live in
SQLite on the machine, and every write names the human or the agent that made it. One
machine on local SQLite is a complete setup. Several machines converge through an oplog,
and a Cloudflare Worker running the same core joins as one more device that has a public
URL; that hub is optional.

It is not a team tracker. Linear and GitHub stay the team record; kabane links to their
issues by identity and keeps the person's own working notes beside them.

Kabane is going public. Success is a stranger who installs it, lets setup wire their
harness, and watches an agent close their first issue, with no hub and no help from its author.

## Brand Personality

Precise, sleek, dense. A modern TUI in the lane of opencode, packed as tightly as lazygit
and k9s, with Linear's speed and calm: keyboard everywhere, opinionated defaults, one screen
that shows the state. It should sit natively in a herdr pane without redrawing herdr's
frames: herdr draws the lines, and kabane separates its regions with background tone, closer
to OpenTUI's own look than to a boxed dashboard. Sleek because it is precise and well made,
not because it is decorated.

The board's voice is lowercase and declarative (`no dispatcher configured`, `no matches`),
never conversational, never apologetic, and it does not narrate what the user can already
see. Onboarding is the exception: the first-run cards and the setup form are warmer and
explain themselves, saying what each field is for and what enter will write, because the
reader is new and there is no state on screen yet to read.

Chrome is quiet; the accent means something is asking for action, and a status hue says
what state a thing is in. Motion marks live work and fresh change, and nothing else. The
feeling to produce is an instrument telling the truth about its own state, at a glance,
from three feet away.

## Anti-references

- **Jake's `UpstreamWorkCard`** (the planner kabane was extracted from). Two panels,
  cached descriptions, dual timestamps, staleness thresholds, clipboard buttons that build
  agent prompts. Every control was defensible alone; together they made a feature the
  author would not use.
- **Any design that mirrors another system.** The moment local storage holds a copy of
  someone else's content, it inherits caching, staleness, refresh affordances, and warning
  states, none of which were the point.
- **A web dashboard rebuilt in cells.** Jira-style legends, stat panels, and nested boxes
  that spend the narrow pane's columns on facts a single glyph could carry.
- **Austerity as a style.** Bare text where an OpenTUI component (a tonal panel, a select,
  tabs, a scrollbox, rendered markdown, a diff) would read faster and look better. Plain is
  not the goal; legible is.
- **Frames inside frames.** herdr draws pane borders and the terminal may draw its own; a
  kabane border inside them is a line inside a line inside a line.
- **A team tracker.** Assignee pickers across people, sprints, workflow permissions. Linear
  and GitHub already do that, and kabane points at them.
- **The factory line.** Velocity, throughput counts, "done today" tallies. Every issue is a
  one-off; what repeats is the repertoire, and the repertoire is the skills.
- **Confirmation dialogs on navigation.** A keypress that opens something should open it.

## Design Principles

1. **Dense, not bare.** A row still answers yes or no in a glyph, and the detail view
   answers which and what. Components are tools, not taboos: use OpenTUI's panels,
   selects, tabs, inputs, scrollboxes, and markdown and diff rendering wherever they make
   state faster to read or an action easier to take. Regions are told apart by background
   tone, not lines. The test is columns spent and glance time, not element count.
2. **The narrow pane is the design target.** Forty columns, in a split or a herdr pane.
   A feature that is idle on most rows costs nothing on those rows, including in the
   footer. A frame costs two columns at forty; a background tone costs none. Wider panes
   get more room, never a different layout to learn.
3. **Store identity, never content.** Point at other systems; do not copy them. What is not
   stored cannot go stale, and what cannot go stale needs no UI. What kabane does store, it
   dates: information decays silently, so every brief shows its age to humans and agents
   alike, and refreshing one is an agent's job, not a button.
4. **The agent surface is first class.** Agents are users, and the MCP tools are their
   screen. Tool names, descriptions, arguments, errors, and what `kabane_context` returns
   get the same care as the board: an agent gets the scope it needs in one call, spends as
   little of its context window as possible, and never has to guess what a tool will do.
   Anything multi-step that reaches outside kabane is an MCP tool or a copilot skill, not
   a board control; inside kabane (moving, editing, filtering, picking) the board offers
   real UI.
5. **Attention is spent, not decorated.** Gray is a fact, the accent is a request, a status
   hue is a state. There is one accent and a small fixed set of status hues (working, done,
   failed), each paired with its own glyph shape; anything blocked on a human is the
   accent's job. Any other color has to earn its place against every existing use of
   these.

## Accessibility & Inclusion

- **Never color-only.** A glyph or word carries the meaning; color reinforces it. The board
  is read at small sizes under terminal themes nobody controls, so every status hue has
  its own glyph shape and reads correctly with color turned off.
- **Readable on light and dark terminals.** Users bring their own theme. Text that carries
  no meaning uses the terminal's default foreground; fixed colors are reserved for meaning
  and checked against both polarities. Today's board assumes a dark background (near-white
  detail text, a footer lifted from a dark bg) and is out of spec until that changes.
- **Column-width discipline is an accessibility constraint.** Row layout counts columns
  with `.length`, so every glyph, border character included, must be a single narrow BMP
  codepoint. A wide or astral glyph wraps the row and destroys the scan. IBM Plex Mono in
  Ghostty is the reference setup, but users bring any font, which rules out Nerd Font
  private-use glyphs.
- **Degrade over ssh, tmux, and herdr rather than failing.** Anything that reaches the host
  OS (clipboard, opening a URL) falls back to an escape-sequence path and says so in the
  footer.
- **Motion only for live work and fresh change.** Spinners animate only while work is
  actually in flight, and a fresh write gets one brief contrast step before it settles.
  Nothing loops on an idle row. A stale runner keeps its badge and loses its animation.
