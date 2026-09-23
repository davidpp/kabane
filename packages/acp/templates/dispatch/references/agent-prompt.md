# Agent prompt

The agent already loads {{INSTRUCTIONS_FILE}}, and its issue is its brief. The prompt adds only
what neither of those can know. Fill in the angle brackets and leave out any line that has
nothing to say.

```
You are implementing <issue id> (<short title>). Read the full brief first with cabane_context
on <issue id>. Since the brief was written, main has gained <what merged, or "nothing">.

Work in your own copy: <the create command, with this issue's branch name>. Do all of your work
there and never in the main checkout.

Running alongside you: <issue id> (<its territory>) and <issue id> (<its territory>). Your
territory is <globs>. Keep your edits to <shared file> to <what, e.g. one registration line>,
and do not reorganise <file>. <Or: "No other agent is running.">

<Only if this issue starts early: "<blocker id> will provide <interface>. Until it merges, work
against a stub of that shape. I will tell you when it lands.">

<One or two pointers the brief leaves out: an existing pattern to copy, or a convention that
matters here.>

<The "Limits every agent is told about" section of the dispatch skill, verbatim.>

Commit and run the gate as {{INSTRUCTIONS_FILE}} describes.

When you finish: add a cabane_comment on <issue id> with what landed, what you verified live and
what is left manual, and anything you saw that is out of scope. Record your branch and each
commit with cabane_log (branch:<name>, commit:<sha>). Leave the issue open and the working copy
in place, because merging is the dispatcher's job. Your final message is the branch, the commit
shas, the gate result and the manual checks.
```
