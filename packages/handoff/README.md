# @cabane/handoff

What whoever did the work on an issue leaves for whoever reads next, another agent or the human.
The work can be of any kind: a code change, a research note, a design. The module is data: it
declares the entry kind `handoff`, its template and one MCP tool, registered with
`Runtime.configure({ modules: [handoffModule] })`. It has no table of its own: a handoff is an entry
on the issue's timeline, and core renders the brief's section from the kind's declaration. The CLI
and the hub register it; a host that does not keeps handoffs written elsewhere in the Discussion,
labelled with their kind.

## The template

```markdown
### Summary

The smallest picture of what was made or changed.

### Evidence

What you saw, not what you concluded: an output, a quoted source, a measurement, a ref to a screenshot or a file. Before and after, when there is a before.

### Not verified

What you did not or could not check, a check only a human can make included.

### Risk

Whether acting on this can be walked back, and who or what is affected if it is wrong.
```

The headings do the work: no one can write under Evidence without having looked. Nothing checks a
body against them. Drop a heading that does not apply and add one the work needs. For example:

- A code change: the summary sketches the diff; the evidence is the command that was run and the
  lines of its output that matter; not verified names the platform nobody ran it on.
- A research note: the summary is three findings; the evidence quotes each source with its
  `url:`; not verified says which claim rests on one source only.
- A design: the summary lists the states of the screen; the evidence is a `file:` ref to each
  screenshot, with the screen as it was before; the risk says who sees it first.

## The MCP tool

`kabane_handoff` takes `id` (short id or ULID) and `body`, markdown that may not be blank. It adds
an entry of kind `handoff` authored by the caller and changes nothing else: handing off is not
closing, and the issue's state and review flag stay as they are. Its description carries the
template and the rule "show, do not tell". It answers in one line:

```
JCAB-12 handed off · 2 earlier on record
```

A blank body and an issue that does not exist are refused. `kabane_comment` with `kind: "handoff"`
writes the same entry; `kabane_handoff` is the named way in, with the template beside it.

The module's MCP instructions ask an agent to hand off its part of an issue before anyone closes
it, whatever the work was, to show rather than tell, and to say what it did not verify.

## In the brief

The brief (`kabane_context`, `kabane context`) carries the `handoff.latest` section after the
description and before the checklist, and omits it when the issue has no handoff. It shows the
newest handoff verbatim under the kind's framing line and counts the earlier ones, which stay out
of the Discussion:

```
## Handoff from cabane://actor/agent/claude · 2026-11-11T14:02:11.418Z

The author's own account of its work: check the evidence before relying on it.

### Summary

Three findings: the vendor caps requests per minute, per key, and retries count against it.

### Evidence

"100 requests per minute per API key" (url:https://example.com/docs/limits)

### Not verified

Whether the paid tier lifts the cap.

### Risk

Easy to walk back: only the batch size depends on it.

1 earlier handoff entry on record.
```

Earlier handoffs are read with `kabane handoff <id> --all` and on the board's comments tab. Like
every entry, a handoff is never edited or deleted; it goes with its issue.

## Exports

`handoffModule` to register, `HANDOFF_KIND` (the entry kind, `"handoff"`) and `HANDOFF_TEMPLATE`.
`handOff(basePath, { id, body }, actor)` records one as the tool does and returns the entry, the
issue's label and the count of earlier handoffs; `handoffReceipt` is the line every surface
answers with.
