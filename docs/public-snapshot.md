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

The scan reads only Git-tracked files and emits JSON containing categories,
dispositions, paths, reasons, and occurrence counts. It never emits matching
line content or candidate token, ciphertext, credential, or PII values. Exit
code 0 means every tracked path and finding is classified. Exit code 1 means at
least one blocker exists; exit code 2 means the scan failed closed.

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

Do not copy a directory wholesale. A newly tracked file that matches no single
include or exclude rule is a blocker, as is any overlapping rule. The scanner
checks high-confidence credential formats and connection strings, secret-like
assignments in tracked `.env` files, email and government-ID patterns, private
absolute paths, binary material, internal-only paths, and known generated or
runtime capture paths. This focused scan is a release gate, not a claim that
pattern matching can prove the absence of every possible secret.
