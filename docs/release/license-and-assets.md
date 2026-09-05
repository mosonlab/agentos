# Anneal — license and asset provenance

Every file the snapshot publishes is accounted for here. The rule this
page exists to enforce is simple: **nothing ships whose origin we cannot name.**
An asset without provenance is removed from `public-snapshot.json`, not published
with a shrug.

## The license

Anneal is released under the **MIT License**.

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
| Third-party source, vendored | 13 files | shadcn/ui. See below. |
| Chain prompts carrying upstream text | `agents/roles/`, `agents/templates/` | mattpocock/skills. See below. |
| Data fixtures | 5 files | See below. |
| Binary media | 3 files | First-party README captures. See below. |

### Binary README assets

The published set contains three first-party media files used by the bilingual
README pair. `public-snapshot.json` includes each file and records its reviewed
`binary-material` finding by exact path.

| Path | Media type | SHA-256 | Bytes | Provenance |
| --- | --- | --- | --- | --- |
| `docs/media/agents.png` | `image/png` | `f248b0a9ecc543a0ec438024272073022d570e9f9588e0e71c9882bb9917f2d5` | 341236 | Capture of Anneal's Agents view. |
| `docs/media/chain.png` | `image/png` | `b51111e47afb1ec62caa2164e0eb50f9e4fc55ad025446d85a0ae437e80563c3` | 417380 | Capture of an Anneal Full Assurance chain. |
| `docs/media/parallel-tasks.gif` | `image/gif` | `b38e64f16fe36cc13c5e845ca9263748ed4195a84eddb72add81228fa6f5cd6c` | 447169 | Capture of Anneal running multiple tasks on its board. |

All three captures come from this repository's own application, are owned by
Moson Lab, and are covered by `LICENSE`. The scanner classifies a file as binary
when its bytes contain a NUL or more than 10% control characters, reading the
whole blob rather than a leading window, and reports every binary in scope; no
other binary file is published.

To re-derive it from a clean checkout:

```sh
npm run snapshot:scan
```

The consequence for licensing is that every published media asset has explicit
provenance rather than relying on an assumed zero-binary inventory.

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
| `apps/web/src/components/ui/card.tsx` | `text/tsx` | `7c12cc68d14fa593bb04b36827b79c1c854f6a8f65046224f388e45b9957e426` | 352 |
| `apps/web/src/components/ui/checkbox.tsx` | `text/tsx` | `809d10a00a9cd4c719cf6b0a3b7c6bf488f9d14213eae3ca6258084f47f4ee13` | 1113 |
| `apps/web/src/components/ui/dialog.tsx` | `text/tsx` | `583efb35c353b5828955b52fd305bcdba700909f3dbd42f46aef96c8a6837190` | 3160 |
| `apps/web/src/components/ui/dropdown-menu.tsx` | `text/tsx` | `762ee3774aa90023e68fb71c37c552ac640e97f13f02c1c6a811bf22ca47bfc1` | 2712 |
| `apps/web/src/components/ui/hover-card.tsx` | `text/tsx` | `645289e91ae03c96dc6854af77b231d2d54758963a4f184ce4f8c15d0e3938db` | 1624 |
| `apps/web/src/components/ui/input.tsx` | `text/tsx` | `c97f29222b2dff9cc77225747fc036d8fc75446c31fe46278eff712f8b2eb032` | 2194 |
| `apps/web/src/components/ui/progress.tsx` | `text/tsx` | `b1eff95e96636a7040c1c5a160fb030ecc50e8a948d60c6691278905173ccf6b` | 720 |
| `apps/web/src/components/ui/select.tsx` | `text/tsx` | `50b8ee0ec789e167e23993907529b01e22e1ba2b41ee57ada18f989777c2c827` | 1784 |
| `apps/web/src/components/ui/switch.tsx` | `text/tsx` | `15d1beaf5575318d9f1065f94036fc3c3464f967f8e6b19a1356c63b0269762a` | 1238 |
| `apps/web/src/components/ui/table.tsx` | `text/tsx` | `6f22198c03f94b6bbc36e98cc3b09f87e34b4bfc0a7e5a871a6331d30e748f34` | 2876 |
| `apps/web/src/components/ui/textarea.tsx` | `text/tsx` | `592fb0c774fec5943cf21bfd462129737dce2788ce024c77f3fe30d22697118f` | 1304 |

These files import `@radix-ui/*`, `class-variance-authority`, `clsx`,
`tailwind-merge` and `lucide-react`. Those are installed dependencies, not
vendored code; they are listed with their licenses in `THIRD_PARTY_NOTICES.md`
and are not redistributed by this repository.

**mattpocock/skills prompts** — the chain role and step prompts under
`agents/roles/` and `agents/templates/` carry verbatim paragraphs from five
upstream skills, wrapped in paragraphs written here for this platform's
contracts. No file is wholly upstream and none is wholly first-party, so these
are listed as a body rather than hashed per file. Upstream baseline:
`mattpocock/skills` at commit `c75f10c`. Upstream copyright:
`Copyright (c) 2026 Matt Pocock`; the full notice text is in
`THIRD_PARTY_NOTICES.md`.

Disposition: **published**, under the combined grant of the upstream MIT license
and this repository's own.

## Data fixtures

Non-source data files in the published set. None is third-party, and none carries
a credential, a private path or a live endpoint. One carries a personal
identifier, recorded below.

| Path | Media type | SHA-256 | Bytes |
| --- | --- | --- | --- |
| `apps/web/src/tests/fixtures/tc-ux-v1-prompts.json` | `application/json` | `25d2062e60a618783de79b1d7a824711adb29931e0334c958e0640fec9a53da2` | 53465 |
| `apps/web/src/tests/fixtures/tc-ux-v1-prompts.provenance.json` | `application/json` | `bab04df18c4680804120478e2362256de41b3a484b81d08024bcc096cdf009d4` | 264 |
| `docs/release/fixtures/oss-b0-smoke-task.json` | `application/json` | `a716ed8fc39420c1b671574450b92c61d913352539078948f9429bef42650de6` | 1875 |
| `scripts/fixtures/local-api-origin-cases.json` | `application/json` | `02a07bb85cd1e80db5097100bb5b0d1c37e35df841dcf2ad1e238e1106e8360f` | 7698 |
| `scripts/fixtures/onboarding-remote-cases.json` | `application/json` | `82ff59b740b4dcc6ef43270fb301800360eecefb65b74ee7ad9e1dc4eafb257f` | 5963 |

Every one of them is first-party, owned by Moson Lab and covered by `LICENSE`,
and every one is **published**. What differs is where the bytes came from, which
is the part worth writing down:

- **`tc-ux-v1-prompts.json`** — recorded `Task.description` text from seven rows
  of an internal task chain in this repository, captured 2026-08-17 and frozen so
  that the task console's regression tests read fixed input rather than whatever
  a database happens to hold. Reviewed for publication.

  One of the seven rows records an approval by name: the text says a named person
  approved the intended product behavior. That name stays. The fixture is what
  those rows actually said on 2026-08-17, and its provenance record asserts
  exactly that; editing the text and recomputing the digest would leave a
  self-consistent pair whose authority statement is false. The name is not a
  credential and identifies this repository's own operator.
- **`tc-ux-v1-prompts.provenance.json`** — the provenance record for the fixture
  above: what it was captured from, when, its byte count and its SHA-256. The
  digest it records is the fixture's actual digest in this commit, so the pair
  checks itself.
- **`oss-b0-smoke-task.json`** — the frozen deterministic smoke task the
  quickstart's step 10 creates. Authored here; no credential, no personal data.
- **`local-api-origin-cases.json`** — the shared policy table deciding which
  local API destinations are accepted and refused. Its hostile URLs are synthetic
  and are the cases being refused, not endpoints anything contacts.
- **`onboarding-remote-cases.json`** — the shared policy table for repository
  remote URLs, read by both the browser and the server so the two cannot drift
  apart. Its credential-bearing URLs are likewise synthetic refusal cases; the
  snapshot scan classifies them as reviewed placeholders rather than findings.

## What is deliberately not published

`public-snapshot.json`'s `exclude` rules name each held-back file with a reason,
and its `deny` rules close whole path classes repository-wide: generated build
output, installed dependencies, caches, dumps, logs, process files and captured
process output. Plans, reviews, briefs, merge notes, internal specifications,
design references and private operational material are excluded by name or by
directory; the four test-coupled runbooks under `docs/runbooks/` are published
by exact name. `docs/public-snapshot.md` describes the boundary and how it is
checked.

## Re-deriving this page

Every digest above is over the file's bytes at the commit this document ships
in, and any of them can be recomputed directly:

```sh
shasum -a 256 <path>
```

If a digest here disagrees with the file in your checkout, the file changed and
this page was not updated with it. Trust the file and report the mismatch.
