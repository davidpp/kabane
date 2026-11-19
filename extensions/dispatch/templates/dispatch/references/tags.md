# Tags

Tag an issue only from this list. A tag someone invented on the spot is one nothing reads, and
the next agent invents a different one for the same thing.

## Tags that change what happens

- **`goal`**: an outcome carried across many slices of work. Its description holds four parts:
  the outcome (what is true for the person using the project when it is done), the non-goals,
  the exit evidence (what someone can observe that proves the outcome), and the delegation (what
  an agent may decide alone, and what goes to the human first). Its children are the work. It is
  finished when its exit evidence exists, not when its children are closed, and only the human
  closes it. Dispatch files work that serves a goal under it with `parentTaskId`.
- **`ready`**: small work that waits for no goal, whose brief stands as written: one concern,
  one territory, no open decision, nothing a goal's non-goals rule out, and no change to stored
  data or to a contract other code relies on. Whoever works the queue starts it without filing
  anything more. Set it when you file an issue that meets all of that.
- **`needs-brief`**: worth doing, but its brief is too thin to run. Whoever rewrites the brief
  takes this tag off, and adds `ready` when the rewrite meets the bar above.
- **`tier:<name>`**, **`tier:<harness>/<name>`** and **`agent:<name>`**: route a subtask's claim
  in a kabane loop run, to a tier's model, to a harness, or to a harness's named agent. The
  loop's docs define them ("Pick models with tiers" and "Route a subtask with tags"). Set them
  only on work a loop run will claim.

## Tags that describe

{{TAGS}}

A descriptive tag changes nothing by itself. It lets someone list the issues of one kind.
