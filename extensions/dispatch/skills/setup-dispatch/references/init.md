# init: write the project's first dispatch skill

The project has no `.agents/skills/dispatch/` and no `.claude/skills/dispatch/`. When either
exists, this is a refresh: read [refresh.md](refresh.md) instead.

1. Read the project, as SKILL.md's "Reading the project" says, and read
   `{{extension}}/templates/dispatch/PLACEHOLDERS.md`.
2. Settle all six questions under its ## Questions, as SKILL.md's "Asking the questions" says:
   from the project's files where they settle one, and the rest asked together, every choice
   offered. Write nothing until they are answered.
3. Run `{{kabane}} dispatch stamp` for `{{TEMPLATE_STAMP}}`.
4. Copy `{{extension}}/templates/dispatch/` to `.agents/skills/dispatch/`: SKILL.md and every
   file in references/, except PLACEHOLDERS.md, which stays behind, and the overlays no answer
   selects. Fill every placeholder, as SKILL.md's "Filling the template" says.
5. Being asked to set the skill up is the go-ahead: write the files without asking, then show
   the content of each one, and say that deleting the directory undoes it. Link
   `.claude/skills/dispatch` as SKILL.md's "Writing" says.
6. Hand off, as SKILL.md's "Handing off" says.
