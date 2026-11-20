# upstream: answer the Team record question again

Question 1, **Team record**, under ## Questions in `{{extension}}/templates/dispatch/PLACEHOLDERS.md`.
An answer other than its recommended one selects the template overlay `references/upstream.md`, a file of the written skill rather than of this one, and fills `{{TEAM_RECORD}}`.

With no dispatch skill in the project yet, run [init.md](init.md): it asks this question with
the others. Otherwise this is a refresh in which this one question is asked again:

1. Follow [refresh.md](refresh.md), but treat question 1 as unanswered even when
   `## This project` records it.
2. Ask it with every choice PLACEHOLDERS.md lists, as it words them, the recommended one first,
   as SKILL.md's "Asking the questions" says. The recorded answer, or one the human's request
   names, becomes the recommended one; the others are still offered. The project's files
   settle the details its answer needs (PLACEHOLDERS.md's entry for `{{TEAM_RECORD}}` says which), not the
   answer itself.
3. Record the answer in `## This project` as `asked`, copy or remove that overlay with it,
   and show the diff before writing, as refresh.md says.
