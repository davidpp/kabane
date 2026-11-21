# 0005: Releases ship on GitHub only; nothing is published to npm

- Status: accepted
- Date: 2026-11-20
- Issue: JCAB-634 (under JCAB-627, install channels)
- Decided by: David ("Drop npm", relayed from an interactive session)

## Context

Homebrew (`davidpp/tap`), the curl installer and mise's `github:` backend all install the
standalone binaries from the GitHub release, and JCAB-624 moved update checks onto GitHub. npm
then served one path, `bun add -g kabane`, at the cost of a second publisher: npm trusted
publishing over OIDC, registry readback, dist-tags read as release state, and a Node and npm pin
in the release workflow. The first release under this decision is 1.0.0.

## Decision

A release is the GitHub release of a `v<version>` tag, its four binaries, `install.sh`,
`SHA256SUMS`, manifest and notes, plus the tap formula for a stable version, published by one
`release.yml` dispatch (`scripts/release-publish.ts`). Version selection starts from the highest
published stable `vX.Y.Z` tag (`scripts/release-version.ts`). `bun run release` cuts the version
and dispatches (`scripts/release-local.ts`). `kabane update` on a Bun install says releases moved
and prints the brew and installer commands (`packages/cli/src/commands/update.ts`).

## Consequences

- One publisher, no npm login, no OIDC token in the publish job, no Node in the release.
- Existing `bun add -g` installs stop at `1.0.0-beta.0`. They hear about the move only from the
  board's notice or from running `kabane update`. That message ships in the first GitHub-only
  release, which a Bun install cannot install through npm.
- Extension authors get `kabane/extension` types by building a checkout; no package carries them.
- `bun run smoke` still packs and installs the bundle to check it, though no release ships it.

## Alternatives rejected

- Keep publishing to npm beside GitHub: a second publisher and its setup for one install path
  the other three cover.
- A last npm release that only prints the move: would need the npm publisher kept alive for it.
