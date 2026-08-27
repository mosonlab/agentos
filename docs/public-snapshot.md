# Public snapshot safety check

`public-snapshot.json` is the authoritative, closed-by-default file boundary for
a future clean public snapshot. It does not create a repository, publish a
release, or change repository visibility. The MIT `LICENSE` records the license
chosen for that snapshot; it is not broader legal advice.

From a clean checkout, run:

```sh
npm run test:snapshot-scan
npm run snapshot:scan
```

The scan requires every tracked worktree file to match `HEAD`; it fails closed
instead of attributing dirty bytes to the reported commit. Untracked files are
outside the Git-tracked snapshot source. The scan emits JSON containing only
categories, dispositions, paths, reasons, and occurrence counts. It never emits
matching line content or candidate token, ciphertext, credential, or PII
values. Exit code 0 means every tracked path and finding is classified. Exit
code 1 means at least one blocker exists; exit code 2 means the scan failed
closed.

The only valid dispositions are:

- `blocker`: stop; the path is unclassified or public-scoped material needs a
  specific decision or cleanup.
- `approved-public-material`: a narrowly documented placeholder or synthetic
  fixture is safe in the snapshot.
- `later-release-follow-up`: the material is explicitly excluded from this
  snapshot and needs a separate publication review before it can be included.

When the report is green, this command prints the exact sorted file list for a
future snapshot tool to consume:

```sh
node scripts/public-snapshot-scan.mjs --list-included
```

## What is open under `docs/`

`docs/` is closed by default. Every path that opens part of it is named one at a
time rather than by a directory glob. The public set includes this page, the
named release documents and fixtures, the public governance/demo pages, and the
individually reviewed operator runbooks. The merge-executor authority is
`docs/runbooks/merge-executor.md`; its repeatable wizard and deterministic test
are separately named source entries in `public-snapshot.json`.

The exact list is the point. A directory glob would publish anything dropped into
`docs/release/` afterwards, which is how `docs/release/v0.1.0-evidence-template.md`
would have gone out: it is the maintainer's own evidence form, filled at one
release-candidate commit, and not a document a reader follows. It is excluded by
name, with a reason, so the scan classifies it as held back rather than as a file
nobody looked at, and a scanner test asserts that the open list is exactly the
eight paths above and that none of them is a directory glob.

These pages were written as public artifacts rather than moved from internal
documentation. Plans, reviews, specifications, and unlisted runbooks stay
excluded. Publishing user documentation is not a reason to publish what it was
written from.

Do not copy a directory wholesale. Reviewed source and configuration patterns
form a bounded allowlist. Repository-wide `deny` rules take precedence over an
include and keep private, generated, coverage, dump, capture, runtime, build,
cache, and installed-dependency path classes out of the snapshot. Outside those
deny rules, a newly tracked file that matches no single include or exclude rule
is a blocker, as is any overlapping rule. Scope totals report excluded,
unclassified, and overlapping files separately.

The scanner checks high-confidence credential formats and connection strings,
secret-like assignments in tracked `.env` files, email and government-ID
patterns, private absolute paths, binary material, internal-only paths, and
known generated or runtime capture paths. Secret-like assignments are approved
as placeholders only when their value is empty, exactly `CHANGE_ME`, or a
single environment-variable reference such as `${EXTERNAL_API_KEY}`. Every
other non-empty assignment is a blocker. This focused scan is a release gate,
not a claim that pattern matching can prove the absence of every possible
secret.
