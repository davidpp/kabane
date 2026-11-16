---
description: Gather what an implementer needs before work starts on an issue, as one comment on it
target: issue
inputs:
  depth:
    options: [quick, medium, thorough]
    default: medium
    hint: quick reads the brief and the files it names; thorough also reads prior issues and the docs around them
---

Do preliminary research on {{target.shortId}} ("{{target.title}}") at {{inputs.depth}} depth. You are not implementing it.

1. Read the issue's brief with `kabane_context` on {{target.shortId}}, and its open questions with `kabane_questions`.
2. Gather what an implementer would need and does not have yet:
   - the code it touches: files, functions, call sites, with paths and line numbers;
   - the docs, conventions and architecture notes that constrain it (AGENTS.md files, ARCHITECTURE.md, CODING_PRINCIPLE.md, PRODUCT.md);
   - prior issues on the same ground (`kabane_search`), and what they decided;
   - what is unclear or contradicts the brief, and the questions an implementer would have to ask.
   At quick depth, stop at the brief and the files it names. At thorough depth, also follow prior issues and the code around each call site.
3. Write the result as one comment on {{target.shortId}} with `kabane_comment`: what you found, each finding with its evidence (a path and line, a quote, an issue id), then the open questions. Say what you did not check.

Change nothing else: no code, no edits to the issue, and keep its state as it is.
