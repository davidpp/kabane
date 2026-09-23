# Issue brief

The description is everything the implementing agent gets, besides {{INSTRUCTIONS_FILE}}. Write
it so an agent that reads nothing else can do the work and knows when it is finished. Use plain
paragraphs in this order. The labels help the agent find each part. They are not a form, so
leave out a part that has nothing to say.

**Title.** One line someone can act on. It names the behaviour, not the mechanism: "Closing the
last tab keeps the window open", not "Refactor the tab handler".

**Files.** The paths that change and what changes in each, including new files and the docs that
describe the behaviour. When the issue builds on another one, name it and what it provides.

**Finding.** What is true today, with the evidence: `file:line`, a measured number, the
upstream source that proves a claim. Say why it matters to the person using the project. This is
the paragraph the user reads first, so it is written for them as well as for the agent.

**Design.** What should change. Number the behaviours when there are several independent ones.
State the defaults, and give any configurable option together with the reason it earns its
place (usually one option, never a matrix). When the change needs something across a boundary
the package graph forbids, write the port or callback into the design.

**Out of scope.** The neighbouring work this issue does not touch. Naming it stops an agent from
widening the change in good faith.

**Decisions.** The decisions this issue relies on, when they are recorded in the description.
If they are recorded elsewhere, attach them with `cabane_contextAdd` instead of copying them
here.

**Verify.** The concrete steps and what to observe, under the testing constraints in
{{INSTRUCTIONS_FILE}}. List the checks nothing can script (keys, GUIs, a deploy) as manual
here, so the agent does not try.

**Conventions.** Only what {{INSTRUCTIONS_FILE}} leaves out for this issue: the working copy
it runs in, and any exception to the project's usual commit or gate rules.

When filing, set `priority` too: `high` for the wave's spine, `normal` otherwise, `low` for
parked or out-of-scope findings. A `someday` issue needs only its title and two lines saying what
it is and why it is parked.
