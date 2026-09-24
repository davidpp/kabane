# Authentication for the Kabane hub

**Status:** decided and implemented · **Checked:** 2026-09-07

A self-hosted hub, at `<your-domain>` behind the Access team `<team>` (placeholders as in
[`deploy.md`](deploy.md)), has two kinds of clients. Machines that can send
headers (Claude Code, Hermes, Codex, cron pullers) and browser connectors that
cannot (ChatGPT, Claude.ai web and mobile). The question was whether Cloudflare
Access can serve both without the Worker growing its own OAuth server.

## Finding

**Cloudflare Access is already an OAuth 2.1 authorization server for MCP.**
"Managed OAuth" (open beta since 2026-04-14) turns any self-hosted Access
application or MCP server application into a standards-compliant authorization
server: a non-browser client gets a `401` with `WWW-Authenticate` pointing at
`/.well-known/oauth-authorization-server` on the app's own domain, registers
via RFC 7591 Dynamic Client Registration, runs the authorization-code flow with
S256 PKCE, and receives an opaque token. Access resolves that token to the user
on every request and forwards a signed JWT in `Cf-Access-Jwt-Assertion`, so
"from your origin's perspective, the request looks the same as a
browser-authenticated request." The Worker keeps its standard Access JWT
verifier unchanged. Service tokens keep working alongside through a `Service Auth`
policy. Sources: [Managed OAuth doc][mo], [blog post][mo-blog],
[Secure MCP servers][smcp], [Managed OAuth vs service tokens table][mo].

**What the connectors require, and whether Managed OAuth meets it:**

| Requirement | ChatGPT | Claude.ai / Desktop / mobile | Managed OAuth |
|---|---|---|---|
| OAuth 2.1 code flow, S256 PKCE | required ([Apps SDK auth][oai-auth]) | required, `code_challenge_methods_supported: ["S256"]` must be advertised ([connector auth][cl-auth]) | yes ([issue 410 trace][gh410] confirms metadata) |
| Client registration | CIMD preferred, DCR "remains supported when configured", predefined clients allowed ([MCP docs][oai-mcp]) | DCR out of the box; CIMD only if `client_id_metadata_document_supported` and `none` are advertised; pre-registered client id via Advanced settings ([connector auth][cl-auth]) | DCR with an allow-list of redirect URIs; CIMD support not documented |
| RFC 9728 protected resource metadata | server "must expose" it ([Apps SDK auth][oai-auth]) | `401` must carry `WWW-Authenticate: Bearer resource_metadata=…`; a `200` is ignored ([connector auth][cl-auth]) | served by Access at the app domain ([Managed OAuth doc][mo]) |
| RFC 8707 `resource` parameter | client sends it (MCP spec MUST) | client sends it (MCP spec MUST) | **required**; `/authorization` returns `invalid_target` without it ([issue 410][gh410]) |
| Redirect URIs | `https://chatgpt.com/connector/oauth/{callback_id}` and `https://chatgpt.com/connector_platform_oauth_redirect` ([Apps SDK auth][oai-auth]) | `https://claude.ai/api/mcp/auth_callback`; Claude Code uses `http://localhost:<port>/callback` and `http://127.0.0.1:<port>/callback` ([connector auth][cl-auth]) | "Allowed redirect URIs" list, `/*` suffix allowed, plus localhost and loopback toggles ([Managed OAuth doc][mo]) |
| Machine-to-machine | not supported: no client credentials, no API keys, no custom headers ([Apps SDK auth][oai-auth]) | `static_headers` in beta (`authorization`, `x-api-key` allowed; other header names need Anthropic review) ([connector auth][cl-auth]) | service tokens via `CF-Access-Client-Id` / `CF-Access-Client-Secret` ([service tokens][st]) |
| No-auth connector | allowed, "No authentication" option in the UI | `none` supported, but the connect flow still probes OAuth metadata; an unreachable server fails at DCR ([issue 402][gh402]) | n/a |

**Known interoperability failure, June 2026.** Claude.ai web and Desktop
failed against Managed OAuth while Claude Code connected to the same URL
([issue 410][gh410], opened 2026-06-07, closed as not planned). Anthropic's
trace showed discovery and DCR succeeding and the authorization code never
returning. A reporter isolated two causes on 2026-06-21: Access's `/authorization`
rejects a request without `resource`, and the protected-resource metadata lists
`"authentication_methods": ["cloudflared", "oauth"]` with the browser-cookie
path first, so a client that picks the first method lands on the Access login
page and is redirected to the resource root instead of the OAuth callback. No
later comment reports a fix on either side. **Whether Claude.ai's connector
now sends `resource` and selects `oauth` is unverified and is the first thing
the deploy test must establish.** ChatGPT against Managed OAuth has no public
report either way.

**Alternatives checked and set aside.**

- *Cloudflare Agents SDK `McpAgent`*: marked "deprecated for new deployments" in
  favor of `createMcpHandler`; either way it is a tool-serving layer, not an
  auth layer, and the hub already has its own Durable Object ([remote MCP guide][cf-remote]).
- *`workers-oauth-provider`*: a full OAuth 2.1 server in the Worker (KV-backed
  tokens, DCR, PKCE, RFC 8414 and 9728 metadata) with the login step delegated
  to an upstream IdP. Access for SaaS can be that upstream: the
  [Secure MCP servers][smcp] guide deploys exactly this (`OAUTH_KV` binding,
  `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`,
  `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL`, `COOKIE_ENCRYPTION_KEY`). It
  works, but it duplicates what Managed OAuth does natively and moves token
  state into the Worker. Kept as the fallback if Managed OAuth proves
  incompatible with a connector.
- *MCP server portal*: Access-hosted aggregator with its own Managed OAuth and
  service-token support. Overkill for one server; same auth mechanism, so it
  inherits the same interoperability question.

## Topologies

**(a) One Access application, Managed OAuth on, two policies.** The MCP server
application covers `<your-domain>`. An `Allow` policy for the owner's identity
serves browser connectors through Managed OAuth. A `Service Auth` policy with
one service token per runtime serves Claude Code, Hermes, Codex, and cron. The
Worker verifies `Cf-Access-Jwt-Assertion` on every request and maps `common_name` to `cabane://actor/agent/<runtime>` and `email` to
`cabane://actor/human/<local-part>`. *Security consequence:* Access rejects
every unauthenticated request before Worker code runs, requests are logged, and
no OAuth token or client secret is ever stored by the Worker. The one new trust
edge is DCR: any client whose redirect URI is on the allow-list can register
itself, so the allow-list must contain exactly the ChatGPT and Claude URIs and
localhost, nothing wildcarded on a third-party host.

**(b) Access Bypass on `/oauth/*` and `/.well-known/*`, Worker runs
`workers-oauth-provider` with Access for SaaS as the upstream IdP.** `/mcp`
stays behind Access for service tokens; browser connectors use the Worker's own
OAuth server, which logs the user in through an Access for SaaS OIDC app.
*Security consequence:* Bypass "does not enforce any Access security controls
and requests are not logged" ([policies][pol]), so the registration, authorize,
and token endpoints are public and defended only by the Worker's own code and
by KV-stored hashed secrets. That is a public Worker with application
authentication only, and it gives up the invariant (a) rests on: the Access
application has no bypass.

## Decision

**Go with (a).** Managed OAuth is the product Cloudflare built for this case,
it keeps the invariant that Access rejects before the Worker runs, the
Worker code is the verifier we already have, and there is nothing to rotate but
service tokens. The cost is one unverified interoperability question with
Claude.ai's connector, which is cheap to test and has (b) as a documented
fallback that changes nothing in the tool layer.

The implementation phase is therefore small. Nothing OAuth-specific lands in
the Worker.

## Implementation

Worker changes, all in `packages/worker`:

1. `src/access.ts`: the JWT verifier (issuer `https://<team>.cloudflareaccess.com`,
   audience `ACCESS_AUD`, RS256, `type === "app"`). Add the actor mapping:
   `common_name` present → look up in `SERVICE_ACTORS` (a JSON var mapping
   client id → `cabane://actor/agent/<name>`), unknown id → `401`; otherwise
   `email` present → `cabane://actor/human/<local-part>`, and the email must
   equal `HUMAN_EMAIL` or the request is `401` (one human per hub).
2. `src/hub.ts`: return `401` with no body for a missing or invalid assertion.
   Do **not** emit `WWW-Authenticate`; Managed OAuth owns the `401` shape and
   the doc says enabling it "replaces the 401 response behavior on the
   protected application".
3. Vars `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `HUMAN_EMAIL`, `SERVICE_ACTORS`:
   empty placeholders in `wrangler.jsonc`, values passed at deploy time
   (`deploy.md` 1.5). No new bindings, no KV, no secrets beyond `SYNC_TOKEN`.
4. Tests: the verifier is injected, so the vitest suite covers service mapping, human mapping, unknown service id,
   wrong human, and missing header without touching Access.

Fallback (b), only if the deploy test fails and Cloudflare has not fixed the
connector path: add `workers-oauth-provider`, an `OAUTH_KV` namespace, the six
secrets listed above, an Access for SaaS OIDC app with redirect
`https://<your-domain>/callback`, and a second Access self-hosted app with a
Bypass policy scoped to `<your-domain>/oauth/*` and `/.well-known/*`. Record
the decision to accept a bypass in an ADR before doing it.

## Manual steps, as the deploy runbook runs them

Cloudflare dashboard, Zero Trust, after `wrangler deploy` of the hub:

1. **Access controls → AI controls → MCP servers → Add an MCP server.**
   HTTP URL `https://<your-domain>/mcp`. Proxy status on for the hostname.
2. **Policies.** `Allow` with Include `email = <your email>`. `Service Auth`
   with Include `Service Token` for each token created in step 4.
3. **Advanced settings → Managed OAuth: on.** Allowed redirect URIs:
   `https://chatgpt.com/connector/oauth/*`,
   `https://chatgpt.com/connector_platform_oauth_redirect`,
   `https://claude.ai/api/mcp/auth_callback`. Allow localhost clients and
   loopback clients on (Claude Code, MCP inspector). Access token lifetime 15m,
   grant session 14d, per Cloudflare's CLI recommendation.
4. **Access controls → Service credentials → Service tokens.** Create
   `kabane-claude-code`, `kabane-hermes`, `kabane-codex`, `kabane-cron`. Copy
   each Client ID into `SERVICE_ACTORS`; secrets go to each machine's keychain
   or env, never into the repo. Copy the application `AUD` into `ACCESS_AUD`.
5. **Connect and verify, in this order.** MCP inspector with the localhost
   redirect (proves Managed OAuth end to end). Claude Code:
   `claude mcp add --transport http kabane https://<your-domain>/mcp` with
   `--header "CF-Access-Client-Id: …" --header "CF-Access-Client-Secret: …"`.
   Codex: `http_headers` / `env_http_headers` in `config.toml` ([Codex MCP][codex]).
   Hermes: its MCP server config with the same two headers.
   Claude.ai: add custom connector by URL, no client id. If it fails at
   Connect, capture the `ofid_` reference and test whether `resource` and the
   `oauth` method are the cause before falling back to (b). ChatGPT: developer
   mode, custom connector, authentication OAuth, no client id.
6. **Reject test.** `curl -i https://<your-domain>/mcp` with no headers must
   return `401` from Access, and `wrangler tail` must show no Worker
   invocation.

Anthropic's egress range for allow-listing, if the zone ever gets WAF rules:
`160.79.104.0/21` ([connector auth][cl-auth]). Discovery and token requests
come from the same range.

## Sources

- [mo]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/ (source mdx read 2026-09-07)
- [mo-blog]: https://blog.cloudflare.com/managed-oauth-for-access/ (2026-04-14)
- [smcp]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/
- [portals]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
- [pol]: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
- [st]: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- [oidc]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/
- [cf-remote]: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- [wop]: https://github.com/cloudflare/workers-oauth-provider
- [oai-auth]: https://developers.openai.com/apps-sdk/build/auth
- [oai-mcp]: https://developers.openai.com/api/docs/mcp
- [cl-auth]: https://claude.com/docs/connectors/building/authentication
- [cl-help]: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- [gh410]: https://github.com/anthropics/claude-ai-mcp/issues/410 (comments through 2026-06-21)
- [gh402]: https://github.com/anthropics/claude-ai-mcp/issues/402
- [codex]: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- MCP authorization spec 2025-06-18: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization

[mo]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
[mo-blog]: https://blog.cloudflare.com/managed-oauth-for-access/
[smcp]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/
[pol]: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
[st]: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
[cf-remote]: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
[oai-auth]: https://developers.openai.com/apps-sdk/build/auth
[oai-mcp]: https://developers.openai.com/api/docs/mcp
[cl-auth]: https://claude.com/docs/connectors/building/authentication
[gh410]: https://github.com/anthropics/claude-ai-mcp/issues/410
[gh402]: https://github.com/anthropics/claude-ai-mcp/issues/402
[codex]: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
