# Product

## Register

product

## Users

One operator (David) across N machines and N agent runtimes, plus the AI runtimes
themselves as first-class authors and workers: Claude Code over ACP inside the board,
Codex and Hermes on their own machines, and browser-only clients (ChatGPT, Claude.ai)
reaching the hub over MCP.

The human's context is a narrow terminal split beside an editor, glancing at the board
between edits. Not a tab he sits in. The job to be done is "see what is open in this
scope, move one thing, and get back to work" in under five seconds.

The agents' context is a tool loop with no screen at all. They read `cabane_context`
and write through `cabane_*` tools. Every surface has to serve both without either one
paying for the other's affordances.

## Product Purpose

A local-first issue tracker and kanban whose authors and workers are AI agent runtimes
as much as humans. Every device keeps an authoritative SQLite and converges through an
oplog; a Cloudflare Worker runs the same core as one more device that happens to have a
public URL.

Success is filing work from anywhere and having the right runtime pick it up, on demand
or by polling. Not adoption, not a product pitch: this is one person's tracker that has
to survive being used every day by a person who is impatient with his own tools.

## Brand Personality

Terse, mechanical, unadorned. The board's voice is lowercase and declarative
(`no dispatcher configured`, `no matches`), never conversational, never apologetic, and
never explains what the user can see. Chrome is gray; the single accent means something
is asking for action. Nothing animates that is not actually in flight.

The feeling to produce is a machine that is telling the truth about its own state, at a
glance, from three feet away.

## Anti-references

- **Jake's `UpstreamWorkCard`** (`packages/dashboard/src/components/planner/`), the
  origin of this file. Two panels, cached descriptions, dual timestamps, staleness
  thresholds, clipboard buttons that build agent prompts. Every control was defensible
  alone; together they made a feature the author would not use.
- **Any design that mirrors another system.** The moment local storage holds a copy of
  someone else's content, it inherits caching, staleness, refresh affordances, and
  warning states, none of which were the point.
- **Jira, and TUIs that reproduce a web dashboard in cells.** Panels, boxes, and legends
  spent on facts that a single character could carry.
- **Confirmation dialogs on navigation.** A keypress that opens something should open it.

## Design Principles

1. **One glyph, one fact.** A row answers yes or no. The detail view answers which and
   what. Never spend a phrase on a row where a character will do.
2. **Store identity, never content.** Point at other systems; do not copy them. What is
   not stored cannot go stale, and what cannot go stale needs no UI.
3. **Agents do the work, the UI does the glance.** Anything multi-step is a copilot
   skill or an MCP tool, not a control. The board stays read-mostly on anything that
   reaches outside it.
4. **The narrow pane is the design target.** Columns are the scarce resource. A feature
   that is idle on most rows must cost nothing on those rows, including in the footer.
5. **Attention is spent, not decorated.** Gray is a fact, the accent is a request. A
   second accent color has to earn its place against every existing use of the first.

## Accessibility & Inclusion

- **Never color-only.** A glyph or word carries the meaning; color reinforces it. The
  board is read at small sizes under varied terminal themes, and the single-accent
  palette leaves no room for hue to be load-bearing.
- **Column-width discipline is an accessibility constraint.** Row layout counts columns
  with `.length`, so every glyph must be a single narrow BMP codepoint. A wide or
  astral glyph wraps the row and destroys the scan. The current font target is IBM Plex
  Mono in Ghostty, which rules out Nerd Font private-use glyphs.
- **Degrade over ssh and tmux rather than failing.** Anything that reaches the host OS
  (clipboard, opening a URL) falls back to an escape-sequence path and says so in the
  footer.
- **Motion only for live state.** Spinners animate only while work is actually in
  flight; a stale runner keeps its badge and loses its animation.
