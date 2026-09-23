# Product

## Register

product

## Users

Developers who already run coding agents (Claude Code, Codex, Gemini CLI) every day and
live in a terminal. They install cabane on their own machine as the place for the work
their agents pick up and report back on. David is the first of them, and daily use by its
author is the floor: a tracker its author stops opening has failed however many others
install it.

The human's context is a narrow pane: a terminal split beside an editor, or a pane in
herdr (a terminal multiplexer for coding agents) next to the agent sessions doing the work.
It is glanced at between edits, not sat in. The job to be done is "see what is open in this
scope, move one thing, and get back to work" in under five seconds.

The agents are first-class authors and workers with no screen at all: the board's copilot
over ACP, coding sessions over stdio MCP on the device, and browser-only clients (ChatGPT,
Claude.ai) through an optional hub. They read `cabane_context` and write through
`cabane_*` tools. Every surface has to serve both without either one paying for the other's
affordances.

## Product Purpose

A local-first issue tracker and kanban for one person and their agents. Issues live in
SQLite on the machine, and every write names the human or the agent that made it. One
machine on local SQLite is a complete setup. Several machines converge through an oplog,
and a Cloudflare Worker running the same core joins as one more device that has a public
URL; that hub is optional.

It is not a team tracker. Linear and GitHub stay the team record; cabane links to their
issues by identity and keeps the person's own working notes beside them.

Cabane is going public. Success is a stranger who installs it, lets setup wire their
harness, and watches an agent close their first issue, with no hub and no help from David.

## Brand Personality

Precise, sleek, dense. A modern TUI in the lane of opencode, packed as tightly as lazygit
and k9s, with Linear's speed and calm: keyboard everywhere, opinionated defaults, one screen
that shows the state. It should sit natively in a herdr pane without redrawing herdr's
frames: herdr draws the lines, and cabane separates its regions with background tone, closer
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

- **Jake's `UpstreamWorkCard`** (`packages/dashboard/src/components/planner/`). Two panels,
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
  cabane border inside them is a line inside a line inside a line.
- **A team tracker.** Assignee pickers across people, sprints, workflow permissions. Linear
  and GitHub already do that, and cabane points at them.
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
   stored cannot go stale, and what cannot go stale needs no UI. What cabane does store, it
   dates: information decays silently, so every brief shows its age to humans and agents
   alike, and refreshing one is an agent's job, not a button.
4. **The agent surface is first class.** Agents are users, and the MCP tools are their
   screen. Tool names, descriptions, arguments, errors, and what `cabane_context` returns
   get the same care as the board: an agent gets the scope it needs in one call, spends as
   little of its context window as possible, and never has to guess what a tool will do.
   Anything multi-step that reaches outside cabane is an MCP tool or a copilot skill, not
   a board control; inside cabane (moving, editing, filtering, picking) the board offers
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
