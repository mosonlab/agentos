# AgentOS — license and asset provenance

Every file the snapshot publishes is accounted for here. The rule this
page exists to enforce is simple: **nothing ships whose origin we cannot name.**
An asset without provenance is removed from `public-snapshot.json`, not published
with a shrug.

## The license

AgentOS is released under the **MIT License**.

| | |
| --- | --- |
| File | `LICENSE` |
| SPDX identifier | `MIT` |
| Copyright | `Copyright (c) 2026 Moson Lab` |
| SHA-256 | `526825b70c7e46a2e5cb8061427463b72d65fe3b2a6164b253a4f1be43cd7c23` |

[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) carries the third-party
notices; this page carries the file-level accounting behind them.

## What the published set contains

The published file set is defined by the `include` rules in
[`public-snapshot.json`](../../public-snapshot.json) and is closed by default:
every tracked file must be classified, and a file no rule reaches is a scan
failure rather than a silent inclusion.

| Category | Count | Provenance |
| --- | --- | --- |
| First-party source, tests, configuration and manifests | the majority | Written for this repository. MIT, per `LICENSE`. |
| Third-party source, vendored | 14 files | shadcn/ui. See below. |
| Data fixtures | 5 files | See below. |
| Images, fonts, audio, video, icons, compiled binaries, archives | **0** | There are none. |

### There are no binary assets

The published set contains **zero binary files**. No image, no font, no icon
file, no compiled artifact, no archive. That is not a claim about what we
remembered to check — it is a property of the file set, and it is re-checked
mechanically: `scripts/public-snapshot-scan.mjs` classifies a file as binary when
its first 8 KiB contain a NUL byte or more than 10% control characters, and the
scan reports any binary in scope.

To re-derive it from a clean checkout:

```sh
npm run snapshot:scan
```

The consequence for licensing is that there is no unprovenanced media in this
release, and no asset whose origin has to be taken on trust.

## Third-party source carried in the tree

**shadcn/ui components** — generated into this repository by the shadcn/ui CLI,
configured by `apps/web/components.json` (SHA-256
`56221b38e01375f841e47e2f9fa4998e51a7b96597d66b001a818421e4f102d4`), and edited
here since. shadcn/ui's distribution model is copy-into-your-project, so
these are the project's files under an upstream MIT grant rather than an
installed dependency. Upstream copyright: `Copyright (c) 2023 shadcn`; the full
notice text is in `THIRD_PARTY_NOTICES.md`.

Disposition: **published**, under the combined grant of the upstream MIT license
and this repository's own.

| Path | Media type | SHA-256 | Bytes |
| --- | --- | --- | --- |
| `apps/web/src/components/ui/badge.tsx` | `text/tsx` | `e90e4f11a2f327581bc110f65512529a89c84ee87c019b1e2bfd5ec5fe9cce44` | 2748 |
| `apps/web/src/components/ui/button.tsx` | `text/tsx` | `2849e10eb34dc1779a406738f493284776c4e7c392ed3c0e5a00954f1948872a` | 4609 |
| `apps/web/src/components/ui/card.tsx` | `text/tsx` | `87c7dfedb4345b7f33d86d69368c6ce85d98cdb5982a752f78cea0b5520fe7ae` | 1493 |
| `apps/web/src/components/ui/checkbox.tsx` | `text/tsx` | `809d10a00a9cd4c719cf6b0a3b7c6bf488f9d14213eae3ca6258084f47f4ee13` | 1113 |
| `apps/web/src/components/ui/dialog.tsx` | `text/tsx` | `19bb7d89fbb3c228d57b2b99cef05a0b21bda2ea58455d4d2f4f0b1a442c727b` | 3823 |
| `apps/web/src/components/ui/dropdown-menu.tsx` | `text/tsx` | `30c55f744d6480e77eb2a13f028b2b8285b1e0ea0cd907849fe9158fc68ba8aa` | 6801 |
| `apps/web/src/components/ui/hover-card.tsx` | `text/tsx` | `645289e91ae03c96dc6854af77b231d2d54758963a4f184ce4f8c15d0e3938db` | 1624 |
| `apps/web/src/components/ui/input.tsx` | `text/tsx` | `c97f29222b2dff9cc77225747fc036d8fc75446c31fe46278eff712f8b2eb032` | 2194 |
| `apps/web/src/components/ui/progress.tsx` | `text/tsx` | `b1eff95e96636a7040c1c5a160fb030ecc50e8a948d60c6691278905173ccf6b` | 720 |
| `apps/web/src/components/ui/select.tsx` | `text/tsx` | `50b8ee0ec789e167e23993907529b01e22e1ba2b41ee57ada18f989777c2c827` | 1784 |
| `apps/web/src/components/ui/switch.tsx` | `text/tsx` | `15d1beaf5575318d9f1065f94036fc3c3464f967f8e6b19a1356c63b0269762a` | 1238 |
| `apps/web/src/components/ui/table.tsx` | `text/tsx` | `932dce4e8a81167636a36ee4d02477d9820cbbe338774ddea7334abbedb0feeb` | 3424 |
| `apps/web/src/components/ui/tabs.tsx` | `text/tsx` | `8cc42eb2622997e341c6b006711d10953c2d596ec19068ee909e991aa488180a` | 1615 |
| `apps/web/src/components/ui/textarea.tsx` | `text/tsx` | `592fb0c774fec5943cf21bfd462129737dce2788ce024c77f3fe30d22697118f` | 1304 |

These files import `@radix-ui/*`, `class-variance-authority`, `clsx`,
`tailwind-merge` and `lucide-react`. Those are installed dependencies, not
vendored code; they are listed with their licenses in `THIRD_PARTY_NOTICES.md`
and are not redistributed by this repository.

## Data fixtures

Non-source data files in the published set. None is third-party, and none carries
a credential, a personal identifier, a private path or a live endpoint.

| Path | Media type | SHA-256 | Bytes |
| --- | --- | --- | --- |
| `apps/web/src/tests/fixtures/tc-ux-v1-prompts.json` | `application/json` | `25d2062e60a618783de79b1d7a824711adb29931e0334c958e0640fec9a53da2` | 53465 |
| `apps/web/src/tests/fixtures/tc-ux-v1-prompts.provenance.json` | `application/json` | `bab04df18c4680804120478e2362256de41b3a484b81d08024bcc096cdf009d4` | 264 |
| `docs/release/fixtures/oss-b0-smoke-task.json` | `application/json` | `a716ed8fc39420c1b671574450b92c61d913352539078948f9429bef42650de6` | 1875 |
| `scripts/fixtures/local-api-origin-cases.json` | `application/json` | `e40ad18b723d231ebee217afe10194ecebc519639ff93d74b3fbf7baf4185bf0` | 7682 |
| `scripts/fixtures/onboarding-remote-cases.json` | `application/json` | `82ff59b740b4dcc6ef43270fb301800360eecefb65b74ee7ad9e1dc4eafb257f` | 5963 |

Every one of them is first-party, owned by Moson Lab and covered by `LICENSE`,
and every one is **published**. What differs is where the bytes came from, which
is the part worth writing down:

- **`tc-ux-v1-prompts.json`** — recorded `Task.description` text from seven rows
  of an internal task chain in this repository, captured 2026-08-17 and frozen so
  that the task console's regression tests read fixed input rather than whatever
  a database happens to hold. Reviewed for publication.
- **`tc-ux-v1-prompts.provenance.json`** — the provenance record for the fixture
  above: what it was captured from, when, its byte count and its SHA-256. The
  digest it records is the fixture's actual digest in this commit, so the pair
  checks itself.
- **`oss-b0-smoke-task.json`** — the frozen deterministic smoke task the
  quickstart's step 8 creates. Authored here; no credential, no personal data.
- **`local-api-origin-cases.json`** — the shared policy table deciding which
  local API destinations are accepted and refused. Its hostile URLs are synthetic
  and are the cases being refused, not endpoints anything contacts.
- **`onboarding-remote-cases.json`** — the shared policy table for repository
  remote URLs, read by both the browser and the server so the two cannot drift
  apart. Its credential-bearing URLs are likewise synthetic refusal cases; the
  snapshot scan classifies them as reviewed placeholders rather than findings.

## Minted artifacts

One published file is not in the source repository and is created per export:

**`release-authority.json`** — the signed release attestation the migration
preflight verifies, minted at the exact commit being exported by `npm run
snapshot:authority`. It is listed in `public-snapshot.json`'s `mintedArtifacts`,
so its absence from the source tree is a recorded fact rather than an unclassified
gap. It carries commit object ids and content digests; it carries no review text.
Its digest is therefore per-release and is recorded in the release evidence rather
than here.

Its trust anchor, **`release-authority.pub`**, is an Ed25519 public key tracked
and reviewed like any other file. Public key material is safe to publish; the
private half is held outside every repository, and
[`migration-and-recovery.md`](migration-and-recovery.md) describes
how both are provisioned.

## What is deliberately not published

`public-snapshot.json`'s `exclude` rules name each held-back file with a reason,
and its `deny` rules close whole path classes repository-wide: generated build
output, installed dependencies, caches, dumps, logs, process files and captured
process output. Plans, reviews, runbooks, internal specifications, design
references and private operational material are excluded by name or by
directory. `docs/public-snapshot.md` describes the boundary and how it is
checked.

## Re-deriving this page

Every digest above is over the file's bytes at the commit this document ships
in, and any of them can be recomputed directly:

```sh
shasum -a 256 <path>
```

If a digest here disagrees with the file in your checkout, the file changed and
this page was not updated with it. Trust the file and report the mismatch.
