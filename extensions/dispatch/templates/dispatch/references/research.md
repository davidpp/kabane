# Research

In this project, research runs apart from the session that dispatches, and its notes are kept at
{{RESEARCH_HOME}}.

## Running it

Start the research as its own agent or session, so that its reading does not fill the
dispatching session. Its prompt names:

- the question, as one sentence that a finding can answer;
- the depth, from the Intake table in `SKILL.md`, or the depth the ask names;
- where the note goes, and that it implements nothing;
- the issue it serves, so it can read that issue's brief with `kabane_context`.

The note is the result. It opens with the question and the date, then gives each finding with its
evidence (a path and line, a quote, a measured number, a link), then what it did not check. A
finding with no evidence is a guess, and the note says so.

## After it

Attach the note to every issue that relies on it with `kabane_contextAdd`, kind `research`. A
note inside the repo is a `file:` reference, which the brief inlines. A note anywhere else is a
pointer the agent has to follow, so quote the one or two findings an issue needs in that issue's
Finding.

Research for a wave's parent or a goal can rewrite that issue's description instead of writing
a note: the Finding paragraph becomes the research, with its evidence, and the comment that goes
with the edit says what changed. Keep what the human wrote apart from what the research found.
