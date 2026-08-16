# PLAN — Batch: frontend convergence onto shadcn/ui and the design tokens

Status: **rev 2 — revised against the plan review and Leo's gate rulings** · Author: plan agent ·
Date: 2026-08-16
Spec: [`docs/specs/batch-frontend-convergence.md`](../specs/batch-frontend-convergence.md) (approved).
Planned against the tree at `e28f746`; the code state is `3f712b5`.
Prior art honoured: [`docs/wiki/batch-0-frontend-base.md`](../wiki/batch-0-frontend-base.md),
[`docs/reference/frontend-css-layering.md`](../reference/frontend-css-layering.md).
This is an implementation plan only. No code changes ship with it.

**Every anchor below was re-verified against the working tree.** Where the spec and the code
disagree, §1 says so and the plan follows the code — as the batch brief requires — without
re-specifying anything the spec decided.

> **Read §0.1 first.** It carries Leo's three gate rulings and the disposition of all ten review
> findings. What rev 2 changed, in one line each: **W0** (baseline screenshots) and **W0b** (the
> committed acceptance checker) are new and run before W1; **§2.5** (property origin) is new and
> rewrites parts of W1/W2/W3; **Appendix A** is now exhaustive for every multi-property, pseudo and
> state rule; **§7**'s two open questions are closed by ruling; **G1 and G3 stopped being guesses**.

---

## 0. Approach summary

Migrate **bottom-up, call sites before the stylesheet**, in 19 work items across six sections:

- **Section 0 — evidence and tooling** (W0, W0b): capture the "before" that W16 has to compare
  against, and put the acceptance checker in the repo, **before a single line of app code moves**.
  Nothing in `apps/web` changes here.
- **A — capability** (W1–W3): give the primitives the legacy appearance *before* anything depends
  on them. Extend `buttonVariants` / `badgeVariants`, port the legacy geometry into `input.tsx` /
  `textarea.tsx` / `table.tsx`, add the new `select.tsx`.
- **B — the keystone** (W4): `components/ui.tsx`, the barrel every page imports. 56 legacy
  references, 33 distinct classes, and the shared vocabulary (`Page`, `Card`, `Pill`, `Toggle`,
  `Markdown`, `Modal`, `FullPanel`, `Field`, …). Migrating it first collapses most of the page work.
- **C — the pages** (W5–W12b): nine commits, smallest first, so the token mapping is calibrated on
  a 21-reference read-only page before it is applied to an 83-reference one.
- **D — the switch** (W13): delete the legacy stylesheet **and** invert the layer test in one
  commit. These are one atomic change; §1 explains why they cannot be split.
- **E — acceptance** (W14–W16): the mechanical sweep, the negative control, the manual walks, the PR.

The load-bearing sequencing fact is the mirror image of batch 0's: **while the legacy sheet is
still live and unlayered, a migrated element is styled correctly the moment it stops carrying its
legacy class** (no legacy rule targets it any more, so its utilities apply normally). The exception
is elements styled by the legacy *element* rules — `input`, `select`, `textarea`, `a`, `h1`–`h4`,
and `button, input, textarea, select { font: inherit; color: inherit }` — which keep legacy
behaviour until W13. So **form controls cannot be visually verified before W13**, and the plan does
not ask anyone to try. §2.5 turns that same fact into a rule about which shadcn properties are live
today and which only wake up at W13; it is the section most likely to be skipped and least safe to
skip.

The interim is deliberately ugly (§4.2). Descendant selectors like `.card > h2`, `.taskCard h3`
and `.kv .k` break as soon as the ancestor's class is removed and stay broken until that page's
own commit. This is expected, it is not a defect, and it must **not** be patched with an inline
style — that is batch 0's failure mode #1 in reverse (spec §8.3). Only the final two commits are
visually meaningful.

---

## 0.1 Gate rulings and review dispositions

### Leo's three rulings at the plan gate (2026-08-16) — same force as the plan body

- **R-1 — spec assumption 4 stands, terminally.** The batch's goal remains **appearance 100%
  unchanged**, held with arbitrary px values and `cva` variants. "Converge onto shadcn's stock
  geometry" is **not** an option and is not to be reopened. The visual rework is the next stage.
  Rev 2 deleted rev 1's Q-2 and every sentence that invited the alternative.
- **R-2 — the corrected acceptance check is a repo artifact.** It ships as
  [`docs/plans/legacy-class-check.sh`](./legacy-class-check.sh): executable, takes a file list as
  arguments, prints `<count>  <file>` per file. W14 **calls it**; nobody inlines a second copy.
  Reason: step ⑥'s code review has to be able to re-run B1–B12 itself. Rev 1's Q-1 is closed.
- **R-3 — W0 is new and runs before W1: capture the baseline screenshots.** W16/E5 wants
  before/after and G2 wants a pre-batch toggle close-up, but rev 1 produced no "before" anywhere,
  and by W16 the legacy sheet is gone and the before is unrecoverable. W0 captures all 8 pages in
  light and dark, plus the Agents toggle close-up and the Tasks board, into
  `docs/plans/baseline-screenshots/` on the branch. It is the batch's only appearance evidence.

### Review findings — all ten accepted, none rejected

| # | Finding | Where rev 2 answers it |
|---|---|---|
| MF-1 | R-1 reopened via Q-2 | §7 (Q-2 deleted and replaced by the ruling), §6 G3 |
| MF-2 | R-2 absent; plan chose the forbidden PR-only outcome | §0.1, §1.1, **W0b**, W14, §8.2 |
| MF-3 | No pre-change evidence exists, so W16 cannot do before/after | **W0**, W16/E5, §6 G2, §8.2 |
| MF-4 | Primitive rewrites drop live shadcn properties / add them to raw controls | **§2.5**, W1, W2, W3 |
| MF-5 | Replacement mappings partial or circular | **Appendix A** (now exhaustive), W4, W8, W10, W11, W12b, **W13 part 3** |
| MF-6 | Table last-row claim false; raw-table conversion under-specified | W3, W5, W6, W7, W11, W12 |
| MF-7 | C5's `git diff master …` cannot run here | W13 part 2, W14 |
| SF-1 | Work-item count wrong and about to drift | §0, §4.1 (19 items / 16 commits) |
| SF-2 | Bookkeeping rules contradict the W10/W13 schedule | §3 preamble, W10 `Files`, §4.3 |
| SF-3 | G1/G3 are no longer unresolved | §6 (both recorded verified, with the emitted CSS) |

**Two findings were accepted but their stated mechanism was corrected**, because following the
review's reasoning literally would have produced a different and wrong fix. Both corrections are
reproduced in §2.5 and were verified against the built CSS, not reasoned about:

1. **MF-4's `font-medium` claim.** The review says a raw control converted to `Button` "would gain
   medium weight" *relative to* an existing primitive site. It would not — not today. `styles.css:91`
   (`button, input, textarea, select { font: inherit; color: inherit }`) is **unlayered**, and
   `.font-medium` compiles into `@layer utilities`, so `font-medium` is inert on **every** primitive
   in the app right now. The real hazard is larger than the one reported: at W13 that rule moves into
   `@layer base` and `font-medium` **wakes up on all 20 `<Button>` sites at once**. The fix is
   therefore not a per-host distinction but a `font-normal` / `font-bold` pin inside every legacy
   variant. Same mechanism for `text-sm`, `text-base`, `md:text-sm`, `rounded-md`, `h-9` and
   `disabled:opacity-50`.
2. **MF-4's `shadow` claim is exactly right**, and is the half that *does* need a per-host
   distinction — verified in `dist`: `.shadow` and `.shadow-sm` sit in `@layer utilities`, nothing
   unlayered sets `box-shadow`, so both are live today. §2.5 enumerates all 13 call sites where the
   two hosts differ.

### Open question this revision raises (recorded, not escalated — chain standing rule)

**OQ-1 — the batch cannot make every control identical *and* leave every control unchanged.**
Today a `.btn` rendered through `<Button>` carries a box-shadow and a `.btn` rendered as a raw
`<button>` does not; the same split exists for `<Input>` vs raw `<input>` and `<Textarea>` vs raw
`<textarea>`. That asymmetry is an artifact of the half-finished batch-0 migration, not a design
decision, and R-1 ("appearance 100% unchanged") requires **preserving** it. §2.5 does preserve it,
at a cost of 13 enumerated `shadow-none` call-site overrides that exist only to reproduce an
accident. If Leo would rather the batch normalise the two hosts, that is one line in §2.5 and 13
fewer overrides, and it becomes a spec §4-rule-4 delta listed in the PR. **The plan proceeds on
preserve, per R-1.** This is not a defect in the spec, so it is not re-specified here — it is a
consequence of R-1 worth seeing once.

---

## 1. Where the code contradicts the spec

Six findings. Each was reproduced against the tree; each changes what the executioner must do. The
spec is approved and the plan does not re-specify it — these are corrections of fact, and every one
of them is a place where following the spec's literal text would produce a wrong result.

### 1.1 The §9.B acceptance grep can never pass (blocking — it is the batch's only criterion)

The spec's runnable check is:

```sh
grep -nE "className=[^>]*\b($(paste -sd'|' docs/specs/legacy-classes.txt))\b" …
```

`\b` treats `-` as a word boundary, so a legacy name matches as a *segment* of an ordinary Tailwind
utility. Verified against two files the spec itself certifies as legacy-free:

- `components/ui/dialog.tsx:47` matches, on `right-4 top-4` (`right`, `top`).
- `components/ui/progress.tsx:19` matches, on `bg-primary` (`primary`).
- `components/ui/table.tsx` and `card.tsx` match once each.

Migrated code is *made of* `gap-2`, `top-0`, `bg-card`, `text-muted-foreground`. B1–B12 as written
are unsatisfiable.

**The replacement is [`docs/plans/legacy-class-check.sh`](./legacy-class-check.sh), committed to the
repo per ruling R-2.** It extracts `className` attribute values (plain string, template literal, or
braced expression), splits on whitespace, drops `${…}` fragments, and compares **whole tokens** for
equality: `bg-primary` is not `primary`; `pill` is `pill`. It exits non-zero if any count is
non-zero, so it works as a gate as well as a report.

```
docs/plans/legacy-class-check.sh <file> [<file> …]     # prints "<count>  <file>" per file
```

It was run against the tree before this revision shipped and reproduces the spec's own baseline
counts exactly — 83/64/**56**/50/48/46/42/25/21/20/8/2 (`ui.tsx` reads 56 against the spec's 57; the
difference is one tokenisation of the `toggle`/`on` template literal at `ui.tsx:125`, not a missed
reference) — and returns `0` for all 12 stock primitives, `main.tsx` and `secret-value-input.tsx`.

Swept across **every** `.tsx` in `apps/web/src`, the only non-zero files are those 12 plus
`tests/styles.test.tsx` (3, from the three `className="…"` patterns inside the `assert.match` pins at
lines 48–50, which C3 deletes at W10). That is a stronger acceptance statement than the spec's
12-file list, and W14 uses the sweep form.

Acceptance A1 (the stylesheet grep) is unaffected and stands as written.

### 1.2 The rem trap invalidates two of the spec's own utility suggestions

`:root { font-size: 13px }` means `1rem = 13px`, so Tailwind's spacing unit is **3.25px**, not 4px.
Two suggestions in the spec are therefore wrong by construction:

| Spec text | Suggested | Actually renders | Legacy value |
|---|---|---|---|
| §2.5, `Tasks.tsx:77` | `gap-1.5` | 4.875px | **6px** |
| §5.5, `.page` narrow padding | `max-[900px]:px-4` | 13px | **16px** |

This is the same trap §2.6 warns about, reached through the spec's own examples. **Standing rule
for the whole batch, and the single highest-value line in this plan:**

> Express every legacy pixel geometry as an **arbitrary px utility** (`gap-[6px]`, `px-[16px]`,
> `h-[34px]`, `mb-[18px]`). Use a scale utility only when the legacy value is an exact multiple of
> 3.25px — in practice only `13px` (`4`), `26px` (`8`) and `0`.

The spec's other §2.5 dispositions are correct and unaffected: `pb-0`, `size-[18px] text-[10px]`,
`items-start`, `w-[130px]`, `text-[16px]`, `text-[18px]`, `bg-[color:var(--surface-run-detail)]`.

### 1.3 `.toggle::after` **is** the Switch knob

`ui.tsx:125` renders a Radix `Switch` with `[&>span]:hidden` — the real thumb is hidden and the
knob the operator sees is the legacy `.toggle::after` pseudo-element, animated by
`.toggle.on::after { transform: translateX(17px) }`. Deleting `.toggle` deletes the knob and the
animation; the control becomes a coloured pill with nothing in it. The spec lists `ui.tsx:125` only
as an interpolation site. **W4 must drop `[&>span]:hidden` and restore the knob on the Radix
thumb.** Target values in W4.

### 1.4 `Button variant="destructive"` is inert

`button.tsx:15` emits `text-destructive-foreground`. There is no `--destructive-foreground` token
in `:root`/`.dark` and no `--color-destructive-foreground` in `@theme inline`, so Tailwind never
generates that class. `.btn.danger` uses `--danger-button` / `--danger-button-hover` /
`--danger-button-foreground`, which do exist. **Migrate `.btn.danger` to a new `cva` variant on
those tokens (W1); do not route it through the stock `destructive` variant.**

### 1.5 Preserving appearance forces edits to three primitives the spec's file set omits

Spec §2.3 concludes "the file set is 12, not 15". That sentence is about *legacy class references*
and it is correct. It is not an edit budget, and reading it as one breaks §4:

- `input.tsx` is `h-9` (29.25px). A legacy input is `padding: 9px 11px` + `font-size: 12.5px` +
  `line-height: 1.5` + 1px borders ≈ **38.75px**. Every form in the app shrinks by ~9px at W13
  unless the primitive carries the legacy geometry.
- `textarea.tsx` likewise (`px-3 py-2 text-base` vs `9px 11px` / `12.5px` / `line-height: 1.6`).
- `table.tsx`: `text-sm` = 11.375px vs legacy `12.5px`; `th` `h-10 px-2` vs `10px 14px`; `td` `p-2`
  vs `13px 14px`; `hover:bg-muted/50` vs `--row-hover`. There is no local table wrapper, and the
  alternative is repeating the same arbitrary values across four call sites and every cell.

**Decision: edit `input.tsx`, `textarea.tsx`, `table.tsx` (W2, W3). Everything else is neutralised
at the wrapper** — `Card`, `Toggle`, `Check`, `Modal`, `Progress` keep their primitives stock and
carry the legacy values from `ui.tsx` or the call site. `dialog.tsx` and `progress.tsx` stay
byte-unchanged, as B14 requires. This expands the spec's stated file set; §7 flags it for the gate.

### 1.6 Two smaller corrections

- **`styles.css:66–85` is one `:root` rule**, not the two separate regions the §2.1 table implies
  (aliases 66–75, typography 77–84). It is deleted as a unit and the typography is re-emitted on
  `html` inside `@layer base`. Same outcome; the plan says it because a line-range edit would leave
  an unbalanced brace.
- **Spec §8 edge case 4 mislocates the password risk.** `Projects.tsx:36,39` are both
  `type="text"` (Name, Slug). The only `type="password"` in the app is `secret-value-input.tsx:6`,
  already a primitive wrapping `Input`, untouched by this batch. The guard
  (`input-semantics.test.tsx:31`) is real and stays; the located risk is not. Carry `type="text"`
  onto both converted inputs anyway — the guard fails if you don't.

---

## 2. Rules that apply to every work item

The executioner should read this section once and then not re-derive it 126 times.

### 2.1 Alias → token → utility

`styles.css:67–75` is the authoritative map. Every legacy alias resolves to a surviving token:

| alias | token | utility |
|---|---|---|
| `--ink-0` | `--background` | `bg-background` |
| `--ink-1` | `--sidebar` | `bg-sidebar` |
| `--ink-2` | `--popover` | `bg-popover` |
| `--ink-3` | `--card` | `bg-card` |
| `--ink-4` | `--secondary` | `bg-secondary` |
| `--ink-5` | `--accent` | `bg-accent` |
| `--line` | `--border` | `border-border` |
| `--line-soft` | `--border-soft` | `border-[color:var(--border-soft)]` |
| `--fg` | `--foreground` | `text-foreground` |
| `--fg-2` | `--secondary-foreground` | `text-secondary-foreground` |
| `--fg-dim` | `--muted-foreground` | `text-muted-foreground` |
| `--fg-faint` | `--faint` | `text-[color:var(--faint)]` |
| `--accent-hi` | `--primary-hover` | `bg-[color:var(--primary-hover)]` |
| `--accent-ink` | `--primary-foreground` | `text-primary-foreground` |
| `--accent-soft` | `--primary-soft` | `border-[color:var(--primary-soft)]` |
| `--green/amber/violet-{fg,bg,line}` | `--status-<c>-{fg,bg,line}` | `[color:var(--status-green-fg)]` form |
| `--red` | `--destructive` | `bg-destructive` |
| `--red-{fg,bg,line}` | `--destructive-{fg,bg,line}` | `[color:var(--destructive-fg)]` form |
| `--blue` | `--link` | `text-[color:var(--link)]` |
| `--radius-ctl` | `--radius` (8px) | `rounded-lg` |
| — | `--radius-card` (10px) | `rounded-xl` |

**Only the tokens listed in `@theme inline` (styles.css:4–20) have stock utility names.** Everything
else — `border-soft`, `faint`, `surface-input`, `surface-run-detail`, `primary-hover`,
`primary-soft`, `destructive-fg/bg/line`, `status-*`, `link`, `row-hover`, `code-background`,
`event-line`, `danger-button*`, `toggle-*`, `check-border`, `radio-border`, `badge-foreground`,
`primary-badge-background`, `border-hover`, `scrollbar`, `modal-shadow`, `scrim` — must be written
as `[color:var(--x)]`. Follow the existing convention at `dialog.tsx:29` (`bg-[color:var(--scrim)]`).

Do **not** add `@theme` entries to give them shorter names: that is a new design token (spec §7).

### 2.2 Colour vs geometry

Arbitrary **geometry** is required (§1.2). Arbitrary **colour literals** are a defect
(spec §8.9): never `bg-[#252116]`, always `bg-[color:var(--token)]`. Every colour has a light and a
dark value only because it goes through a token.

### 2.3 `cn` is `twMerge(clsx(…))`

`lib/utils.ts:5`. tailwind-merge drops the earlier of two conflicting utilities in the same group,
so `<Progress className="h-[8px]">` correctly beats the primitive's `h-2`. Two consequences:

- Passing a legacy value in `className` is the normal way to neutralise a stock default. It works.
- It does **not** reliably resolve arbitrary variants against each other. When in doubt, grep the
  built CSS rather than assume.

Do not remove an existing neutralisation (`max-w-none`, `gap-0`, `shadow-none`) because it looks
redundant — spec §8.5; it becomes load-bearing at W13.

### 2.4 Do not touch

- `components/ui/dialog.tsx`, `components/ui/progress.tsx` — byte-unchanged (B14).
- `components/ui/tabs.tsx` — **dead code**; nothing imports it (verified). `ui.tsx`'s `Tabs` and
  `Segmented` are hand-rolled `div`+`button`, and `primitives.test.tsx:7–14` pins exactly two
  `<button>` and no `role="tablist"`. Do not "upgrade" them to the Radix primitive.
- `tests/input-semantics.test.tsx`, `primitives.test.tsx`, `row-menu.test.tsx`,
  `storage.test.tsx` — spec §6.3. If a migration wants one of them edited, stop; the migration
  changed behaviour.
- `packages/**` — no backend, schema, or runner change in this batch (§9).

### 2.5 Property origin — which shadcn properties are live today, and which wake up at W13

*(New in rev 2. This is the review's must-fix #4, and it is the section that decides whether
"appearance unchanged" is true or merely asserted.)*

The legacy sheet is unlayered, so for a control that carries both a legacy class and a shadcn
primitive's utilities, the split is mechanical:

> For every property the legacy selector **does** set, the unlayered rule wins and the primitive's
> utility is dead. For every property it **does not** set, the primitive's utility is **live today**
> and is part of the appearance R-1 requires preserving.

Two consequences the executioner must hold at once, and they pull in opposite directions:

1. **A live utility that W2/W3 deletes is a regression.** Deleting `shadow-sm` from `input.tsx`
   removes a shadow that 26 inputs render right now.
2. **A dead utility that W13 revives is also a regression.** `button { font: inherit }` at
   `styles.css:91` is unlayered and beats `@layer utilities`, so `font-medium` is inert on every
   primitive today. At W13 that rule moves into `@layer base` and `font-medium` wakes up on all 20
   `<Button>` sites simultaneously — a change nobody asked for, introduced by a line that was never
   edited.

**The verified inventory.** Every row was checked in `apps/web/dist/assets/*.css` (layer placement)
and against `styles.css` (what the legacy selector sets), not reasoned about:

| Primitive utility | Live today? | Why | Disposition |
|---|---|---|---|
| `shadow` — `button.tsx:13` (`variant.default`) | **yes** | nothing unlayered sets `box-shadow` | **keep**: every legacy `Button` variant carries `shadow` |
| `shadow-sm` — `input.tsx:11`, `textarea.tsx:12` | **yes** | same | **keep** in both bases; do **not** drop |
| `min-h-[60px]` — `textarea.tsx:12` | yes, but inert | nothing unlayered sets `min-height`; every `<Textarea>` site is `rows≥4` ⇒ ≥100px | **keep** (dropping is a no-op but keeping is free) |
| `transition-colors`, `focus-visible:ring-1 focus-visible:ring-ring` | **yes** | `input:focus` sets only `border-color` | **keep** (spec §8.5) |
| `disabled:pointer-events-none` — `button.tsx:8` | **yes** | nothing competes | **keep** |
| `justify-center` — `button.tsx:8` | yes, inert | `.btn` sets no `justify-content`; buttons are intrinsically sized | keep |
| `[&_svg]:size-4` (= 13px) — `button.tsx:8` | **yes** | no unlayered svg rule reaches button children | **keep** |
| `font-medium` — `button.tsx:8` | **no** | `styles.css:91 button,input,textarea,select{font:inherit}` is unlayered; `.font-medium` is in `["utilities"]` | **wakes at W13** ⇒ pin `font-normal` on `variant.legacy`/`variant.icon`, `font-bold` on `legacyPrimary`/`legacyDanger` |
| `text-sm` / `text-base` / `md:text-sm` | **no** | same rule | **wakes at W13** ⇒ pin `text-[12.5px]` / `text-[12px]` explicitly; **drop `md:text-sm`** or it re-wins at ≥768px |
| `disabled:opacity-50` — `button.tsx:8` | **no** | `.btn:disabled{opacity:.45}` is unlayered | **wakes at W13** ⇒ pin `disabled:opacity-45` on **all four** legacy variants |
| `rounded-md`, `h-9`, `px-3`, `py-1`, `px-4`, `py-2` | no | `.btn` / the form rule set them | resolved by `size.legacy*` through twMerge (§2.3) |
| `bg-primary`, `text-primary-foreground`, `hover:bg-primary/90` (`variant.default`) | no | `.btn` and `.btn:hover` set background/colour | replaced wholesale by the legacy variants |

**The host asymmetry, and the 13 sites where it bites.** A `.btn` hosted by `<Button>` carries
`shadow` today; a `.btn` hosted by a raw `<button>` does not. Same for `<Input>` vs raw `<input>`
and `<Textarea>` vs raw `<textarea>`. R-1 requires preserving both, so the primitive keeps the
majority behaviour and the raw-conversion sites take an explicit `shadow-none` at the call site:

| Direction | Count | Sites |
|---|---:|---|
| `<Button className="btn…">` — has `shadow` today, keeps it | 20 | Agents 47, 132, 212, 286, 408, 411, 412 · Goals 50, 63, 68, 98, 213 · Secrets 38, 39, 87 · Tasks 139, 278 · TaskDetail 105, 148, 150 |
| raw `<button className="btn…">` — **no** shadow today ⇒ pass `shadow-none` | 9 | `ui.tsx:270` · `Inbox.tsx:195`, `196` · `Projects.tsx:29`, `30`, `66`, `182`, `185`, `186` |
| raw `<input>` ⇒ pass `shadow-none` | 2 | `Projects.tsx:36`, `39` |
| raw `<textarea>` ⇒ pass `shadow-none` | 2 | `Projects.tsx:194` · `Inbox.tsx:200` |

`.iconBtn` has exactly one host — the raw `<button>` at `ui.tsx:184` — so **`variant.icon` carries
`shadow-none` in the variant itself**, not at the call site. `Segmented`, `Tabs`, `showMore`,
`inboxItem`, `choice`, `projectSwitcher` and `navItem` keep their raw `<button>` host and are not
converted to `Button`, so nothing changes for them.

**The procedure, at every raw → primitive conversion.** Before converting, list what the primitive
adds that the raw element does not have today, and either neutralise it at the call site or record
it as a spec §4-rule-4 delta with its before/after value. The four properties known to matter are
`box-shadow`, `font-weight`, `font-size` and `disabled` opacity; `transition-colors`,
`justify-center` and `[&_svg]:size-4` are the ones verified not to matter. **W1, W2 and W3 are not
accepted until this inventory has been checked against the W0 screenshots** (§3, Section 0).

**Consequence for §0's "Section A changes nothing".** That claim was true of geometry and false in
general: W1's variants are inert only while nothing consumes them, and W2/W3 edit files whose
`box-shadow` is live. Restated correctly: **Section A changes nothing that renders, provided §2.5's
dispositions are followed** — because every property it touches is either dead until W13 or
explicitly preserved.

---

## 3. Numbered work items

Conventions: **Files** is exhaustive for intended edits — including test files, when a work item
edits one. **Verify** is that item's own check, and every item additionally keeps
`npm run typecheck` and `npm run build -w @agentos/web` green. **`npm run test -w @agentos/web` is
green at every commit in the batch, W13 included** — there is no allowed-red commit. What W13 is, is
a **build-before-test boundary**: its test run is only meaningful after its build, because
`styles.test.tsx` reads `dist` (§4.4). One commit per work item unless stated.

---

### Section 0 — evidence and tooling (W0, W0b)

Neither item touches `apps/web`. Both exist because the batch's acceptance depends on artifacts that
do not survive the batch (W0) or on a check nobody else can re-run (W0b). **Ruling R-3 and R-2
respectively.**

#### W0 — capture the baseline screenshots, before anything moves

Ruling R-3. Depends on: nothing. **This is the first commit of the batch and it is not optional:**
by W13 the legacy stylesheet is gone and the "before" cannot be reconstructed from the branch.

- Run the app at the batch's base commit (`3f712b5` behaviour, i.e. the branch before W1).
- Capture, at a fixed viewport width ≥1280px, **in both light and dark**:
  Agents, TaskDetail, Goals, Secrets, Tasks, Projects, Connections, Inbox — **8 pages × 2 themes =
  16 shots**.
- Plus two targeted shots, both in the theme the reviewer will compare in:
  - **the Agents detail page's toggle switches, close up** — this is G2's only evidence; the knob is
    a `::after` pseudo-element that W4 relocates onto the Radix thumb, and there is no test for it;
  - **the Tasks kanban board**, including one column in its resting state.
- Commit them under `docs/plans/baseline-screenshots/`, named `<page>-<theme>.png` (and
  `agents-toggle-<theme>.png`, `tasks-board-<theme>.png`), with a one-line `README.md` recording the
  viewport, the browser, and the commit they were taken at.
- **Verify:** 18 files present; every one opens; `git log` shows them landing **before** W1.
- **Commit:** `docs/plans: baseline screenshots before the frontend convergence batch`.
- **Rollback:** additive, docs-only.

W16/E5 compares against **these exact files**, not against a fresh re-render, and G2 (§6) is checked
against `agents-toggle-*.png`. If a page is genuinely unreachable in the run environment, say which
one and why in the PR — do not silently ship 17.

#### W0b — put the acceptance checker in the repo, and calibrate on it

Ruling R-2. Depends on: nothing.

- [`docs/plans/legacy-class-check.sh`](./legacy-class-check.sh) **already exists on the branch** —
  the plan step landed it, because §1.1 needs it to state its own baseline and step ⑥ needs it to
  re-run B1–B12 without reconstructing it from prose. Executable, takes a file list, prints
  `<count>  <file>`, exits non-zero if any count is non-zero.
- W0b's work is to **calibrate**: run it over the 12 files, confirm it still prints
  83/64/56/50/48/46/42/25/21/20/8/2, and paste that output into the PR as the batch's starting line.
  Run it over `apps/web/src/components/ui/*.tsx` and confirm twelve zeros.
- If either run disagrees with those numbers, **stop and report it**. A drifting baseline means the
  tree moved under the plan, and every per-file target in Section C is then suspect.
- Nobody inlines a second copy of this check — not in a work item, not in the PR body. W14 calls the
  file.
- **Verify:** the two runs above; `bash -n docs/plans/legacy-class-check.sh` clean; the file is mode
  `755`.
- **Commit:** none required if the script is unchanged; if calibration forces a fix to the script,
  that fix is its own commit, `docs/plans: fix the legacy-class acceptance checker`.

---

### Section A — capability (W1–W3)

Nothing here renders differently, **provided §2.5's dispositions are followed** — the unlayered
legacy sheet still wins on every property it sets, and §2.5 lists the properties it does not set.
These items only make the primitives *able* to carry the legacy appearance.

#### W1 — `buttonVariants` and `badgeVariants` gain the legacy variants

Spec §4 rule 3, §5.4. Depends on: nothing. **Read §2.5 first** — the `font-*`, `shadow*` and
`disabled:opacity-*` pins below are not decoration.

- `components/ui/button.tsx:7–35` — add to the `cva` config, without changing the existing stock
  variants (they are unused by call sites but are the shadcn vintage batch 1 will upgrade):
  - `variant.legacy` — `.btn`: `border border-border bg-card text-secondary-foreground shadow
    font-normal disabled:opacity-45` +
    `hover:border-[color:var(--border-hover)] hover:bg-secondary hover:text-foreground`.
  - `variant.legacyPrimary` — `.btn.primary`: `border border-primary bg-primary
    text-primary-foreground shadow font-bold disabled:opacity-45
    hover:bg-[color:var(--primary-hover)] hover:border-[color:var(--primary-hover)]`.
  - `variant.legacyDanger` — `.btn.danger`: `border border-[color:var(--destructive-line)]
    bg-[color:var(--danger-button)] text-[color:var(--danger-button-foreground)] shadow font-bold
    disabled:opacity-45 hover:bg-[color:var(--danger-button-hover)]`. **Not** the stock
    `destructive` variant (§1.4).
  - `variant.icon` — `.iconBtn`: `grid place-items-center border-0 bg-transparent shadow-none
    font-normal text-muted-foreground disabled:opacity-45 hover:bg-secondary hover:text-foreground`.
    `shadow-none` sits in the variant, not the call site: `.iconBtn`'s only host is the raw
    `<button>` at `ui.tsx:184` (§2.5).
  - `size.legacy` — `h-[34px] gap-[7px] px-[13px] text-[12.5px] rounded-lg whitespace-nowrap`.
  - `size.legacySmall` — `.btn.small`: `h-[28px] gap-[7px] px-[10px] text-[12px] rounded-lg`.
  - `size.legacyIcon` — `.iconBtn`: `size-[28px] rounded-[7px]`.
  - Leave the base string (line 8) alone. `font-medium`, `text-sm` and `disabled:opacity-50` stay in
    it and are beaten by the variant through twMerge; **that is why every variant carries its own
    pin** — a variant that omits one inherits the base's value at W13 (§2.5).
- `components/ui/badge.tsx:6–24` — add a `tone` variant with the six `.pill` tones, each
  `border-[color:var(--status-<c>-line)] bg-[color:var(--status-<c>-bg)]
  text-[color:var(--status-<c>-fg)]`; `grey` = `border-border bg-secondary text-muted-foreground`;
  `accent` = `border-[color:var(--primary-soft)] bg-[color:var(--primary-badge-background)]
  text-primary`. Add a `shape.pill` variant carrying `.pill`'s geometry:
  `inline-flex items-center gap-[5px] rounded-full border border-transparent px-[9px] py-[2px]
  text-[11px] leading-[18px] whitespace-nowrap font-normal`. **`border-transparent` is not
  redundant**: `.pill`'s base is `border: 1px solid transparent`, and Tailwind v4's bare `border`
  leaves the colour at `currentColor`, so a `shape="pill"` used without a `tone` would draw a
  visible border it does not draw today. Thread both through
  `badgeVariants({ variant, tone, shape })` at `badge.tsx:32` and extend `BadgeProps`. **Keep the
  literal `"font-normal"` argument** — `primitives.test.tsx:18` asserts it appears in the rendered
  span.
- **Verify:** `npm run typecheck`; `npm run build -w @agentos/web && npm run test -w @agentos/web`
  still green — in particular `primitives.test.tsx`, which renders `<Pill tone="grey">`. Then the
  §2.5 inventory check: diff the variant strings against the §2.5 table and confirm every "wakes at
  W13" row has a pin.
- **Commit:** `feat(web): legacy button and badge variants on the existing cva configs`.
- **Rollback:** additive only; reverting this file alone is safe until W4 consumes it.

#### W2 — `input.tsx` and `textarea.tsx` carry the legacy geometry

Spec §4, §5.4. Depends on: nothing. Rationale: §1.5. Property dispositions: §2.5.

- `components/ui/input.tsx:10–13` — replace the **geometry** half of the class string with the
  legacy values: `w-full rounded-lg border border-border bg-[color:var(--surface-input)]
  px-[11px] py-[9px] text-[12.5px] text-foreground outline-0 focus:border-primary`.
  Drop `h-9`, `text-base`, **`md:text-sm`** (it would re-win at ≥768px, §2.5).
  **Keep `shadow-sm`** — it is live on all 26 `<Input>` sites today (§2.5); rev 1 dropped it, which
  was the review's must-fix #4.
  Keep `file:*`, `placeholder:text-muted-foreground`, `transition-colors`, the
  `focus-visible:ring-*` pair, `disabled:cursor-not-allowed disabled:opacity-50`, and the
  `type = "text"` default at line 6 — `input-semantics.test.tsx:12` pins it.
- `components/ui/textarea.tsx:11–14` — same treatment plus `resize-y leading-[1.6]`; drop
  `text-base` and `md:text-sm`. **Keep `shadow-sm` and keep `min-h-[60px]`** (§2.5: the min-height
  is inert at every current site, so keeping it costs nothing and removes a way to be wrong).
- Neither file has focus-ring parity to preserve: the legacy rule is
  `input:focus { border-color: var(--primary) }`, which `focus:border-primary` reproduces. Keep the
  shadcn `focus-visible:ring-*` classes as they are — they are already live today and removing them
  would be a behaviour change.
- **Verify:** `npm run build -w @agentos/web && npm run test -w @agentos/web` green
  (`input-semantics.test.tsx` covers all three assertions); `grep -c 'shadow-sm'` on both files is
  ≥1. Appearance is unverifiable until W13 (§0) — do not attempt it here.
- **Commit:** `refactor(web): port legacy input and textarea geometry into the primitives`.
- **Rollback:** file-local; safe to revert alone before W13.

#### W3 — new `select.tsx`, and `table.tsx` geometry

Spec §5.4, §4. Depends on: nothing.

- **New `components/ui/select.tsx`** — a native `<select>` wrapper shaped exactly like
  `input.tsx`: `React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>`,
  `cn(…, className)`, spreads props, `Select.displayName = "Select"`, matching the v3-era vintage
  (`React.forwardRef`, no `data-slot`) per spec §7. **No Radix.** Base classes: the same geometry as
  `input.tsx` — **including `shadow-sm`**, so a `<select>` matches the `<Input>` next to it — plus
  `appearance-none pr-[30px] bg-no-repeat` and the two-gradient chevron ported from `styles.css:240`:

  ```
  bg-[image:linear-gradient(45deg,transparent_50%,var(--faint)_50%),linear-gradient(135deg,var(--faint)_50%,transparent_50%)]
  bg-[position:right_14px_top_15px,right_9px_top_15px]
  bg-[size:5px_5px]
  ```

  Note `--fg-faint` → `--faint` (§2.1). **This was guess G1; it is now verified** — all three
  compile under Tailwind 4.3.3 (§6). The lucide fallback is retired.
- `components/ui/table.tsx` — port the legacy geometry (§1.5):
  - `Table` (line 12): add `text-[12.5px] border-collapse`, drop `text-sm`. `border-collapse` is
    legacy `.table`'s and is **not** in the stock primitive; without it the ported cell borders
    double up (this was G4 — it is now a required class, not a contingency). The existing wrapper
    `<div className="relative w-full overflow-auto">` at line 9 **is** `.tableWrap`.
  - `TableHead` (line 76): `h-auto px-[14px] py-[10px] text-[12px] font-normal
    text-muted-foreground text-left whitespace-nowrap border-b border-[color:var(--border-soft)]`;
    drop `h-10 px-2 font-medium`.
  - `TableCell` (line 91): `px-[14px] py-[13px] align-middle whitespace-nowrap
    text-secondary-foreground border-b border-[color:var(--border-soft)]`; drop `p-2`.
  - `TableRow` (line 61): `hover:bg-[color:var(--row-hover)]`; drop `hover:bg-muted/50`. Keep
    `border-b` off the row — the legacy sheet draws borders on cells.
  - `TableBody` (line 33): add **`[&_tr:last-child>td]:border-b-0`**. The stock
    `[&_tr:last-child]:border-0` removes the border from the last `<tr>`, but after the change above
    the border lives on the `<td>`, so the stock class no longer reaches it and every table would
    render a border under its final row. Legacy `styles.css:294` is
    `.table tbody tr:last-child td { border-bottom: 0 }`; the arbitrary variant is the literal
    translation. Verified to compile (§6). This is the review's must-fix #6.
- **Element-tree conversion is mandatory at every raw-table site** (W5, W6, W7, W11, W12). Swapping
  `<table className="table">` for `<Table>` and leaving native `thead`/`tr`/`th`/`td` underneath
  produces an **unstyled** table: the primitive's padding, font size, borders and hover all live on
  `TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell`, not on `Table`. Every raw table
  converts all six element types, preserving `key`, `onClick` and every other prop verbatim.
- **Verify:** `npm run typecheck`; `npm run build -w @agentos/web`, then
  `grep -c "linear-gradient(45deg" apps/web/dist/assets/*.css` ≥ 1 and
  `grep -c "border-collapse" apps/web/dist/assets/*.css` ≥ 1.
- **Commit:** `feat(web): native select primitive + legacy table geometry`.
- **Rollback:** `select.tsx` is a new file with no consumers until W6; `table.tsx` is file-local.

---

### Section B — the keystone (W4)

#### W4 — `components/ui.tsx`

Spec §5.2 (keystone), §5.6 (markdown), §5.7 (nav-item shape), §2.5 (two inline styles).
Depends on: W1, W2, W3. **56 legacy tokens, 33 distinct classes.** The largest single item and the
one that decides how the rest of the batch reads.

New exports this item must add, because the alternative is the same string repeated 25+ times:

- **`Page`** — `.page` appears at 25 sites across 9 files and carries the §5.5 responsive padding.
  Export `const Page = ({ className, children }) => <div className={cn(PAGE, className)}>` with
  `PAGE = "max-w-[1240px] px-[34px] pt-[26px] pb-[80px] max-[900px]:px-[16px]
  max-[900px]:pt-[20px] max-[900px]:pb-[60px]"`. Note the arbitrary px (§1.2 — `px-4` is 13px,
  not 16px). This is plan decision **P-1** (§7).
- **`NAV_ITEM`** — spec §5.7 asks for it by name: "migrate `.navItem` to a nav-item component or a
  shared class string, not to eleven bespoke utility strings inlined per item." `Shell.tsx` (W12b)
  consumes it for three different hosts (`Link`, `Link`, `button`), so a plain exported string is
  the lower-risk form.

Per-symbol targets. **Appendix A is the exhaustive per-selector map** — every multi-property,
descendant, pseudo and state rule is written out there, and rev 2 made it exhaustive precisely so
that this table can stay a summary without anything falling through the gap (review must-fix #5).

| Symbol | Line | Change |
|---|---|---|
| `Pill` | 16 | `<Badge variant="outline" tone={tone} shape="pill">` — **B13**: the tone stops being a class-name fragment and becomes a `cva` variant (W1). |
| `AgentChip` | 47–48 | `.chip` → `inline-flex items-center gap-[6px] rounded-full border border-[color:var(--status-violet-line)] bg-[color:var(--status-violet-bg)] text-[color:var(--status-violet-fg)] px-[9px] py-[2px] text-[11.5px] leading-[19px]`; `.chip.human` → `border-border bg-secondary text-secondary-foreground`. |
| `Card` | 57–63 | `ShadCard` is already `rounded-xl border bg-card text-card-foreground` = `.card` exactly; add only `px-[20px] py-[18px]`, and `flush` → `px-0 pt-[18px] pb-0` with the title row taking `px-[20px]`. `cardTitle` → `flex items-center gap-[9px] mb-[14px] text-[13.5px]`; its `.spacer` child → `flex-1`. **`primitives.test.tsx:17` pins `shadow-none` in the rendered markup** — do not pass a `shadow-*` that twMerge would drop it for. |
| `KeyValue` | 73–79 | `.kv` → `grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-[40px] gap-y-[16px] [&>div]:min-w-0`; `three` → `grid-cols-[repeat(3,minmax(0,1fr))]`; `.k` → `text-muted-foreground text-[12px]`; `.v` → `mt-[3px] text-[13px] [overflow-wrap:anywhere]`. |
| `Metric` | 84 | `.metric` → `rounded-xl border border-border bg-card px-[16px] py-[14px]`; `.k` → `text-muted-foreground text-[12px]`; `.v` → `mt-[6px] text-[15px] font-bold`. `.metrics` → `grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-[14px]`. |
| `Segmented` | 93–97 | Root `.segmented` → `inline-flex gap-[3px] rounded-[9px] border border-[color:var(--border-soft)] bg-card p-[3px]`. Buttons `.segmented button` → **`border-0 bg-transparent`** `rounded-[7px] px-[13px] py-[6px] text-[12.5px] text-muted-foreground` + **`hover:text-secondary-foreground`**; `on` → `bg-accent text-foreground`; `.segmented.accent button.on` → `bg-primary text-primary-foreground font-bold`. The reset and the hover are not optional — Tailwind preflight leaves `<button>` with `border: 0 solid` and a transparent background, but the raw legacy rule set both explicitly and the hover colour has no other source (review must-fix #5). **Keep the two direct `<button>` children** (`primitives.test.tsx:7`). |
| `Tabs` | 107–111 | Root `.tabs` → `flex w-fit max-w-full gap-[3px] overflow-x-auto rounded-[9px] border border-[color:var(--border-soft)] bg-card p-[3px] mb-[16px]`. Buttons `.tabs button` → `border-0 bg-transparent rounded-[7px] px-[14px] py-[7px] text-[12.5px] text-muted-foreground whitespace-nowrap`; `on` → `bg-accent text-foreground`. Note `.tabs button` has **no** hover rule (unlike `.segmented button`) — do not add one. Same `primitives.test.tsx` pin. |
| `Toggle` | 122–128 | **§1.3.** Drop `[&>span]:hidden`. Root: `h-[21px] w-[38px] border-0 data-[state=unchecked]:bg-[color:var(--toggle-background)] data-[state=checked]:bg-primary disabled:opacity-50 disabled:cursor-not-allowed`. Thumb: `[&>span]:size-[15px] [&>span]:bg-[color:var(--toggle-knob)] [&>span]:data-[state=checked]:bg-[color:var(--toggle-knob-active)] [&>span]:data-[state=checked]:translate-x-[17px] [&>span]:data-[state=unchecked]:translate-x-0`. Legacy knob sits at `top:3px; left:3px` inside a 21px box — the Radix root's `items-center` plus `border-2 border-transparent` should produce that 3px inset; **check against `docs/plans/baseline-screenshots/agents-toggle-*.png`** (G2). |
| `Check` | 137–143 | `.check` → `size-[17px] rounded-[4px] border-[color:var(--check-border)] bg-secondary text-primary-foreground p-0`; the checked state is already `data-[state=checked]:bg-primary` in the primitive — add `data-[state=checked]:border-primary`. |
| `EmptyState` | 146 | `.empty` → `px-[10px] py-[40px] text-center text-[12.5px] text-[color:var(--faint)]`. |
| `GapNotice` / `ErrorNotice` | 151, 159–161 | `.notice` → `flex gap-[10px] rounded-lg border border-border bg-card px-[14px] py-[11px] text-[12px] leading-[1.6] text-muted-foreground`; `gap` → `border-[color:var(--status-amber-line)] text-[color:var(--status-amber-fg)] bg-[color-mix(in_srgb,var(--status-amber-fg)_5%,transparent)]`; `error` → `border-[color:var(--destructive-line)] text-[color:var(--destructive-fg)] bg-[color:var(--destructive-bg)]`. The Retry button becomes `<Button variant="legacy" size="legacySmall" className="shadow-none">` (§2.5 — it is a raw `<button>` today). `.notice code` → `[&_code]:text-inherit [&_code]:opacity-90`; `.notice .spacer` → `flex-1`. **Copy stays byte-identical** (spec §7, no i18n). |
| `ShowMore` | 170–174 | `.longText` → `text-secondary-foreground text-[12.5px] leading-[1.75] whitespace-pre-wrap [overflow-wrap:anywhere]`; `.clamped` → `block overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical]`; `.showMore` → `inline-flex items-center gap-[6px] mt-[10px] p-0 border-0 bg-none text-muted-foreground text-[12px] hover:text-foreground`. **Keep the existing `WebkitLineClamp` inline style**: it is dynamic (`lines` prop), not a cascade escape hatch, so it is not one of the nine in §2.5 of the spec. |
| `RowMenu` | 184 | The trigger `.iconBtn` → `<Button variant="icon" size="legacyIcon">` (the variant already carries `shadow-none`, §2.5); `.menuWrap` → `relative`. **Keep both `stopPropagation` handlers** (`row-menu.test.tsx`). |
| `Markdown` | 214–215, 237 | **§5.6.** `<ul className="list-disc mb-[10px] pl-[22px]">`, `<ol className="list-decimal mb-[10px] pl-[22px]">`; `<li className="my-[3px]">`; `.md` root → `text-secondary-foreground text-[12.5px] leading-[1.75] [&>*:last-child]:mb-0`; `<p className="mb-[10px] [overflow-wrap:anywhere]">`; `<strong className="text-foreground">`; `<code>` → `rounded-[4px] bg-[color:var(--code-background)] px-[5px] py-[1px] text-[11.5px] text-primary`. |
| `Label` | 240 | `.dim` → `text-muted-foreground`. |
| `Modal` | 251–254 | `.modal` → `w-[min(560px,100%)] max-h-[86vh] overflow-y-auto rounded-[12px] border border-border bg-card p-[22px] shadow-[0_30px_90px_var(--modal-shadow)]`. **Keep `max-w-none gap-0`** (spec §8.5). `DialogTitle` takes the `cardTitle` string; `DialogFooter` keeps `mt-[18px] justify-end` and gains `flex items-center gap-[10px]` (was `.row`). |
| `FullPanel` | 266–273 | `.overlay` → `fixed inset-y-0 right-0 left-[214px] z-40 overflow-y-auto bg-popover max-[900px]:left-0`; `.overlayHead` → `sticky top-0 z-[1] flex items-center gap-[12px] border-b border-[color:var(--border-soft)] bg-popover px-[34px] py-[16px] max-[900px]:px-[16px]`; `.overlayBody` → `max-w-[1020px] px-[34px] pt-[24px] pb-[80px] max-[900px]:px-[16px]` + the `STACK` utilities. **§2.5 of the spec:** `<h1 style={{fontSize:16}}>` → `className="text-[16px]"`. The Cancel button at line 270 is a **raw `<button>`** → `<Button variant="legacy" size="legacy" className="shadow-none">` (§2.5). |
| `Field` | 278–281 | `.field` → `grid grid-cols-[minmax(0,1fr)] gap-[6px]`; `<label>` → `text-secondary-foreground text-[12.5px]`; `.hint` → `text-[color:var(--faint)] text-[11.5px] leading-[1.5]`. |

Also export the three highest-traffic layout strings so the pages do not each invent them:
`STACK = "grid grid-cols-[minmax(0,1fr)] gap-[16px]"`, `ROW = "flex items-center gap-[10px]"`,
`ROW_WRAP = "flex flex-wrap items-center gap-[8px]"`.

- **Verify:** `docs/plans/legacy-class-check.sh apps/web/src/components/ui.tsx` → `0`;
  `npm run build -w @agentos/web && npm run test -w @agentos/web` green with `primitives.test.tsx`
  and `row-menu.test.tsx` **unmodified**; by hand,
  `renderToStaticMarkup(<Markdown text={"- a\n\n1. b"} />)` contains `list-disc` and `list-decimal`
  (this becomes the W13 assertion).
- **Commit:** `refactor(web): migrate the shared ui barrel off the legacy stylesheet`.
- **Rollback:** revert alone only before W5; after that the pages depend on `Page`/`STACK`/tones.

---

### Section C — the pages (W5–W12b)

One commit each, in this order. The order is deliberate: **Connections first** because at 21
references it exercises `Page`, `pageHead`, `stack`, `Card`, `count`, `Table` and `Pill` — roughly
80% of the shared vocabulary — on a read-only page with no forms, no state and no drag-and-drop. If
the token mapping is wrong, it is cheapest to discover there. **Agents last** because at 83
references it is mostly repetition of decisions already made.

Every item in this section shares one **Verify** block, so it is stated once:

> `docs/plans/legacy-class-check.sh <file>` → `0`; `npm run typecheck` and
> `npm run build -w @agentos/web` green; `npm run test -w @agentos/web` green; the page renders with
> no leftover unstyled region (spec §8.10 — a stale `className="row"` is silently broken layout, not
> an error, and only the checker catches it).

And two rules that apply to every item in the section:

- **Appendix A is the map.** If a selector this page uses is not in Appendix A with a destination,
  stop and add it there before writing the JSX — a zero from the checker proves *removal*, not
  relocation (review must-fix #5).
- **Raw → primitive conversions run the §2.5 procedure**, which in practice means the
  `shadow-none` overrides enumerated there, and nothing else.

| # | File | Refs | Work beyond the Appendix A mapping | Depends on |
|---|---|---:|---|---|
| **W5** | `pages/Connections.tsx` | 21 | Two `tableWrap`+`table` pairs (35–36, 67–68) → full `<Table>/<TableHeader>/<TableBody>/<TableRow>/<TableHead>/<TableCell>` trees (W3). The outer `.tableWrap` div also wraps the `EmptyState` sibling — drop the div and leave `<Table>` and `<EmptyState>` as siblings inside `<Card flush>`; `.card.flush` supplies no padding, so nothing moves. `td.name` / `span.sub` per Appendix A. `.pill grey` on a `Link` (52) → `cn(badgeVariants({variant:"outline",tone:"grey",shape:"pill"}))`. | W1–W4 |
| **W6** | `pages/Secrets.tsx` | 20 | 1 `<select>` (48) → `<Select>`. `Table` at 97 is imported but the tree under it is raw — convert all six element types (W3). 3 `.btn` on `<Button>` hosts (38, 39, 87) → variants, **no `shadow-none`** (§2.5). | W3, W4 |
| **W7** | `pages/Projects.tsx` | 42 | **Zero prior migration.** 2 raw `<table>` (75, 163) → full `Table` element trees; 6 raw `<button>` (29, 30, 66, 182, 185, 186) → `Button` **+ `shadow-none`**; 2 raw `<input type="text">` (36, 39) → `<Input type="text" className="shadow-none">` — **keep the explicit type** (§1.6); 1 raw `<textarea rows={14}>` (194) → `<Textarea className="shadow-none">`. 3 `.btn` on `<Link>` (133–135) → `className={cn(buttonVariants({variant:"legacy",size:"legacy"}),"shadow-none")}` — a `<Link>` is not a `<Button>` host and has no shadow today. | W1–W4 |
| **W8** | `pages/Inbox.tsx` | 64 | **Zero prior migration.** 5 raw `<button>` (52, 187, 195, 196, 201): 195/196 → `Button` `legacyPrimary`/`legacyDanger` **+ `shadow-none`**; 52 (`.inboxItem`) and 187 (`.choice`) are full-width cards, not buttons — **keep the `<button>` host** and carry the Appendix A utilities; 201 (`.row`) → `ROW`. 1 raw `<textarea rows={5}>` (200) → `<Textarea className="shadow-none">`. `<h1 style={{fontSize:18}}>` (132) → `text-[18px]`. `.statPill` on `Link` ×2 (138–139). The `.inboxItem`, `.msgCard`, `.choice` and `.waitBar` families are written out in full in Appendix A. | W1–W4 |
| **W9** | `pages/Goals.tsx` | 48 | **S4:** `.goalCard h3 { font-size: 1.17em }` → explicit `text-[1.17em]` on the heading (109 block). `<Progress className="progressTrack">` ×2 (118, 172) → `className="h-[8px] bg-accent"`; `progress.tsx` stays unchanged (B14) and twMerge resolves `h-2`/`bg-primary/20` (§2.3). 1 `<select>` (58) → `Select`. `.pill green`/`.pill grey` ternary (199) → `tone={item.done ? "green" : "grey"}` via `Pill`. `.goalCard + .goalCard` → `mt-[12px]` on every card but the first. | W1–W4 |
| **W10** | `pages/Tasks.tsx` | 46 | **B13:** `` className={`dot ${tone}`} `` (32) → a `tone`-keyed lookup, not a string build; there are **five** dot states plus the base (Appendix A), not three. Kanban: the `.board`/`.column`/`.columnHead`/`.columnBody`/`.over`/`.columnEmpty`/`.taskCard` family is written out in Appendix A. 5 `<select>` (156, 162, 170, 206, 213) → `Select`. **Spec §2.5:** `style={{alignItems:"flex-start"}}` (60) → `items-start`; `style={{gap:6}}` (77) → `gap-[6px]`, **not** `gap-1.5` (§1.2). **Also deletes `tests/styles.test.tsx:44–52`** — see §4.3; that file is in this item's `Files` list. | W1–W4 |
| **W11** | `pages/TaskDetail.tsx` | 50 | 1 `<select>` (144) → `<Select className="w-[130px]">`, dropping `style={{width:130}}`. `style={{background:"var(--surface-run-detail)"}}` (50) → `bg-[color:var(--surface-run-detail)]`. **`.eventLog` and `.eventRow` are different boxes** — `.eventLog` is the scroll container (`max-h-[420px] overflow-auto rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--code-background)]`) and `.eventRow` is the row grid; rev 1 collapsed them into one string, which would have deleted the container. Full family, incl. `.seq`/`.type`/`.payload` and `:last-child`, in Appendix A. `Table` at 201 is imported but the tree under it is raw — convert all six element types. 5 `.statPill`. `.codeBlock` ×1. | W1–W4 |
| **W12** | `pages/Agents.tsx` | 83 | Largest, but no new patterns: `row`(10), `hint`(9), `stack`(8), `btn`(7), `fieldRow`(6). 4 `<select>` (66, 76, 202, 453) → `Select`. `Table` at 143/358 imported, trees raw — convert both fully. `.codeBlock` ×2. All 7 `.btn` are on `<Button>` hosts → **no `shadow-none`** (§2.5). Lines 125/399 already read `className="page text-foreground"` → `<Page className="text-foreground">`. | W1–W4 |

#### W12b — `App.tsx`, `Shell.tsx`, `goal-limit-inputs.tsx`

The chrome, 35 references. Its own commit, immediately after W12.

- `App.tsx` (8 refs; 38, 48, 67) — `.page` → `<Page className="pb-0">` at 38/48, dropping
  `style={{paddingBottom:0}}` (spec §2.5); `.notice error` → the `ErrorNotice` utilities.
- `Shell.tsx` (25 refs) — carries most of **S5**. The `.shell`/`.sidebar`/`.sidebarFoot`/`.content`/
  `.projectSwitcher`/`.projectMark`/`.projectName`/`.chevron`/`.navItem`/`.badge`/`.runnerRow`/
  `.state`/`.dot` family is written out in full in Appendix A. Beyond the mapping:
  - `style={{width:18,height:18,fontSize:10}}` (40) → `size-[18px] text-[10px]` (spec §2.5).
  - `.navItem` ×3 (70, 83, 84) → the exported `NAV_ITEM` string (W4, spec §5.7). **Keep the
    right-aligned `.count`/`.badge` slot (73) as a slot**, and keep the runner row (78–82) a
    single hover-able unit — spec §5.7 constrains this so batch 1 and batch 5 can extend them.
  - `.projectSwitcher` (31) stays a raw `<button>`; it is not a `.btn` and takes no `Button`
    variant.
  - `.dot on/off` ternary (79) → a state-keyed lookup over the six Appendix A strings, including
    `.dot.on`'s `box-shadow` glow, which rev 1 omitted.
- `goal-limit-inputs.tsx` (2 refs) — `.fieldRow` ×2 →
  `grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-start gap-[14px]`. **Do not touch the
  four `<Input type="number">` calls**; `input-semantics.test.tsx:22` pins their `min`/`step`, and
  they are `<Input>` hosts, so they keep their shadow (§2.5).
- **Verify:** the shared block, plus the first **S5** narrow-viewport walk (this is the earliest
  point it is checkable), plus `input-semantics.test.tsx` green.
- **Commit:** `refactor(web): migrate app chrome off the legacy stylesheet`.

**Section C rollback:** each page is independently revertible *within the branch*, but see §8 —
after W13 a single-page revert renders that page unstyled. Before W13 it is safe.

---

### Section D — the switch (W13)

#### W13 — delete the legacy stylesheet **and** invert the layer test, in one commit

Spec §5.1, §5.3, §5.5, §6.1, §6.2. Depends on: W1–W12b, all of them.

**Part 1 — `apps/web/src/styles.css`, 463 lines → ~82.**

Keep lines 1–64 byte-identical (`@import`, `@custom-variant`, `@theme inline`, the provenance
comment, `:root`, `.dark`). Delete lines 66–463 in full — that is the single `:root` alias +
typography rule (§1.6), every class rule, the form-control block, and the media query. Then append:

```css
@layer base {
  html { font-family: var(--mono); font-size: 13px; line-height: 1.5;
         color: var(--foreground); background: var(--background);
         font-synthesis: none; -webkit-font-smoothing: antialiased;
         text-rendering: optimizeLegibility; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--background); }
  button, input, textarea, select { font: inherit; color: inherit; }
  button { cursor: pointer; }
  a { color: var(--link); text-decoration: none; }
  h1, h2, h3, h4 { margin: 0; font-weight: 700; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { border: 3px solid transparent; border-radius: 8px;
                              background: var(--scrollbar); background-clip: content-box; }
  ::-webkit-scrollbar-track { background: transparent; }
}
```

Four constraints, all from spec §5.1/§5.3, all verified satisfiable:

1. `html`, not `:root` — so `styles.test.tsx:65`'s `/:root\s*\{([^}]+)\}/` still latches onto the
   light token block. `.dark` is applied to `document.documentElement` (`lib/theme.tsx:20`), i.e.
   the same element; nothing changes.
2. `font-size: 13px` **unchanged** — spec §8.7. Changing it rescales every utility at once.
3. Alias substitution: `--fg`→`--foreground`, `--ink-0`→`--background`, `--blue`→`--link`.
   `--scrollbar` and `--mono` are real tokens and stay.
4. `@layer base` is written **after** `@import "tailwindcss"`, so it appends to `base` and still
   beats preflight on source order while now correctly losing to utilities.

**This is the moment §2.5 pays out.** Moving `button, input, textarea, select { font: inherit }`
into `@layer base` is what makes `font-medium`, `text-sm` and `disabled:opacity-50` live for the
first time. If W1/W2/W3 skipped their pins, the whole app's buttons and form controls change weight
and size **in this commit**, with nothing in the diff to point at.

**Part 2 — `apps/web/src/tests/styles.test.tsx`.**

- Replace the test at 38–53 with the general assertion (spec §6.1): walk every layer-depth-zero
  style rule in `built`, flag any whose selector contains a class token **and** which declares at
  least one non-custom-property, assert the list is empty and print the offenders. Reuse
  `layersAt()` at 13–30 rather than rewriting it. The custom-property carve-out is what admits
  `.dark{--background:…}` with no name allowlist. **No allowlist at merge**; if one proves
  unavoidable it must be empty and commented.
- Companion assertions (spec §6.1, C2): `.flex{` is still in `["utilities"]`, and the walker's
  total unlayered-rule count is non-zero (otherwise a parser bug makes the test vacuously green).
- Replace the markdown test at 55–63 (spec §6.2): preflight's `ol,ul,menu{list-style:none}` still
  in `["base"]`; `list-disc` and `list-decimal` present and in `["utilities"]`;
  `renderToStaticMarkup(<Markdown text={"- a\n\n1. b"} />)` emits a `<ul>` carrying `list-disc` and
  an `<ol>` carrying `list-decimal`. The SSR assertion is the one that prevents the regression.
- **Lines 65–103 must not change** (spec §6.3, C5): the `lightBlock` regex, `token()`,
  `luminance()`, `contrast()`, and the 14 contrast pairs. The runnable form of C5 is

  ```sh
  git diff 3f712b5 -- apps/web/src/tests/styles.test.tsx | grep -c '^[+-].*lightBlock' # expect 0
  git diff 3f712b5 -- apps/web/src/tests/styles.test.tsx                              # inspect: no hunk at/after line 65
  ```

  **Not `git diff master`** — neither `master` nor `origin/master` exists in this repository
  (`git rev-parse master` exits 128), so rev 1's C5 command could never run (review must-fix #7).
  `3f712b5` is the pinned baseline this plan is written against and is always present on the branch.
- The five inline-style pins at 44–52 are already gone by then — see §4.3.

**Part 3 — the selector-destination checklist (new in rev 2, review must-fix #5).**

Before this commit lands, produce a table of **every selector deleted from `styles.css`** — all 126
class selectors plus every descendant, pseudo-element, pseudo-class and state rule among them
(`.segmented button:hover`, `.taskCard .foot svg`, `.choice.on .radio`, `.eventRow:last-child`,
`.dot.on`, `.md > :last-child`, `.msgCard + .msgCard`, `.table tbody tr:last-child td`, …) —
against the file and class string that now carries it. Appendix A is the source; this is Appendix A
checked back against the finished diff rather than against the plan.

Any row with no destination is either an intentional drop (list it in the PR as a spec §4-rule-4
delta with its before/after value) or a bug. **A zero from `legacy-class-check.sh` proves the class
name is gone, not that its declarations were relocated** — this table is the only thing that proves
the second, and it is what the reviewer at step ⑥ reads.

- **Verify:** `npm run build -w @agentos/web` **then** `npm run test -w @agentos/web`; A1
  (`grep -oE '^\s*\.[A-Za-z][A-Za-z0-9_-]*' apps/web/src/styles.css | sort -u` returns only
  `.dark`); A4 (`git diff 3f712b5 -- apps/web/src/styles.css` shows no hunk touching lines 26–64);
  the file is under ~100 lines; `grep -c "max-width: *900px" apps/web/dist/assets/*.css` ≥ 1 (S5
  survived as arbitrary variants); Part 3's table complete.
- **Commit:** `refactor(web)!: delete the legacy stylesheet and invert the layer regression test`.
- **Rollback:** §8. This commit is the batch's point of no return; reverting it alone restores 126
  unlayered rules that now beat the migrated utilities, which is worse than either end state.

---

### Section E — acceptance (W14–W16)

#### W14 — the mechanical sweep

- **Call the committed checker** (ruling R-2) — do not inline a copy:

  ```sh
  docs/plans/legacy-class-check.sh $(find apps/web/src -name '*.tsx' | sort)
  ```

  Every count must be `0`, and the script's exit status must be `0`. The whole-tree form supersedes
  the spec's 12-file list: at `3f712b5` the only non-zero files are those 12 plus
  `tests/styles.test.tsx` (3, removed by C3 at W10), so a clean sweep of every `.tsx` is both
  stricter and shorter than enumerating B1–B12 (§1.1).
- Run A1–A9, B13–B17, C1–C6 from the spec's checklist. C5 and C6 use `3f712b5` as the baseline ref,
  not `master` (W13 part 2).
- B17: `grep -rnE 'bg-\[#|text-\[#|border-\[#|\[rgb' apps/web/src` returns nothing.
- B16: no new `.css` file, no `<style>` tag, no `@layer legacy`.
- Confirm W13 part 3's selector-destination table is complete and attach it to the PR.

#### W15 — the negative control (spec §6.1, C7)

Temporarily add `.row { display: flex }` to `styles.css`, rebuild, and show the new assertion goes
red naming `.row`; remove it, rebuild, show green. **Record both outputs in the PR description; do
not commit the temporary rule.** This is batch 0's practice and the only proof the new test is not
vacuous.

#### W16 — manual walks and the PR

- **E1** ≤900px: sidebar collapses to a wrapping row, footer hidden, page padding `20px 16px 60px`,
  overlay full-bleed. Nothing automated covers this (spec §8.2).
- **E2** light and dark on all 8 pages + the New Task overlay + a modal.
- **E3** markdown `-`/`1.` markers; a Goals card `h3` visibly larger than its body.
- **E4** all 12 `<select>` sites: styled, chevron present, opens normally.
- **E5 — before/after against `docs/plans/baseline-screenshots/` (ruling R-3).** Re-shoot **all 18**
  W0 frames at the same viewport and theme, and compare pairwise. The four the spec singles out —
  Agents, Tasks (board), Inbox, Projects — get the closest read, but the comparison set is the whole
  W0 capture, because W0 is the only appearance evidence this batch produces and re-shooting a
  subset wastes the other 14. Attach the pairs, or the diffs, to the PR.
- **G2 specifically:** compare the re-shot toggle close-up against
  `docs/plans/baseline-screenshots/agents-toggle-*.png`. Knob size, inset and travel must match.
- **Rem-scale eyeball** (spec §8.7): confirm at the first comparison that nothing rescaled by 16/13.
- PR description must carry: the D1–D4 gate outputs; the W0b calibration output and the W14 sweep
  output; the **new test count** with the delta accounted for against the 59-test baseline at
  `3f712b5`; the §6.4 command order; the W15 negative control; W13 part 3's selector-destination
  table; every §4-rule-4 accepted appearance delta with before/after values (including any §2.5
  host-asymmetry decision, per OQ-1); and the "pages I find ugly" list (spec §11 — **record, do not
  act**).

---

## 4. Order, commits, and the two things that will look like breakage

### 4.1 Commit map

**19 work items, 16 commits**, strictly serial, single implementer. (Rev 1 said "16 items, 14
commits" while enumerating 17 — review should-fix #1. The recount: W0, W0b, W1–W12, W12b, W13–W16 =
19 items; W14–W16 produce no commits of their own, and W0b produces one only if calibration forces a
fix to the checker, so the commit count is 16.)

```
W0  baseline screenshots           ─┐ Section 0 — evidence and tooling
W0b calibrate legacy-class-check.sh ┘  (no apps/web change; R-3, R-2)
W1  button/badge variants          ─┐
W2  input/textarea geometry         │ Section A — no rendered change, given §2.5
W3  select primitive + table        ─┘
W4  ui.tsx                          ── Section B
W5  Connections   W6  Secrets       ─┐
W7  Projects      W8  Inbox         │ Section C — smallest first
W9  Goals         W10 Tasks         │
W11 TaskDetail    W12 Agents        │
W12b App + Shell + goal-limit       ─┘
W13 styles.css + styles.test.tsx    ── Section D  (point of no return)
W14 sweep  W15 negative control  W16 PR   ── Section E (no commits except PR text)
```

W0 and W0b are mutually independent, but **both precede W1** — W0 because its subject stops existing
(R-3), W0b because Section C's per-item Verify calls the checker. W1–W3 are mutually independent and
could be one commit; they are three because W3 adds a file and W2 touches the two primitives most
likely to need a revisit after the first visual pass.

### 4.2 The interim is ugly, and that is correct

Between W4 and W13 the app renders in a mixed state:

- **Descendant rules** (`.card > h2`, `.taskCard h3`, `.kv .k`, `.inboxItem .body`, `.table .name`)
  lose their subject as soon as the ancestor's class is removed, so an unmigrated page inside a
  migrated `Card` shows unstyled headings.
- **`color: inherit`** at `styles.css:91` is unlayered until W13, so a migrated `<button>` carrying
  `text-secondary-foreground` renders in the *inherited* colour, not the token, for the whole
  interim. This is the same mechanism as the descendant breakage and resolves at the same moment.

**Do not fix either with an inline style or a temporary class** — spec §8.3. They resolve at W13.

Form controls are the opposite case: `input`, `select`, `textarea` keep legacy geometry until W13
because the element rule at `styles.css:233–240` is unlayered and still wins. So W2/W3's work is
invisible until W13, and **no form-control appearance check before W13 means anything.**

### 4.3 The five inline-style pins break before W13 — handle them at W10

`styles.test.tsx:44–52` pins literal source strings in `App.tsx`, `Shell.tsx`, `Tasks.tsx` and
`TaskDetail.tsx`. Those files are edited at W10, W11 and W12b — *before* the test rewrite at W13.
Removing the five `assert.match` lines is C3 and does not depend on the stylesheet, so:

> **Delete `styles.test.tsx:44–52` in the W10 commit** (the first commit that touches a pinned
> file). Removing assertions cannot fail, and the rest of the file — including the layer assertions
> that still describe the pre-W13 world — stays green.

`tests/styles.test.tsx` is therefore listed in **W10's `Files`**, not only here (review
should-fix #2). Without this, `npm test` is red from W10 to W13 for a reason unrelated to the work
in flight.

### 4.4 Build before test, always

`styles.test.tsx:8–11` reads `apps/web/dist/assets/*.css` and throws if the directory is empty —
and `apps/web/dist/` **does not exist in a fresh checkout** (verified). It also does not detect a
*stale* artifact, which spec §6.4 leaves open on purpose. So every verification in this plan means:

```sh
npm run build -w @agentos/web && npm run test -w @agentos/web
```

Never `npm test` alone after a CSS edit. This is an ordering requirement, not a licence for a red
commit: every commit in the batch is green **in that order**, W13 included (§3 preamble).

---

## 5. Coverage map — spec requirement → work item

| Spec | Requirement | Work item |
|---|---|---|
| §5.1 | `styles.css` final shape, `@layer base`, `html` not `:root`, alias substitution | W13 part 1 |
| §5.2 | 12 source files, zero legacy references | W4, W5–W12, W12b |
| §5.2 | `ui.tsx` migrated first as the keystone | W4 (order fixed in §4.1) |
| §5.2 | Connections / Inbox / Projects in scope despite future rewrites | W5, W8, W7 |
| §5.3 | Light token block stays first, unnested, in `styles.css` | W13 part 1, constraint 1 |
| §5.4 | `Select` primitive, native, no Radix | W3 |
| §5.4 | 12 `<select>` sites converted | W6, W9, W10 ×5, W11, W12 ×4 |
| §5.4 | Raw `<input>`/`<textarea>` converted, explicit `type` | W7, W8 |
| §5.5 | `@media (max-width:900px)` → `max-[900px]:` variants | W4 (`Page`, `FullPanel`), W12b (`Shell`) |
| §5.6 | Markdown markers as utilities; `.goalCard h3` explicit | W4, W9 |
| §5.7 | Nav-item shape, count slot, runner row, Agents table extensibility | W4 (`NAV_ITEM`), W12b, W12 |
| §6.1 | General unlayered-class assertion + companions | W13 part 2 |
| §6.1 | Negative control in the PR | W15 |
| §6.2 | Markdown test rewritten around utilities + SSR | W13 part 2 |
| §6.3 | Contrast test and four pinned test files unmodified | W13 (constraint, baseline `3f712b5`), §2.4 |
| §6.4 | Build-before-test ordering in the PR | §4.4, W16 |
| §2.5 | 8 of 9 compatibility inline styles removed | W4 ×1, W8, W10 ×2, W11 ×2, W12b ×3 |
| §2.3 | Three interpolation sites migrated at the signature | W4 ×2, W10 ×1 |
| §4 rules 1–3 | Appearance preserved via tokens / arbitrary values / cva variants | §2.1–2.2, **§2.5**, W1, Appendix A |
| §4 rule 4 | Accepted deltas enumerated with before/after values | W16 PR body, §7 OQ-1 |
| §9.A | A1–A9 | W13, W14 |
| §9.B | B1–B17 | W14 (**via `docs/plans/legacy-class-check.sh`**, ruling R-2) |
| §9.C | C1–C7 | W13, W14, W15 |
| §9.D | D1–D4 | W16 |
| §9.E | E1–E4 | W16 |
| §9.E | E5 before/after evidence | **W0** (capture, ruling R-3) + W16 (compare) |
| §11 | "Pages I find ugly" list recorded, not acted on | W16 |

Every spec requirement maps to a numbered item. Nothing in §7 of the spec (out of scope) is planned.

---

## 6. Where this plan is guessing

Flagged explicitly, because the executioner will hit these and should not treat them as settled.
**G1, G3 and G4 were resolved during the rev-2 revision** and are recorded here as facts, with the
check retained as regression protection (review should-fix #3).

- **G1 — the `<select>` chevron as arbitrary background utilities. RESOLVED: verified.** Compiled
  against this repository's Tailwind 4.3.3, all three utilities emit:
  `background-image: linear-gradient(45deg,transparent 50%,var(--faint) 50%),linear-gradient(135deg,var(--faint) 50%,transparent 50%)`,
  `background-position: right 14px top 15px,right 9px top 15px`, `background-size: 5px 5px`.
  **Keep the check** as regression protection: after the first build,
  `grep -c "linear-gradient(45deg" apps/web/dist/assets/*.css` ≥ 1. The lucide-fallback branch is
  **retired** — do not implement it. If the grep ever returns 0, that is a build regression to
  report, not a licence to substitute.
- **G2 — the Toggle knob inset. Still open, now checkable.** Legacy puts a 15px knob at
  `top:3px; left:3px` inside a 21px track via a pseudo-element. The Radix thumb is a flex child of a
  root with `border-2 border-transparent` and `items-center`, which *should* land in the same place.
  Not verifiable without rendering — **compare against
  `docs/plans/baseline-screenshots/agents-toggle-*.png`** (W0, ruling R-3). Before rev 2 there was
  nothing to compare against; that was review must-fix #3.
- **G3 — `color-mix()` inside an arbitrary value. RESOLVED: verified.** Four sites need it
  (`.notice.gap`, `.waitBar`, `.columnBody`, `.columnBody.over`).
  `bg-[color-mix(in_srgb,var(--x)_5%,transparent)]` compiles and emits the expected declaration.
  **The plain-token fallback is removed** — under R-1 a flat token in place of a 4%/5% tint is a
  visible appearance change, and rev 1 pre-authorised it. If it ever fails to compile, stop and
  report.
  One detail worth knowing: Tailwind emits an **unguarded fallback** ahead of the `@supports`
  branch — `background-color: var(--primary)` at full opacity, then
  `@supports (color: color-mix(…)) { background-color: color-mix(…) }`. Every browser this app
  targets takes the second branch; a browser without `color-mix` would render the tint solid rather
  than absent. Not a defect, but do not be surprised by it in the built CSS.
- **G4 — shadcn `Table` geometry parity. RESOLVED into a requirement.** `border-collapse` is legacy
  `.table`'s and is absent from the primitive, so W3 now adds it unconditionally rather than as a
  contingency; `border-collapse` and `[&_tr:last-child>td]:border-b-0` both compile. The stock
  `caption-bottom` stays (no `<caption>` exists in the app).
- **G5 — `.page` as a component.** P-1 assumes no test or selector depends on `.page` being a bare
  `<div>`. Verified today (no `querySelector` on class names anywhere in `src`; the only class
  manipulation is `lib/theme.tsx:20` toggling `dark` on `<html>`), but it is a shape change across
  25 sites.
- **G6 — the `ui.tsx` count is 56, not 57.** One reference in the spec's tally is not reproducible
  (§1.1). If the executioner finds 57 by a different method, the extra one is in the `ui.tsx:125`
  template literal and is covered by W4 regardless.
- **G7 — "under ~100 lines" (A9).** Lines 1–64 plus the `@layer base` block above lands at roughly
  82 lines. An estimate, not a measured value.
- **G8 — the new test count (D4).** The batch removes 5 assertions and adds ~6 across two tests.
  Whether `node --test` reports the same number of *tests* depends on how the layer test is split.
  The PR states the measured number; do not predict it here.

---

## 7. Decisions this plan made, and questions closed at the gate

**P-1 — `Page` becomes a component (decided).** `.page` has 25 call sites across 9 files and
carries the §5.5 responsive padding. Inlining a six-utility string 25 times guarantees drift. Spec
§5.7 already prefers a component over "eleven bespoke utility strings" for the analogous
`.navItem`. *Overturning cost: low — replace `<Page>` with `<div className={PAGE}>`; the string is
exported either way.*

**P-2 — `input.tsx` / `textarea.tsx` / `table.tsx` are edited (decided).** Forced by §4's
appearance rule; see §1.5. *Overturning cost: high — the alternative is a visible geometry change
on every form and table in the app, which this stage forbids.*

**P-3 — the legacy variants pin their own `font-*`, `shadow*` and `disabled:opacity-*` (decided,
new in rev 2).** §2.5. Not a style preference: `styles.css:91` masks those utilities today and
un-masks them at W13, so a variant that omits a pin silently inherits the shadcn base value in the
one commit nobody will be reading for typography. *Overturning cost: none — it is a correctness fix.*

**P-4 — the acceptance checker is a committed repo artifact (decided by ruling R-2).**
`docs/plans/legacy-class-check.sh`, landed with this plan. *Closes rev 1's Q-1, which had defaulted
to PR-description-only — the outcome the ruling forbids.*

**Q-1 — CLOSED by ruling R-2.** The corrected check is committed, not PR-only. See P-4 and W0b.

**Q-2 — CLOSED by ruling R-1, terminally.** Spec assumption 4 stands: this batch preserves the
current appearance with existing tokens, arbitrary values and `cva` variants. Converging onto
shadcn's stock geometry is **not** an available option and is not to be re-argued in review, in the
PR, or in the executing session. The visual rework is the next stage and is out of scope here.
Rev 1 presented this as an open choice; that was review must-fix #1.

**OQ-1 — open, recorded, not escalated.** See §0.1: preserving appearance exactly means preserving
the box-shadow asymmetry between primitive-hosted and raw-hosted controls, at a cost of 13
`shadow-none` overrides. The plan proceeds on preserve, per R-1; normalising instead is a one-line
change to §2.5 plus a §4-rule-4 delta entry in the PR. Recorded here and in the task activity log
per the chain's standing rule; no `inbox_ask` was sent.

---

## 8. Rollback

### 8.1 Per section

- **Section 0 (W0, W0b)** — docs-only and additive. Nothing to roll back; reverting W0 destroys the
  batch's only appearance evidence and must not be done to "clean up the diff".
- **Section A (W1–W3)** — additive and inert while the legacy sheet is live. Revertible
  individually with no visual effect, until W4 consumes the new variants.
- **Section B (W4)** — revertible alone before W5. After W5 the pages import `Page`, `STACK` and
  the badge tones from it; reverting orphans them, which fails loudly at `npm run typecheck`
  rather than silently.
- **Section C (W5–W12b)** — each page revertible alone **before W13**; the legacy classes come
  back and the legacy rules are still there to serve them. **After W13, a single-page revert
  renders that page unstyled** (spec §12).
- **Section D (W13)** — not independently revertible in either direction. Reverting `styles.css`
  alone restores 126 unlayered rules that now beat every migrated utility, leaving the app *worse*
  than before the batch because both mechanisms are live. Reverting the test alone leaves an
  assertion designed to fail against the old sheet.
- **Section E** — PR text and manual checks; nothing to roll back.

### 8.2 The batch

**The rollback unit is the whole batch.** `git revert` of the merge commit, or a branch reset,
restores `3f712b5` exactly. Blast radius:

- `apps/web/src/**` — every change that renders;
- one new source file, `apps/web/src/components/ui/select.tsx`;
- `docs/plans/legacy-class-check.sh` (ruling R-2) and `docs/plans/baseline-screenshots/**` (ruling
  R-3) — **documentation, outside the build**. Neither is imported by anything, neither affects
  `npm run build`, `npm run test` or `npm run typecheck`, and both are worth keeping even if the
  code is reverted: the screenshots document the state the revert returns to, and the checker is
  what any future attempt re-runs.

No API surface, no persisted data, no runner behaviour, so there is no forward-fix obligation and no
window in which a revert loses anything. If part of the batch needs undoing, revert everything under
`apps/web/` and re-land; leave `docs/plans/**` in place.

---

## 9. Migrations and restarts

**None.** No Prisma schema change, no enum change, no migration, no `db:generate`, no seed change,
no service restart, no launchd change. `packages/**` is untouched (spec §7). The only build
artifact that matters is `apps/web/dist/`, and the only ordering requirement is §4.4.

---

## Appendix A — legacy selector → replacement, exhaustive

**Rev 2 made this exhaustive.** Rev 1 deferred whole families to "see W8 / W10 / W11 / W12b" while
those items defined only some of their members — a zero from `legacy-class-check.sh` would still
have passed with declarations silently dropped (review must-fix #5). Every multi-property rule,
every descendant rule, and every pseudo-class / pseudo-element / state rule in `styles.css:99–463`
now appears below with a destination. W13 part 3 checks this table back against the finished diff.

**Read every pixel value as an arbitrary utility** unless it is a multiple of 3.25px (§1.2).
`1px solid var(--line)` is always `border border-border`; `var(--radius-ctl)` is `rounded-lg`;
`var(--radius-card)` is `rounded-xl`; `999px`/`50%` radii are `rounded-full`.

### A.1 Single-property classes

| Legacy | Replacement | Owner |
|---|---|---|
| `.dim` 450 | `text-muted-foreground` | W4 + pages |
| `.faint` 451 | `text-[color:var(--faint)]` | pages |
| `.strong` 452 | `text-foreground` | pages |
| `.nowrap` 453 | `whitespace-nowrap` | pages |
| `.small` 454 (standalone) | `text-[11.5px]` | pages |
| `.spacer` 175, and `.cardTitle .spacer` 253, `.detailHead .spacer` 166, `.notice .spacer` 409 | `flex-1` | W4 + pages |
| `.clickable` 299 | `cursor-pointer` | pages |
| `.menuWrap` 432 | `relative` | W4 (`RowMenu`) |
| `.tableWrap` 301 | dropped — the `Table` primitive's own `relative w-full overflow-auto` wrapper replaces it | W3, W5–W12 |
| `.toolbar` 209 | `flex items-center gap-[10px] mb-[16px]` | pages |
| `.unreadDot` 370 | `flex-none size-[7px] rounded-full bg-primary` | W8 |
| `.progressTrack` 411 | `h-[8px] bg-accent` passed to `<Progress>`; `rounded-full overflow-hidden` are already in the primitive, which stays unchanged (B14) | W9 |

### A.2 Layout primitives

| Legacy | Replacement | Owner |
|---|---|---|
| `.page` 156 + media 460 | `max-w-[1240px] px-[34px] pt-[26px] pb-[80px] max-[900px]:px-[16px] max-[900px]:pt-[20px] max-[900px]:pb-[60px]` | `Page` / `PAGE`, W4 |
| `.stack` 172 | `grid grid-cols-[minmax(0,1fr)] gap-[16px]` | `STACK`, W4 |
| `.row` 173 | `flex items-center gap-[10px]` | `ROW`, W4 |
| `.rowWrap` 174 | `flex flex-wrap items-center gap-[8px]` | `ROW_WRAP`, W4 |
| `.pageHead` 158 | `flex items-start gap-[20px] mb-[18px]` | pages |
| `.pageHead .titles` 159 | `flex-1 min-w-0` | pages |
| `.pageHead h1` 160 | `text-[22px] tracking-[-.01em]` | pages |
| `.pageHead .subtitle` 161 | `mt-[5px] text-[12.5px] text-muted-foreground` | pages |
| `.pageActions` 162 | `flex items-center gap-[9px]` | pages |
| `.detailHead` 164 | `flex items-center gap-[12px] mb-[18px]` | pages |
| `.detailHead h1` 165 | `text-[20px]` | pages |
| `.backLink` 167 + `:hover` 168 | `inline-flex items-center gap-[8px] text-[12.5px] text-muted-foreground hover:text-foreground` | pages |

### A.3 Controls

`.btn`/`.iconBtn` and their states become `cva` variants (W1); the table records what each variant
must reproduce, and **§2.5 governs `shadow`, `font-weight` and `disabled` opacity for all of them**.

| Legacy | Replacement | Owner |
|---|---|---|
| `.btn` 179–184 | `variant="legacy" size="legacy"` = `inline-flex items-center gap-[7px] h-[34px] px-[13px] border border-border rounded-lg bg-card text-secondary-foreground text-[12.5px] whitespace-nowrap` + `shadow font-normal` (§2.5) | W1 |
| `.btn:hover` 185 | `hover:border-[color:var(--border-hover)] hover:bg-secondary hover:text-foreground` | W1 |
| `.btn:disabled` 186 | `disabled:opacity-45`; `cursor: not-allowed` is already suppressed by the base's `disabled:pointer-events-none` (§2.5) | W1 |
| `.btn.primary` 187 | `variant="legacyPrimary"` = `border-primary bg-primary text-primary-foreground font-bold` | W1 |
| `.btn.primary:hover` 188 | `hover:bg-[color:var(--primary-hover)] hover:border-[color:var(--primary-hover)]` | W1 |
| `.btn.danger` 189 | `variant="legacyDanger"` = `border-[color:var(--destructive-line)] bg-[color:var(--danger-button)] text-[color:var(--danger-button-foreground)] font-bold` (§1.4 — **not** stock `destructive`) | W1 |
| `.btn.danger:hover` 190 | `hover:bg-[color:var(--danger-button-hover)]` | W1 |
| `.btn.small` 191 | `size="legacySmall"` = `h-[28px] gap-[7px] px-[10px] text-[12px] rounded-lg` | W1 |
| `.iconBtn` 193–196 | `variant="icon" size="legacyIcon"` = `grid place-items-center size-[28px] rounded-[7px] border-0 bg-transparent text-muted-foreground shadow-none font-normal` | W1 |
| `.iconBtn:hover` 197 | `hover:bg-secondary hover:text-foreground` | W1 |
| `.iconBtn.danger:hover` 198 | `hover:text-[color:var(--destructive-fg)]` on the danger menu item | W4 (`RowMenu`) |
| `.segmented` 200 | `inline-flex gap-[3px] rounded-[9px] border border-[color:var(--border-soft)] bg-card p-[3px]` | W4 |
| `.segmented button` 201–204 | `rounded-[7px] border-0 bg-transparent px-[13px] py-[6px] text-[12.5px] text-muted-foreground` | W4 |
| `.segmented button:hover` 205 | `hover:text-secondary-foreground` | W4 |
| `.segmented button.on` 206 | `bg-accent text-foreground` | W4 |
| `.segmented.accent button.on` 207 | `bg-primary text-primary-foreground font-bold` | W4 |
| `.tabs` 210 | `flex w-fit max-w-full gap-[3px] overflow-x-auto rounded-[9px] border border-[color:var(--border-soft)] bg-card p-[3px] mb-[16px]` | W4 |
| `.tabs button` 211 | `rounded-[7px] border-0 bg-transparent px-[14px] py-[7px] text-[12.5px] text-muted-foreground whitespace-nowrap` — **no hover rule exists; do not add one** | W4 |
| `.tabs button.on` 212 | `bg-accent text-foreground` | W4 |
| `.toggle` 214–217 | Radix `Switch` root: `relative flex-none w-[38px] h-[21px] p-0 border-0 rounded-full data-[state=unchecked]:bg-[color:var(--toggle-background)] transition-colors` | W4, §1.3 |
| `.toggle::after` 218–221 | the Radix thumb, un-hidden: `[&>span]:size-[15px] [&>span]:rounded-full [&>span]:bg-[color:var(--toggle-knob)] [&>span]:transition-transform` | W4, §1.3 |
| `.toggle.on` 222 | `data-[state=checked]:bg-primary` | W4 |
| `.toggle.on::after` 223 | `[&>span]:data-[state=checked]:translate-x-[17px] [&>span]:data-[state=checked]:bg-[color:var(--toggle-knob-active)]` | W4 |
| `.toggle:disabled` 224 | `disabled:opacity-50 disabled:cursor-not-allowed` | W4 |
| `.check` 226–230 | `grid place-items-center flex-none size-[17px] p-0 rounded-[4px] border border-[color:var(--check-border)] bg-secondary text-primary-foreground` | W4 |
| `.check.on` 231 | `data-[state=checked]:bg-primary data-[state=checked]:border-primary` | W4 |
| `.field` 242 | `grid grid-cols-[minmax(0,1fr)] gap-[6px]` | W4 |
| `.field > label` 243 | `text-secondary-foreground text-[12.5px]` | W4 |
| `.field .hint` 244 | `text-[color:var(--faint)] text-[11.5px] leading-[1.5]` | W4 |
| `.fieldRow` 247 | `grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-start gap-[14px]` | W4, W12b |
| `input/select/textarea` 233–240 | the `Input` / `Select` / `Textarea` primitives (W2, W3); `input:focus` → `focus:border-primary` | W2, W3 |

### A.4 Cards, metrics, code and tables

| Legacy | Replacement | Owner |
|---|---|---|
| `.card` 251 | stock `Card` (`rounded-xl border bg-card text-card-foreground`) + `px-[20px] py-[18px]` | W4 |
| `.card > h2`, `.cardTitle` 252 | `flex items-center gap-[9px] mb-[14px] text-[13.5px]` | W4 |
| `.card.flush` 254 | `px-0 pt-[18px] pb-0` | W4 |
| `.card.flush > .cardTitle` 255 | `px-[20px]` on the title row | W4 |
| `.count` 257–260 | `inline-grid place-items-center min-w-[20px] h-[19px] px-[6px] rounded-[6px] bg-accent text-[11.5px] text-muted-foreground` | W4 |
| `.kv` 262 | `grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-[40px] gap-y-[16px]` | W4 |
| `.kv > div` 263 | `[&>div]:min-w-0` on the grid | W4 |
| `.kv .k` 264 | `text-muted-foreground text-[12px]` | W4 |
| `.kv .v` 265 | `mt-[3px] text-[13px] [overflow-wrap:anywhere]` | W4 |
| `.kv.three` 266 | `grid-cols-[repeat(3,minmax(0,1fr))]` | W4 |
| `.metrics` 268 | `grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-[14px]` | W4 |
| `.metric` 269 | `rounded-xl border border-border bg-card px-[16px] py-[14px]` | W4 |
| `.metric .k` 270 | `text-muted-foreground text-[12px]` | W4 |
| `.metric .v` 271 | `mt-[6px] text-[15px] font-bold` | W4 |
| `.longText` 273 | `text-secondary-foreground text-[12.5px] leading-[1.75] whitespace-pre-wrap [overflow-wrap:anywhere]` | W4 |
| `.clamped` 274 | `block overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical]`; the line count stays the existing dynamic inline style | W4 |
| `.showMore` 275 | `inline-flex items-center gap-[6px] mt-[10px] p-0 border-0 bg-none text-muted-foreground text-[12px]` | W4 |
| `.showMore:hover` 276 | `hover:text-foreground` | W4 |
| `.codeBlock` 278–283 | `max-h-[460px] overflow-auto rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--code-background)] px-[16px] py-[14px] text-[12px] leading-[1.65] text-secondary-foreground whitespace-pre-wrap [overflow-wrap:anywhere]` | W11, W12 |
| `.table` 287 | `Table` base + `border-collapse` (W3) | W3 |
| `.table th` 288–291 | `TableHead`: `h-auto px-[14px] py-[10px] border-b border-[color:var(--border-soft)] text-muted-foreground text-[12px] font-normal text-left whitespace-nowrap` | W3 |
| `.table td` 292 | `TableCell`: `px-[14px] py-[13px] border-b border-[color:var(--border-soft)] text-[12.5px] text-secondary-foreground align-middle whitespace-nowrap` | W3 |
| `.table tbody tr:hover` 293 | `TableRow`: `hover:bg-[color:var(--row-hover)]` | W3 |
| `.table tbody tr:last-child td` 294 | `TableBody`: `[&_tr:last-child>td]:border-b-0` — **must be added; the stock `[&_tr:last-child]:border-0` targets the `<tr>`, not the `<td>`** (§W3, review must-fix #6) | W3 |
| `.table .name` 295 | `text-foreground font-bold` on the cell | W5, W7, W11, W12 |
| `.table .name .sub` 296 | `block mt-[3px] text-muted-foreground font-normal text-[11.5px]` on the inner `<span>` | W5, W7, W11, W12 |
| `.table td.right`, `.table th.right` 297 | `text-right` | pages |
| `.table td.tight` 298 | `w-[1%] whitespace-nowrap` | pages |

### A.5 Pills, chips and stat pills

| Legacy | Replacement | Owner |
|---|---|---|
| `.pill` 305–309 | `shape="pill"` = `inline-flex items-center gap-[5px] px-[9px] py-[2px] rounded-full border border-transparent text-[11px] leading-[18px] whitespace-nowrap font-normal` (**`border-transparent` matters** — W1) | W1 |
| `.pill.green` 310 | `tone="green"` = `border-[color:var(--status-green-line)] bg-[color:var(--status-green-bg)] text-[color:var(--status-green-fg)]` | W1 |
| `.pill.amber` 311 | `tone="amber"`, same shape with `--status-amber-*` | W1 |
| `.pill.violet` 312 | `tone="violet"`, same shape with `--status-violet-*` | W1 |
| `.pill.red` 313 | `tone="red"` = `border-[color:var(--destructive-line)] bg-[color:var(--destructive-bg)] text-[color:var(--destructive-fg)]` | W1 |
| `.pill.grey` 314 | `tone="grey"` = `border-border bg-secondary text-muted-foreground` | W1 |
| `.pill.accent` 315 | `tone="accent"` = `border-[color:var(--primary-soft)] bg-[color:var(--primary-badge-background)] text-primary` | W1 |
| `.chip` 317–321 | `inline-flex items-center gap-[6px] px-[9px] py-[2px] rounded-full border border-[color:var(--status-violet-line)] bg-[color:var(--status-violet-bg)] text-[color:var(--status-violet-fg)] text-[11.5px] leading-[19px]` | W4 (`AgentChip`) |
| `.chip.human` 322 | `border-border bg-secondary text-secondary-foreground` | W4 |
| `.statPills` 324 | `flex flex-wrap gap-[8px]` | pages |
| `.statPill` 325–329 | `inline-flex items-center gap-[7px] px-[11px] py-[5px] rounded-[8px] border border-border bg-card text-[12px] text-secondary-foreground` | W8, W11 |
| `.badge` 137–141 | `inline-grid place-items-center min-w-[20px] h-[18px] px-[6px] rounded-full bg-destructive text-[color:var(--badge-foreground)] text-[11px] font-bold` | W12b |

### A.6 Shell and navigation (W12b unless noted)

| Legacy | Replacement |
|---|---|
| `.shell` 101 + media 457 | `grid grid-cols-[214px_minmax(0,1fr)] min-h-screen max-[900px]:grid-cols-1` |
| `.sidebar` 103–109 + media 458 | `sticky top-0 flex h-screen flex-col gap-[2px] overflow-y-auto border-r border-[color:var(--border-soft)] bg-sidebar px-[10px] pt-[10px] pb-[12px] max-[900px]:static max-[900px]:h-auto max-[900px]:flex-row max-[900px]:flex-wrap` |
| `.projectSwitcher` 111–116 | `flex items-center gap-[9px] w-full p-[8px] mb-[10px] rounded-lg border border-transparent bg-transparent text-left` (stays a raw `<button>`) |
| `.projectSwitcher:hover` 117 | `hover:bg-secondary` |
| `.projectMark` 118–123 | `grid place-items-center flex-none size-[26px] rounded-[7px] bg-primary text-primary-foreground text-[12px] font-bold`; the `style={{width:18,height:18,fontSize:10}}` variant at line 40 → `size-[18px] text-[10px]` |
| `.projectName` 124 | `flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]` |
| `.chevron` 125 | `flex-none text-[color:var(--faint)]` |
| `.navItem` 127–131 | `NAV_ITEM` (W4) = `flex items-center gap-[11px] px-[10px] py-[8px] rounded-lg text-[13px] text-muted-foreground` |
| `.navItem:hover` 132 | `hover:bg-secondary hover:text-secondary-foreground` |
| `.navItem.active` 133 | `bg-accent text-foreground` |
| `.navItem svg` 134 | `[&_svg]:flex-none [&_svg]:opacity-85` |
| `.navItem .count` 135 | `ml-auto` on the count slot — **keep it a slot** (spec §5.7) |
| `.sidebarFoot` 143 + media 459 | `mt-auto grid gap-[2px] pt-[10px] max-[900px]:hidden` |
| `.runnerRow` 144 | `flex items-center gap-[10px] px-[10px] py-[8px] text-[12.5px] text-secondary-foreground whitespace-nowrap` — **keep it one hover-able unit** (spec §5.7) |
| `.runnerRow .state` 145 | `ml-auto text-[color:var(--faint)] text-[11.5px]` |
| `.dot` 146 | `size-[7px] rounded-full bg-[color:var(--faint)]` |
| `.dot.on` 147 | `bg-[color:var(--status-green-fg)] shadow-[0_0_8px_color-mix(in_srgb,var(--status-green-fg)_55%,transparent)]` — **the glow is a declaration, not decoration; rev 1 omitted it** |
| `.dot.off` 148 | `bg-destructive` |
| `.dot.green` 149 | `bg-[color:var(--status-green-fg)]` (no glow) |
| `.dot.amber` 150 | `bg-[color:var(--status-amber-fg)]` |
| `.dot.red` 151 | `bg-[color:var(--destructive-fg)]` |
| `.content` 155 | `min-w-0 bg-popover` |

### A.7 Kanban (W10)

| Legacy | Replacement |
|---|---|
| `.board` 333 | `grid grid-flow-col auto-cols-[minmax(250px,1fr)] gap-[14px] overflow-x-auto pb-[10px]` |
| `.column` 334 | `flex flex-col min-h-[420px]` |
| `.columnHead` 335 | `flex items-center gap-[8px] px-[2px] pt-0 pb-[12px] text-[12.5px] text-secondary-foreground` |
| `.columnBody` 337–341 | `flex-1 grid grid-cols-[minmax(0,1fr)] content-start gap-[10px] p-[10px] rounded-xl border border-[color:var(--border-soft)] bg-[color-mix(in_srgb,var(--foreground)_1%,transparent)]` — **the 1% base tint is the "faint drop region behind every column" the comment at 336 protects; do not drop it** |
| `.columnBody.over` 342 | `border-[color:var(--primary-soft)] bg-[color-mix(in_srgb,var(--primary)_4%,transparent)]` |
| `.columnEmpty` 343 | `px-0 py-[26px] text-center text-[12px] text-[color:var(--faint)]` |
| `.taskCard` 345 | `px-[14px] py-[13px] rounded-xl border border-border bg-card cursor-pointer` |
| `.taskCard:hover` 346 | `hover:border-[color:var(--border-hover)]` |
| `.taskCard h3` 347 | `text-[13px] leading-[1.45]` |
| `.taskCard .meta` 348 | `mt-[9px] grid gap-[6px] text-muted-foreground text-[11.5px]` |
| `.taskCard .metaRow` 349 | `flex flex-wrap items-center gap-[8px]` |
| `.taskCard .foot` 350 | `flex items-center gap-[10px] mt-[10px] text-muted-foreground text-[11.5px]` |
| `.taskCard .foot svg` 351 | `[&_svg]:size-[13px] [&_svg]:flex-none [&_svg]:opacity-85` — note `size-[13px]`, **not** the button base's `[&_svg]:size-4` |
| `.runLine` 352 | `inline-flex items-center gap-[6px]` |
| `.runLine .runName` 353 | `text-primary` |
| `.dot` + tone (32) | the six A.6 dot strings, selected by a `tone`-keyed lookup (**B13** — not a string build) |

### A.8 Inbox (W8)

| Legacy | Replacement |
|---|---|
| `.inboxList` 357 | `grid grid-cols-[minmax(0,1fr)] gap-[10px]` |
| `.inboxItem` 358–362 | `flex gap-[14px] w-full px-[16px] py-[13px] rounded-xl border border-border bg-card text-left cursor-pointer` (stays a raw `<button>`) |
| `.inboxItem:hover` 363 | `hover:border-[color:var(--border-hover)]` |
| `.inboxItem .body` 364 | `flex-1 min-w-0` |
| `.inboxItem .sender` 365 | `flex items-center gap-[8px] text-[12.5px] text-foreground font-bold` |
| `.inboxItem .title` 366 | `flex items-center gap-[8px] mt-[5px] text-foreground text-[13px]` |
| `.inboxItem .summary` 367 | `mt-[4px] overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground text-[12px]` |
| `.inboxItem .side` 368 | `flex-none text-right text-muted-foreground text-[11.5px]` |
| `.inboxItem .side .src` 369 | `mt-[5px] text-[color:var(--faint)]` |
| `.msgCard` 372 | `px-[18px] py-[14px] rounded-xl border border-border bg-card` |
| `.msgCard + .msgCard` 373 | `mt-[12px]` on every card but the first |
| `.msgCard.mine` 374 | `ml-[40px] bg-secondary` |
| `.msgHead` 375 | `flex items-center gap-[8px] mb-[10px] text-secondary-foreground text-[12.5px]` |
| `.msgHead .time` 376 | `ml-auto text-[color:var(--faint)] text-[11.5px]` |
| `.waitBar` 378–382 | `flex items-center gap-[10px] px-[14px] py-[11px] rounded-lg border border-[color:var(--status-amber-line)] bg-[color-mix(in_srgb,var(--status-amber-fg)_5%,transparent)] text-[color:var(--status-amber-fg)] text-[12.5px]` |
| `.choice` 384–388 | `flex items-start gap-[11px] w-full px-[14px] py-[12px] rounded-lg border border-border bg-secondary text-left text-foreground` (stays a raw `<button>`) |
| `.choice:hover` 389 | `hover:border-[color:var(--primary-soft)]` |
| `.choice.on` 390 | `border-primary` |
| `.choice .radio` 391 | `flex-none size-[15px] mt-[2px] rounded-full border border-[color:var(--radio-border)]` |
| `.choice.on .radio` 392 | `border-4 border-primary` — a 4px border, **not** a background fill |
| `.choice .label` 393 | `flex-1 text-[12.5px]` |
| `.choice .hint` 395 | `block mt-[3px]` **on top of** `.field .hint`'s colour/size (A.3) |
| `.choiceList` 394 | `grid grid-cols-[minmax(0,1fr)] gap-[10px]` |

### A.9 Notices, goals, overlays, markdown, event log

| Legacy | Replacement | Owner |
|---|---|---|
| `.empty` 399 | `px-[10px] py-[40px] text-center text-[12.5px] text-[color:var(--faint)]` | W4 |
| `.notice` 401–405 | `flex gap-[10px] px-[14px] py-[11px] rounded-lg border border-border bg-card text-muted-foreground text-[12px] leading-[1.6]` | W4 |
| `.notice.gap` 406 | `border-[color:var(--status-amber-line)] text-[color:var(--status-amber-fg)] bg-[color-mix(in_srgb,var(--status-amber-fg)_5%,transparent)]` | W4 |
| `.notice.error` 407 | `border-[color:var(--destructive-line)] text-[color:var(--destructive-fg)] bg-[color:var(--destructive-bg)]` | W4 |
| `.notice code` 408 | `[&_code]:text-inherit [&_code]:opacity-90` | W4 |
| `.goalCard` 413 | `px-[18px] py-[16px] rounded-xl border border-border bg-card` | W9 |
| `.goalCard + .goalCard` 414 | `mt-[12px]` on every card but the first | W9 |
| `.goalCard .top` 415 | `flex items-center gap-[10px]` | W9 |
| `.goalCard h3` 416 | `text-[1.17em]` — **S4**; the value is relative on purpose | W9 |
| `.goalCard .mid` 417 | `flex justify-between mt-[10px] mb-[8px] text-muted-foreground text-[12px]` | W9 |
| `.goalCard .bottom` 418 | `mt-[9px] text-muted-foreground text-[12px]` | W9 |
| `.overlay` 422 + media 461 | `fixed inset-y-0 right-0 left-[214px] z-40 overflow-y-auto bg-popover max-[900px]:left-0` | W4 |
| `.overlayHead` 423–427 + media 462 | `sticky top-0 z-[1] flex items-center gap-[12px] px-[34px] py-[16px] border-b border-[color:var(--border-soft)] bg-popover max-[900px]:px-[16px]` | W4 |
| `.overlayBody` 428 + media 462 | `max-w-[1020px] px-[34px] pt-[24px] pb-[80px] max-[900px]:px-[16px]` | W4 |
| `.modal` 430 | `w-[min(560px,100%)] max-h-[86vh] overflow-y-auto p-[22px] rounded-[12px] border border-border bg-card shadow-[0_30px_90px_var(--modal-shadow)]` | W4 |
| `.md` 433 | `text-secondary-foreground text-[12.5px] leading-[1.75]` | W4 |
| `.md p` 434 | `mb-[10px] [overflow-wrap:anywhere]` on the `<p>` | W4 |
| `.md ul, .md ol` 435 | `mb-[10px] pl-[22px]` on both | W4 |
| `.md ul` 436 | `list-disc` on the `<ul>` — **S3**, a utility, not a layered rule (spec §5.6) | W4 |
| `.md ol` 437 | `list-decimal` on the `<ol>` | W4 |
| `.md li` 438 | `my-[3px]` | W4 |
| `.md strong` 439 | `text-foreground` | W4 |
| `.md code` 440 | `px-[5px] py-[1px] rounded-[4px] bg-[color:var(--code-background)] text-primary text-[11.5px]` | W4 |
| `.md > :last-child` 441 | `[&>*:last-child]:mb-0` on the root | W4 |
| `.eventLog` 443 | `max-h-[420px] overflow-auto rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--code-background)]` — **the scroll container, a different box from `.eventRow`** | W11 |
| `.eventRow` 444 | `grid grid-cols-[46px_92px_1fr] gap-[10px] px-[12px] py-[7px] border-b border-[color:var(--event-line)] text-[11.5px]` | W11 |
| `.eventRow:last-child` 445 | `[&>*:last-child]:border-b-0` on `.eventLog`, or `last:border-b-0` on the row | W11 |
| `.eventRow .seq` 446 | `text-[color:var(--faint)]` | W11 |
| `.eventRow .type` 447 | `overflow-hidden text-ellipsis text-primary` | W11 |
| `.eventRow .payload` 448 | `overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground` | W11 |

### A.10 Excluded

`.dark` (the dark token block) survives in `styles.css` and is the only class selector A1 permits
after the batch. `.jpg` appears only inside a comment.
