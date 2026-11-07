# Verified release and explicit update — proposed contract

Status: implemented; committed during the 2026-10-08 handoff. The additional Astra
review was stopped at the maintainer's request on 2026-10-05, without a release/update
verdict. The handoff reuses the recorded local test evidence rather than repeating the
full test matrix. External setup and live release verification remain human-owned;
no release version is selected here. The accepted token-efficiency work remains unchanged.
Parent approved fail-closed refusal of the pinned-Bun missing-global-bin case.

## Approved decisions

1. Approve a manually dispatched release workflow, defaulting to nonpublishing verification,
   with an approved `npm-release` environment for the publishing job. Publishing requires
   dispatch **on an existing `v<version>` tag**, not a branch plus a different checkout ref.
2. Approve stable-only updates within the installed major; for `0.x`, stay within its minor.
   No version/channel/force override in v1. Crossing that boundary requires a deliberate
   manual installation after reading compatibility notes. `kabane update` itself is the
   explicit authorization; no additional interactive prompt or `--yes` is needed.
3. Approve **latest-only** selection: if the registry's `latest` is outside that policy,
   prerelease, older, or blocked by Bun policy, report it and do not choose an older fallback.
4. `update --check` is metadata-only, reporting a stable **candidate** with installation
   eligibility explicitly unknown/policy-unverified in text and JSON. A current/no-op result
   also does not certify fresh policy validation. `update` must perform a proven bounded
   policy-enforcing Bun dry-run before installing that exact candidate; no check-time probe.
5. Approve Linux x64 plus macOS arm64 installed-artifact smoke. They exercise distinct
   OpenTUI native dependencies and Bun global-layout/symlink behavior. No Windows or wider
   platform claim. Keep the existing manual board-in-a-real-terminal check.
6. Confirm human-owned setup and version selection described below. No token fallback if
   trusted publishing is unavailable; stop and report that setup is incomplete.

Decision 4 is substantive and parent-approved. Official Bun documentation establishes age enforcement for
exact installs but not age enforcement by `bun info`. It also says exact requests bypass
Bun's range-resolution stability heuristic. We must not call a metadata candidate
“eligible,” or imply identical range and exact-version resolution behavior.

## Existing entry points and gaps

- `packages/cli/package.json` is the only release version. The root version is private
  workspace metadata. `scripts/build.ts` carries the CLI version into the generated
  manifest and bundle; three exact React/OpenTUI dependencies remain external.
- `scripts/smoke.ts` builds and packs internally, installs that tarball into disposable
  HOME/BUN_INSTALL/KABANE_HOME, and exercises the installed CLI and stdio MCP. It removes
  the tarball on success. The runbook subsequently publishes the directory, not the tested
  archive. Retain and publish the same archive instead.
- `.github/workflows/ci.yml` freezes dependencies and runs check/typecheck/test/smoke on
  Linux. Its superseding-gate cancellation policy must not be reused for publication.
- `main.ts` already dispatches `standalone` commands before `openContext`. Reuse that
  boundary for update; no new tracker-initialization bypass framework is needed.
- Local research observed Bun **1.4.2**; `.bun-version` pins **1.4.0**. Documentation was
  consulted against Bun's `bun-v1.4.0` sources. Local help output is not a 1.4.0 execution
  test. Registry `kabane@0.1.0` and absence of GitHub releases were reported by the parent;
  `git tag -l` returned no local tags. Neither absence proves no remote tag exists.

## Release contract

### Verification and artifact identity

A new `release.yml` has `workflow_dispatch` only, with `publish: false` by default.
Nonpublishing runs may verify a branch; such artifacts are explicitly nonpromotable when
there is no matching existing tag. Publishing runs require all of:

- Repository exactly `davidpp/kabane`; dispatch ref is a tag `v<stable semver>`.
- Peeled existing remote tag commit = checkout HEAD = event source SHA; source CLI version
  = tag suffix = generated package version = installed CLI and MCP versions.
- Checked-in lockfile exists; `bun install --frozen-lockfile`, full check/typecheck/test,
  then one build and one `npm pack --json` from generated dist.
- Tarball inspection retains current no-workspace-dependency/no-map/no-machine-path checks,
  validates package identity, bin, engine and exact externals, and rejects unexpected paths
  or unsafe archive entries before extraction.
- SHA256 and npm-compatible SHA512 integrity are calculated from those actual tarball
  bytes. Record version, commit, tag, Bun/npm versions, archive filename and hashes in a
  validated release manifest; include checksum and release-notes files as assets.
- Installed CLI/MCP smoke consumes this archive, without building or packing again, on
  Linux x64 and macOS arm64. Existing concise/context checks remain intact.
- Upload once under an immutable Actions artifact identity. Each consumer recomputes
  hashes and fails on mismatch; the download action's digest warning is not enforcement.

The ordinary `bun run smoke` still builds/packs a temporary archive. Add an explicit
existing-tarball mode and an artifact-retention/output mode, sharing the installed checks.
Release verification retains its archive; no second package build is hidden in smoke.

### Publication and human control

The publishing job depends on both platform checks, uses `environment: npm-release`, and
alone receives `id-token: write` and GitHub release `contents: write`. Verification jobs
have read-only permissions. Pin reviewed action revisions and an exact approved Node/npm
pair; npm requires CLI >=11.5.1 and Node >=22.14.0 for trusted publishing. Node 24 is the
official npm example; select and verify exact patch versions during implementation.

Use a package-wide concurrency group, `cancel-in-progress: false`, separate from ordinary
CI. This prevents simultaneous runs, not external publishes or guaranteed queue ordering.
Immediately before irreversible operations, reread tag/commit, archive hashes, registry
version/integrity, current stable tag and existing GitHub release/assets. A new stable
release must advance `latest`, never implicitly downgrade it.

1. Verify all preconditions and prepare a draft GitHub release with the existing tag,
   explicit `--verify-tag`, notes and all assets. Never create/push a missing tag. Existing
   draft assets must match byte-for-byte; no overwrite/clobber recovery.
2. Publish **the archive path**, not dist, with `npm publish ./kabane-X.tgz --access public
   --tag latest --ignore-scripts`. No rebuild/repack, inherited publish token, login or
   implicit credential fallback. Check OIDC prerequisites before invoking; errors remain
   errors. `npm whoami` is not an OIDC permission test.
3. Verify the exact registry version, SHA512 integrity and expected stable tag with bounded
   retries. Publish the prepared GitHub draft only after confirmation. Verify final asset
   hashes and immutable-release status.

A checksum is byte identity, not independently trusted authenticity. npm OIDC provenance
and GitHub immutable release attestations add provenance; their live behavior remains a
human verification step. Notes are not immutable on GitHub, so also attach the reviewed
notes file as an immutable asset.

### Dry-run, duplicates and partial failure

Nonpublishing mode runs the gates, artifact inspection, installed smoke and artifact
upload/download/hash round trip, emits the planned publication operations, and never
creates a draft, publishes, changes dist-tags or requests publishing credentials. It does
not run `npm publish`, even with `--dry-run`, or claim to validate OIDC authentication.
Existing registry versions can be reported as promotion blockers without blocking the
nonpublishing artifact test itself.

| Observed state | Allowed behavior |
|---|---|
| Registry version absent, no release | Fresh approved publication |
| Matching draft only | Continue with matching assets and existing tag |
| npm version exists, matching integrity/source artifact | Resume GitHub completion; never republish |
| Matching npm + immutable GitHub release | Report verified already complete; no writes |
| Any tag/version/hash/asset mismatch | Fail closed; human investigation |
| Publisher timeout/error, registry state unknown | Bounded readback; no blind retry of publish |
| npm succeeds, GitHub fails | Nonzero partial result; retain matching draft/archive; resume completion only |

Continuation uses the retained original artifact and its provenance. A failed publishing
job can be rerun while successful preparation jobs/artifacts remain available. If the
original artifact is unavailable, recover a hash-verified original archive from retained
assets or stop; rebuilding the same source is not permission to replace its bytes. Never
unpublish, move tags, delete releases or roll back `latest` automatically.

## Update contract

`kabane update [--check] [--json]` is standalone. Invalid flags/positionals fail before
metadata access. No startup check, MCP tool, board hot update, git pull, tracker config
read, schema initialization, sync, harness registration or Cloudflare call is added.

### Positive identification

Before any mutation, require agreement between the running packaged bin, its enclosing
published manifest, Bun's effective global directory/bin location, global dependency
registration and registry lock resolution. Resolve symlinks and validate containment;
normal Bun isolated-layout symlinks are not themselves evidence of a source link.
Reject private/source manifests, workspace/link/file/git/URL registrations, local tarball
installs, mismatched versions/bins, paths escaping the owned global tree, unsupported
lockfile/layout/Bun variants and installations belonging to another package manager.
Default and documented configured global directories are in scope only when positively
resolved. Unknown means unsupported, not “probably global.”

Source links get nonmutating contributor instructions: review/update their checkout
manually and follow the existing build/link path. Do not suggest replacing the link with a
registry install automatically. A supported-install check may fetch metadata; an
unsupported install reports its reason without networking or touching its link.

The exact directory/lockfile identification and metadata output must first be demonstrated
on pinned Bun 1.4.0 in disposable fixtures. Do not parse human `pm ls` output as authoritative
provenance or invent an undocumented package-manager inspection API.

### Metadata, policy and installation

Use Bun's own metadata command (`bun info` / documented `bun pm view` alias) with argument
arrays and inherited global registry/auth/proxy/TLS configuration. Keep metadata and
installation in the same intentional global-install configuration context, not whichever
project happens to be cwd. Never hardcode npmjs for user updates, print credentials,
replace user configuration, null out npmrc, disable age/integrity checks or force resolution.

Validate unknown metadata with zod `safeParse`: package identity, strict stable version,
expected target details and compatible Bun engine. Reject malformed/excessive output,
missing information or incompatible targets. Proposed bounds: 15 seconds per metadata
subprocess, 30 seconds total check, 1MiB per captured stream; abort/kill on overflow and
report nonzero. A limited metadata schema is not a bound on the registry's own work.

Compare the registry's stable `latest` with the installed version. Equal is current; lower
is not a downgrade; prerelease/current prerelease, larger policy boundary or invalid target
is manual-only. No fallback to historical versions or registry-wide version enumeration.
Report target selection separately from Bun's installation policy, per decision 4.

For explicit update, recheck installation identity immediately before mutation, then use
Bun's exact-target dry-run to enforce its applicable registry/release-age/security policy.
If blocked, stop without changing the installation; do not weaken settings. Demonstrate
this dry-run's effects in fixtures first. Then invoke the same verified Bun executable with
`[bun, 'add', '--global', '--exact', 'kabane@X']`, preserving that policy context. Bound the
operation (proposed 120 seconds), and do not use a shell or a version supplied unchecked
by metadata. Respect Bun's configured dry-run setting; final verification cannot mistake
no installation for success.

Afterward verify global registration, package manifest version and bin ownership again,
then run **that exact installed bin** with `--version`. Success requires agreement on X;
ordinary PATH lookup alone is insufficient. Say board/MCP processes must be restarted.
Existing source-pinned MCP commands still point at source and need deliberate manual
rewiring if desired; no user config is changed.

A manager failure, timeout or mismatched postcondition is nonzero and may have partially
changed the executable installation. Never claim “nothing changed” after invoking it,
retry automatically, delete package-manager files or silently downgrade. Rechecking an
owned path is not an atomic lock against an unrelated human/package-manager process;
detect mismatches and state that concurrency limit rather than claiming atomic updates.

### Data and rollback

The updater never opens a tracker database, including externally configured shared DBs.
This is independent of what a later normal CLI invocation may migrate. Stop board/MCP and
other shared-data writers before deliberately moving to a release with schema changes;
read compatibility notes and make a consistent backup of the actual configured databases,
config and associated WAL state before the first normal open. A SQLite backup mechanism or
closed/checkpointed database is required, not an arbitrary live main-file copy.

Reinstalling an old executable is not database rollback. If a newer executable has already
migrated shared data, only a documented compatible binary or an explicitly coordinated
backup restore is safe. No downgrade/backup/restore/migration orchestration is added here.

Exit codes follow the CLI: 0 verified check/no-op/success, 1 operational failure or refused
update, 2 usage. JSON distinguishes candidate/policy-unverified, current, manual-only,
unsupported, verified updated and partial failure; an operational error is never a
successful result with an error string embedded in it.

## Territory and proof required after approval

- New `.github/workflows/release.yml`; CI adjustments only for justified artifact smoke.
- `scripts/build.ts`, `scripts/smoke.ts`, focused artifact/release helper and co-located tests;
  root scripts/manifest only if needed. No release framework or SDK upgrade.
- `packages/cli/src/commands/update.ts`, focused install/metadata helper and co-located tests;
  `main.ts` command registration/help using existing standalone dispatch.
- `docs/release.md`, install/upgrade guidance in README, CLI README and getting-started;
  update this plan's proposed decisions only after acceptance. No token-efficiency contracts,
  core/Worker APIs, migrations or parent-owned efficiency plan edits.

Tests must exercise the **packed CLI** with isolated HOME/BUN_INSTALL/KABANE_HOME and a
controlled registry/package-manager fixture, not only helper mocks. Use real pinned Bun
for layout/config/policy evidence; mock irreversible publisher operations. Source-link and
unknown tests snapshot links/manifests; all update cases use invalid/read-only or absent
tracker config/DB sentinels and assert no DB/config/WAL/harness writes. Cover hoisted and
isolated installs, configured directories, unrelated cwd config, credential-redacted errors,
offline/timeouts/oversized output, metadata/engine/version mismatch, age blocks/exclusions,
major and pre-1.0 minor boundaries, prereleases/downgrades/current, manager failures,
mid-install partial changes and incorrect installed versions. No live user update.

Release tests cover missing/unsafe artifact, source/package/tag/SHA/hash mismatch, missing
remote tag, duplicate/integrity conflict, lower `latest`, concurrency configuration,
OIDC/permission absence, publisher failure/ambiguous result, GitHub partial completion and
idempotent recovery. Static workflow validation must assert default dry-run, tag/ref guards,
environment, permissions and concurrency; YAML parsing alone does not prove GitHub/OIDC
execution. Demonstrate a nonpublishing artifact round trip and full
`check/typecheck/test/smoke/diff --check`; report live publishing and manual TUI as unverified.

## Human-owned setup and live verification

David must select and commit the release version, push its reviewed commit and signed
existing tag, configure repository immutable releases/tag protection, create the protected
`npm-release` environment with an appropriate reviewer/self-review policy, and configure
npm's trusted publisher for `davidpp/kabane`, exact workflow filename `release.yml`, and
exact environment name. Current npm docs say newly created trusted publishers default to
staged-publish permission only; this proposal needs **direct `npm publish` explicitly
allowed**. Do not add staged publishing merely to avoid deciding that permission.

Confirm the repository/package are public for automatic npm provenance, and that the
workflow uses GitHub-hosted runners. No npm token is installed as a fallback. Environment
protection, successful token exchange, registry provenance/integrity and final immutable
GitHub assets require an explicitly human-authorized live run; a local dry-run cannot prove
them. No external setting or publish-capable workflow is run during this design task.

## Official references

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): supported runners,
  npm/Node minimums, workflow/environment matching, OIDC/provenance, allowed actions,
  `whoami` limitation and token fallback behavior.
- [npm publish v11](https://docs.npmjs.com/cli/v11/commands/npm-publish/): tarball input,
  immutable name/version, submitted SHA512 integrity and tag behavior.
- [GitHub release create](https://cli.github.com/manual/gh_release_create): missing-tag
  creation by default, `--verify-tag`, draft/asset handling.
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
  and [enablement](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes):
  draft-first, locked tags/assets, mutable notes and automatic release attestations.
- [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments),
  [concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
  [artifact transfer](https://docs.github.com/en/actions/using-workflows/storing-workflow-data-as-artifacts)
  and [runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
  Artifact digest mismatches warn rather than automatically fail; pending runs can be
  replaced with default queue settings. Use current documented macOS arm64 labels explicitly.
- Bun 1.4.0 sources: [info](https://github.com/oven-sh/bun/blob/bun-v1.4.0/docs/pm/cli/info.mdx),
  [install](https://github.com/oven-sh/bun/blob/bun-v1.4.0/docs/pm/cli/install.mdx),
  [package utilities](https://github.com/oven-sh/bun/blob/bun-v1.4.0/docs/pm/cli/pm.mdx),
  [lockfile](https://github.com/oven-sh/bun/blob/bun-v1.4.0/docs/pm/lockfile.mdx).
  `--lockfile-only` still populates cache with metadata **and tarball dependencies**; it is
  not a metadata-only check. Exact versions honor age but bypass the stability heuristic;
  missing registry timestamps pass Bun's age gate, so do not assert a stronger guarantee.
- Current Bun [bunfig](https://bun.sh/docs/runtime/bunfig) and
  [npmrc](https://bun.sh/docs/pm/npmrc): global/local precedence and registry credentials.
  The npmrc supported-options page does not establish `min-release-age` compatibility;
  verify pinned-runtime behavior before repeating that runbook claim as updater policy.

## Pinned Bun proof and implementation evidence

Downloaded the official `bun-v1.4.0/bun-darwin-aarch64.zip` into an owned temporary directory,
not a user installation. Its SHA256 matches the official `SHASUMS256.txt`:
`c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381`.
The executable reports `1.4.0`, build `34cbb9a40`.

A loopback registry served self-authored tiny `kabane` packages 0.1.0/0.1.1/0.1.2 with
SHA512 integrity and publication times. Separate disposable HOME/XDG_CONFIG_HOME,
BUN_INSTALL and cache directories tested hoisted and isolated `install.linker` settings,
with global bunfig registry and `minimumReleaseAge = 86400`. These are package-manager
probes, not tests of the actual Kabane updater (which is not implemented yet).

- `bun info kabane --json` succeeds from the existing global package root, reporting the
  young latest 0.1.2 despite the age setting. Running it from an empty home without a
  package.json instead fails with “Bun could not find a package.json file to install from.”
  The approved intentional global-install cwd is required, not merely cosmetic.
- In both layouts, eligible exact 0.1.1 dry-run exits 0 and age-blocked exact 0.1.2 exits 1.
  Whole-install snapshots of regular-file hashes and symlink targets remain identical after
  both probes. Dry-run can download/extract the target tarball into cache, confirming that
  it belongs only in explicit update, never metadata-only check.
- Global package.json records `kabane: 0.1.0`; bun.lock is JSONC, lockfileVersion 2,
  configVersion 1, with a `kabane@0.1.0` registry tarball/integrity tuple. Hoisted package
  files are directly under node_modules/kabane; isolated files live under
  node_modules/.bun/kabane@0.1.0/node_modules/kabane with normal internal symlinks.
- Hoisted actual exact update to 0.1.1 changes installation state and its global bin prints
  0.1.1, as expected.
- **Counterexample:** pinned Bun's fresh isolated global install exits 0 and creates internal
  node_modules/.bin links, but never creates the advertised global bin. `bun pm bin -g`
  prints BUN_INSTALL/bin although BUN_INSTALL/bin/kabane is absent. Actual exact update also
  exits 0 and advances manifest/lock/package files but still leaves that bin absent; invoking
  it fails with “Module not found.” Do not infer a usable owned executable from registration
  or package-manager success, and do not repair/create the link automatically.

Parent approved v1 refusal of this missing/unverified isolated-global case: support is proven
hoisted registry installs with positive current global-bin/registration/lock ownership. No
internal-bin or PATH fallback, link creation/repair, prerequisite/pin change or source-version
bump. The retained self-authored registry fixture and actual packed-CLI regressions reproduce
fresh/update missing-bin refusal, real bun-link refusal, eligible/young policy behavior and
installation/tracker/WAL/harness sentinel snapshots. Temporary downloaded binary/probes/logs and local round-trip artifacts
were removed after final verification; no binaries/tarball caches are versioned.
To reproduce, invoke a separately checksum-verified Bun1.4.0 executable (no global install)
from the repository root: `"$BUN_140" test packages/cli/src/commands/update.test.ts
packages/cli/src/update-process.test.ts scripts/release-artifact.test.ts
scripts/release-publish.test.ts scripts/release-workflow.test.ts`. The fixture creates its
own local registry, homes, registration/lock/cache/bin layouts and tracker/harness sentinels;
no external registry or real-user update is needed for these tests.

Implementation checkpoint: actual packed-CLI/local-registry tests have run on checksum-verified
Bun 1.4.0, including verified hoisted/default+explicit directory installs, metadata-only young
candidate, age-blocked unchanged installation, real source bun-link, missing isolated bin,
trusted postinstall failure/bin removal and policy/current/malformed/offline cases. The
bounded-child tests cover output limits, credential-bearing diagnostics and process-group
timeout. Local retained-archive preparation/hash verification/installed CLI+MCP smoke passed
without another build/pack in the consumer. Final check/typecheck/test/smoke/diff checks passed:
1,163 Bun tests +77 Worker tests. A final checksum-verified Bun1.4.0 run passed all31 new
co-located tests across5 files. No live OIDC/publish/GitHub settings/remote workflow/manual TTY
checks were performed; Linux native smoke is defined in the workflow but was not run locally.

Proposed workflow pins were verified via official GitHub ref APIs: checkout v7
`3d3c42e5aac5ba805825da76410c181273ba90b1`, setup-bun v2
`0c5077e51419868618aeaa5fe8019c62421857d6`, setup-node v6
`249970729cb0ef3589644e2896645e5dc5ba9c38`, upload-artifact v4
`ea165f8d65b6e75b540449e92b4886f43607fa02`, download-artifact v4
`d3f86a106a0bac45b974a628896c90dbdf5c8093`. Node24.21.0 is present in the official
[distribution checksums](https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt); npm12.2.0 is
[registry latest](https://registry.npmjs.org/npm/latest), whose engine accepts Node24.21.0.
These are proposed exact tooling pins for David review, not approval to release.

Two runtime details constrain claims: Bun info needs a package.json-containing intentional
cwd, and runtime/transpiler caches may also be maintained during a metadata-only command.
A pinned-Bun fixture found `install.dryRun=true` was not sufficient to prevent a real
`bun add` installation; our explicit updater conservatively blocks when that Bun setting
is true rather than relying on manager interpretation. This is a do-not-mutate guard, not
an implementation of age/version eligibility. Registry/proxy/auth/age remain Bun-owned.

Root scripts directly reuse existing zod3.25.76 and @types/bun1.4.0 as dev dependencies;
no SDK/dependency version was upgraded. Their release/smoke TypeScript is included in the
root typecheck, and co-located scripts tests in the ordinary test gate.

Final local artifact round trip: prepare once on Bun1.4.0/npm11.19.0, copy the four original
release files to a separate consumer directory, verify hashes and run installed CLI+MCP
smoke with no consumer build/pack. Archive version0.1.0, 9 published files, SHA256
`8cd07ad5c572cdbe8a9b60b5eafc45c4976305c249a362d1036c1efc3d27750b`;
SHA512 integrity
`sha512-nZE/btAVYUwMvUiev0Dsvjm8gT8BF1zJ6XWJdTBmi5YISE8jO/bkn9MiwJqk3NZNLYf/PLLm3TU8tA7mE6dtRQ==`.
This uncommitted local artifact is explicitly dirty/tag-null and nonpromotable. Workflow
Node/npm12.2.0/tool/action execution and GitHub upload/download are not established by
that local copy; static workflow guards and mocked irreversible-operation tests passed.
Ordinary installed smoke also passed (~292KiB, 9 files), preserving all accepted concise
queue/receipt/context/MCP checks. Existing plus new lint complexity/length/duplicate warnings
are nonblocking; no gate errors or bypass remained at that checkpoint. No commit,
version bump, tag, publish, external setting, real-user install, MCP rewiring or paid model
run occurred during implementation. The 2026-10-08 handoff commits the implementation;
additional review is not resumed, and live release verification remains outstanding.
