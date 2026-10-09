# Releasing kabane

Kabane ships as one npm package, `kabane`, requiring Bun at runtime. A release is
**human-triggered**: agents must never publish, log in, create/push tags, run a
publish-capable workflow, or configure npm/GitHub release settings. Nonpublishing local
verification and installed smoke are safe with the disposable homes described below.

The implementation is committed; the additional review was stopped at the maintainer's
request without a release/update verdict. No release version is selected by this work.
Live environment protection, trusted publishing, provenance and immutable-release behavior
remain unverified until a human performs the approved release.

## Local release (human-run)

You can release from your computer without an Actions environment, npm trusted publisher,
or OIDC. Use a clean `main` checkout with this implementation committed and pushed. GitHub
CLI must already be authenticated (`gh auth login` if needed), with repository admin access
when enabling release immutability. Let the command choose and bump the version:

```bash
bun run release:local prepare
```

Auto reads npm `latest` and inspects the complete commit range since that release's
consistent tag or registry `gitHead`. It checks the baseline's CLI version and ancestry;
missing/conflicting baselines, shallow history, more than 1000 commits, or oversized/unclear
history fail rather than guessing. Selection uses declared Conventional Commit intent, not
an automatic proof of API compatibility:

- `!`, `BREAKING CHANGE:` or `BREAKING-CHANGE:`: major, **minor during 0.x**. Auto never
  declares initial development stable 1.0.0.
- `feat:`: minor; `fix:` / `perf:`: patch. Highest severity wins.
- `docs`, `chore`, `style`, `refactor`, `test` / `tests`, and `ci`: no automatic release
  without release-affecting commits. Unknown/substantive types without declared breaking
  intent (`build`, `revert`) and unclassified merges require a deliberate override.

For a fresh release, force a semantic increment with `prepare --bump patch`, `--bump minor`,
or `--bump major`; these increment npm latest without requiring history inference. Explicit
major during 0.x means deliberately entering stable 1.0.0. Numeric `--version X.Y.Z` remains
available for deliberate selection/recovery. Do not combine selectors.

This command updates **only** the CLI version and lockfile, commits those files, runs
check/typecheck/test, builds/packs **once**, validates the archive and runs the installed
CLI/MCP smoke on those bytes. It retains the original archive, manifest, checksums, release
notes and verification record under gitignored `.releases/<selected-version>/`. The selected
version/selector/source and phase are retained in `.releases/current.json`. Repeated preparation
and publication reuse that choice; authentication handoff never increments again, even if
npm latest has already advanced during partial publication. Default notes contain
recent commit subjects for review; provide `--notes-file /path/to/reviewed-notes.md` during
fresh preparation to supply your own public notes.

After verification it enables GitHub release immutability if disabled, creates an annotated
`v<selected-version>` tag (honoring configured Git signing), and atomically pushes main plus that tag.
It never moves an existing tag. A configured signing key may require its own authentication.
**Preparation does not publish, run npm login, replace your installed Kabane, or open tracker
config/data.** These source/tag/settings writes are authorization granted by the human
running the command; agents must not execute the release flow against real accounts.

Review the retained notes and perform the real-terminal board check below using that archive,
then authenticate to npm and explicitly resume:

```bash
npm login
bun run release:local publish
```

Publication uses your local npm configuration/authentication, including interactive npm
2FA prompts. It refuses a missing/unverified artifact, changed source/tool versions, moved
remote tag, disabled immutability, conflicting assets or registry bytes. It creates the
matching GitHub draft/assets, publishes the exact retained tarball once, verifies registry
integrity/latest, then finalizes and verifies the immutable GitHub release. **It does not
rerun gates, build or pack.** Local publication does not claim GitHub Actions OIDC provenance.

GitHub's tag endpoint exposes **published** releases, not drafts. The publisher discovers
drafts through an authenticated push-authorized releases listing, consumes all pages within
its bound (100 releases/page, at most 10 pages), and rejects conflicting, duplicate,
malformed or incomplete metadata/pagination. A tag-route 404 alone never proves absence.
All matching asset bytes are still downloaded and hashed; API digests do not replace this.

If a tooling bug blocks an already verified release, keep its source checkout and original
archive unchanged. A separate fixed tooling checkout can use that clean `main` source root
for **publish only**, without committing source changes or rebuilding:

```bash
# HUMAN ONLY, from the original verified source checkout:
bun /path/to/fixed-tooling/scripts/release-local.ts publish --source-root "$PWD"
```

Source-root selection still requires the original manifest/proof/bytes, exact source commit,
remote tag and producer tool versions, local authentication, and enabled immutability. It is
not accepted for preparation or as an alternative to CI's protected OIDC authorization.
Retain the recovery tooling/checkpoint until publication is verified complete; only then
integrate the fix into main for future releases.

Rerun `prepare` for the same untouched prepared source to finish a failed setting/tag/push
step without rerunning successful gates/smoke or rebuilding. Rerun `publish` for matching
npm-success/GitHub-failure state to complete GitHub only. An identical completed release
is a verified no-op. Never delete the archive and rebuild after an ambiguous publication.
A failed gate/version commit may leave local source changes: inspect/fix them deliberately,
not by stashing/resetting unrelated work. Before an archive exists, auto rechecks changed
source and resumes only if it still selects the original version; once an archive exists,
restore the original source instead of replacing its bytes. After successful publication,
a new `prepare` selects the next release from the newly published baseline. Keep the selection
record; if it is missing for an older verified archive, deliberately pass its numeric
`--version` to publish. A `.releases/release.lock` prevents overlapping local commands on this
checkout; investigate a stale lock before removing it. It is not a cross-machine lock against
other publishers.

The `.releases/` directory is deliberately retained, not automatically cleaned up. Keep the
four original public assets for recovery; remove local artifacts only after a verified
successful release and an intentional retention decision.

## Package and version

`packages/cli/package.json` is the only release version. Its development manifest stays
private, with a source bin and `workspace:*` dependencies. `scripts/build.ts` generates
`packages/cli/dist` containing:

- `bin/kabane.js`: Bun bundle, workspace and pure-JS dependencies inlined, Bun shebang kept.
- `templates/dispatch/`, repository README and LICENSE, and generated package.json.
- Exactly pinned external `@opentui/core`, `@opentui/react` and `react`, taken from the
  board manifest. OpenTUI installs its platform-native optional dependency; React must not
  be duplicated inside the bundle. No published dependency may name `@cabane/*`.

The build carries CLI name/version/description/keywords/license/repository/homepage/bugs,
adds type/bin/files/dependencies, and derives the minimum Bun engine from `.bun-version`.
CLI `--version` and stdio MCP identify this version. Do not publish the private source
package or rebuild/repack after choosing a verified archive.

## Human-owned Actions setup (optional; before workflow publishing)

1. Review the proposed exact action pins in `.github/workflows/release.yml`, Node
   **24.21.0** and npm **12.2.0**. These versions/pins were checked against official
   distribution/registry/GitHub refs; availability is not approval to execute a release.
   Keep Bun **1.4.0** from `.bun-version`. npm trusted publishing requires CLI >=11.5.1
   and Node >=22.14.0; npm12.2.0 also requires a sufficiently recent Node24.
2. Configure GitHub environment **`npm-release`**, required reviewers and an appropriate
   self-review/bypass policy. A solo maintainer needs a reviewer arrangement that can
   actually approve their run. Restrict allowed release refs; protect tags from movement.
   Enable repository **release immutability**.
3. Configure the npm trusted publisher for public package `kabane`: owner **davidpp**,
   repository **kabane**, workflow filename **release.yml**, environment **npm-release**,
   GitHub-hosted runners. Explicitly permit **direct `npm publish`**: current npm defaults
   newly configured publishers to staged-publish permission only. No long-lived token
   fallback is provided. Public package/repository are needed for automatic provenance.
4. Only after checking those settings, set environment variable
   **`RELEASE_SETUP_CONFIRMED=true`** in `npm-release`. This is a human assertion, not
   programmatic proof that reviewers, tag protection, immutability or OIDC are configured.
   `npm whoami` is not an OIDC permission check.
5. Review compatibility and prepare notes. The pipeline compares the existing tag's commit
   but does not authenticate a maintainer signing key; signed-tag review is a human step.

The local command needs none of the Actions environment/trusted-publisher setup above.
It can enable release immutability when the human explicitly runs preparation. No agent
performs account setup or executes release operations. An accidentally auto-created unprotected
GitHub environment is not authorization: the publication script also requires confirmed
setup, a matching tag-ref event/source SHA, OIDC request permissions and no inherited npm
publish credentials.

## Human version and tag selection

The local command handles version/lock commit and annotated tag creation/push. For the
Actions route, choose the version in `packages/cli/package.json` and refresh its lockfile;
do not change the private root version or reset data. Commit the reviewed implementation
and selected release version, then a human creates/pushes the signed existing tag:

```bash
# HUMAN ONLY, after choosing/reviewing the version and source commit:
git tag -s v<version> -m "kabane <version>"
git push origin v<version>
```

The workflow never creates or pushes a missing tag. Package version, tag suffix, peeled
remote tag commit, checkout HEAD, event source SHA and installed CLI/MCP identity must
agree. Publishing a stable version must advance npm `latest` rather than downgrade it.
An already published name/version cannot be replaced, even after npm unpublish.

## Verification without publishing

Ordinary local gate:

```bash
bun install --frozen-lockfile
bun run check && bun run typecheck && bun run test
bun run smoke
```

Default smoke builds/packs a temporary archive, checks safe members, published identity,
exact externals, workspace dependencies, maps and machine-path leaks, installs into
throwaway HOME/Bun global directories/cache/KABANE_HOME, then exercises installed CLI
and stdio MCP, including concise queue/receipt/context checks and stdin-close exit.
Installation preserves the invoking user's registry/release-age settings; it does not
null out npmrc or weaken age/integrity policy. It does not open the board.

A retained nonpublishing archive and local byte round trip:

```bash
work=$(mktemp -d)
bun scripts/release.ts prepare "$work/release"
bun scripts/release.ts verify "$work/release"
bun scripts/smoke.ts --artifact-dir "$work/release"
# Existing archive only (no build/pack), for additional local checks:
bun scripts/smoke.ts --tarball "$work/release/kabane-<version>.tgz"
```

Preparation builds/packs **once** and retains archive, `manifest.json`, `SHA256SUMS` and
`release-notes.md`. The manifest records commit, tag (or null), dirty-source status,
Bun/npm versions, archive SHA256/SHA512 and notes SHA256. Dirty or branch artifacts can
be checked but are nonpromotable. Remove your disposable directory afterward; preserve it
on failure for investigation. Never substitute a rebuilt archive in partial-release recovery.

GitHub's **verified release** workflow is `workflow_dispatch` only; `publish` defaults
false. Branch verification is allowed. A human may run nonpublishing verification on an
existing tag, inspect the retained Actions artifact and review its notes/checksums. It
executes no `npm publish` (including `--dry-run`), draft/tag/release writes or OIDC exchange.
This tests artifact preparation/transfer/install, not publisher authentication.

## Human publishing run

Dispatch on the **existing `v<version>` tag ref**, with `publish=true` and reviewed public
notes. Do not dispatch a branch and substitute a different checkout ref. The workflow:

1. Frozen install and full gates on Linux; build/pack one release archive, inspect and
   upload that immutable Actions artifact identity.
2. Linux x64 and macOS arm64 jobs download **the same artifact ID**, independently verify
   hashes, and install/drive CLI+MCP from that archive without another build/pack. No wider
   platform or interactive-board support is claimed.
3. The `npm-release` job waits for the configured human approval. Download **this run's
   archive** and perform the real-terminal board check before approving; a prior dry-run
   archive is not necessarily byte-identical to this run's archive.
4. Revalidate original bytes, clean source, remote tag, registry version/integrity/latest and
   release state. Prepare a draft with matching archive/manifest/checksum/notes using
   `gh release create --verify-tag`; append only missing matching draft assets, never
   overwrite remote assets.
5. Publish the **archive path**, not dist, using npm OIDC; bounded registry readback confirms
   integrity/stable-tag state. Publish the draft only afterward; verify final asset hashes
   and immutability. Notes/title can still be edited on GitHub, so the reviewed notes file
   is also an immutable asset. Checksums establish bytes, not independently trusted origin.

Only publication has GitHub contents-write/id-token-write permissions. Its package-wide
concurrency group does not cancel an in-flight publication and is separate from superseding
CI gates. Pending runs can be replaced; external publishers are not locked by Actions.
Tag protection and human setup remain important because the remote services are not an
atomic transaction.

### Manual real-terminal smoke

Use the publishing run's downloaded archive in a disposable home. Keep registry/age policy;
if blocked, inspect it rather than bypassing it. The package manager must install the
supported global bin; do not synthesize an internal-bin fallback.

```bash
# HUMAN, in a real terminal; replace the archive path with this run's original bytes:
work=$(mktemp -d)
cd "$work" && git init -q
HOME="$work/home" BUN_INSTALL="$work/bun" \
  BUN_INSTALL_GLOBAL_DIR="$work/bun/install/global" BUN_INSTALL_BIN="$work/bun/bin" \
  KABANE_HOME="$work/tracker" KABANE_HARNESSES= \
  bun add -g /absolute/path/to/kabane-<version>.tgz
HOME="$work/home" KABANE_HOME="$work/tracker" KABANE_HARNESSES= "$work/bun/bin/kabane"
```

Expect first-run card/setup/board; `q` quits. This command is not an agent authorization.

## Duplicate and partial-release recovery

- Identical npm version plus immutable matching GitHub release: verified no-op, no writes.
- Matching draft: verify each existing asset; add only missing assets, never clobber.
- npm version already exists with matching original bytes/stable-tag state: finish GitHub
  only, never republish. A later `latest` is not rolled back during older-release recovery.
- Any source/tag/version/hash/asset conflict, unknown state or unprotected final release:
  nonzero failure; investigate manually. Never unpublish/delete/move tags automatically.
- Publisher timeout/error: read committed state with a bounded retry, **no blind publish
  retry**. npm success followed by GitHub failure leaves a recoverable draft and nonzero
  partial result. Rerun failed jobs while the successful producer's original artifact is
  retained. If unavailable, recover the original hash-verified bytes from retained draft
  assets, or stop; rebuilding the same source does not recover its artifact identity.

A live human release must verify trusted-publisher token exchange, npm provenance and
integrity, protected-environment behavior, immutable GitHub assets/tag/attestation and
actual supported-platform execution. Local mocks/static workflow validation do not prove
those properties.

Official sources and pinned-Bun proof are recorded in
[`release-update-plan.md`](release-update-plan.md). Binary updates/data rollback are
separate procedures; see [updating](getting-started.md#updating).
