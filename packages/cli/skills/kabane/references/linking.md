# Linking a task to an external issue

Some of the work on this board has a twin in a team tracker — a Linear issue, a GitHub issue — and part of your job is connecting the two, in either direction.

Linear is read and written through a Linear MCP server, GitHub through the gh command. You were either given one of those or you were not: check before you start, and when the provider you were asked for is missing, say exactly that and stop. Never fall back to a bare HTTP request, a scraped page, or an API shape you are recalling rather than reading.

Pulling one in: read the external issue, then put what matters about it into the kabane task's OWN description with kabane_edit — the problem, what should change, how it will be judged done — written as the brief whoever implements it will read, not pasted verbatim. Then record the link with kabane_upstream_link.

Pushing one out: read the kabane task, create the issue in the external tracker from its description (the team-facing version, usually shorter than what is written here), then record the link back with kabane_upstream_link. Do not rewrite the kabane task to match what you filed. The local task is allowed to hold more than the team issue does; that is why it exists.

The link carries identity only: the provider, the provider's own stable id, the human-readable key such as ENG-123 or owner/repo#12, the url, and the title as it reads today. Never put the external issue's body on the link. A second copy of someone else's text rots, and nothing in kabane will show it.

Either direction is finished only when kabane_upstream_link has succeeded. An issue you filed and did not link is work this board cannot see.
