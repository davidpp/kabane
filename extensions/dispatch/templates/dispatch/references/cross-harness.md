# More than one harness

This project runs work on more than one coding harness. {{HARNESSES}}

## Splitting the work

Give each harness whole issues, never half of one: an issue's territory belongs to one agent,
whatever runs it. Split by what each harness does well, and by load, not by turns. Write the
issue's brief the same way for either harness. The brief is the whole of what an agent gets, so
nothing in it should assume which harness reads it.

When the work runs as a kabane loop, route an issue with a `tier:<harness>/<name>` tag
(`references/tags.md`) rather than starting it by hand.

## Review across harnesses

A branch one harness wrote is reviewed by an agent on another before it merges. The reviewer
reads the issue's brief, its handoff and the branch's diff, and records what it found on the issue
with `kabane_comment` (kind `review`), each finding graded must-fix or optional, with its
evidence. A must-fix finding goes back to the implementing agent with the review cited; the merge
waits for it. One review pass per branch: a second pass is for a fix that changed the design.
