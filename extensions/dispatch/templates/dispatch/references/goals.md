# Goals

This project carries some of its work as goals: outcomes that take many slices to reach.
`references/tags.md` says what a `goal` issue holds.

## When the ask is a goal

An ask is a goal when no single wave finishes it, or when its finish is something someone
observes rather than a change that merges: a user who can now do X, a number that moves. File it
with `kabane_add` (kind `issue`, tag `goal`, state `next`) and write its four parts. Do not
invent an outcome or exit evidence the human did not give: ask for the missing part on the goal
with `kabane_ask`, and stop there. A goal with a wrong outcome sends every slice in the wrong
direction.

Research the goal at thorough depth before the first slice, and put what you found in the goal's
description as its Finding, so every slice can cite it.

## Slices

A slice is an issue or a wave under the goal, sized and run like any other. File the next one or
two slices, not the whole plan: each landing changes what the next slice should be, and a plan
filed in full goes stale while the first slice is still running. Each slice's brief says which
part of the outcome it moves.

When a slice lands, compare the goal's exit evidence with what now exists. When the evidence is
there, say so on the goal with a `kabane_comment` that shows it, and leave the closing to the
human.

## Who carries the goal

{{STEWARD}}

## Small work beside goals

Small work that serves no goal is tagged `ready` or `needs-brief` (`references/tags.md`). It does
not wait for a goal, but a goal's slice in flight comes first: start queue work only when it does
not touch the files that slice is changing.
