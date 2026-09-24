# Releasing kabane

Kabane ships as one npm package, `kabane`, whose bin needs Bun at runtime. This is the
maintainer's runbook for cutting a release. Publishing, tagging and the GitHub release are
**MANUAL**: an agent may run every step up to the smoke test and must never run
`npm publish`, `npm login`, or push a tag.

## What gets published

`bun run build` (`scripts/build.ts`) writes the package into `packages/cli/dist`, which is
the directory `npm pack` and `npm publish` run in:

| Path | What it is |
|---|---|
| `bin/kabane.js` | the CLI, `bun build --target bun` from `packages/cli/index.ts`, every `@cabane/*` workspace package and every pure-JS dependency inlined, `#!/usr/bin/env bun` kept |
| `templates/dispatch/` | the copilot's dispatch skill template, read from disk at runtime (`../templates/dispatch` from the bin) |
| `package.json` | generated, see below |
| `README.md`, `LICENSE` | the repository's own |

Three dependencies stay external and are listed as exact `dependencies`:

- `@opentui/core` loads its native renderer, `@opentui/core-<platform>-<arch>`, at runtime
  from an optional dependency, so it has to be installed per machine by the package manager.
- `@opentui/react` and `react`: `@opentui/react` imports `react` itself, and a second React
  bundled beside it would break every hook, so both stay external with it.

Their versions are read from `packages/board/package.json`, which must pin them exactly;
the build fails otherwise. Bumping OpenTUI or React is a change there, nothing else.

### Why a generated manifest

`packages/cli/package.json` stays the development manifest: `private: true`, the source
entry (`index.ts`), and `workspace:*` dependencies on the `@cabane/*` packages. The npm name
`cabane` and the `@cabane` scope belong to other people, so the published manifest must name
none of those packages, or an install would resolve someone else's code. Making the CLI
package itself publishable with a `prepack` build would mean rewriting its dependencies,
entry and bin in place and back again around every pack; generating a separate manifest in
the output directory keeps both honest and leaves nothing to restore. The build carries
`name`, `version`, `description`, `keywords`, `license`, `repository`, `homepage` and `bugs`
over from `packages/cli/package.json`, takes `engines.bun` from `.bun-version`, and adds
`type`, `bin`, `files` and the external `dependencies`. `private: true` on the CLI package
means `npm publish` run from `packages/cli` by mistake refuses.

## Steps

### 1. Version

Set `version` in `packages/cli/package.json`. It is the only version the package has:
`kabane --version` and the MCP server's `serverInfo` read it. Commit that alone, as
`release: kabane <version>`.

### 2. Gate

```bash
bun install --frozen-lockfile
bun run check && bun run typecheck && bun run test
```

### 3. Build and smoke

```bash
bun run smoke
```

It builds `packages/cli/dist`, runs `npm pack`, checks the tarball names no `@cabane/*`
package and carries no source map or absolute path of the machine, installs it with
`bun add -g` into a throwaway HOME, BUN_INSTALL and KABANE_HOME under the system temp
directory, then runs `kabane --version`, `--help`, `init`, `add` and `list` in a temp git
repo and an MCP `initialize` handshake over `kabane mcp`, which must also exit when its
stdin closes. Expected: `smoke: passed`. The CI gate runs the same script.

The smoke does not open the board. Once per release, open it from the installed tarball
by hand, in a real terminal, against a throwaway home:

```bash
cd "$(mktemp -d)" && git init -q
npm pack --pack-destination . <your clone>/packages/cli/dist
HOME=$PWD BUN_INSTALL=$PWD/.bun KABANE_HOME=$PWD/.kabane KABANE_HARNESSES= \
  bun add -g ./kabane-<version>.tgz
HOME=$PWD KABANE_HOME=$PWD/.kabane KABANE_HARNESSES= ./.bun/bin/kabane
```

Expected: the first-run card, then setup, then the board; `q` quits.

### 4. Publish (**MANUAL**)

Publish the `dist` the smoke just built and tested; do not rebuild in between.

```bash
cd packages/cli/dist
npm pack --dry-run            # the file list: bin/, templates/, README.md, LICENSE, package.json
npm whoami                    # the account that owns `kabane` on npm
npm publish --access public
npm view kabane version       # the version from step 1
```

### 5. Tag and GitHub release (**MANUAL**)

```bash
git tag -s v<version> -m "kabane <version>"
git push origin v<version>
gh release create v<version> --title "kabane <version>" --generate-notes
```

### 6. Check the published package

From a shell with no clone on its PATH:

```bash
bun add -g kabane@<version>
kabane --version
```

A release-age guard (`minimumReleaseAge` in `~/.bunfig.toml`, `min-release-age` in
`~/.npmrc`) hides a version for its first days, so on a machine that has one this step
fails until the version is old enough. That is the guard working, not the release.

## First release only

- The repository is `github.com/davidpp/kabane` before the first publish: the manifest's
  `repository`, `homepage` and `bugs` point there, and npm resolves the README's relative
  links against `repository`.
- `docs/getting-started.md` (Prerequisites, Install) and `docs/deploy.md` (2.1) describe a
  clone and `bun link` because there was no package yet. Once `npm view kabane` answers,
  lead both with `bun add -g kabane` as the README's Install section does.
