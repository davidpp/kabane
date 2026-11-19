# The team's tracker

This project's team tracks its work in {{TEAM_RECORD}}. That tracker is the team's record. Kabane
holds the detail beneath it, which only the people and agents doing the work need to see.

## What goes where

The team's tracker holds a request at the level the team talks about it: a feature, a bug, a
product or scope decision, a pull request. Kabane holds everything below that: the parent that
plans a request, its waves and subtasks, checklists, research, implementation questions,
handoffs and runs. Do not push kabane's detail upstream. A teammate who opens the request should
see the request and its pull request, not a stream of subtasks.

## Linking

One upstream request maps to one kabane parent. When an ask arrives as an upstream issue, find
or file its kabane parent, link the two with `kabane_upstream_link`, and copy what the upstream
issue says into the parent's description. The link is identity only, and nothing stored on it
can go stale. Dispatch files waves and subtasks under that parent, and none of them goes
upstream. An upstream epic or project may map to a kabane issue tagged `goal` in the same way.

An ask with no upstream twin either gets one, when the team would track it as its own request,
or stays in kabane only.

## Along the way

- **New work found mid-wave.** A new bug, or a follow-up the team would track as its own request,
  is filed upstream through the team's tracker and linked. Anything smaller is a kabane issue
  under the parent, or a `someday` issue.
- **Decisions.** A product or scope decision goes on the upstream issue or the pull request,
  where the team sees it. An implementation choice stays in kabane, with `kabane_ask`.
- **Commits and pull requests** cite the upstream id, never a kabane id, and only as a plain
  reference while the request is still in progress. A kabane id goes in the issue's work log,
  as `kabane_log` with a `commit:` reference.

## Closing

A request may land as several pull requests, across one wave or several, and only the one that
completes it closes the request: it alone uses the tracker's closing form, so that an earlier
merge does not close a request that is half done. Its description carries the parent's handoff, condensed: what landed, the evidence, and
what is left to check. Close the kabane parent with `kabane_done` once that pull request has
merged; when the parent is a `goal`, leave the closing to the human. Its children close in
kabane and leave no trace upstream.

Kabane never writes to the team's tracker. The agent does, with the tracker's own tools.
