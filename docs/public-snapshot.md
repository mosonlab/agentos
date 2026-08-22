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

## The release authority attestation

The snapshot excludes every file under `docs/reviews`, and one of those files is
the evidence the migration preflight reads before it will let a
migration start. A snapshot without a substitute cannot run its own release
migration at all — not because it is unsafe, but because the proof is missing.

`release-authority.json` is that substitute, and it carries its own trust:

**Once, as an operator action — done.** `release-authority.pub` is tracked at
the repository root: an Ed25519 public key, fingerprint
`632a7cd307d0090855ebd79e92ae1e64a65d3cd3e66b53e2dffe3ac5aa39d3f5`. It was
created by the command below, reviewed, and merged like any other source file;
its private half is the release owner's, lives outside every checkout at mode
0600, and is in no repository, log or pull request.

```sh
npm run snapshot:authority-keygen -- ~/.agentos-keys/release-authority.ed25519
# save the printed public key as release-authority.pub, review it, commit it
```

The keygen script refuses to write a private key anywhere inside the repository
and refuses to overwrite an existing one. Rotating the anchor means committing a
different public key — a visible edit to a tracked file, and to the fingerprint
pinned in `packages/db/src/release-authority.test.ts`.

**Per export:** mint the attestation from the clean private checkout, at the
exact commit being exported. A snapshot published without this step ships no
attestation and its readers stop at `authority`; the anchor makes the second
path available, not automatic.

```sh
RELEASE_AUTHORITY_KEY=~/.agentos-keys/release-authority.ed25519 \
GOAL5A0_MASTER_SHA=<40-hex> GOAL5A0_CONTROL_PLANE_A_SHA=<40-hex> \
  npm run snapshot:authority
```

Minting refuses unless every one of these holds:

- the worktree matches `HEAD` including untracked files — the attestation hashes
  what is on disk and names a commit, and a file on disk that is not in that
  commit cannot honestly be attested to it;
- every attested file is in `HEAD` with exactly the bytes on disk, checked file
  by file against the commit's blobs. `git status` alone would miss a file that
  is ignored rather than untracked, so this is checked separately;
- the signing key is the private half of the tracked `release-authority.pub`;
- the private revalidation document is present and passes the same check the
  preflight runs — the same function, so the attestation records a check that
  passed rather than replacing one.

**Then scan.** The attestation is a snapshot input, so it is scanned like every
other one:

```sh
npm run snapshot:scan
node scripts/public-snapshot-scan.mjs --list-included
```

The attestation is a tracked file, so `git ls-files` sees it and the scanner
reads its bytes and classifies it against the same include rules as everything
else. `mintedArtifacts` is the manifest's mechanism for a snapshot input that is
generated rather than tracked, and it is empty: nothing this repository
publishes is minted-and-untracked today.

**Then commit the attestation.** It is tracked, so it is reviewed and gated like
the key that verifies it, and re-signing it is a commit like any other:

```sh
git add release-authority.json
```

An attestation left stale after the migration set moves is refused by the
preflight rather than ignored, so a release whose authority was not re-signed
stops at `authority`.

**What the published repository proves, and what it cannot.** A public snapshot
is this export committed into a fresh repository, so it has history — its own.
None of the private commits the attestation names exist there, which means the
preflight cannot ask that repository about the private ancestry at all. It asks
the strongest question that lineage can answer instead: every release-path file
must be committed there, at `HEAD`, with the bytes the attestation was minted
over. The run prints which of the three bindings answered:

```text
preflight authority=attestation binding=signature-content-and-published-tree
preflight authority=attestation binding=signature-and-content
preflight authority=revalidation-document+attestation binding=signature-content-and-history
```

Nothing else is relaxed there. Signature, trust anchor, closed file manifest,
migration-set digest, private evidence digests and the two operator-declared
SHAs are checked in a published repository exactly as they are in a private
checkout, and `packages/db/src/release-authority.dbtest.ts` runs the real
preflight against a real database in all three lineages to prove it.

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
