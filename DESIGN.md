---
name: Cabane
description: A kanban for one person and their agents, read at a glance in a forty-column pane.
colors:
  accent: "#f97316"
  working: "#58a6ff"
  done: "#22c55e"
  failed: "#ef4444"
  text: "#e6edf3"
  text-secondary: "#9ca3af"
  text-muted: "#6b7280"
  text-faint: "#4b5563"
  surface-raised: "#1c1c1c"
  surface-overlay: "#262626"
  surface-selected: "#2f2f2f"
  text-light: "#1f2328"
  text-secondary-light: "#57606a"
  text-muted-light: "#6e7781"
  text-faint-light: "#8c959f"
  surface-raised-light: "#f0f0f0"
  surface-overlay-light: "#e8e8e8"
  surface-selected-light: "#dddddd"
typography:
  title:
    fontFamily: "the terminal's font (reference: IBM Plex Mono)"
    fontWeight: 700
  label:
    fontFamily: "the terminal's font (reference: IBM Plex Mono)"
    fontWeight: 700
  body:
    fontFamily: "the terminal's font (reference: IBM Plex Mono)"
    fontWeight: 400
  meta:
    fontFamily: "the terminal's font (reference: IBM Plex Mono)"
    fontWeight: 400
spacing:
  gutter: "1ch"
  bay-gap: "1lh"
  panel-padding: "1ch"
  reserved: "2ch"
components:
  strip-selected:
    backgroundColor: "{colors.surface-selected}"
  bay-label:
    typography: "{typography.label}"
  footer:
    backgroundColor: "{colors.surface-raised}"
    height: "1lh"
  sidebar:
    backgroundColor: "{colors.surface-raised}"
  overlay:
    backgroundColor: "{colors.surface-overlay}"
    padding: "{spacing.panel-padding}"
  copilot-pane:
    backgroundColor: "{colors.surface-raised}"
    padding: "{spacing.panel-padding}"
  field:
    backgroundColor: "{colors.surface-raised}"
  field-focused:
    backgroundColor: "{colors.surface-selected}"
  badge-working:
    textColor: "{colors.working}"
  badge-request:
    textColor: "{colors.accent}"
---

# Design System: Cabane

## 1. Overview

**Creative North Star: "The Strip Bay"**\*

In an air traffic control tower, every flight is a paper strip in a holder, and the strips
sit in bays ordered by what happens next. A controller reads the whole bay at a glance,
moves one strip, marks it in a shorthand every controller shares, and slides a strip out of
line when it needs attention so it cannot be missed. Pilots fly; the controller sequences.
Cabane is that bay. Rows are strips, sections are bays, agents fly the work, and the person
at the board sequences it. Every flight is different and the procedures repeat, which is the
shape of software work: every issue is a one-off, and what repeats is the repertoire of
skills.

The metaphor stops at the tower's calm. It is not the radar screen, not an alarm panel, and
nothing blinks. The board is dense because the pane is narrow, not because it is busy: forty
columns, one line per strip, a glyph where a word would be rent. It is sleek because it is
precise. Regions are told apart by background tone, never by lines, because it lives inside
herdr or a terminal split that already draws frames. It borrows OpenTUI's own look (tonal
panels, rendered markdown, real inputs) over bare text, since the previous board read as
austere and that was a failure, not a style.

It rejects Jake's `UpstreamWorkCard`, any design that mirrors another system, a web dashboard
rebuilt in cells, austerity as a style, frames inside frames, a team tracker, the factory
line, and confirmation dialogs on navigation.

\* *Provisional, 2026-09-23. The Strip Bay was picked as a direction to try, not a settled
identity, and the ATC details it leans on (cocking a strip, strip marking) are general
knowledge that nobody here has checked against real tower practice. Revisit after the first
sleek pass on the board: keep what explained a decision, drop what had to be forced, and
replace the metaphor if it stops earning its keep.*

**Key Characteristics:**
- Forty columns is the design target; wider panes get more room, never a different layout.
- No lines. Background tone separates regions; herdr draws the frames.
- Hue is meaning, contrast is time.
- One accent, and it always means a human is needed.
- Motion marks live work and fresh change, and nothing else.
- A closed glyph notation, one narrow cell per glyph.

## 2. Colors: The Tower Palette

A quiet neutral field that takes its tone from the user's own terminal, with one accent for
requests and three status hues for states.

### Primary
- **Accent** (`{colors.accent}`): a strip pulled out of line. The review flag, a question
  awaiting input, anything blocked on a human, the marked working set, and the cursor of an
  input waiting for you. Its value and name are provisional and get decided in a
  `/colorize` pass.

### Secondary: status hues
- **Working** (`{colors.working}`): work in flight. The spinner and the in-flight badge on a
  row, the copilot indicator while a turn runs, a tool call in the transcript. Provisional
  alongside the accent.
- **Done** (`{colors.done}`): `✓` and `•` for finished work, and a success notice.
- **Failed** (`{colors.failed}`): `✗` and every error line.

### Neutral
- **Default Foreground** (unset): the terminal's own foreground, for every piece of text that
  carries no meaning of its own on the unpainted background: titles, brief text, labels. Never a
  fixed hex.
- **Text** (`{colors.text}`): the same foreground made explicit, for a cell on a painted surface.
  The Selection Rule needs it; it is the terminal's reported foreground when there is one.
- **Secondary** (`{colors.text-secondary}`): one step down from the foreground. A normal-priority
  id.
- **Muted** (`{colors.text-muted}`): chrome. Meta, counts, footer key labels, a linked-issue
  glyph, a paused or stale card.
- **Faint** (`{colors.text-faint}`): what cannot be acted on right now (an unsatisfiable
  trigger), and the title of a cold strip.
- **Raised, Overlay, Selected** (`{colors.surface-raised}`, `{colors.surface-overlay}`,
  `{colors.surface-selected}`): the three painted steps above the terminal's own background.

The grays run the other way on a light terminal: faint is the lightest there, not the darkest,
which is why the `-light` ramp has grays of its own rather than reusing the dark ones.

### Named Rules
**The Cocked Strip Rule.** The accent means a human is needed, and it is never used for
anything else. Not for success, not for running work, not for decoration, not for markdown
list bullets. If an orange cell does not answer "what is waiting on me", it is the wrong
color.

**The Hue Is Meaning, Contrast Is Time Rule.** Hue says what a thing is: request, working,
done, failed. Contrast says how recent it is. A strip an agent just wrote steps up a tone and
settles; a brief nobody has touched in a long time drops to faint. Hue never encodes age, and
contrast never encodes state. Say "contrast", not "brightness": on a light terminal, brighter
means fainter.

**The Derived Surface Rule.** Painted surfaces and the grays are derived from the terminal's own
colors, read once at startup with OpenTUI's `renderer.getPalette()`: the surfaces step the
background toward the foreground, and the grays step the foreground toward the background.
That way cabane matches herdr's pane and any theme, on either polarity, with no tint of its
own. The fixed ramps in the frontmatter are the fallback, chosen by `renderer.themeMode`
when the palette query goes unanswered (tmux without passthrough, for one), and the dark
ramp when neither answers. The steps live in `packages/board/src/theme.ts`, tuned so a
near-black terminal lands on the dark ramp and a near-white one on the light ramp. Every
color in the board comes from there; a hex literal anywhere else fails a test.

**Open.** Priority is color-only today (an urgent id is tinted `{colors.failed}`, a high one
`{colors.accent}`), which breaks "never color-only" and collides with two meanings above.
Resolve it in the `/colorize` pass.

## 3. Typography

**Font:** the terminal's own. IBM Plex Mono in Ghostty is the reference setup, not a
requirement.

**Character:** one monospace face, so hierarchy comes only from weight, tone, and the odd
italic. That is enough if every step is used deliberately.

### Hierarchy
- **Title** (bold, default fg): the board's header line, the detail view's `id · title`, the
  first line of each intro card.
- **Label** (bold, default fg, with a muted count): bay labels (`next · 3`), sidebar group
  titles, markdown headings in a brief.
- **Body** (regular, default fg): strip titles, brief text, transcript text.
- **Meta** (regular, muted): kind and state meta, times, key labels in the footer.
- **Aside** (italic, muted): the detail under a line (an error's message, a tool's
  arguments), the way opencode sets an MCP server's error beside its name.

### Named Rules
**The Lowercase Rule.** Chrome is lowercase and declarative (`no matches`,
`no dispatcher configured`). Content keeps the case its author wrote. Onboarding may speak in
full sentences.

**The Single-Cell Rule.** Every glyph is one narrow BMP codepoint, because row layout counts
columns with `.length`. No emoji, no wide or astral glyphs, no Nerd Font private-use
glyphs.

## 4. Elevation

Flat and tonal. There are no shadows and no borders. Depth is three painted steps above the
terminal's unpainted background: **raised** for docked panels (the sidebar, the footer, the
copilot pane, input fields and code in a brief), **overlay** for floating layers (the
dispatch picker, the help sheet), and **selected** for the one row or field the keyboard is
on. A floating layer sits one step above what it covers and carries one cell of padding
instead of a frame.

### Named Rules
**The No-Line Rule.** herdr draws the lines. Cabane draws no box-drawing borders and no
horizontal rules, and the overlays and the copilot pane lose theirs. A region change is a tone
change. If you reach for a border, the fix is a surface step or a blank line.

**The Selection Rule.** A selected row or field paints an explicit background and an explicit
foreground on every cell. Never `TextAttributes.INVERSE`: with unset colors it swaps default
for default and renders white on white (JJAK-1017).

## 5. Components

### Strips (rows)
- **Notation, left to right:** caret (`▸` / `▾`, expandability only), short id, two spaces,
  mark column, link column, transient `✦ ai`, title, muted meta, then badges (`· review`,
  the in-flight badge, `+N`, `· ? input`).
- **Held columns:** the mark and link columns keep their width when empty, so one vertical
  scan answers "which of these". Transient glyphs hold no column.
- **Fit:** one line per strip, always. The title truncates with `…` and never wraps; badge
  widths count against it; it never drops below four columns.
- **Selected:** `{components.strip-selected}` under the Selection Rule.
- **Fresh:** a strip an agent just wrote shows `✦ ai` in default fg, and its row steps up to
  raised, then eases back to the base over about 600ms with an ease-out curve. It happens once
  and never loops.
- **Cold:** a strip whose brief has gone untouched past one threshold takes a faint title. It
  gets no glyph, no timestamp, and no warning; its age is spelled out in the detail view.

### Bays (sections)
- **Label:** `{components.bay-label}`, lowercase state name, then a muted `· count`.
- **Spacing:** one blank line (`{spacing.bay-gap}`) between bays. No rule, no box.

### Strip marking (the glyph notation)
A closed vocabulary. Adding a glyph changes the language, so it needs a reason that holds
against every glyph already here.

| Glyph | Means | Hue |
|---|---|---|
| `●` (mark column) | in the marked working set | accent |
| `◆` | points at an issue in another tracker | muted |
| `✦ ai` | an agent changed this strip this turn | default fg |
| `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | in flight, on the one surface that owns the fact | working |
| `●` (badge) | in flight, echoed on a surface that does not own it | working |
| `⠋` frozen | in flight, but the runner stopped reporting | muted |
| `⏸` | paused | muted |
| `✓` `•` | done | done |
| `○` | pending plan step | muted |
| `✗` | failed | failed |
| `?` | waiting on your answer | accent |
| `⚙` `←` `▶` `·` `$` | transcript: tool call, tool result, phase, progress, cost | working, muted, working, muted, muted |

### Footer
- **Style:** `{components.footer}`, one row padded to the full width so no content bleeds
  into it.
- **Priority:** a transient notice, then the live search query, then a committed filter's
  summary, then key hints.
- **Hints:** the key in default fg, its label muted (`esc close`), in the opencode manner.
  The full list lives behind `?`. A hint for a key that is inert on this row is not shown.

### Sidebar (activity)
- **Style:** `{components.sidebar}`, frameless rows, bold group labels, `> ` focus gutter.
- **Content:** activity cards grouped by kind, then the questions waiting for input, which
  take the accent.

### Detail view
- **Header:** `id · title` as Title, then the in-flight status line.
- **Brief:** rendered markdown. Headings as Label, list bullets muted, code on raised. No
  heading color: blue belongs to working.
- **Age:** the meta line says how old the brief is in words (`brief · 41d`). This is where
  decay is spelled out.

### Copilot pane
- **Style:** `{components.copilot-pane}`, no border. The first line is `copilot · <harness>`
  with the harness name in default fg and the rest muted.
- **Input:** OpenTUI's `<textarea>` on raised, with the cursor in accent because the input is
  waiting on you.
- **The repertoire:** the `/` list shows each skill name in default fg with its description
  muted. This is the part of cabane that repeats, and it should read like a tidy set of
  tools.

### Overlays (picker, help)
- **Style:** `{components.overlay}`, centered, no border. The title as Title, then one row per
  item, with a selected row under the Selection Rule and unsatisfiable rows faint.

### Setup and intro cards
- **Width:** every line fits forty columns.
- **Fields:** `{components.field}`, focused as `{components.field-focused}` with a `›`
  gutter, and a muted note under each one saying what it is for and what enter will write.
- **Voice:** the one warmer surface: full sentences, still lowercase chrome.

### Motion
- **Spinner:** braille frames at 80ms, animating on exactly one surface per fact; every echo
  shows a still `●`.
- **Fresh change:** the single contrast step described under Strips.
- **Nothing else moves.** No idle loops, no entrance choreography, no bounce.

## 6. Do's and Don'ts

### Do:
- **Do** separate regions with the three surface steps and blank lines, and let herdr draw the
  frames.
- **Do** derive surfaces from `renderer.getPalette()` and fall back to the frontmatter ramp
  that matches `renderer.themeMode`.
- **Do** leave meaningless text on the terminal's default foreground, so it reads on light
  and dark alike.
- **Do** reach for OpenTUI's components (tonal panels, selects, tabs, inputs, scrollboxes,
  markdown, diffs) when they read faster than bare text.
- **Do** pair every hue with a glyph shape, so the board still reads with color off.
- **Do** check every row at forty columns before anything else.

### Don't:
- **Don't** rebuild Jake's `UpstreamWorkCard`: two panels, cached descriptions, dual
  timestamps, staleness thresholds, clipboard buttons that build agent prompts.
- **Don't** design anything that mirrors another system. A copy inherits caching, staleness,
  refresh affordances, and warning states.
- **Don't** build a web dashboard in cells: Jira-style legends, stat panels, nested boxes
  spending the narrow pane's columns on facts a single glyph could carry.
- **Don't** mistake austerity for a style. Bare text where a component would read faster is a
  defect.
- **Don't** put frames inside frames. No box-drawing borders and no horizontal rules, anywhere.
- **Don't** add team-tracker furniture: assignee pickers across people, sprints, workflow
  permissions.
- **Don't** build the factory line: velocity, throughput counts, "done today" tallies.
- **Don't** put confirmation dialogs on navigation. A keypress that opens something opens it.
- **Don't** use the accent for success, running work, or decoration.
- **Don't** show age with hue, a warning glyph, or a timestamp on the row.
- **Don't** use `TextAttributes.INVERSE` for selection.
- **Don't** hardcode a near-white foreground on the terminal's unpainted background; that is
  how today's detail view disappears on a light theme.
- **Don't** add opencode's colored bar down the left of a block. It spends a column at forty
  that a surface step gives for free.
