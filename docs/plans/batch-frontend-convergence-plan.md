# PLAN — Batch: frontend convergence onto shadcn/ui and the design tokens

Status: rev 1, first pass · Author: plan agent · Date: 2026-08-16
Spec: [`docs/specs/batch-frontend-convergence.md`](../specs/batch-frontend-convergence.md) (approved).
Planned against branch `agentos/cmsvovk6s004qmpyjn33gyzvi/run-1` at `e28f746`; the code state is `3f712b5`.
Prior art honoured: [`docs/wiki/batch-0-frontend-base.md`](../wiki/batch-0-frontend-base.md),
[`docs/reference/frontend-css-layering.md`](../reference/frontend-css-layering.md).
This is an implementation plan only. No code changes ship with it.

**Every anchor below was re-verified against the working tree.** Where the spec and the code
disagree, §1 says so and the plan follows the code — as the batch brief requires — without
re-specifying anything the spec decided.

---

## 0. Approach summary

Migrate **bottom-up, call sites before the stylesheet**, in 16 work items across five sections:

- **A — capability** (W1–W3): give the primitives the legacy appearance *before* anything depends
  on them. Extend `buttonVariants` / `badgeVariants`, port the legacy geometry into `input.tsx` /
  `textarea.tsx` / `table.tsx`, add the new `select.tsx`. Nothing renders differently yet, because
  the unlayered legacy sheet still wins.
- **B — the keystone** (W4): `components/ui.tsx`, the barrel every page imports. 56 legacy
  references, 33 distinct classes, and the shared vocabulary (`Page`, `Card`, `Pill`, `Toggle`,
  `Markdown`, `Modal`, `FullPanel`, `Field`, …). Migrating it first collapses most of the page work.
- **C — the pages** (W5–W12b): nine commits, smallest first, so the token mapping is calibrated on
  a 21-reference read-only page before it is applied to an 83-reference one.
- **D — the switch** (W13): delete the legacy stylesheet **and** invert the layer test in one
  commit. These are one atomic change; §1 explains why they cannot be split.
- **E — acceptance** (W14–W16): negative control, the mechanical sweep, the manual walks, the PR.

The load-bearing sequencing fact is the mirror image of batch 0's: **while the legacy sheet is
still live and unlayered, a migrated element is styled correctly the moment it stops carrying its
legacy class** (no legacy rule targets it any more, so its utilities apply normally). The exception
is elements styled by the legacy *element* rules — `input`, `select`, `textarea`, `a`, `h1`–`h4` —
which keep legacy geometry until W13. So **form controls cannot be visually verified before W13**,
and the plan does not ask anyone to try.

The interim is deliberately ugly (§4.2). Descendant selectors like `.card > h2`, `.taskCard h3`
and `.kv .k` break as soon as the ancestor's class is removed and stay broken until that page's
own commit. This is expected, it is not a defect, and it must **not** be patched with an inline
style — that is batch 0's failure mode #1 in reverse (spec §8.3). Only the final two commits are
visually meaningful.

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
are unsatisfiable. **The plan replaces the check with a whole-token one**, verified to return `0`
for all 12 stock primitives and to reproduce the spec's own baseline counts exactly
(83/64/**56**/50/48/46/42/25/21/20/8/2 — `ui.tsx` reads 56 against the spec's 57; the difference is
one tokenisation of the `toggle`/`on` template literal at `ui.tsx:125`, not a missed reference):

```sh
# Prints "<count>  <file>" per file. Every count must be 0 at acceptance.
sort docs/specs/legacy-classes.txt > /tmp/legacy-sorted.txt
for f in "$@"; do
  n=$(grep -oE 'className=("[^"]*"|\{`[^`]*`\}|\{[^}]*\})' "$f" \
      | grep -oE '("[^"]*"|`[^`]*`)' \
      | tr -d '"`' | tr ' ' '\n' \
      | grep -vE '^\$\{|^$' \
      | grep -Fxf /tmp/legacy-sorted.txt | wc -l | tr -d ' ')
  echo "$n  $f"
done
```

It extracts `className` attribute values, splits on whitespace, and compares **whole tokens** for
equality. `bg-primary` is not `primary`; `pill` is `pill`. Acceptance A1 (the stylesheet grep) is
unaffected and stands as written.

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

---

## 3. Numbered work items

Conventions: **Files** is exhaustive for intended edits. **Verify** is that item's own check, and
every item additionally keeps `npm run typecheck` and `npm run build -w @agentos/web` green.
`npm test` is green at every commit except the W13 boundary, which §4.3 explains. One commit per
work item unless stated.

---

### Section A — capability (W1–W3)

Appearance is unchanged at the end of this section: the unlayered legacy sheet still wins
everywhere. These items only make the primitives *able* to carry the legacy appearance.

#### W1 — `buttonVariants` and `badgeVariants` gain the legacy variants

Spec §4 rule 3, §5.4. Depends on: nothing.

- `components/ui/button.tsx:7–35` — add to the `cva` config, without changing the existing stock
  variants (they are unused by call sites but are the shadcn vintage batch 1 will upgrade):
  - `variant.legacy` — `.btn`: `border border-border bg-card text-secondary-foreground` +
    `hover:border-[color:var(--border-hover)] hover:bg-secondary hover:text-foreground` +
    `disabled:opacity-45`.
  - `variant.legacyPrimary` — `.btn.primary`: `border border-primary bg-primary
    text-primary-foreground font-bold hover:bg-[color:var(--primary-hover)]
    hover:border-[color:var(--primary-hover)]`.
  - `variant.legacyDanger` — `.btn.danger`: `border-[color:var(--destructive-line)]
    bg-[color:var(--danger-button)] text-[color:var(--danger-button-foreground)] font-bold
    hover:bg-[color:var(--danger-button-hover)]`. **Not** the stock `destructive` variant (§1.4).
  - `variant.icon` — `.iconBtn`: `grid place-items-center border-0 bg-transparent
    text-muted-foreground hover:bg-secondary hover:text-foreground`.
  - `size.legacy` — `h-[34px] gap-[7px] px-[13px] text-[12.5px] rounded-lg whitespace-nowrap`.
  - `size.legacySmall` — `.btn.small`: `h-[28px] gap-[7px] px-[10px] text-[12px] rounded-lg`.
  - `size.legacyIcon` — `.iconBtn`: `size-[28px] rounded-[7px]`.
- `components/ui/badge.tsx:6–24` — add a `tone` variant with the six `.pill` tones, each
  `border-[color:var(--status-<c>-line)] bg-[color:var(--status-<c>-bg)]
  text-[color:var(--status-<c>-fg)]`; `grey` = `border-border bg-secondary text-muted-foreground`;
  `accent` = `border-[color:var(--primary-soft)] bg-[color:var(--primary-badge-background)]
  text-primary`. Add a `shape.pill` variant carrying `.pill`'s geometry:
  `inline-flex items-center gap-[5px] rounded-full border px-[9px] py-[2px] text-[11px]
  leading-[18px] whitespace-nowrap`. Thread both through `badgeVariants({ variant, tone, shape })`
  at `badge.tsx:32` and extend `BadgeProps`. **Keep the literal `"font-normal"` argument** —
  `primitives.test.tsx:18` asserts it appears in the rendered span.
- **Verify:** `npm run typecheck`; `npm run test -w @agentos/web` (after a build) still green —
  in particular `primitives.test.tsx`, which renders `<Pill tone="grey">`.
- **Commit:** `feat(web): legacy button and badge variants on the existing cva configs`.
- **Rollback:** additive only; reverting this file alone is safe until W4 consumes it.

#### W2 — `input.tsx` and `textarea.tsx` carry the legacy geometry

Spec §4, §5.4. Depends on: nothing. Rationale: §1.5.

- `components/ui/input.tsx:10–13` — replace the geometry half of the class string with the legacy
  values: `w-full rounded-lg border border-border bg-[color:var(--surface-input)]
  px-[11px] py-[9px] text-[12.5px] text-foreground outline-0 focus:border-primary`. Drop `h-9`,
  `text-base`, `md:text-sm`, `shadow-sm`. Keep `file:*`, `placeholder:text-muted-foreground`,
  `disabled:cursor-not-allowed disabled:opacity-50`, and the `type = "text"` default at line 6 —
  `input-semantics.test.tsx:12` pins it.
- `components/ui/textarea.tsx:11–14` — same treatment plus `resize-y leading-[1.6]`; drop
  `min-h-[60px]`, `text-base`, `md:text-sm`.
- Neither file has focus-ring parity to preserve: the legacy rule is
  `input:focus { border-color: var(--primary) }`, which `focus:border-primary` reproduces. Keep the
  shadcn `focus-visible:ring-*` classes as they are — they are already live today and removing them
  would be a behaviour change.
- **Verify:** `npm run test -w @agentos/web` green (`input-semantics.test.tsx` covers all three
  assertions). Appearance is unverifiable until W13 (§0) — do not attempt it here.
- **Commit:** `refactor(web): port legacy input and textarea geometry into the primitives`.
- **Rollback:** file-local; safe to revert alone before W13.

#### W3 — new `select.tsx`, and `table.tsx` geometry

Spec §5.4, §4. Depends on: nothing.

- **New `components/ui/select.tsx`** — a native `<select>` wrapper shaped exactly like
  `input.tsx`: `React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>`,
  `cn(…, className)`, spreads props, `Select.displayName = "Select"`, matching the v3-era vintage
  (`React.forwardRef`, no `data-slot`) per spec §7. **No Radix.** Base classes: the same geometry
  as `input.tsx` plus `appearance-none pr-[30px] bg-no-repeat` and the two-gradient chevron ported
  from `styles.css:240`:

  ```
  bg-[image:linear-gradient(45deg,transparent_50%,var(--faint)_50%),linear-gradient(135deg,var(--faint)_50%,transparent_50%)]
  bg-[position:right_14px_top_15px,right_9px_top_15px]
  bg-[size:5px_5px]
  ```

  Note `--fg-faint` → `--faint` (§2.1). **This is guess G1** — if Tailwind does not emit these
  arbitrary values, fall back to a `relative` wrapper `<span>` with an absolutely-positioned
  `lucide-react` `ChevronDown` (`pointer-events-none`), use it for all 12 sites, and record the
  choice in the PR. Do not mix the two forms.
- `components/ui/table.tsx` — port the legacy geometry (§1.5):
  - `Table` (line 12): add `text-[12.5px]`, drop `text-sm`. The existing wrapper `<div
    className="relative w-full overflow-auto">` at line 9 **is** `.tableWrap`; call sites drop
    their own wrapper div rather than nesting a second one.
  - `TableHead` (line 76): `h-auto px-[14px] py-[10px] text-[12px] font-normal
    text-muted-foreground text-left whitespace-nowrap border-b border-[color:var(--border-soft)]`;
    drop `h-10 px-2 font-medium`.
  - `TableCell` (line 91): `px-[14px] py-[13px] align-middle whitespace-nowrap
    text-secondary-foreground border-b border-[color:var(--border-soft)]`; drop `p-2`.
  - `TableRow` (line 61): `hover:bg-[color:var(--row-hover)]`; drop `hover:bg-muted/50`. Keep
    `border-b` off the row (the legacy sheet draws borders on cells, and `TableBody`'s
    `[&_tr:last-child]:border-0` already handles `.table tbody tr:last-child td`).
- **Verify:** `npm run typecheck`; grep the built CSS after the next build for the chevron
  (`grep -c "linear-gradient(45deg" apps/web/dist/assets/*.css` ≥ 1) — that is the G1 check.
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

Per-symbol targets (legacy values read off `styles.css`; the full class-by-class table is
Appendix A):

| Symbol | Line | Change |
|---|---|---|
| `Pill` | 16 | `<Badge variant="outline" tone={tone} shape="pill">` — **B13**: the tone stops being a class-name fragment and becomes a `cva` variant (W1). |
| `AgentChip` | 47–48 | `.chip` → `inline-flex items-center gap-[6px] rounded-full border px-[9px] py-[2px] text-[11.5px] leading-[19px]` + violet tokens; `.chip.human` → `border-border bg-secondary text-secondary-foreground`. |
| `Card` | 57–63 | `ShadCard` is already `rounded-xl border bg-card text-card-foreground` = `.card` exactly; add only `px-[20px] py-[18px]`, and `flush` → `px-0 pt-[18px] pb-0` with the title row taking `px-[20px]`. `cardTitle` → `flex items-center gap-[9px] mb-[14px] text-[13.5px]`. **`primitives.test.tsx:17` pins `shadow-none` in the rendered markup** — do not pass a `shadow-*` that twMerge would drop it for. |
| `KeyValue` | 73–79 | `.kv` → `grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-[40px] gap-y-[16px]`; `three` → 3 cols; `.k` → `text-muted-foreground text-[12px]`; `.v` → `mt-[3px] text-[13px] [overflow-wrap:anywhere]`. |
| `Metric` | 84 | `.metric` → `rounded-xl border border-border bg-card px-[16px] py-[14px]`; `.v` → `mt-[6px] text-[15px] font-bold`. |
| `Segmented` | 93–97 | `.segmented` → `inline-flex gap-[3px] rounded-[9px] border border-[color:var(--border-soft)] bg-card p-[3px]`; buttons `rounded-[7px] px-[13px] py-[6px] text-[12.5px] text-muted-foreground`; `on` → `bg-accent text-foreground`; `accent`+`on` → `bg-primary text-primary-foreground font-bold`. **Keep the two direct `<button>` children** (`primitives.test.tsx:7`). |
| `Tabs` | 107–111 | `.tabs` → `flex w-fit max-w-full gap-[3px] overflow-x-auto rounded-[9px] border border-[color:var(--border-soft)] bg-card p-[3px] mb-[16px]`; buttons `px-[14px] py-[7px]`. Same pin. |
| `Toggle` | 122–128 | **§1.3.** Drop `[&>span]:hidden`. Root: `h-[21px] w-[38px] border-0 data-[state=unchecked]:bg-[color:var(--toggle-background)] data-[state=checked]:bg-primary`. Thumb: `[&>span]:size-[15px] [&>span]:bg-[color:var(--toggle-knob)] [&>span]:data-[state=checked]:bg-[color:var(--toggle-knob-active)] [&>span]:data-[state=checked]:translate-x-[17px] [&>span]:data-[state=unchecked]:translate-x-0`. Legacy knob sits at `top:3px; left:3px` inside a 21px box — the Radix root's `items-center` plus `border-2 border-transparent` should produce that 3px inset; verify visually (**G2**). |
| `Check` | 137–143 | `.check` → `size-[17px] rounded-[4px] border-[color:var(--check-border)] bg-secondary text-primary-foreground`; the checked state is already `data-[state=checked]:bg-primary` in the primitive — add `data-[state=checked]:border-primary`. |
| `EmptyState` | 146 | `.empty` → `px-[10px] py-[40px] text-center text-[12.5px] text-[color:var(--faint)]`. |
| `GapNotice` / `ErrorNotice` | 151, 159–161 | `.notice` → `flex gap-[10px] rounded-lg border border-border bg-card px-[14px] py-[11px] text-[12px] leading-[1.6] text-muted-foreground`; `gap` → amber tokens + `bg-[color-mix(in_srgb,var(--status-amber-fg)_5%,transparent)]` (**G3**); `error` → destructive tokens. The Retry button becomes `<Button variant="legacy" size="legacySmall">`. `.notice code` → `[&_code]:text-inherit [&_code]:opacity-90`. **Copy stays byte-identical** (spec §7, no i18n). |
| `ShowMore` | 170–174 | `.longText` → `text-secondary-foreground text-[12.5px] leading-[1.75] whitespace-pre-wrap [overflow-wrap:anywhere]`; `.clamped` → the `-webkit-box` clamp. **Keep the existing `WebkitLineClamp` inline style**: it is dynamic (`lines` prop), not a cascade escape hatch, so it is not one of the nine in §2.5. |
| `RowMenu` | 184 | The trigger `.iconBtn` → `<Button variant="icon" size="legacyIcon">`; `.menuWrap` → `relative`. **Keep both `stopPropagation` handlers** (`row-menu.test.tsx`). |
| `Markdown` | 214–215, 237 | **§5.6.** `<ul className="list-disc …">`, `<ol className="list-decimal …">`, both `mb-[10px] pl-[22px]`; `<li className="my-[3px]">`; `.md` root → `text-secondary-foreground text-[12.5px] leading-[1.75]`; `<p className="mb-[10px] [overflow-wrap:anywhere]">`; `<strong className="text-foreground">`; `<code>` → `rounded-[4px] bg-[color:var(--code-background)] px-[5px] py-[1px] text-[11.5px] text-primary`. `.md > :last-child { margin-bottom: 0 }` → `[&>*:last-child]:mb-0` on the root. |
| `Label` | 240 | `.dim` → `text-muted-foreground`. |
| `Modal` | 251–254 | `.modal` → `w-[min(560px,100%)] max-h-[86vh] overflow-y-auto rounded-[12px] border border-border bg-card p-[22px] shadow-[0_30px_90px_var(--modal-shadow)]`. **Keep `max-w-none gap-0`** (spec §8.5). `DialogTitle` takes the `cardTitle` string; `DialogFooter` keeps `mt-[18px] justify-end` and gains `flex items-center gap-[10px]` (was `.row`). |
| `FullPanel` | 266–273 | `.overlay` → `fixed inset-y-0 right-0 left-[214px] z-40 overflow-y-auto bg-popover max-[900px]:left-0`; `.overlayHead` → `sticky top-0 z-[1] flex items-center gap-[12px] border-b border-[color:var(--border-soft)] bg-popover px-[34px] py-[16px] max-[900px]:px-[16px]`; `.overlayBody` → `max-w-[1020px] px-[34px] pt-[24px] pb-[80px] max-[900px]:px-[16px]` + the `STACK` utilities. **§2.5:** `<h1 style={{fontSize:16}}>` → `className="text-[16px]"`. Cancel button → `<Button variant="legacy" size="legacy">`. |
| `Field` | 278–281 | `.field` → `grid grid-cols-[minmax(0,1fr)] gap-[6px]`; `<label>` → `text-secondary-foreground text-[12.5px]`; `.hint` → `text-[color:var(--faint)] text-[11.5px] leading-[1.5]`. |

Also export the three highest-traffic layout strings so the pages do not each invent them:
`STACK = "grid grid-cols-[minmax(0,1fr)] gap-[16px]"`, `ROW = "flex items-center gap-[10px]"`,
`ROW_WRAP = "flex flex-wrap items-center gap-[8px]"`.

- **Verify:** whole-token check on `ui.tsx` → `0`; `npm run test -w @agentos/web` green with
  `primitives.test.tsx` and `row-menu.test.tsx` **unmodified**; by hand,
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

> whole-token check on the file → `0`; `npm run typecheck` and `npm run build -w @agentos/web`
> green; `npm run test -w @agentos/web` green; the page renders with no leftover unstyled region
> (spec §8.10 — a stale `className="row"` is silently broken layout, not an error, and only the
> grep catches it).

| # | File | Refs | Work beyond the Appendix A mapping | Depends on |
|---|---|---:|---|---|
| **W5** | `pages/Connections.tsx` | 21 | `tableWrap`+`table` (35–36, 67–68) → `<Table>` with **no wrapper div** (W3). `.pill grey` on a `Link` (52) → `cn(badgeVariants({variant:"outline",tone:"grey",shape:"pill"}))`. | W1–W4 |
| **W6** | `pages/Secrets.tsx` | 20 | 1 `<select>` (48) → `<Select>`. `Table` at 97 already imported; drop `tableWrap`/`table`. 3 `.btn` → `<Button>`. | W3, W4 |
| **W7** | `pages/Projects.tsx` | 42 | **Zero prior migration.** 2 raw `<table>` (75, 163) → `Table`; 6 raw `<button>` (29, 30, 66, 182, 185, 186) → `Button`; 2 raw `<input type="text">` (36, 39) → `<Input type="text">` — **keep the explicit type** (§1.6); 1 raw `<textarea rows={14}>` (194) → `Textarea`. 3 `.btn` on `<Link>` (133–135) → `className={buttonVariants({variant:"legacy",size:"legacy"})}`. | W1–W4 |
| **W8** | `pages/Inbox.tsx` | 64 | **Zero prior migration.** 5 raw `<button>` (52, 187, 195, 196, 201) → `Button` where it is a button (`legacyPrimary`/`legacyDanger` at 195/196) and a plain styled `<button>` for `.inboxItem` (52) and `.choice` (187), which are full-width cards, not buttons — keep the `<button>` host, carry the utilities. 1 raw `<textarea rows={5}>` (200) → `Textarea`. `<h1 style={{fontSize:18}}>` (132) → `text-[18px]`. `.statPill` on `Link` ×2 (138–139). | W1–W4 |
| **W9** | `pages/Goals.tsx` | 48 | **S4:** `.goalCard h3 { font-size: 1.17em }` → explicit `text-[1.17em]` on the heading (109 block). `<Progress className="progressTrack">` ×2 (118, 172) → `className="h-[8px] bg-accent"`; `progress.tsx` stays unchanged (B14) and twMerge resolves `h-2`/`bg-primary/20` (§2.3). 1 `<select>` (58) → `Select`. `.pill green`/`.pill grey` ternary (199) → `tone={item.done ? "green" : "grey"}` via `Pill`. | W1–W4 |
| **W10** | `pages/Tasks.tsx` | 46 | **B13:** `` className={`dot ${tone}`} `` (32) → a `tone`-keyed lookup, not a string build. Kanban: `.board` (288) → `grid grid-flow-col auto-cols-[minmax(250px,1fr)] gap-[14px] overflow-x-auto pb-[10px]`; `.columnBody`/`.over` ternary (295) → two utility strings, `over` = `border-[color:var(--primary-soft)] bg-[color-mix(in_srgb,var(--primary)_4%,transparent)]` (**G3**). 5 `<select>` (156, 162, 170, 206, 213) → `Select`. **§2.5:** `style={{alignItems:"flex-start"}}` (60) → `items-start`; `style={{gap:6}}` (77) → `gap-[6px]`, **not** `gap-1.5` (§1.2). **Also deletes `styles.test.tsx:44–52`** — see §4.3. | W1–W4 |
| **W11** | `pages/TaskDetail.tsx` | 50 | 1 `<select>` (144) → `<Select className="w-[130px]">`, dropping `style={{width:130}}`. `style={{background:"var(--surface-run-detail)"}}` (50) → `bg-[color:var(--surface-run-detail)]`. `.eventLog`/`.eventRow` (23) → `grid grid-cols-[46px_92px_1fr] gap-[10px] px-[12px] py-[7px] border-b border-[color:var(--event-line)] text-[11.5px]`. `Table` at 201 already imported; drop `tableWrap`/`table`. 5 `.statPill`. | W1–W4 |
| **W12** | `pages/Agents.tsx` | 83 | Largest, but no new patterns: `row`(10), `hint`(9), `stack`(8), `btn`(7), `fieldRow`(6). 4 `<select>` (66, 76, 202, 453) → `Select`. `Table` at 143/358 already imported; drop both `tableWrap`/`table` pairs. `.codeBlock` ×2. Lines 125/399 already read `className="page text-foreground"` → `<Page className="text-foreground">`. | W1–W4 |

#### W12b — `App.tsx`, `Shell.tsx`, `goal-limit-inputs.tsx`

The chrome, 35 references. Its own commit, immediately after W12.

- `App.tsx` (8 refs; 38, 48, 67) — `.page` → `<Page className="pb-0">` at 38/48, dropping
  `style={{paddingBottom:0}}` (§2.5); `.notice error` → the `ErrorNotice` utilities.
- `Shell.tsx` (25 refs) — carries most of **S5**:
  - `.shell` (65) → `grid grid-cols-[214px_minmax(0,1fr)] min-h-screen max-[900px]:grid-cols-1`.
  - `.sidebar` (66) → `sticky top-0 flex h-screen flex-col gap-[2px] overflow-y-auto border-r
    border-[color:var(--border-soft)] bg-sidebar px-[10px] pt-[10px] pb-[12px]
    max-[900px]:static max-[900px]:h-auto max-[900px]:flex-row max-[900px]:flex-wrap`.
  - `.sidebarFoot` (77) → `mt-auto grid gap-[2px] pt-[10px] max-[900px]:hidden`.
  - `.projectSwitcher`/`.projectMark`/`.projectName`/`.chevron` (31–34);
    `style={{width:18,height:18,fontSize:10}}` (40) → `size-[18px] text-[10px]` (§2.5).
  - `.navItem` ×3 (70, 83, 84) → the exported `NAV_ITEM` string (W4, spec §5.7). **Keep the
    right-aligned `.count`/`.badge` slot (73) as a slot**, and keep the runner row (78–82) a
    single hover-able unit — spec §5.7 constrains this so batch 1 and batch 5 can extend them.
  - `.dot on/off` ternary (79) → three utility strings.
  - `.content` (89) → `min-w-0 bg-popover`.
- `goal-limit-inputs.tsx` (2 refs) — `.fieldRow` ×2 →
  `grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-start gap-[14px]`. **Do not touch the
  four `<Input type="number">` calls**; `input-semantics.test.tsx:22` pins their `min`/`step`.
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
  `luminance()`, `contrast()`, and the 14 contrast pairs. `git diff master -- …styles.test.tsx`
  must show no change from the `lightBlock` declaration to EOF.
- The five inline-style pins at 44–52 are already gone by then — see §4.3.

- **Verify:** `npm run build -w @agentos/web` **then** `npm run test -w @agentos/web`; A1
  (`grep -oE '^\s*\.[A-Za-z][A-Za-z0-9_-]*' apps/web/src/styles.css | sort -u` returns only
  `.dark`); A4 (`git diff` on lines 26–64 of `styles.css` is empty); the file is under ~100 lines;
  `grep -c "max-width: *900px" apps/web/dist/assets/*.css` ≥ 1 (S5 survived as arbitrary variants).
- **Commit:** `refactor(web)!: delete the legacy stylesheet and invert the layer regression test`.
- **Rollback:** §8. This commit is the batch's point of no return; reverting it alone restores 126
  unlayered rules that now beat the migrated utilities, which is worse than either end state.

---

### Section E — acceptance (W14–W16)

#### W14 — the mechanical sweep

- Run the whole-token check (§1.1) over all 12 files **plus** `main.tsx`, `icons.tsx`,
  `secret-value-input.tsx` and every file in `components/ui/`; every count must be `0`.
- Run A1–A9, B13–B17, C1–C6 from the spec's checklist.
- B17: `grep -rnE 'bg-\[#|text-\[#|border-\[#|\[rgb' apps/web/src` returns nothing.
- B16: no new `.css` file, no `<style>` tag, no `@layer legacy`.
- **Open decision (§7, Q-1):** whether the corrected checker is committed or lives only in the PR
  description. Default is **PR description only**, consistent with spec assumption 7.

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
- **E5** before/after screenshots for Agents, Tasks (board), Inbox, Projects.
- **Rem-scale eyeball** (spec §8.7): confirm at the first screenshot that nothing rescaled by 16/13.
- PR description must carry: the D1–D4 gate outputs and the **new test count** with the delta
  accounted for against the 59-test baseline at `3f712b5`; the §6.4 command order; the W15 negative
  control; every §4-rule-4 accepted appearance delta with before/after values; the G1 chevron
  choice; and the "pages I find ugly" list (spec §11 — **record, do not act**).

---

## 4. Order, commits, and the two things that will look like breakage

### 4.1 Commit map

16 work items, 14 commits, strictly serial, single implementer:

```
W1  button/badge variants          ─┐
W2  input/textarea geometry         │ Section A — no visual change
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

W1–W3 are mutually independent and could be one commit; they are three because W3 adds a file and
W2 touches the two primitives most likely to need a revisit after the first visual pass.

### 4.2 The interim is ugly, and that is correct

Between W4 and W13 the app renders in a mixed state: descendant rules (`.card > h2`, `.taskCard h3`,
`.kv .k`, `.inboxItem .body`, `.table .name`) lose their subject as soon as the ancestor's class is
removed, so an unmigrated page inside a migrated `Card` shows unstyled headings. **Do not fix this
with an inline style or a temporary class** — spec §8.3. It resolves at that page's own commit.

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

Without this, `npm test` is red from W10 to W13 for a reason unrelated to the work in flight.

### 4.4 Build before test, always

`styles.test.tsx:8–11` reads `apps/web/dist/assets/*.css` and throws if the directory is empty —
and `apps/web/dist/` **does not exist in a fresh checkout** (verified). It also does not detect a
*stale* artifact, which spec §6.4 leaves open on purpose. So every verification in this plan means:

```sh
npm run build -w @agentos/web && npm run test -w @agentos/web
```

Never `npm test` alone after a CSS edit.

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
| §6.3 | Contrast test and four pinned test files unmodified | W13 (constraint), §2.4 |
| §6.4 | Build-before-test ordering in the PR | §4.4, W16 |
| §2.5 | 8 of 9 compatibility inline styles removed | W4 ×1, W8, W10 ×2, W11 ×2, W12b ×3 |
| §2.3 | Three interpolation sites migrated at the signature | W4 ×2, W10 ×1 |
| §4 | Appearance preserved via tokens / arbitrary values / cva variants | §2.1–2.2, W1, Appendix A |
| §9.A | A1–A9 | W13, W14 |
| §9.B | B1–B17 | W14 (**with the §1.1 corrected check**) |
| §9.C | C1–C7 | W13, W14, W15 |
| §9.D | D1–D4 | W16 |
| §9.E | E1–E5 | W16 |
| §11 | "Pages I find ugly" list recorded, not acted on | W16 |

Every spec requirement maps to a numbered item. Nothing in §7 (out of scope) is planned.

---

## 6. Where this plan is guessing

Flagged explicitly, because the executioner will hit these and should not treat them as settled.

- **G1 — the `<select>` chevron as arbitrary background utilities.** The two-gradient string in W3
  is a plausible Tailwind v4 arbitrary value (underscores for spaces, balanced parens, top-level
  commas), but it has not been compiled. **Check:** after the first build,
  `grep -c "linear-gradient(45deg" apps/web/dist/assets/*.css`. If 0, take the documented lucide
  fallback and use it for all 12 sites.
- **G2 — the Toggle knob inset.** Legacy puts a 15px knob at `top:3px; left:3px` inside a 21px
  track via a pseudo-element. The Radix thumb is a flex child of a root with `border-2
  border-transparent` and `items-center`, which *should* land in the same place. Not verifiable
  without rendering. Compare against a pre-batch screenshot of the Agents detail toggles.
- **G3 — `color-mix()` inside an arbitrary value.** Four sites need it (`.notice.gap`, `.waitBar`,
  `.columnBody`, `.columnBody.over`). `bg-[color-mix(in_srgb,var(--x)_5%,transparent)]` is the
  intended form. Same dist-grep check as G1; the fallback is a plain token background, which is an
  accepted §4-rule-4 delta and must then be listed in the PR.
- **G4 — shadcn `Table` geometry parity.** W3 ports the padding, font size and hover colour, but
  `border-collapse` is not in the primitive (legacy `.table` sets it) and the stock `caption-bottom`
  stays. If cell borders double up, add `border-collapse` on the `Table` base and note it.
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

## 7. Decisions this plan made, and open questions

Neither question blocks execution. Per the chain's standing rule they are recorded here and in the
task activity log rather than sent to the human, and the plan proceeds on the stated default.

**P-1 — `Page` becomes a component (decided).** `.page` has 25 call sites across 9 files and
carries the §5.5 responsive padding. Inlining a six-utility string 25 times guarantees drift. Spec
§5.7 already prefers a component over "eleven bespoke utility strings" for the analogous
`.navItem`. *Overturning cost: low — replace `<Page>` with `<div className={PAGE}>`; the string is
exported either way.*

**P-2 — `input.tsx` / `textarea.tsx` / `table.tsx` are edited (decided).** Forced by §4's
appearance rule; see §1.5. *Overturning cost: high — the alternative is a visible geometry change
on every form and table in the app, which this stage forbids.*

**Q-1 — Is the corrected acceptance check a plan artifact or a repo artifact?** Default: PR
description only, per spec assumption 7. Committing it as `docs/plans/legacy-class-check.sh` or an
npm script would make B1–B12 re-runnable at any future review, at the cost of one new file in a
batch that is trying not to add infrastructure. **Leo's call at the gate.**

**Q-2 — Spec assumptions 2 and 4 are the reversible-at-this-gate pair.** The spec names them as the
two whose reversal would change the plan's shape. This plan is built on both holding (native
`<select>` in W3; arbitrary-value appearance preservation throughout §2 and Appendix A). Reversing
assumption 4 — "converge onto shadcn's stock geometry instead" — would delete most of Appendix A,
W2, and W3's table work, and shrink the batch by roughly a third, at the cost of a
different-looking app. **If that is wanted, it must be said at this gate, not later.**

---

## 8. Rollback

### 8.1 Per section

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
restores `3f712b5` exactly. Blast radius is `apps/web/src/**` plus one new file
(`components/ui/select.tsx`). No API surface, no persisted data, no runner behaviour, so there is
no forward-fix obligation and no window in which a revert loses anything. If part of the batch
needs undoing, revert everything and re-land.

---

## 9. Migrations and restarts

**None.** No Prisma schema change, no enum change, no migration, no `db:generate`, no seed change,
no service restart, no launchd change. `packages/**` is untouched (spec §7). The only build
artifact that matters is `apps/web/dist/`, and the only ordering requirement is §4.4.

---

## Appendix A — legacy class → replacement

The classes that appear more than twice, or that carry a value easy to get wrong. The rest are
single-property: `.dim` → `text-muted-foreground`, `.faint` → `text-[color:var(--faint)]`,
`.strong` → `text-foreground`, `.nowrap` → `whitespace-nowrap`, `.small` → `text-[11.5px]`,
`.spacer` → `flex-1`, `.clickable` → `cursor-pointer`, `.mine` → `ml-[40px] bg-secondary`,
`.tight` → `w-[1%] whitespace-nowrap`, `.right` → `text-right`, `.flush` → see `Card`. Read every
value as **arbitrary px** unless noted (§1.2).

| Legacy | Replacement | Owner |
|---|---|---|
| `.page` | `max-w-[1240px] px-[34px] pt-[26px] pb-[80px] max-[900px]:px-[16px] max-[900px]:pt-[20px] max-[900px]:pb-[60px]` | `Page`, W4 |
| `.stack` | `grid grid-cols-[minmax(0,1fr)] gap-[16px]` | `STACK`, W4 |
| `.row` | `flex items-center gap-[10px]` | `ROW`, W4 |
| `.rowWrap` | `flex flex-wrap items-center gap-[8px]` | `ROW_WRAP`, W4 |
| `.pageHead` | `flex items-start gap-[20px] mb-[18px]`; `h1` `text-[22px] tracking-[-.01em]`; `.titles` `flex-1 min-w-0`; `.subtitle` `mt-[5px] text-[12.5px] text-muted-foreground` | pages |
| `.detailHead` | `flex items-center gap-[12px] mb-[18px]`; `h1` `text-[20px]` | pages |
| `.backLink` | `inline-flex items-center gap-[8px] text-[12.5px] text-muted-foreground hover:text-foreground` | pages |
| `.pageActions` | `flex items-center gap-[9px]` | pages |
| `.toolbar` | `flex items-center gap-[10px] mb-[16px]` | pages |
| `.btn` / `.primary` / `.danger` / `.small` | `Button variant="legacy\|legacyPrimary\|legacyDanger" size="legacy\|legacySmall"` | W1 |
| `.iconBtn` | `Button variant="icon" size="legacyIcon"` | W1 |
| `.pill` + tone | `Badge shape="pill" tone=…` | W1, W4 |
| `.card` / `.cardTitle` | `px-[20px] py-[18px]` on the stock `Card`; title `flex items-center gap-[9px] mb-[14px] text-[13.5px]` | W4 |
| `.count` | `inline-grid place-items-center min-w-[20px] h-[19px] px-[6px] rounded-[6px] bg-accent text-[11.5px] text-muted-foreground` | W4 |
| `.badge` | `inline-grid place-items-center min-w-[20px] h-[18px] px-[6px] rounded-full bg-destructive text-[color:var(--badge-foreground)] text-[11px] font-bold` | W12b |
| `.navItem` / `.active` | `flex items-center gap-[11px] px-[10px] py-[8px] rounded-lg text-[13px] text-muted-foreground hover:bg-secondary hover:text-secondary-foreground [&_svg]:flex-none [&_svg]:opacity-85` + active `bg-accent text-foreground`; the `.count` slot keeps `ml-auto` | `NAV_ITEM`, W4/W12b |
| `.field` / `.fieldRow` | `grid grid-cols-[minmax(0,1fr)] gap-[6px]` / `grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] items-start gap-[14px]` | W4, W12b |
| `.hint` | `text-[11.5px] leading-[1.5] text-[color:var(--faint)]` | W4 |
| `.table` / `.tableWrap` | the `Table` primitive and **its own** wrapper div — drop both classes and the outer `<div>` | W3 |
| `.statPill` | `inline-flex items-center gap-[7px] px-[11px] py-[5px] rounded-[8px] border border-border bg-card text-[12px] text-secondary-foreground` | pages |
| `.metrics` / `.metric` | `grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-[14px]` / `rounded-xl border border-border bg-card px-[16px] py-[14px]` | W4 |
| `.kv` / `.k` / `.v` / `.three` | see the W4 table | W4 |
| `.codeBlock` | `max-h-[460px] overflow-auto rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--code-background)] px-[16px] py-[14px] text-[12px] leading-[1.65] text-secondary-foreground whitespace-pre-wrap [overflow-wrap:anywhere]` | W11, W12 |
| `.empty` | `px-[10px] py-[40px] text-center text-[12.5px] text-[color:var(--faint)]` | W4 |
| `.notice` / `.gap` / `.error` | see the W4 table | W4 |
| `.overlay` / `.overlayHead` / `.overlayBody` / `.modal` | see the W4 table | W4 |
| `.md` and children | see the W4 table (`list-disc` / `list-decimal` on the JSX) | W4 |
| `.toggle` / `.check` | see the W4 table (§1.3 for the knob) | W4 |
| `.progressTrack` | `h-[8px] bg-accent` on `<Progress>`; the primitive stays unchanged | W9 |
| `.goalCard` | `rounded-xl border border-border bg-card px-[18px] py-[16px]`; `h3` `text-[1.17em]`; `+ .goalCard` → `mt-[12px]` on the sibling | W9 |
| `.board` / `.column` / `.columnHead` / `.columnBody` / `.over` / `.columnEmpty` / `.taskCard` | see W10 | W10 |
| `.inboxList` / `.inboxItem` and children / `.unreadDot` / `.msgCard` / `.msgHead` / `.waitBar` / `.choice` / `.choiceList` / `.radio` | see W8 | W8 |
| `.eventLog` / `.eventRow` / `.seq` / `.type` / `.payload` | see W11 | W11 |
| `.shell` / `.sidebar` / `.sidebarFoot` / `.content` / `.projectSwitcher` / `.projectMark` / `.projectName` / `.chevron` / `.runnerRow` / `.dot` + states | see W12b | W12b |
| `.segmented` / `.tabs` / `.on` / `.accent` | see the W4 table | W4 |
| `.longText` / `.clamped` / `.showMore` | see the W4 table | W4 |
| `.chip` / `.human` | see the W4 table | W4 |
