# kabane

The command line for one device of the tracker. Every command is a thin
argument parser over `@cabane/core` with the `bun:sqlite` adapter; the database
is authoritative on this machine and `kabane sync` converges it with the others.

```bash
bun link            # from packages/cli, once; then `kabane` is on PATH
kabane              # first run: the setup screen, then the board
```

Bare `kabane` in a terminal opens the board. On a device with no
`config.json` it first shows a setup screen: your name (the actor slug,
`cabane://actor/human/<name>`), the device id, the detected coding harnesses
to register `kabane mcp` in.
It writes the same config `kabane init` would, local SQLite and no sync, and
never replaces one that exists. Piped or run by an agent, bare `kabane` prints
help as before. The flag form stays for scripts and for sync:

```bash
kabane init --actor cabane://actor/human/<you> --device <machine> [--sync-url … --sync-token …]
kabane add "Write the deploy runbook" --kind issue --assignee claude --scope myapp
kabane list
```

## Home and config

`KABANE_HOME` (default `~/.kabane`) holds `config.json` and `kabane.db`, with
plain table names, and `detected-scopes/`, the scope ids [detection](#scope) resolved.

```json
{
  "actor": "cabane://actor/human/alex",
  "deviceId": "mbp",
  "sync": {
    "enabled": true, "url": "https://hub.example.com", "token": "…", "deviceId": "mbp", "batchBytes": 262144,
    "headers": { "CF-Access-Client-Id": "…", "CF-Access-Client-Secret": "…" }
  }
}
```

- **actor** is stamped on what this device writes: task provenance, comment
  author, work-log author. Override per call with `--as <actor-uri>`. Actors
  under `cabane://actor/agent/` comment as `ai`, everything else as `human`.
- **deviceId** seeds the sync identity on the first push and is write-once
  after that.
- **sync** is the block `@cabane/core`'s `SyncDevice.connect` reads. Sync is
  enabled when `init` is given both `--sync-url` and `--sync-token`. `headers`
  are sent on every push and pull: the hub sits behind Cloudflare Access, so a
  device carries its Access service-token credentials here, separate from the
  log's bearer `token`. `init --access-client-id <id> --access-client-secret
  <secret>` writes them as `CF-Access-Client-Id` / `CF-Access-Client-Secret`;
  both or neither.
- **db** (optional) points the CLI at another SQLite file and table prefix
  instead of `KABANE_HOME/kabane.db` with plain names. `path` is absolute or
  `~`-expanded; `tablePrefix` defaults to empty. This is how a host app that
  embeds `@cabane/core` shares its database with the CLI, with zero migration
  and no sync between the two hosts, because it is the same file. Jake, the
  planner the CLI was extracted from, is one such host:

  ```json
  { "actor": "cabane://actor/human/alex", "deviceId": "mbp",
    "sync": { "enabled": false, "batchBytes": 262144 },
    "db": { "path": "~/.jake/jake.db", "tablePrefix": "planner_" } }
  ```

  `kabane init --db-path ~/.jake/jake.db --table-prefix planner_` writes that
  block. Both hosts run the same `@cabane/core`, so the schema apply on open is
  the same idempotent one Jake runs at boot. Leave `sync` disabled in this
  shape: Jake already syncs that file as its own device, and `kabane sync`
  warns when `db.path` and sync are both set.
- **extensions** (optional) turns official extensions on by name, e.g.
  `"extensions": ["loop"]`; absent is none. An extension ships inside the
  `kabane` package and adds commands, listed by `kabane help` once it is on,
  and board activity and triggers. It is imported only when one of its
  commands or the board runs, so `kabane list` never loads it. An off
  extension's command prints the line to add here instead of running. A name
  this version does not ship is ignored, with a warning on stderr when a
  command reads the list. The contract an extension implements
  is `@cabane/extension`.

### Settings layers

An extension's settings (today the loop's, under `loop`) resolve through layers, lowest first,
key by key:

1. the schema's defaults;
2. **global**: the namespace's key in `KABANE_HOME/config.json`, for every project on this device;
3. **shared**: `<repo>/.kabane/<namespace>.json` (`.kabane/loop.json`), checked in, for everyone
   who clones the repo;
4. **local**: `KABANE_HOME/projects/<slug>/<namespace>.json`, for this project, for you only, on
   this device. `<slug>` is the project root's path with each run of other characters than
   letters and digits as `-`, then a short hash of it. It holds from anywhere in the project and
   from its worktrees, puts no file in the repo, and does not change when the project's scope
   does. Moving or cloning the directory again starts with no local settings;
5. the command's own flags, or the board's run form.

`--layer user`, `--layer project` and `--layer scope`, the names before these, still mean global,
shared and local. Local settings from before kabane kept them by path, under
`scopes.<scope id>` in `config.json`, are still read as local, just under the file; kabane never
writes or moves them.

A write lands in the layer it names even when a higher one sets the same key, so it can change
nothing yet. `set` and `unset` then say which layer still decides and its value; an unset that
leaves a lower layer deciding names that layer and its value too:

```text
$ kabane config set loop.stallAfter 7 --layer global
loop.stallAfter = 7 (global); here /repo/.kabane/loop.json (shared) still decides: 2. Without --layer, a write here goes to local and overrides it.
$ kabane config get loop.stallAfter --layers
2 (shared: /repo/.kabane/loop.json)
  hides 7 (global: ~/.kabane/config.json)
```

Objects merge key by key, so each layer can add a gate; lists and scalars are replaced by the
higher layer. `null` in a layer unsets what the layers under it say. Every layer is validated on
its own first, so an error names the file it is in; a key no setting has is refused in every
layer. Device keys (`actor`, `deviceId`, `sync`, `db`, `copilot`, `harness`, `timezone`,
`extensions`) have the global layer only: no project file can redirect the database or the hub.

### Managing config from the CLI

```bash
kabane config                         # every key, its value and layer, and its description
kabane config list --json
kabane config get copilot.model        # dotted paths; one value
kabane config get loop.gates --layers  # every leaf under the key, each with the layer it came from
kabane config set copilot.model opus
kabane config set sync.enabled false   # booleans are true or false
kabane config set sync.batchBytes 262144
kabane config set extensions loop      # comma-separated names; "" clears the array
kabane config set copilot.args -- '--model,sonnet'
kabane config set sync.headers '{"CF-Access-Client-Id":"id","CF-Access-Client-Secret":"secret"}'
kabane config set loop.gates.test 'bun test'                 # in a project: local, no file in it
kabane config set loop.model haiku --layer global            # every project
kabane config set loop.lenses quality --layer shared         # the repo's .kabane/loop.json
kabane config get loop.model --scope github.com/acme/app     # another project's legacy scopes block
kabane config unset copilot.model      # remove the key from the layer
kabane config path                     # resolved config.json location
```

Reads resolve for the project the command runs in: its `.kabane/` files when run from the
project's root (what `kabane loop start` reads from there), and its local settings from anywhere
in it. With no `--layer`, a write goes to local inside a project and to global outside one; a
device key always goes to global. `--layer global|local|shared` names the layer.
`--scope <uri or id>` naming another project reads only its legacy `scopes` block, and a local
write for it has to run in that project.

Every operation supports `--json`. `list` returns rows with `key`, `namespace` (the extension
that declares it, absent for a device key), `value`, `default` (no layer sets it), `layer` and
`from` (the file or scope it came from), `hides` (the `{layer, from, value}` each lower layer
sets at the key, lowest first; empty for a group), `readOnly`, `protected`, `description`, and
what the key's schema says of it. A record's entries follow it as rows of their own
(`loop.gates.test`), in its group:

- `field`: its `path` in the namespace (or `config.json`), its `kind` and what bounds that
  kind: `enum` with `values`; `number` with `integer`, and `minimum`, `maximum`,
  `exclusiveMinimum`, `exclusiveMaximum` when set; `boolean`; `string` with `minLength`,
  `maxLength`, `pattern`; `list` with its `item`; `record` with `keyPattern` and its `value`;
  `group` for an object of keys; `other`. Also `optional` (absent is valid), `default` (what
  the schema fills in) and `description`.
- `layers`: the layers it can be written to, `["global"]` for a device key and
  `["global", "shared", "local"]` for an extension's.
- `target` (`list` only): the layer a `set` with no `--layer` writes, `local` for an
  extension's key inside a project and `global` otherwise.
- `secret`: true for `sync.token` and `sync.headers`, which read as `<set>`.
- `label` and `group`: how the key reads on a settings screen, as `config-looks.ts` declares for
  a device key and an extension's `looks` for its own; a key with none reads under its path, in
  its parent object's group or `Other`.
- `options`: the values it steps through, when it has any: the declared ones, resolved for the
  project here (`copilot.harness` the harnesses this build launches, `extensions` the ones it
  ships, `loop.lenses` the project's lenses), else an enum's values or a bounded integer's range.
  `none`: what an optional key left unset reads as, when declared.
- `restart`: when a change applies. `start` for a device key, loaded when a process starts, so
  a running board or MCP server needs a restart; `resolve` for an extension's, read each time
  it is used (the loop's at each run it starts).

`get` returns the resolved value, or JSON `null` / human `default` when absent; with
`--layers` it returns `{key, value, leaves}` and the row's `label`, `group`, `options`, `none`,
`field`, `layers`, `secret` and `restart`, where `leaves` maps every dotted key under `key` to its `value`, `layer`, `from` and
`hides`, the `{layer, from, value}` each lower layer sets there, lowest first, and prints a line
per leaf with what it hides under it. `path` returns a string. `set` returns
`{key, layer, from, value, restart}` and `unset` returns `{key, layer, from, unset: true,
restart}`, `from` being the file written. Either adds `shadowedBy: {layer, from, value}` when a
higher layer still decides the key; an unset adds `fallsBackTo`, in the same shape, when a lower
layer (a legacy `scopes` block included) now decides it. `kabane_configSet` adds
`restartRequired`, true when `restart` is `start`.

Strings are literal; numbers and booleans use JSON syntax. Arrays take trimmed
comma-separated values, with an empty string meaning an empty array.
`sync.headers` and `loop.gates` take a JSON object of string values; one gate is its own key,
`loop.gates.<name>`. Put `--` before a value starting with `--`. Object groups (`sync`, `db`,
`copilot`, `loop`, `loop.budget`) can be read; edit or unset their dotted keys individually.
`loop.lenses` names verifier lenses: `functional` and `quality` ship with kabane, and a lens of
the project's own is `.claude/skills/dispatch/references/lenses/<name>.md` in its dispatch skill,
where a file named after a shipped lens replaces it.
`actor`, `deviceId` and `sync.deviceId` are read-only, including for `unset`.

Writes validate the entire config, or the whole namespace block they land in, before touching
the file, and retain unknown device fields, including those inside groups. A project file keeps
its indentation. Unsetting removes the key from that layer so a lower layer, or the default,
applies. Enabling an unshipped extension preserves its name and prints the extension loader's
warning on stderr. These operations never open SQLite or connect to sync. Except for `path`,
they require an existing config and point to `kabane init` when none exists.

## Scope

`scopeUri` is the context a task is filed under. Storage never resolves it; the
CLI does, from the working directory, so `list`, `search`, `add`, `board` and
`mcp` all land on the same scope whether you run them at a repo root, in a
package below it, or in a worktree. The cascade, highest first:

1. `--scope <uri>`
2. your own pin, `KABANE_HOME/projects/<slug>/scope` (one line, e.g. `myapp`),
   keyed by the project root's path, the main checkout's for a worktree; only
   `kabane init --scope <uri>` writes it, for the project the working directory
   is in
3. `.kabane/scope` — the repo's shared pin, the nearest one walking up; only
   `kabane init --scope <uri> --shared` writes it, into the working directory
4. `.jake/config.json` → `project.id` — a device sharing a Jake database has to
   honour the id Jake already filed tasks under
5. the id detection stored for this checkout in `KABANE_HOME/detected-scopes/`,
   keyed by its root path and holding only while the repo there has the same
   first commit
6. the git remote, normalized to `host/owner/repo` (`origin`, else the first
   remote listed), and stored for step 5, so a checkout keeps its scope when
   its remote is renamed; a fork or another clone resolves by its own remote
7. the first commit, as `git:<hash12>` — replaced by a real remote id if one
   appears later, never the reverse
8. the project root path

Detection writes nothing into the repo, which may be a checkout you don't own.
A `.kabane/scope` an earlier kabane wrote is still read, and never moved or
rewritten; a `git:` id in either pin still gives way to the remote. Your own pin
wins over the repo's, as a local setting wins over a shared one. On a device
that already has a config, `kabane init --scope <uri>` on its own writes only
the pin. Outside a project there is nothing to key your own pin by, so
`init --scope` refuses there unless `--shared` marks the directory.

Outside a project there is no scope and a query spans all of them. Bare ids
normalize to `jake://scope/<id>`; a detected scope also carries `branch` and
`package` as URI parameters, which record where a task was filed and never
narrow a filter. The resolution itself is `@cabane/core/scope` — off the package
barrel, because it needs git and a filesystem and the Worker has neither.

## Output and exit codes

Human text by default, `--json` on any command for the structured value. Exit
codes: `0` ok, `1` error, `2` usage. Errors go to stderr.

## Commands

| Command | Flags |
|---|---|
| `init` | `--actor <uri>` `--device <id>` `--sync-url <url>` `--sync-token <token>` `--access-client-id <id>` `--access-client-secret <secret>` (together; Access service token sent as headers on every push and pull) `--db-path <file>` `--table-prefix <prefix>` (open another database, e.g. Jake's `~/.jake/jake.db` with `planner_`) `--scope <uri>` (writes your own pin for the project under `KABANE_HOME/projects/<slug>/`; alone on a configured device, writes only that) `--shared` (with `--scope`, writes `./.kabane/scope` in the repo instead) `--force` |
| `config [list\|get <key>\|set <key> <value>\|unset <key>\|path]` | `--json` — inspect or edit device config without opening the database |
| `add "<title>"` | `--kind task\|issue` `--state <s>` `--priority urgent\|high\|normal\|low` `--scope <uri>` `--assignee <who>` `--parent <id>` `--description <text>` `--tags a,b` `--due YYYY-MM-DD\|<ISO time>` (a date is due by the end of that day in your timezone; a time without `Z` or an offset is your local time) `--format concise\|full` |
| `list` | `--state <s>` `--kind` `--priority` `--assignee` `--scope` `--tag` `--all` (include done and cancelled) `--limit <n>` `--format concise\|full` `--cursor <cursor>` |
| `show <id>` | task, links, comments, work log, then each module's section (the decisions); `--json` also carries `updatedBy` (actor URI of the last writer), `version`, and `sections`, each module section's markdown by name (`questions.decisions`) |
| `edit <id>` | `--title` `--description` `--state` `--priority` `--kind` `--assignee <who>\|none` `--scope` `--parent <id>\|none` `--tags` `--due` `--format concise\|full` |
| `done <id>` | `--format concise\|full` |
| `search <query>` | `--state` `--scope` `--limit` `--format concise\|full` `--cursor <cursor>` |
| `link <src> <dst>` | `--type blocks\|blocked_by\|parent\|child\|related\|duplicate\|follows` `--note` — a task-to-task DAG edge, not an external issue |
| `upstream link <id> <url>` | `--title <t>` `--provider <p>` `--id <key>` `--external-id <id>` — point a task at one issue in Linear or GitHub. Provider and issue key are read off the URL; the flags cover self-hosted or unfamiliar shapes |
| `upstream unlink <id> [key]` | drop the link; the key is only needed when a task has more than one |
| `open <id>` | launch the task's linked issue: the desktop app when its scheme is registered, else the browser, else the URL lands on the clipboard |
| `comment <id> "<text>"` | `--as <actor>` |
| `questions [<id>]` | `--all` (include answered and withdrawn) `--scope <uri>` `--limit <n>` `--cursor <cursor>` — open questions for the directory's scope or one issue, a bounded page as `kabane_questions` prints it; `--json` is the same page as `{ items, hasMore, nextCursor }`. Pass `nextCursor` back as `--cursor` with the same filters, in either output |
| `answer <handle> <answer…>` | `--reason <text>` (why you chose it); or `--withdraw --reason <text>` — answer `JCAB-12:1` or `id:<ULID>` (a choice by its full text or its label, `B` for "B. One tree", ignoring case; a comma list for multi-select); the full text is recorded, and an unknown choice exits 1 listing the valid ones. The last answer moves a waiting issue to next |
| `log <id>` | `--ref <type:value>` (repeatable) `--commit <sha>` `--branch <name>` `--pr <owner/repo#n>` `--url` `--session` `--file` `--note` |
| `checklist <id>` | the issue's checklist, as the brief's `checklist.items` section prints it; `--json` gives `{ items }`. `checklist add <id> <text…>` `--at <n>` (1-based; default the end), `checklist tick <item…>` `--undo`, `checklist edit <item> [<text…>]` `--at <n>` `--remove` — an item is its handle `JCAB-12.3` or its ULID |
| `context <id>` | `--no-deref` `--no-subtasks` `--format concise\|full` `--sections metadata,description,checklist.items,upstream,position,context,priorWork,discussion,questions.decisions` `--cursor <cursor>` — lossless bounded selected markdown in concise mode; complete legacy brief otherwise. Core's sections, each registered module's after the one it names (`checklist.items` after the description, `questions.decisions` after the discussion) |
| `scope` | `--json` — resolve the current directory without device setup: `{ scopeUri, baseUri, scopeId, name, root, extensions }`; `scopeUri` includes branch/package extensions, `baseUri` omits them. Outside a project: `{ "scopeUri": null }`, exit 0. Text: `name · scopeUri · root` |
| `sync [status\|push\|pull\|backfill]` | `backfill` seeds the log with rows that existed before sync was armed, then pushes |
| `update` | `--check` `--json` — metadata-only stable candidate (policy-unverified), or explicit verified update of a supported hoisted Bun global registry install; no tracker initialization |
| `board` | `--scope <uri>` — the terminal kanban (`@cabane/board`) on this device, no activity feed or dispatcher; those are host ports |
| `mcp` | `--as <actor>` — serve this device over MCP on stdio; the hub's tool list (`kabane_*`), with the working directory's scope as the default so writes may omit `scopeUri` |
| `mcp install` | `--harness claude\|codex\|gemini` (repeatable) `--force` `--print` — register `mcp` in each harness on PATH through its own `mcp add`, as `cabane://actor/agent/<harness>`; `--print` prints the snippets instead, also the fallback when none is found |

Updates are latest-stable only within the installed major (`0.x`: same minor). Source links,
file/tarball/other-manager and unverified isolated/missing-global-bin installs refuse mutation;
no automatic link repair, downgrade, git pull, startup networking or MCP rewiring is performed.
The explicit update preserves Bun registry/proxy/age policy; dry-run may populate external
package-manager caches, while check only reads metadata and may use runtime/metadata caches.
No tracker DB/config is opened. Restart board/MCP after a verified update; binary rollback
is not database rollback. See [compatibility/backup procedure](../../docs/getting-started.md#updating).

Agents should select `--format concise` on list/search/add/edit/done/context.
Context defaults to all sections; concatenate chunks by offset and consume every
preceding chunk before relying on its completeness flags. Finish required
description and human steering before starting work; request omitted sections
with `--sections` and continue using the same flags plus `--cursor`. Queue output
is compact JSON pages (default 20, maximum 100, <=16KiB UTF-8); mutation receipts
are <=2KiB with identity/state/version and no description echo. Follow
`nextCursor` via `--cursor` with the same filters. Preview truncation is explicit;
`show <id> --json` retrieves full fields. Omitted/full formats keep legacy human
text or raw `--json` records. See [concise read semantics](../../docs/concise-reads.md),
including query-relevant stale cursors and independent MCP today buckets.

Ids are short ids (`JCAB-12`) or ULIDs. Short ids are labels, not identities:
two devices can mint the same one offline, and `sync pull` relabels the later
one (`sync status` counts `renamed ids`).

## Checklists

A checklist is the steps of one issue, from the `@cabane/checklist` module. An item has no
assignee, no state beyond done, and no brief; if it needs any of those, it's a subtask
(`add --parent`). Each write prints one line, the receipt the MCP tools
(`kabane_checklistAdd`, `kabane_checklistTick`, `kabane_checklistEdit`) return:

```
$ kabane checklist add JCAB-12 Write the migration
JCAB-12 0/1 · added JCAB-12.1
$ kabane checklist tick JCAB-12.1
JCAB-12 1/1 · ticked JCAB-12.1
$ kabane checklist JCAB-12
## Checklist 1/1

- [x] JCAB-12.1 Write the migration id:01K9Z3V4Q8M2D6E7F8G9H0J1K2
```

`JCAB-12.3` counts every item ever added to the issue, so moving or removing one renumbers
none. A question's handle (`JCAB-12:3`) is refused with the item form to use instead.

## MCP on this device

```bash
kabane mcp install          # every harness on PATH: claude, codex, gemini
kabane mcp install --print  # .mcp.json, config.toml, settings.json, and a generic entry
```

Each harness gets `kabane` at user scope, spawning `<absolute bun> <this
clone>/index.ts mcp --as cabane://actor/agent/<harness>`: absolute because a
harness spawns servers with its own PATH, which often lacks `~/.bun/bin`, and
the bin's `#!/usr/bin/env bun` needs bun on it. An existing entry is reported
and left alone unless `--force`. The table behind both the install and the
snippets is `src/mcp-clients.ts`; `McpInstall.run(harnesses, opts)` in
`src/commands/mcp-install.ts` is the same install for callers other than the
command.

Same tools as a hub at `https://<your-domain>/mcp`: `kabane_scopeList`,
`kabane_add`, `kabane_get`, `kabane_list`, `kabane_search`, `kabane_today`,
`kabane_context`, `kabane_edit`, `kabane_done`, `kabane_link`,
`kabane_comment`, `kabane_log`, `kabane_contextAdd`, `kabane_contextList`,
`kabane_contextRemove`, `kabane_upstream_link`, `kabane_upstream_unlink`, and the
questions module's `kabane_ask`, `kabane_questions`, `kabane_answer`, and the checklist
module's `kabane_checklistAdd`, `kabane_checklistTick`, `kabane_checklistEdit`. A client's
`tools/list` is the authority, with each tool's parameters. The one difference: here a write may omit `scopeUri`
and take the directory default; at the hub it is required. Stdout is the wire,
so the command prints nothing of its own.

## Layout

```
index.ts            bin shim
src/main.ts         command table, help, exit codes
src/args.ts         pure argv parser
src/config.ts       KABANE_HOME, config.json, the scope pins
src/context.ts      Runtime.configure + Planner.init, the Ctx commands receive, scope resolution
src/output.ts       --json vs human rendering, icons
src/first-run.ts    bare `kabane` in a terminal: the setup screen's deps, then the board
src/mcp-clients.ts  per-harness MCP registration argv and config snippets (pure)
src/commands/*.ts   one file per command
cli.test.ts         scripted session against the real binary
```

## Verified

`cli.test.ts` drives every command through the binary. Two devices were
converged by hand through a local `wrangler dev` of the sync log: concurrent
offline creates on both devices, the short-id rename on pull, and `backfill`
from a device that had rows before sync was enabled.
