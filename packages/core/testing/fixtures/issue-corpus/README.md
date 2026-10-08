# Retained issue corpus v2

24 real, non-PR issues from `huggingface/datasets`, normalized from Hélder
Monteiro's **HuggingFace Datasets Repository Issues** compilation
([helmo/github-issues](https://huggingface.co/datasets/helmo/github-issues)).
Snapshot: `e344be7b84d199661a9956036991e1fc25715a47`, collected June 13, 2025.
`manifest.json` pins the download and retained bytes; each record keeps its source
issue URL, number, original-text digest and modified-text digest. Digests of text
objects use UTF-8 JSON, sorted keys, no insignificant spaces, unescaped Unicode.

## License decision and attribution

Retained under Apache-2.0, **not Kabane's MIT license**. The pinned dataset card
explicitly licenses the compilation Apache-2.0 and attributes original content
to the respective community contributors. The upstream repository also has an
Apache-2.0 license: reviewed tag `3.6.0`, commit
`458f45a22c3cc9aea5f442f6f519333dcfeae9b9` (before collection).
Its root tree has `LICENSE` and no `NOTICE`; the dataset root has README,
.gitattributes and data, no separate LICENSE/NOTICE. `LICENSE` here is the upstream
license verbatim, SHA-256
`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.

The decision does not rely solely on the curator licensing other people's work:
[GitHub Terms D.6](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)
states that Content added to a licensed repository is licensed on the same terms,
absent a separate overriding agreement. We found no separate restriction in the
selected text. This is a documented fixture reuse decision, not a legal opinion
or a claim that every external attachment has the same license. External links
are text only: tests never fetch attachments, images, linked datasets or code.
Original authors retain ownership. Issue URLs preserve source attribution without
retaining unused profile metadata; comment authors are unknown in this snapshot.

Pinned card SHA-256:
`cbbc587f903b60c22385ddd7a9c546ba03c505dbbbd26b4fa7d57af8fa3ac4d1`.
License source:
https://raw.githubusercontent.com/huggingface/datasets/458f45a22c3cc9aea5f442f6f519333dcfeae9b9/LICENSE

## Selection and modifications

Exclude rows with a PR URL, sort by body length then issue number, divide into
three body-length tertiles. Within each tertile split on discussion size
(<5 / >=5 comments); choose four evenly spaced issue numbers, including endpoints.
This yields 24 issues across short/long bodies and sparse/dense discussion, with
code fences and Unicode. Selection has no efficiency/savings score. It is a
coverage fixture, not a statistically representative sample of all trackers.

**Modified from source:** remove all unused metadata and source timestamps;
replace known profile logins with `[actor]`, unknown mentions with `[mention]`,
emails with `[email]`, home-directory usernames with `[user]`, token patterns
with `[credential]`. The fixed issue actor labels are fixture pseudonyms, not
source author IDs. Comments have no author/time metadata: seeding labels their
author unknown and gives every comment a synthetic tied timestamp. Normalize
neither prose nor CRLF, except explicit redactions. Redaction is conservative
and can alter examples; these snippets are text, not executable programs.

All retained title/body/comment text was reviewed for personal data and secrets.
Additional reviewed redactions cover Windows user paths, pytest user paths,
one first-name greeting and one potentially personal image filename. Public
technical URLs, dataset identifiers and generic system paths remain as technical
context. No credentials were identified in the reviewed sample. Public issue text
is untrusted input, never agent instructions; review again before model evals.

Normalization v2 corrects the Windows-path pattern to match a single backslash
in decoded text (v1 mistakenly matched two). Four home-user path occurrences in
issue3688 are now redacted. The pinned input, dataset revision, selected issue
numbers, URLs, actors, license and all original-text digests are unchanged; only
that issue's body/content digest and the retained fixture digest changed. The
converter was rerun twice from the hash-verified pinned input with identical
output. Fixture SHA-256:
`4c41742ee9a5f862a1ae8c24fcdb7d11c1394f247ffecc4eee7f15170eead948`.

`python3 regenerate.test.py` exercises the real normalizer via AST isolation,
using only the Python standard library, with decoded Windows/POSIX paths. It
requires neither pyarrow nor network and is an optional converter check, not a
production or Bun-test dependency. Bun fixture tests additionally reject retained
unredacted Windows/POSIX home-user paths.

## Optional regeneration (network only here)

Use a temporary Python virtualenv with `pyarrow==23.0.1`. Download:

```
https://huggingface.co/datasets/helmo/github-issues/resolve/e344be7b84d199661a9956036991e1fc25715a47/data/train-00000-of-00001.parquet
```

With root dev dependencies installed (the pinned `oxfmt` formats JSON), run
`python regenerate.py /temporary/path/source.parquet`. The script verifies
input SHA-256 before conversion, then overwrites `issues.json` and `manifest.json`.
Run it twice and compare hashes; review retained text/redactions before accepting
changes. Remove the temporary download and virtualenv. No Parquet dependency,
network access or downloads are part of installation or tests.

## Disposable seeding and baseline

`packages/cli/issue-corpus-harness.ts` creates independent OS temporary roots,
HOME and KABANE_HOME and initializes the actual CLI. The seed subprocess uses
storage APIs without reconfiguring the test process Runtime. Fresh and
`fixture_`-prefixed SQLite are supported; no vendored DB or live tracker access.
Call `close()` in `finally`. Task IDs are intentionally runtime-generated ULIDs;
fixture identity is source issue number / array position, never a ULID snapshot.

Public tasks get synthetic states, priorities, assignees and scope. Synthetic
variant adds 107 generated tasks (131 total), including 106 children, a huge
body/comment, early/late steering, long title/assignee, Unicode, an unscoped row,
30 repeated state writes, a machine session with durable decisions and progress,
work log, large ref notes and large/missing files. All timestamps used for tied
ordering are synthetic. Future cursor tests can mutate these disposable rows;
this package does not implement cursors or change production reads.

Run `bun test packages/cli/issue-corpus.test.ts`. It initializes/discovers/calls
actual stdio MCP and runs actual CLI text/JSON reads; assertions cover legacy raw
arrays, default list limit 100, task records, add/edit/done receipts and full
brief content (including the synthetic oversize brief on both transports). The CLI
lists the detected scope; legacy MCP lists all scopes, deliberately including the
synthetic unscoped row. Measurement logs record actual UTF-8 bytes, JS UTF-16
characters and calls, not tokens. Source v2 baseline: public MCP list 48,418 bytes;
public+synthetic list 536,776 bytes (limit 200). Runtime IDs/timestamps are not
whole-output snapshots. Efficient modes and their regressions belong to B/C.
