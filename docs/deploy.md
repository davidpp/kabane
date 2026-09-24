# Self-hosting the hub

This is the optional Cloudflare hub, for syncing several machines; one machine on local
SQLite needs none of it ([`getting-started.md`](getting-started.md)). You host it on your own
Cloudflare account, on a domain you own, behind your own Cloudflare Access team. Nobody
else's hub is involved.

**Verified locally:** 2026-09-07 against `wrangler dev` with the dev verifier (see the last
section). Steps an agent must never perform are marked **MANUAL**: they touch Cloudflare,
DNS, Access, or a connector UI. Everything else was run as written.

Placeholders used throughout:

| Placeholder | Example | What it is |
|---|---|---|
| `<your-domain>` | `hub.example.com` | the hostname the hub answers on, in a zone on your Cloudflare account |
| `<team>` | `example` | your Zero Trust team name; the Access issuer is `https://<team>.cloudflareaccess.com` |
| `<your clone>` | `~/src/kabane` | where you cloned this repository |

Reading order matters. Part 1 builds the hub, part 2 the first device, part 3 the others,
part 4 connects clients, part 5 is what you do when something changes. The auth decision
behind part 1 is in [`auth.md`](auth.md).

What you end up with:

```
laptop ──┐                       ┌── Claude Code  (service token, CLI or hub)
desktop ─┼── <your-domain> ──────┼── Hermes       (service token)
hermes ──┘   CabaneLog (oplog)   ├── Codex        (service token)
             CabaneHub (device   ├── Claude.ai    (Managed OAuth)
             "cloud", MCP)       └── ChatGPT      (Managed OAuth)
```

Every device keeps an authoritative SQLite. The hub is one more device with a public URL.

---

## 1. Cloudflare

Prerequisites, all on your own Cloudflare account:

- A zone for the domain `<your-domain>` lives in (the hub's hostname can be a subdomain of it).
  Wrangler creates the DNS record for the custom domain; add nothing by hand.
- A Zero Trust organization, which gives you the Access team `<team>` and its issuer
  `https://<team>.cloudflareaccess.com` (Zero Trust → Settings → Team name). The Zero Trust
  Free plan is enough.
- The Workers Free plan is enough (1.1 says why).

### 1.0 Deploy from GitHub Actions instead of your laptop — MANUAL once

`.github/workflows/ci.yml` runs the gate on every push. Its `deploy` job runs only when you
start it: in your fork or copy of this repository, Actions → `ci` → **Run workflow** on
`main`. It runs the gate, then deploys the Worker with `cloudflare/wrangler-action` to the
domain and Access team you configure below. A run with a required value missing fails
before deploying and names what is missing. Once set up, 1.1, 1.2, 1.5 and 5.7 are one
workflow run each; the Access application, service tokens and Managed OAuth (1.3, 1.4, 1.6)
remain dashboard work either way.

In the repository settings create the `production` environment and add:

| Kind | Name | Required | Value |
|---|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | yes | An API token from the Cloudflare dashboard with `Workers Scripts: Edit`, `Workers Routes: Edit`, `Account Settings: Read`, and, because the Worker owns the `<your-domain>` custom domain, `Zone: DNS: Edit` and `Zone: Workers Routes: Edit` on that zone |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | yes | Overview page of the account |
| Secret | `SYNC_TOKEN` | yes | `openssl rand -base64 32`; uploaded to the Worker on every deploy |
| Variable | `HUB_DOMAIN` | yes | `<your-domain>`, bare hostname, no scheme; passed as `wrangler deploy --domain` |
| Variable | `ACCESS_TEAM_DOMAIN` | yes | `https://<team>.cloudflareaccess.com` |
| Variable | `ACCESS_AUD` | no | The AUD tag from 1.3 |
| Variable | `HUMAN_EMAIL` | no | Your address, the one in the Allow policy |
| Variable | `SERVICE_ACTORS` | no | The JSON map from 1.5, one line |
| Variable | `KABANE_TIMEZONE` | no | Your IANA timezone (1.5); empty is UTC |

`ACCESS_AUD`, `HUMAN_EMAIL` and `SERVICE_ACTORS` can stay empty until 1.3 and 1.4 are done;
an empty value deploys a Worker that admits nobody, exactly like a fresh manual deploy. Run
the workflow again after filling them. None of these values go into `wrangler.jsonc`: its
`vars` block holds empty placeholders, the job passes each variable with `--var`, which
overrides the file, and the domain with `--domain`.

### 1.1 Log in and deploy — MANUAL, or skip when 1.0 is set up

```bash
cd <your clone>/packages/worker
bunx wrangler login
bunx wrangler deploy --domain <your-domain>
```

Expected: the deploy creates the Worker `cabane-worker`, applies migration tag `v1`
(`CabaneLog` and `CabaneHub` as SQLite-backed Durable Object classes), and attaches the
custom domain `<your-domain>`. `wrangler.jsonc` names no route or domain, so every deploy
passes `--domain`. Wrangler creates the DNS record for a custom domain; nothing to add by
hand. `bunx wrangler deploy --dry-run` builds and lists the bindings without uploading, if
you want to check the bundle first. No `workers.dev` URL and no preview URL are published
(`workers_dev` and `preview_urls` are `false`). The Workers Free plan is enough: SQLite-backed Durable Objects are the only kind
it offers, and the limits (100k requests and 100k rows written per day, 5 GB stored) are
far above one person's tracker.

Check:

```bash
curl -i https://<your-domain>/health
```

Expected: `HTTP/2 401` **from the Worker** with body `{"error":"unauthorized"}`. Access
is not in front yet, so the request reaches the Worker, which refuses it because no
assertion is present. If you get `522` or a Cloudflare error page, the custom domain has
not finished provisioning; wait a minute.

### 1.2 The log secret — MANUAL

```bash
openssl rand -base64 32          # keep the output, every device needs it
bunx wrangler secret put SYNC_TOKEN
```

Paste the value when prompted. Expected: `✨ Success! Uploaded secret SYNC_TOKEN`. Devices
send this as `Authorization: Bearer` on `/push` and `/pull`; it is the log's own check and
sits behind Access, so it is the second wall, not the perimeter.

### 1.3 The Access application — MANUAL

Zero Trust dashboard → **Access controls → Applications → Add an application →
Self-hosted** (or **AI controls → MCP servers → Add an MCP server** if you want the MCP
server application type; both produce an application with an AUD and the same policy
model). Fill:

| Field | Value |
|---|---|
| Application name | `kabane` |
| Application domain | `<your-domain>`, path empty (every route is protected, `/health` included) |
| Session duration | 24 hours (browser sessions only; service tokens do not use it) |

Policies, two of them:

| Policy | Action | Include |
|---|---|---|
| `owner` | Allow | Emails: your address |
| `runtimes` | Service Auth | Service Token: every token created in 1.4 (come back and add them) |

No Bypass policy anywhere. `auth.md` depends on it: Access rejects every unauthenticated
request before the Worker runs, and a Bypass would take that away.

After saving, open the application and copy the **Application Audience (AUD) Tag**. That is
`ACCESS_AUD`.

### 1.4 Service tokens, one per runtime — MANUAL

**Access controls → Service credentials → Service tokens → Create Service Token**, four
times, duration 1 year:

| Token name | Runtime | Actor the Worker stamps |
|---|---|---|
| `kabane-claude-code` | Claude Code | `cabane://actor/agent/claude` |
| `kabane-hermes` | Hermes | `cabane://actor/agent/hermes` |
| `kabane-codex` | Codex | `cabane://actor/agent/codex` |
| `kabane-cron` | scheduled pulls on devices | `cabane://actor/agent/cron` |

Each creation shows the **Client ID** (ends in `.access`) and the **Client Secret** once.
Store the secret in the runtime machine's keychain or env; it never goes into a repo. The
client ids go into `SERVICE_ACTORS` in the next step. Then return to 1.3 and add the four
tokens to the `runtimes` Service Auth policy.

### 1.5 Fill the vars and redeploy — MANUAL

With CI (1.0), set the variables `ACCESS_AUD`, `HUMAN_EMAIL`, `SERVICE_ACTORS` and
`KABANE_TIMEZONE` in the `production` environment and run the workflow again. By hand,
pass them on the deploy command:

```bash
cd <your clone>/packages/worker
bunx wrangler deploy --domain <your-domain> --var \
  "ACCESS_TEAM_DOMAIN:https://<team>.cloudflareaccess.com" \
  "ACCESS_AUD:<the AUD tag from 1.3>" \
  "HUMAN_EMAIL:<your address, the one in the Allow policy>" \
  'SERVICE_ACTORS:{"<claude-code client id>.access":"cabane://actor/agent/claude","<hermes client id>.access":"cabane://actor/agent/hermes","<codex client id>.access":"cabane://actor/agent/codex","<cron client id>.access":"cabane://actor/agent/cron"}' \
  "KABANE_TIMEZONE:<your IANA timezone, e.g. America/Toronto>"
```

`wrangler.jsonc` keeps empty placeholders for the Access vars, and a deploy replaces every
var with the file's value unless `--var` names it. So every manual deploy passes the whole
set: a later `bunx wrangler deploy` without it resets them to empty and closes the hub. Keep
the command somewhere outside the repository (a script next to your other credentials), or
let CI deploy. The AUD and the client ids are identifiers, not secrets, but they are yours
and do not belong in a tracked file.

Empty `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `HUMAN_EMAIL`, or `SERVICE_ACTORS` means nobody is
admitted, which is the state the fresh deploy from 1.1 was in. `KABANE_TIMEZONE` is your
IANA timezone: the hub has no timezone of its own, and it decides which day is today and
when a date deadline's day ends for the browser clients (ChatGPT, Claude.ai) that reach
kabane through the hub. Unset, the hub uses UTC, so a date due today turns overdue in the
evening anywhere west of Greenwich; a name the runtime does not know stops the hub from
booting and says so, rather than guessing.

Check, from a machine with a service token:

```bash
curl -s https://<your-domain>/health \
  -H "CF-Access-Client-Id: <client id>" \
  -H "CF-Access-Client-Secret: <client secret>"
```

Expected: `{"ok":true,"service":"cabane-worker","actor":"cabane://actor/agent/claude"}`
with the actor matching the token you used. And the reject test:

```bash
curl -i https://<your-domain>/health
bunx wrangler tail --format pretty      # in a second terminal, while running the curl
```

Expected: a `302` to the Access login page (a browser) or `401` from Access (a non-browser
client), and **no invocation in `wrangler tail`**. Access rejected before the Worker ran.

### 1.6 Managed OAuth for browser connectors — API for the toggle, MANUAL for the allowlist

Only needed for Claude.ai and ChatGPT. The Worker needs no change: Managed OAuth ends in
the same `Cf-Access-Jwt-Assertion` the Worker already verifies (`auth.md`, topology a).

**The toggle is an API field** (verified 2026-09-07 on a live application). `PUT
/accounts/<id>/access/apps/<app>` with the existing fields plus:

```json
"oauth_configuration": {
  "enabled": true,
  "dynamic_client_registration": {
    "enabled": true,
    "allow_any_on_localhost": true,
    "allow_any_on_loopback": true
  }
}
```

The two `allow_any_on_*` flags are what the dashboard calls **Allow localhost clients** and
**Allow loopback clients** (Claude Code and the MCP inspector redirect to
`http://localhost:<port>/callback`). Note the PUT must resend `policies` as
`[{ "id", "precedence" }]` or the application loses them.

**The allowlist and lifetimes are dashboard-only.** The API accepted but did not persist
`allowed_redirect_uris`, `access_token_lifetime`, and `grant_session_duration` (verified:
they never come back on GET). Set them by hand: Zero Trust → **Access controls** →
**Applications** → `Kabane` → ⋯ → **Edit** → **Advanced settings** → Managed OAuth section:

| Setting | Value |
|---|---|
| Allowed redirect URIs | `https://chatgpt.com/connector/oauth/*` |
| | `https://chatgpt.com/connector_platform_oauth_redirect` |
| | `https://claude.ai/api/mcp/auth_callback` |
| Access token lifetime | 15 minutes |
| Grant session duration | 14 days |

Whether an empty allowlist admits any `https` redirect or none is not documented; add the
three URIs before testing a browser connector so the result is unambiguous.

Check (both were verified live after the API call):

```bash
curl -s https://<your-domain>/.well-known/oauth-authorization-server
curl -s -o /dev/null -D - -X POST https://<your-domain>/mcp -H 'Content-Type: application/json' -d '{}' | grep -i www-authenticate
```

Expected: the first returns JSON with `issuer` `https://<team>.cloudflareaccess.com`,
`authorization_endpoint`, `token_endpoint`, `registration_endpoint` under
`/cdn-cgi/access/oauth/`, and `code_challenge_methods_supported: ["S256"]`. The second is a
`401` carrying `WWW-Authenticate: Bearer realm="OAuth" ... resource_metadata="https://<your-domain>/.well-known/cloudflare-access-protected-resource/mcp"`,
which is the RFC 9728 pointer ChatGPT and Claude.ai follow.

---

## 2. First device

### 2.1 Install the CLI

The CLI is not on npm yet, so it runs from a clone. `bun link` is the install path that was
verified; `bun install -g` from a path is not supported for a workspace package and was not
used.

```bash
git clone https://github.com/davidpp/kabane.git
cd kabane && bun install
cd packages/cli && bun link
kabane --help
```

Expected: `bun link` prints `Success! Registered "kabane"`, `which kabane` answers
`~/.bun/bin/kabane`, and `--help` lists fourteen commands. The link points at this
checkout, so `git pull` updates the binary; do not link from a worktree that will be
removed.

### 2.2 Initialize

```bash
kabane init \
  --actor cabane://actor/human/<your name> \
  --device <short machine name> \
  --sync-url https://<your-domain> \
  --sync-token '<SYNC_TOKEN from 1.2>'
```

Expected:

```
✓ Initialized /Users/<you>/.kabane
  actor:  cabane://actor/human/<your name>
  device: <short machine name>
  sync:   https://<your-domain>
```

`KABANE_HOME` (default `~/.kabane`) now holds `config.json` and `kabane.db`. The device id
is write-once: it becomes the device's identity in the log on the first push and renaming
it afterwards makes the log treat the machine as new. A device set up through the
first-run screen instead of `init` took its short hostname as the device id; to pick
another, change both `deviceId` fields in `config.json` before the first push.

### 2.3 Give the device its Access credentials

The hub is behind Access, so every push and pull must carry a service token. Use the
`kabane-cron` token from 1.4 for devices (it is the identity of the machine, not of the
person; writes are still stamped with the device's `actor`). Edit
`~/.kabane/config.json` and add `headers` inside `sync`, or pass
`--access-client-id <id> --access-client-secret <secret>` to `init` in 2.2, which writes the
same block:

```json
"sync": {
  "enabled": true,
  "url": "https://<your-domain>",
  "token": "<SYNC_TOKEN>",
  "deviceId": "<short machine name>",
  "batchBytes": 262144,
  "headers": {
    "CF-Access-Client-Id": "<cron client id>.access",
    "CF-Access-Client-Secret": "<cron client secret>"
  }
}
```

Check:

```bash
kabane sync status
```

Expected: `Sync: not armed on this device (run \`kabane sync push\` once with sync
configured).` Arming happens on the first connection.

### 2.4 Arm, and backfill what the device already holds

```bash
kabane sync push
```

Expected: `⬆️  Pushed 0 ops (0 duplicates, 0 batches) as device <name>`. The device is
now armed and every later write is captured.

Nothing already in the database when sync is armed replicates by itself. If this device
had tasks before you set up sync (a machine you used on local SQLite first), seed the log
with them once:

```bash
kabane sync backfill
```

Expected: `📦 Backfilled N rows into the oplog (0 already present)`, then the push line.
Backfill is idempotent (op ids derive from table,
row id and version), so a re-run is a no-op. What carries over: tasks, links, comments,
work logs, projects, context refs, upstream links. What does **not**: agent sessions and
activities, and anything marked `visibility: private`.

Check:

```bash
kabane sync status
```

Expected: `Sync: armed as device <name>`, `pending ops: 0`, `last sync:` a timestamp,
`quarantined: 0`.

### 2.5 Or share a host app's database instead

A device can open a database another host already keeps, instead of its own
`~/.kabane/kabane.db`. This is for a host app that embeds `@cabane/core` and keeps its
tables behind a prefix (Jake, the planner kabane was extracted from, uses `planner_` in
`~/.jake/jake.db`). Skip 2.2 to 2.4 and initialize like this instead:

```bash
kabane init \
  --actor cabane://actor/human/<your name> \
  --device <short machine name> \
  --db-path <the host's database file> --table-prefix <its table prefix>
kabane list --limit 5
```

Expected: the `init` output ends with `db: <the file> (tables <prefix>*)` and `list` shows
the host's tasks. Nothing is copied and nothing syncs between the two hosts, because it is
one file. Do **not** add `--sync-url` in this shape: the host syncs that file as its own
device, and `kabane sync` warns when `db.path` and sync are both set. Opening the file
applies the migrations it has not had yet (§5.8), so update the host's `@cabane/core` to
the same release before either host opens the file on a newer build; the two share one
schema.

---

## 3. Additional devices

Repeat 2.1 to 2.3 with a different `--device` name (same `SYNC_TOKEN`, same or a
dedicated service token), then:

```bash
kabane sync pull
```

Expected: every replicated row from the log applied. A fresh device replays the full log;
at current rates that is seconds. Do not run `backfill` on an empty device: there is
nothing to seed.

### 3.1 Scheduled pull

Push is opportunistic (the hub pushes after every write, a device after `kabane sync
push`), but pull writes rows and may relabel ids, so it is never automatic inside another
command. Schedule it.

macOS (launchd), template in [`schedule/com.kabane.sync-pull.plist`](schedule/com.kabane.sync-pull.plist):

```bash
sed "s|__HOME__|$HOME|g" <your clone>/docs/schedule/com.kabane.sync-pull.plist \
  > ~/Library/LaunchAgents/com.kabane.sync-pull.plist
plutil -lint ~/Library/LaunchAgents/com.kabane.sync-pull.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kabane.sync-pull.plist
launchctl print gui/$(id -u)/com.kabane.sync-pull | grep -E "state|interval"
```

Expected: `OK` from `plutil`, then `state = waiting` and `interval = 300`. Output lands in
`~/.kabane/sync-pull.log`. Remove with `launchctl bootout gui/$(id -u)/com.kabane.sync-pull`.

Linux (cron), line in [`schedule/kabane-sync-pull.cron`](schedule/kabane-sync-pull.cron):

```bash
crontab -l 2>/dev/null | cat - <your clone>/docs/schedule/kabane-sync-pull.cron | crontab -
crontab -l | grep kabane
```

Both assume the `bun link` install (`~/.bun/bin/kabane`) and the default `KABANE_HOME`.
Five minutes matches the hub's `SYNC_INTERVAL_MINUTES`; a task filed at the hub reaches a
device within two intervals.

### 3.2 A runtime that polls for work

Hermes, Codex, and Claude Code pick up issues assigned to them with `kabane list
--assignee <runtime> --state next` after a pull, then `kabane context <id>` for the brief.
The pollers themselves live outside this repo.

---

## 4. Clients

Two ways in: a device's own CLI over stdio (full local tracker, no network), or the hub
over HTTP (the replicated surface, fifteen `kabane_*` tools, `scopeUri` required on
writes). Header-capable clients use a service token; browser connectors use Managed OAuth.

### 4.1 Claude Code

Hub, with the `kabane-claude-code` token:

```bash
claude mcp add --transport http -s user kabane https://<your-domain>/mcp \
  --header "CF-Access-Client-Id: <client id>.access" \
  --header "CF-Access-Client-Secret: <client secret>"
claude mcp list
```

Expected: `kabane: https://<your-domain>/mcp (HTTP) - ✔ Connected`. Writes from this
connection are stamped `cabane://actor/agent/claude`.

Local device instead (no network, sessions included):

```bash
kabane mcp install --harness claude
claude mcp list | grep kabane
```

Expected: `✓ claude installed  as cabane://actor/agent/claude`, then `kabane: <bun>
<clone>/packages/cli/index.ts mcp --as cabane://actor/agent/claude - ✔ Connected`. It
runs `claude mcp add -s user`; an existing `kabane` entry, local or hub, is left alone and
reported as already installed, and `--force` replaces it. Without `--harness` the same
command covers Codex and Gemini CLI too. `kabane mcp install --print` shows the config
it would register, for pasting into a client with no registration CLI.

### 4.2 Hermes

`~/.hermes/config.yaml`, under `mcp_servers` (the `url` form is documented in Hermes's
`cli-config.yaml.example`; `headers` is the static-header map its MCP skills use):

```yaml
mcp_servers:
  kabane:
    url: https://<your-domain>/mcp
    headers:
      CF-Access-Client-Id: "<hermes client id>.access"
      CF-Access-Client-Secret: "<hermes client secret>"
    timeout: 30
```

Expected: Hermes registers tools named `mcp_kabane_kabane_add` and so on. Alternatively,
install the CLI on the Hermes machine (part 2) and let Hermes drive `kabane` through its
terminal toolset; that gives it sessions and the board, not just the replicated surface.

### 4.3 Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.kabane]
url = "https://<your-domain>/mcp"

[mcp_servers.kabane.http_headers]
CF-Access-Client-Id = "<codex client id>.access"
CF-Access-Client-Secret = "<codex client secret>"
```

Or keep the secret out of the file with `env_http_headers`, mapping header names to
environment variable names, in the same table position.

Local device instead:

```bash
kabane mcp install --harness codex
codex mcp get kabane
```

Expected: `args: <clone>/packages/cli/index.ts mcp --as cabane://actor/agent/codex`.
`codex mcp add` rewrites the whole `config.toml` in its own formatting (table order,
`120` as `120.0`); the content is the same, but keep a copy if you diff that file.

Gemini CLI has no hub section here; the local device is one line, registered at user
scope in `~/.gemini/settings.json`:

```bash
kabane mcp install --harness gemini
gemini mcp list
```

Expected: `✓ kabane: ... mcp --as cabane://actor/agent/gemini (stdio) - Connected`.

### 4.4 MCP inspector, the first browser-style test — MANUAL

Before touching a connector UI, prove Managed OAuth end to end with a client you can read:

```bash
npx -y @modelcontextprotocol/inspector https://<your-domain>/mcp
```

In the UI, transport Streamable HTTP, no headers, Connect. Expected: a browser tab opens on
the Access login, you authenticate as `HUMAN_EMAIL`, the inspector lists fifteen tools, and
`kabane_scopeList` returns your scopes. Writes are stamped `cabane://actor/human/<local
part>`.

### 4.5 Claude.ai — MANUAL

Settings → Connectors → Add custom connector → URL `https://<your-domain>/mcp`, no
client id. Expected: an Access login, then the connector shows as connected.

Known risk (`auth.md`): Claude.ai failed against Managed OAuth in June 2026 while Claude
Code worked (anthropics/claude-ai-mcp#410, causes isolated to the `resource` parameter and
`authentication_methods` ordering); no fix is confirmed. If Connect fails, capture the
`ofid_` reference from the error, check whether the authorization request carried
`resource`, and only then consider the fallback topology (b) in `auth.md`, which needs an
ADR because it introduces an Access bypass.

### 4.6 ChatGPT — MANUAL

Settings → Connectors → Advanced → Developer mode, then Create → URL
`https://<your-domain>/mcp`, Authentication OAuth, no client id. Expected: an Access
login, then the connector lists the tools. There is no public report of ChatGPT against
Managed OAuth either way; this is the last test in the order.

Test order, and stop at the first failure: inspector (4.4), Claude Code (4.1), Claude.ai
(4.5), ChatGPT (4.6).

---

### 4.7 Board copilot — the harness `kabane board` talks to

The other direction: `A` in the board starts an agent session on this machine and hands it
what is on screen. Nothing here touches Cloudflare or the hub — the harness runs locally as
you, and its writes go through `kabane mcp` into this device's database, stamped
`cabane://actor/agent/<harness>`.

| `copilot.harness` | Needs | What the board launches |
|---|---|---|
| `claude` (default) | `claude` on PATH, logged in (`claude` once) | `npx -y @agentclientprotocol/claude-agent-acp@0.76.0` |
| `codex` | `codex` on PATH, `codex login` | `npx -y @agentclientprotocol/codex-acp@1.11.0` |
| `gemini` | `gemini` on PATH, logged in (`gemini` once) | `gemini --acp` |

Adapter versions are pinned so every device behaves the same. The block in
`~/.kabane/config.json` is optional; with no block at all the board opens with a Claude
copilot:

```json
{
  "copilot": { "harness": "codex" }
}
```

`kabane board --copilot gemini` overrides it for one run. `copilot.command` (with optional
`copilot.args`) replaces the launch line entirely, for a local build or a wrapper script;
the pinned adapter's own arguments are not kept.

What the harness brings and what kabane adds:

- **Inherited from your own harness config**: the model, the permission mode, hooks, skills,
  and the `CLAUDE.md` / `AGENTS.md` of the project — the session's cwd is the scope's
  project root, or the directory the board was opened from when `--scope` named a scope
  that has no checkout here. Kabane configures none of it and sandboxes nothing. A harness in an
  ask-first permission mode is the one case to watch: the board cannot answer a permission
  request yet, so it declines it and says so in the transcript.
- **Added by kabane**: `KABANE_SESSION=1` in the harness environment, so your own hooks can
  tell a board session from an interactive one; one instruction block naming the job; and
  one MCP server, `kabane mcp --scope <uri> --as cabane://actor/agent/<harness>`.

The first turn cold-starts `npx`, which takes a few seconds; the footer indicator appears
immediately. If it fails with an npm resolution error, check for a release-age guard:
`min-release-age` in `~/.npmrc` hides packages published in the last few days, pinned
versions included. `NPM_CONFIG_USERCONFIG=/dev/null kabane board` bypasses it for one run.

## 5. Operations

### 5.1 Rotate the log secret — MANUAL

```bash
openssl rand -base64 32
bunx wrangler secret put SYNC_TOKEN
```

Then update `sync.token` on every device (`~/.kabane/config.json`, or wherever a host app
keeps its sync settings). With CI (1.0), update the `SYNC_TOKEN` secret too, or the next
workflow run uploads the old value again. Until a device is updated its pushes fail with
`401`, which propagates as an error and leaves the watermark in place; nothing is
quarantined on a `401`. Run `kabane sync push` on each device to confirm.

### 5.2 Rotate or revoke a service token — MANUAL

Zero Trust → Service tokens → the token → **Refresh** (new secret, same client id, so
`SERVICE_ACTORS` is unchanged) or **Revoke**. Update the secret where that runtime keeps
it (Claude Code: `claude mcp remove` then `add`; Hermes and Codex: their config files;
devices: `sync.headers`). A revoked token gets `401` from Access before the Worker runs.

### 5.3 Add a runtime — MANUAL

Create a service token (1.4), add it to the `runtimes` Service Auth policy (1.3), add its
client id to `SERVICE_ACTORS` with the actor URI you want stamped, and redeploy with the
new map (1.5). A token that is in the policy but not in `SERVICE_ACTORS` is admitted by
Access and refused by the Worker with `401 unknown service identity`; the Worker is closed
by default.

### 5.4 Watch it run — MANUAL

```bash
bunx wrangler tail --format pretty
```

Every request logs at the edge; `hub push failed` or `hub pull failed` lines mean the
scheduled pass hit the log and will retry at the next interval (the alarm never throws).
The hub's alarm runs every `SYNC_INTERVAL_MINUTES`; changing the var needs a redeploy and
takes effect at the next alarm.

### 5.5 What `quarantined` means

`kabane sync status` shows `quarantined: N` and the last ten op ids. A quarantined op is
one the server refused on content (a `400`, `413`, or `500`, typically a row over the 2 MB
Durable Object value cap: descriptions are PRDs). The transport bisected the failing batch
until the offender was alone, recorded it, and moved the watermark past it so everything
else keeps flowing. The row is still correct locally; it is simply not replicated. Fix:
shorten the row, edit it so a new version is captured, push again. A `401` or a dead
network never quarantines.

### 5.6 The log was wiped or restored

There is no restore command in Kabane, and none is needed for the data: every device is
authoritative. If the Durable Object is deleted or rolled back (Cloudflare keeps 30 days of
point-in-time bookmarks for SQLite-backed objects, restorable from the dashboard), the next
push from any device sees `head < last_applied_seq`, logs `sync log reset detected`, rewinds
its applied watermark to 0, and re-reads. To repopulate an empty log, run `kabane sync
backfill` on one device that has everything; the others pull. Short ids may be relabelled
during that convergence.

### 5.7 Redeploy after a code change — MANUAL, or a workflow run when 1.0 is set up

```bash
cd <your clone> && bun run check && bun run typecheck && bun run test
cd packages/worker && bunx wrangler deploy --domain <your-domain> --var …   # the full set from 1.5
```

`wrangler.jsonc` `migrations` only ever gain tags; never rename or remove a class.

### 5.8 Upgrade kabane across devices: the hub first, then each device

Every database carries a numbered schema version (`schema_migrations`, behind the table
prefix when a host app shares its database). On boot, kabane applies the migrations the
database has not had yet, each once and each in its own transaction: a migration that fails is reported by
number and leaves the database at the version before it. A database already at a newer
version than the build opening it is refused with "update kabane before opening it",
rather than written by code that does not know its schema.

The version also rides on every op a device pushes. A device that pulls an op from a newer
schema than its own applies everything before that op, stops its watermark just short of
it, and fails the pull with "Update kabane on this device and sync again". Nothing is
skipped: after the update, the next pull starts at that op. Pushing keeps working
meanwhile, since a newer device reads an older one's ops.

So a release that adds a migration goes out in this order:

1. The hub: redeploy the Worker (§5.7). The cloud device migrates on its next boot, and
   browser clients (Claude.ai, ChatGPT) stay current throughout.
2. Each device: pull the clone and `bun install` in it (`bun link` follows the clone), then
   run any `kabane` command once. Until a device updates, its scheduled pull logs the
   "update kabane" error and holds its place.
3. A host app that shares a database file with a device (2.5): update its `@cabane/core`
   at the same time as the CLI on that machine.

A device that updates before the hub is safe too: the hub's cloud device and every older
device stop at that device's first op until they update.

Migration 5 (calendar-date deadlines) rewrites every deadline stored as the end of a UTC day
(`…T23:59:59.999Z`, `…T23:59:00Z` and the like) as the date it meant, on each database as it
boots; deadlines with a real time are left alone. Set `KABANE_TIMEZONE` on the hub (1.5) in
the same redeploy, or the hub keeps reading those dates in UTC.

---

## What was verified locally, and what was not

Run on 2026-09-07 against `wrangler dev --port 8794` with a `.dev.vars` carrying
`ACCESS_DEV_UNVERIFIED=true` (unsigned assertions accepted), `SYNC_TOKEN=dev-token`, a
`HUMAN_EMAIL`, and a two-entry `SERVICE_ACTORS`. Devices carried the dev assertion in
`sync.headers` instead of a service token, because there is no Access in front of
localhost.

| Step | Result |
|---|---|
| 1.1 reject test | `GET /health` bare → `401`; with a human assertion → `{"ok":true,…,"actor":"cabane://actor/human/<local part>"}`; with a service assertion → the mapped agent actor; `GET /mcp` → `405`; `POST /push` without the bearer → `401` |
| 2.1 `bun link` | `kabane` on PATH at `~/.bun/bin/kabane`, `--help` lists the commands |
| 2.2 to 2.4 device A | `init` → `sync status` "not armed" → a task added before arming → `sync backfill` seeded and pushed it (1 op) → a task added after arming was captured and pushed live |
| 3 device B | `init`, `sync pull` → 2 ops applied, both tasks listed |
| hub as device | after the alarm the hub's `kabane_list` returned both device tasks with the right `updatedBy`; `kabane_add` at the hub as the Hermes service identity was stamped `cabane://actor/agent/hermes` |
| collision repair | hub and device A had both minted `JCAB-1`; device B's next pull applied the hub's task, `renamed 1`, and all three sides agree on `JCAB-3` for it |
| 3.1 templates | `plutil -lint` OK on the plist, before and after the `__HOME__` substitution |
| 4.1 Claude Code | `claude mcp add --transport http … --header "Cf-Access-Jwt-Assertion: …"` against localhost → `claude mcp list` shows `✔ Connected`; removed afterwards |
| 4.1 to 4.3 local | `kabane mcp install` registered claude, codex and gemini at user scope; a second run reported each already installed; `--force` replaced claude and gemini; `claude mcp list` and `gemini mcp list` showed `Connected`; a `kabane_add` through the registered argv, spawned with a bare PATH, was stamped `cabane://actor/agent/claude`; all three configs restored afterwards |
| 4.4 inspector | `npx @modelcontextprotocol/inspector --cli … --method tools/list` → 15 tools; `tools/call kabane_add` created a task |

Not verifiable without the real account, therefore **MANUAL** above: `wrangler login` and
`deploy`, the custom domain, the Access application and policies, service tokens, Managed
OAuth and its metadata endpoint, the `wrangler tail` reject test, Claude.ai and ChatGPT
connectors, Hermes and Codex against the real hub, and the launchd job on a machine you are
willing to have pull every five minutes.
