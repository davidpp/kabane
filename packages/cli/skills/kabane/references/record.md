# Model work on the record

Kabane 2.0 stores everything in four shapes. Before you write, decide which one the thing is: the
choice decides who can find it later, what a retry does, and what two devices do when both write
it.

| Shape | What it is | Ask yourself | Retry or a second device |
|---|---|---|---|
| Thread | Something that can be owned, discussed and finished: a request, a bug, a design question, a job. It has a title, a body, a scope, a parent, and may have a state and an assignee. | Will someone pick this up, or will people talk about it, on its own? | A new thread each time, unless it was filed with a key |
| Entry | Something that happened or was said, by an author at a time: a comment, a finding, a decision, a question and its answer, a handoff, a work log line. Never edited. | Is it a fact about a moment that should stay as it was said? | A new entry each time |
| Attribute | A current fact about a thread with one value per key: priority, due date, tags. It changes. | Should a reader see only the latest value? | The last write wins; the same value twice is one row |
| Ref | A URI the thread keeps pointing at, with a kind: what it reads, what it maintains, its twin in GitHub or Linear, another thread. | Is it a pointer someone will follow, not text to keep? | One row, never a duplicate, but adding it again rewrites that row: see the table below for what each kind of ref keys on |

Two rules settle most cases:

- **Work is a thread, what happened on it is an entry.** A finding that changes the work in front
  of you is an entry on that thread. A finding that is its own work is a new thread, linked back.
- **Store the pointer, not the content.** A Slack message, a PR, a design file and a transcript
  stay where they are, behind a ref or a logged URI. The thread's body says what matters about
  them in your own words.

## What 2.0.0-beta.0 exposes

| To do this | MCP | CLI | A retry |
|---|---|---|---|
| File a thread | `kabane_add` | `{{kabane}} add` | Duplicates, unless you pass `key` (`<plan>/<name>`, lowercase): then it returns the first one with `existed: true` and changes nothing |
| File a plan of threads and links | `kabane_apply` | `{{kabane}} apply <file> --key <plan>` | Creates only what is missing. A thread already there keeps its fields even if the file changed them; edit it instead |
| Change state, assignee, priority, due, tags, parent | `kabane_edit` | `{{kabane}} edit` | Same value, same result. `tags` replaces the whole list |
| Claim a thread | `kabane_edit` state `in_progress` | `{{kabane}} edit <id> --state in_progress` | Still yours, but it also sets the state again: a thread you claimed and then put in `waiting` goes back to `in_progress` |
| See who holds a claim | the result of a claiming edit only | `{{kabane}} wait state <id> in_progress waiting --timeout 1s` prints `claimedBy` | |
| Comment, or record a finding, decision or review | `kabane_comment` with `kind` | `{{kabane}} comment <id> "…" --kind <kind>` | Duplicates |
| Record work done (commits, PRs, branches, files) | `kabane_log` | `{{kabane}} log` | Duplicates: each call is one occurrence |
| Ask the human a decision | `kabane_ask` | none | Duplicates the question |
| Answer or withdraw a question | `kabane_answer` | `{{kabane}} answer` | |
| Hand off your part | `kabane_handoff` | `{{kabane}} handoff <id> --from <file>` | Duplicates; the brief shows only the latest |
| Point at an input or a maintained output | `kabane_contextAdd` (`uri`, `kind`, `label`, `note`) | none | One row per thread and URI. Adding it again rewrites `label`, `note`, `addedBy` and `addedAt` (a label you leave out is dropped), and a different `kind` replaces the ref: the URI loses its old kind. Read `kabane_contextList` before you re-add a URI |
| Link two threads (`blocks`, `related`, `duplicate`, `follows`) | `kabane_link` | `{{kabane}} link` | One row per pair and type, so `blocks` and `related` between the same two threads are two links. Linking again rewrites its `note` and time |
| Record the GitHub or Linear twin | `kabane_upstream_link` (`provider`, `externalId`, `url`) | `{{kabane}} upstream link <id> <url>` | One row per thread, provider and external id. Linking again rewrites its title and URL and keeps when it was first made |
| Wait for an answer, a state, blockers done, or something addressed to an actor | none | `{{kabane}} wait answered\|state\|ready\|addressed` | Returns at once if already true |
| Read the whole brief | `kabane_context` | `{{kabane}} context <id> --format concise` | |

An entry kind is a free string. The shipped ones are `outcome.finding`, `outcome.decision`,
`outcome.verification` and `outcome.summary`, which the brief shows in its Discussion, and
`handoff`, which it shows under the description. Prefer those over a kind of your own, so the
next reader's tools recognise them.

Not exposed in 2.0.0-beta.0, so do not try to reach them through another call:

- An attribute under a key of your own. Use a tag (`request`, `finding`, `idea`), and remember
  `tags` is one list that an edit replaces whole, so read it first and write it back with yours
  added.
- Addressing an entry to an actor of your choosing, or replying to one entry. Only `kabane_ask`
  addresses an entry, to the human, and only `kabane_answer` replies.
- A retry-safe comment, log line, question or handoff. Before writing one again after a crash,
  read the thread and check whether the first one landed.
- Finding a thread by a ref's URI. `kabane_search` reads titles and descriptions only, so put
  the words someone will search for in the title or body.
- The brief does not show tags, `related` links or who holds the claim. Read tags with
  `kabane_get`, every link with `kabane_linkList`, and the claim with `{{kabane}} wait state`.

## A client request

Ana at Acme asks in Slack for the SSO audit log as a CSV.

1. **A thread**, because someone will own it and finish it. Give it a key built from the
   message's own id (channel `C1`, message `p123`), lowercased, so a second agent reading the same
   message files the same thread instead of a duplicate:
   `kabane_add` with title `Acme: export the SSO audit log as CSV`, kind `issue`, tags
   `["request"]`, key `acme-requests/slack-c1-p123`, and the ask in Ana's words in the description, with
   who asked and when.
2. **A ref** to where it was asked: `kabane_contextAdd` with uri
   `url:https://acme.slack.com/archives/C1/p123`, kind `source`. The message stays in Slack.
3. **Attributes** for what is current: priority and a due date with `kabane_edit`.
4. **Entries** for what happens next: a call note with `kabane_comment`, and a decision Ana has
   to make goes to the human with `kabane_ask` (the human relays it), never into the
   description.

The tag is what tells a request from a finding later: `kabane_list` with tag `request`. A request
is a hard ask and stays open until it is done or cancelled.

## An unsolicited finding

While working on the CSV export, you notice that a sync test times out on CI three runs in ten.

- If it blocks or changes the export, it is **an entry** on the export's thread:
  `kabane_comment` with kind `outcome.finding` and where you saw it.
- If it is separate work, it is **a new thread** with tag `finding`, left in `inbox` with no
  assignee, since nobody asked for it: `kabane_add`. Put the evidence in a first
  `outcome.finding` entry on it, and `kabane_link` it `related` to the export so either reader
  can get from one to the other. Do not fix it unasked.

An idea is the third case: a thread tagged `idea`, filed like a finding because nobody asked for
it, but it grows instead of going stale. Research on it goes in child threads, and the idea
gains one entry with each conclusion. A finding can go stale and an idea can be dropped when
nobody acts on it; a request cannot. Kabane closes nothing on its own: a job or a person cancels
old findings and ideas with an entry saying why.

## A design discussion

You and the human are deciding how the CSV export pages through large logs, around a design
file.

- **A thread** whose body is the question and the constraints, under the request it serves
  (`parentTaskId`), with **a ref** of kind `design`
  to the file (`file:docs/export.md`, or a URL). The discussion is about the file but is not
  the file.
- Each turn of the discussion is **an entry**. A conclusion is an `outcome.decision` entry: the
  question, the choice, who chose. A choice that belongs to the human goes through `kabane_ask`,
  whose answer the brief shows under Decisions.
- Research that would bury the thread goes in **a child thread** (`parentTaskId`). The parent
  gets one entry with the conclusion and a ref to the result.
- When the discussion produces work, file that work as its own threads under it and link them,
  rather than turning the discussion itself into the build.

## Worked path: a plan, a claim, a question, a second agent

This is the coding use, but the steps are the same for any work two agents share.

1. **The lead files the plan in one call.** `{{kabane}} apply plan.json --key sso-csv`, or
   `kabane_apply` with the same document:

   ```json
   {
     "threads": [
       { "key": "spec", "title": "Write the CSV export spec", "state": "next", "assignee": "claude", "parent": "acme-requests/slack-c1-p123" },
       { "key": "build", "title": "Build the CSV export", "state": "next", "assignee": "codex", "parent": "acme-requests/slack-c1-p123" }
     ],
     "links": [{ "from": "spec", "to": "build", "type": "blocks" }]
   }
   ```

   The threads are `sso-csv/spec` and `sso-csv/build`, under the client request they serve, so
   the request's brief lists them as its subtasks. If the lead crashes and applies the file
   again, it prints `0 created, 2 already there`. Adding a thread to the file and applying again
   creates only that one.

2. **Each worker claims before touching anything.** `kabane_edit` on `sso-csv/spec` with state
   `in_progress`. The thread already names its assignee, so set only the state; on an unassigned
   thread, set the assignee and the state in the same edit. The result says `claimedBy` and
   `claimHeld`. A null `claimedBy` means no claim was made, because the thread has no assignee.
   If `claimedBy` names another agent, it holds the thread: leave it. The
   first claim wins on every device once they sync. A claim lasts while the thread is
   `in_progress` or `waiting`; any other state releases it. After a crash, read the state before
   claiming again: if the thread is `waiting` and `{{kabane}} wait state` names you in `claimedBy`,
   it is still yours, and claiming again would pull it out of `waiting`.

3. **A decision goes to the human.** `kabane_ask` on `sso-csv/spec`. The thread moves to
   `waiting`. A worker with a shell can block on the answer:
   `{{kabane}} wait answered <handle> --timeout 2h`. The last answer moves the thread to `next`,
   which releases the claim, so when the wait returns, claim it again (step 2) and read the
   answer itself with `kabane_questions` (the wait says only that it was answered).
   Calling `kabane_ask` again would ask twice, so after a crash read `kabane_questions` first.

4. **The work is logged as it lands.** `kabane_log` with `commit:<sha>` and `pr:<owner>/<repo>#<n>`
   refs, then `kabane_handoff`: what changed, what you saw, what you did not verify. What the
   next step must read, such as the spec file, gets a ref on that step's thread
   (`kabane_contextAdd` on `sso-csv/build`, kind `spec`), so its brief carries it. Then
   `kabane_done`.

5. **The second agent waits on the record, not on a message.** Codex, on another harness or
   another device, runs `{{kabane}} wait ready sso-csv/build`. It returns when every blocker is done
   or cancelled. Codex then claims `sso-csv/build` (step 2) and reads `kabane_context` on it: the
   brief shows its parent, what blocked it and the blocker's state. For the spec itself it reads
   `kabane_context` on `sso-csv/spec`, whose brief carries the latest handoff, the answered
   decisions, the context refs and the work log. `kabane_linkList` and `kabane_get` give the
   `related` links and the tags the brief leaves out.

Across two devices, each wait reads the local database: the other device's write shows once
sync has delivered it.

## What an enabled extension adds

An extension that ships a skill is listed by `kabane_skillList`. Its skill's "On the record"
section lists the MCP tools and commands the extension exposes and what each writes, as a
thread, an entry, an attribute or a ref. What it writes lands in the same four shapes, so the
rules above still hold:

- An extension that drives a parent's subtasks through harnesses claims them as in step 2, and
  skips a thread someone has taken (`in_progress`) or parked (`waiting`, `someday`).
- A thread of kind `job` is a standing request that a schedule runs, its description being the
  request. Its schedule and runs are kept in the extension's own tables, not on the thread, so a
  run leaves what a reader needs as entries on the job. What the job keeps up to date is a ref
  of kind `artifact` on it, added with `kabane_contextAdd`.

What kabane leaves to the harness or to something on top: coming back to a thread later
(schedule it in your harness, or make it a job), a lease that expires a dead claim (a stale claim
stays until someone puts the thread back), a `failed` state (record the failure as an entry and
put the thread back), and a feed of everything new since you last looked (read by state:
`{{kabane}} wait addressed <actor>`, `kabane_questions`, `kabane_list`).
