---
description: Research an issue before work starts and rewrite it into the brief an implementer can work from
target: issue
inputs:
  depth:
    options: [quick, medium, thorough]
    default: medium
    hint: quick reads the brief and the files it names; thorough also reads prior issues and the docs around them
---

Research {{target.shortId}} ("{{target.title}}") at {{inputs.depth}} depth, then rewrite the issue itself into the brief its implementer will work from. You are not implementing it. The issue is the result of this run; the comment is only the note of what you changed.

1. Read the issue's brief with `kabane_context` on {{target.shortId}}, and its open questions with `kabane_questions`. Keep the description as it is now: you will paste it into your comment at the end, so nothing the human wrote is lost.

2. Gather what an implementer would need and does not have yet:
   - the code it touches: files, functions, call sites, with paths and line numbers;
   - the docs, conventions and architecture notes that constrain it (AGENTS.md files, ARCHITECTURE.md, CODING_PRINCIPLE.md, PRODUCT.md, `wiki/`);
   - prior issues on the same ground (`kabane_search`), and what they decided;
   - what is unclear or contradicts the issue as written.
   At quick depth, stop at the brief and the files it names. At thorough depth, also follow prior issues and the code around each call site.

3. Rewrite the issue with `kabane_edit`: its title as one line someone can act on, and its description as a brief in the shape of `.agents/skills/dispatch/references/issue-template.md`. Keep what the human asked for apart from what you found:
   - first the ask: the goal and what should change (Design), what is out of scope, and how to verify it. This is the human's intent. Sharpen it, do not change it; where the research shows the ask cannot work as written, say so there in a line and file the decision (step 4).
   - then the research: Files, and a Finding paragraph that says what is true today, each claim with its evidence (a path and line, a quote, an issue id), and what you did not check.
   Leave the issue's state, priority, assignee and parent as they are.

4. Decisions. A decision the work relies on that is already made (a prior issue, a design record, an answer on this issue) goes in the brief's Decisions paragraph with its source. A decision that is still open and belongs to the human is filed with `kabane_ask` on {{target.shortId}}: the choices, your recommendation and why, one question per decision, all in one call. File only the ones that change what gets built. Do not write open options into the description, and do not decide for the human.

5. Finish with one comment on {{target.shortId}} with `kabane_comment`: what you changed in the issue and why, the questions you filed, and the description as it was before you rewrote it, quoted in full.

Change no code and no other issue.
