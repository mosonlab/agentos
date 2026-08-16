# SPEC — Batch: frontend convergence onto shadcn/ui and the design tokens

Status: draft for approval. Written against `master` at `3f712b5` (2026-08-16).

Prior art you must read before planning: [`docs/wiki/batch-0-frontend-base.md`](../wiki/batch-0-frontend-base.md)
(the failure-mode field guide is not optional reading — this batch walks straight into four of
its five traps) and [`docs/reference/frontend-css-layering.md`](../reference/frontend-css-layering.md).
Decisions source: [`docs/reference/danny-agentos-video/decisions.md`](../reference/danny-agentos-video/decisions.md) §3.
Backlog home: [`docs/BACKLOG-V2.md`](../BACKLOG-V2.md).

---

## 1. Problem and audience

Batch 0 introduced Tailwind v4 and shadcn/ui into `apps/web` but deliberately stopped half way.
It left the 463-line hand-written `apps/web/src/styles.css` in place with all of its class
selectors **unlayered**, as a compatibility surface. Under CSS cascade-layer rules a normal
declaration outside every layer beats a normal declaration inside any layer, regardless of
specificity — and Tailwind emits its utilities (including every shadcn class) inside
`@layer utilities`. So the legacy stylesheet sits on top of the new design system and silently
wins every property it declares. The existing regression test
`apps/web/src/tests/styles.test.tsx:38-53` asserts that state as if it were the intended
end state.

The user-visible consequence, and the reason Leo raised this on 2026-08-16, is that the app does
not look like one product. Adoption of the new primitives is very uneven (§2.4): `Agents.tsx`
has 52 shadcn element usages, `Inbox.tsx` / `Connections.tsx` / `Projects.tsx` have none and
still render raw `<table>` / `<button>` / `<input>` styled only by the legacy sheet. Two styling
systems are live at once and the older one is the one that wins.

**Audience.** Leo, the single self-hosted operator, is the end user of the result. The direct
consumers of this document are the plan agent and the executioner for this batch, and the
reviewer at the PR gate.

**This is stage one of two.** This stage is *convergence only*: finish the migration so that the
shadcn/ui primitives and the Tailwind v4 design tokens are the only styling mechanism in
`apps/web`. Stage two — reworking the visual language itself — is unscheduled and out of scope;
Leo decides on it after this merges. Everything in this spec is mechanical and enumerable by
design, and it contains no aesthetic judgement. That is the point.

---

## 2. Verified starting state

Every number below was re-measured against `3f712b5`. Where it disagrees with the task brief, the
measurement here is the one to plan against and the disagreement is called out.

### 2.1 What `apps/web/src/styles.css` actually contains

463 lines, four distinct things:

| Lines | Contents | Fate |
|---|---|---|
| 1–2 | `@import "tailwindcss"`, `@custom-variant dark` | **Survives verbatim** |
| 4–20 | `@theme inline` token bridge (24 colour roles + 5 radius/font) | **Survives verbatim** |
| 22–24 | Provenance comment | Survives |
| 26–45 | `:root` — the light design tokens | **Survives verbatim, and must stay the first `:root` in the file** (§5.3) |
| 47–64 | `.dark` — the dark design tokens | **Survives verbatim** |
| 66–75 | Second `:root` — legacy variable *aliases* (`--ink-0..5`, `--fg*`, `--line*`, `--accent-hi/ink/soft`, colour-word aliases, `--radius-ctl`) | **Deleted** — dead once the legacy rules go (§2.3) |
| 77–84 | Root typography (`font-family`, `font-size: 13px`, `line-height`, `color`, `background`, font smoothing) | **Relocated into `@layer base`** (§5.1) |
| 87–97 | Element base: `*` box-sizing, `body`, form-control font inheritance, `a`, `h1`–`h4`, three `::-webkit-scrollbar` rules | **Relocated into `@layer base`** (§5.1) |
| 99–232 | Legacy class rules — shell, content, controls | **Deleted** |
| 233–240 | Form element rules (`input[type=…]`, `select`, `textarea`, plus the hand-drawn `select` chevron) | **Deleted** — behaviour moves into the `Input` / `Textarea` / `Select` primitives (§5.4) |
| 242–455 | Legacy class rules — cards, tables, pills, kanban, inbox, misc | **Deleted** |
| 456–463 | `@media (max-width: 900px)` restyling six legacy classes | **Deleted** — behaviour moves to `max-[900px]:` utilities (§5.5) |

Target size after the batch: roughly 75–85 lines. **"Delete the legacy stylesheet" does not mean
deleting the file** — the Tailwind entry point and the tokens are the design system.

### 2.2 The selector count

`grep -oE '\.[A-Za-z][A-Za-z0-9_-]*' apps/web/src/styles.css | sort -u` returns **128** distinct
`.name` tokens. Two of them are not legacy class selectors:

- `.dark` — the dark token block, which survives; and
- `.jpg` — a substring of the filename `new-task-modal-blank-t0600.jpg` inside the comment at
  line 421.

**The real figure is 126 legacy class selectors.** The brief's 128 counts those two. The
authoritative list is Appendix A, materialised as `docs/specs/legacy-classes.txt` (one name per
line) so the acceptance greps in §9 are runnable as written. Acceptance is measured against that
list, not against the raw grep.

### 2.3 Which files reference them

Legacy class tokens found inside `className` string literals (template-literal interpolations
resolved by hand — see the note below):

| File | Lines | Legacy class refs |
|---|---:|---:|
| `pages/Agents.tsx` | 511 | 83 |
| `pages/Inbox.tsx` | 217 | 64 |
| `components/ui.tsx` | 283 | 57 |
| `pages/TaskDetail.tsx` | 224 | 50 |
| `pages/Goals.tsx` | 234 | 48 |
| `pages/Tasks.tsx` | 319 | 46 |
| `pages/Projects.tsx` | 199 | 42 |
| `components/Shell.tsx` | 92 | 25 |
| `pages/Connections.tsx` | 96 | 21 |
| `pages/Secrets.tsx` | 143 | 20 |
| `App.tsx` | 80 | 8 |
| `components/goal-limit-inputs.tsx` | 29 | 2 |
| **12 source files** | | **466** |
| `tests/styles.test.tsx` | 103 | 3 (pins, removed by §6) |

**Two corrections to the brief.** `components/ui/dialog.tsx` and `components/ui/progress.tsx`
carry **zero** legacy class references. `progress.tsx` is pure Tailwind. `dialog.tsx`'s only
non-utility reference is `bg-[color:var(--scrim)]`, and `--scrim` is a *surviving* token from the
light/dark blocks, not a legacy alias. Both files are therefore untouched by this batch, and the
acceptance checklist must not demand edits to them. Similarly, `components/ui/input.tsx` and
`textarea.tsx` contain the string `md:text-sm` — a Tailwind breakpoint variant, not the legacy
`.md` class. **The file set is 12, not 15.**

**Interpolated class names.** Three call sites build a legacy class name at runtime, and a naive
per-name grep will under-count them:

- `components/ui.tsx:16` — `` className={`pill ${tone}`} `` with `tone ∈ {green, amber, violet, red, grey, accent}`
- `components/ui.tsx:125` — `` className={`${on ? "toggle on" : "toggle"} [&>span]:hidden`} ``
- `pages/Tasks.tsx:32` — `` className={`dot ${tone}`} ``

Each of these reaches a legacy modifier class that never appears as a literal token next to its
base class. They must be migrated too.

**Legacy variable aliases are already dead in TSX.** Every `var(--…)` used from a `.tsx` file
resolves to a surviving token: `--scrim` (dialog), `--border-soft` (Agents ×5, Goals ×1),
`--status-violet-fg` (Agents), `--surface-run-detail` (TaskDetail), `--destructive-fg` (Tasks).
None of the `--ink-*` / `--fg-*` / `--line*` aliases is referenced from TSX, which is why the
alias block at 66–75 can be deleted outright once the legacy rules go. This is a claim the plan
must re-verify, not assume.

### 2.4 How uneven adoption actually is

shadcn element usages counted as `<Name` occurrences for names imported from `components/ui/*`:

| File | shadcn usages | Raw elements still styled by the legacy sheet |
|---|---:|---|
| `pages/Agents.tsx` | 52 | 4 × `<select>` |
| `pages/TaskDetail.tsx` | 29 | 1 × `<select>` |
| `pages/Secrets.tsx` | 22 | 1 × `<select>` |
| `pages/Goals.tsx` | 12 | 1 × `<select>` |
| `pages/Tasks.tsx` | 9 | 5 × `<select>` |
| `components/Shell.tsx` | 4 (DropdownMenu) | 2 × `<button>` |
| `components/goal-limit-inputs.tsx` | 4 (`Input`) | — |
| `pages/Projects.tsx` | 0 | `<table>`, 6 × `<button>`, 2 × `<input>`, `<textarea>` |
| `pages/Connections.tsx` | 0 | `<table>` |
| `pages/Inbox.tsx` | 0 | 5 × `<button>`, `<textarea>` |
| `App.tsx` | 0 | — |
| `components/ui.tsx` | 0 direct; wraps `Badge`/`Card`/`Checkbox`/`Dialog`/`DropdownMenu`/`Switch` | 6 × `<button>` |

The brief cites "Inbox 2, Connections 3, Projects 4". Under the measure above those three pages
are at **zero** direct usages — what they import is `components/ui.tsx`, the local wrapper barrel,
and those wrappers are themselves legacy-classed — `Pill` renders a shadcn `Badge` and then
puts `pill <tone>` on it.
The brief's characterisation — those three pages are the least migrated — is correct; the specific
numbers are not reproducible and should not be used as acceptance figures.

**There are 12 shadcn primitives in `components/ui/`, not 13**: badge, button, card, checkbox,
dialog, dropdown-menu, input, progress, switch, table, tabs, textarea. There is **no Select
primitive**, which is the single largest gap this batch has to close (§5.4).

### 2.5 Inline styles

Ten `style={{…}}` sites exist outside `tests/`. One is functional and stays; nine exist only
because of the cascade problem.

| Site | Declaration | Disposition |
|---|---|---|
| `components/ui/progress.tsx:20` | `transform: translateX(-N%)` | **Keep** — this is data, not styling |
| `App.tsx:38`, `App.tsx:48` | `paddingBottom: 0` on `.page` | Becomes `pb-0`; `.page` is gone so the utility now wins |
| `components/Shell.tsx:40` | `width/height: 18, fontSize: 10` on `.projectMark` | Becomes `size-[18px] text-[10px]` |
| `pages/Tasks.tsx:60` | `alignItems: "flex-start"` on `.row` | Becomes `items-start` |
| `pages/Tasks.tsx:77` | `gap: 6` on `.row` | Becomes `gap-1.5` |
| `pages/TaskDetail.tsx:144` | `width: 130` on a raw `<select>` | Becomes `w-[130px]` on the `Select` primitive |
| `components/ui.tsx:268` | `fontSize: 16` on an overlay `<h1>` | Becomes `text-[16px]` |
| `pages/Inbox.tsx:132` | `fontSize: 18` on a detail `<h1>` | Becomes `text-[18px]` |
| `pages/TaskDetail.tsx:50` | `background: var(--surface-run-detail)` | Becomes `bg-[color:var(--surface-run-detail)]` |

The first eight of the nine are exactly batch 0's failure mode #1 — inline style used as an
escape hatch because a layered utility could not beat an unlayered legacy class. Once the legacy
class is gone the utility wins normally and the escape hatch is dead weight. The last one is a
token reference and could be expressed either way; the arbitrary-value utility is preferred for
consistency with `dialog.tsx`.

### 2.6 The rem trap — read this before sizing anything

`:root { font-size: 13px }` (line 78) is live today. **`rem` is relative to the root font size**,
so every Tailwind size utility in this app already resolves against 13px, not 16px:
`text-sm` = 11.375px, `h-9` = 29.25px, `p-4` = 13px. The shadcn primitives are already rendering
on that compressed scale.

Two consequences:

1. **`font-size: 13px` must survive with its value unchanged**, relocated but not altered.
   Changing it rescales every utility in the application at once.
2. Do not reason about legacy-vs-utility geometry from the Tailwind documentation's px table.
   Measure. `.btn` is `height: 34px; font-size: 12.5px`; shadcn `Button` default is
   `h-9 text-sm` = 29.25px / 11.375px at this root size. They are close but not equal, and §4
   governs what to do about that.

---

## 3. Intended behaviour, in concrete scenarios

These are the observable outcomes a reviewer can check. Numbers are stated so they are falsifiable.

**S1 — the built stylesheet has no unlayered class rules.**
After `npm run build -w @agentos/web`, the emitted `dist/assets/*.css` contains no style rule
that (a) sits outside every `@layer` and (b) has a class selector and (c) declares at least one
non-custom-property. `.dark{--background:…}` still exists unlayered and is still allowed, because
it declares only custom properties. `.flex` and every other utility is still inside
`@layer utilities`.

**S2 — nothing in the app changes tokens.**
The `:root` and `.dark` blocks are byte-identical to `3f712b5`. The 14 existing WCAG contrast
assertions in `styles.test.tsx` pass unmodified. This is the mechanical proof that the batch
touched mechanism and not design.

**S3 — markdown lists still show markers.**
A message body containing `- item` and `1. item` still renders discs and decimals. Preflight's
`ol,ul,menu{list-style:none}` is still in `@layer base`; the markers now come from
`list-disc` / `list-decimal` utilities in `@layer utilities`, which beat `base`. No unlayered
rule is involved. See §5.6 for why this is the chosen resolution.

**S4 — Goals card headings keep their size.**
`.goalCard h3 { font-size: 1.17em }` was a third preflight restoration (batch 0 failure mode #3),
alongside the two markdown ones, and the brief does not mention it. After the batch the `h3` in a
goal card carries an explicit size utility and renders at the same size.

**S5 — the ≤900px layout still collapses.**
At a 900px-or-narrower viewport the sidebar stops being a sticky 214px column and becomes a
wrapping horizontal row, the sidebar footer hides, the page padding drops to `20px 16px 60px`,
and the New Task overlay covers the full viewport instead of insetting 214px from the left. This
is currently the `@media (max-width: 900px)` block at 456–463 and it is the easiest thing in this
batch to delete by accident, because the six classes it targets are also declared elsewhere.

**S6 — every form control is a primitive.**
No page renders a bare `<input>`, `<textarea>`, `<select>`, `<table>` or `.btn`-classed `<button>`
that depends on a stylesheet rule to look right. Projects and Connections render shadcn `Table`;
Projects, Inbox and `ui.tsx` render shadcn `Button`; all 12 `<select>` sites render the new
`Select` primitive (§5.4).

**S7 — behaviour is unchanged.**
Same routes, same polling, same click targets, same keyboard behaviour, same DOM host elements
where batch 0's `primitives.test.tsx` and `row-menu.test.tsx` pin them, same explicit `type`
attributes where `input-semantics.test.tsx` pins them. All four of those test files pass
unmodified. If a migration requires changing one of them, that is a signal the migration changed
behaviour — stop and reconsider, do not edit the test.

---

## 4. The appearance rule (the one real judgement call)

This batch says "no visual redesign" and simultaneously replaces the rules that produce every
pixel. Those two cannot both be absolute, so the rule is stated once here and applies everywhere:

> **Preserve the rendered appearance. Express it with the existing tokens, existing utilities, or
> a new `cva` variant on an existing primitive. Never with a new token, a new scale, or a new
> stylesheet rule.**

Concretely, in priority order:

1. If the legacy value maps onto an existing token or a stock utility, use it.
   `background: var(--ink-3)` → `bg-card`. `border: 1px solid var(--line)` → `border border-border`.
   `color: var(--fg-dim)` → `text-muted-foreground`.
2. If it does not map cleanly, keep the legacy value as an arbitrary-value utility:
   `h-[34px]`, `text-[12.5px]`, `gap-[9px]`. This is not a new design token — it is the existing
   value, relocated.
3. If a legacy class had variants (`.btn` / `.btn.primary` / `.btn.danger` / `.btn.small`,
   `.pill.{green,amber,violet,red,grey,accent}`, `.segmented.accent`, `.notice.{gap,error}`),
   add them as variants on the corresponding existing primitive's `cva` config rather than
   scattering the same arbitrary values across call sites. Extending `buttonVariants` and
   `badgeVariants` is in scope; adding a new component library is not.
4. Where an exact match is genuinely impossible or would cost an unreadable pile of arbitrary
   values, accept the nearest existing utility, and **list the site in the PR description** with
   the before/after value. A short, enumerated list of accepted deltas is acceptable output; a
   silent drift is not.

**Adding a `Select` primitive is explicitly in scope** (§5.4) because the batch deletes the rules
that currently style `<select>` and there is no primitive to take over. It is a native `<select>`
wrapper, not a Radix Select — see §5.4 for why.

---

## 5. Required changes, by mechanism

### 5.1 `apps/web/src/styles.css` — final shape

One file. No new stylesheet, no new import in `main.tsx`. Final structure, in this order:

```
@import "tailwindcss";
@custom-variant dark (…);            /* unchanged */

@theme inline { … }                  /* unchanged, all 29 mappings */

/* provenance comment */

:root { …light tokens… }             /* unchanged, byte-for-byte, and FIRST */
.dark { …dark tokens… }              /* unchanged, byte-for-byte */

@layer base {
  html { font-family; font-size: 13px; line-height: 1.5; color; background;
         font-synthesis; -webkit-font-smoothing; text-rendering }
  * { box-sizing: border-box }
  body { margin: 0; min-height: 100vh; background }
  button, input, textarea, select { font: inherit; color: inherit }
  button { cursor: pointer }
  a { color: var(--link); text-decoration: none }
  h1, h2, h3, h4 { margin: 0; font-weight: 700 }
  ::-webkit-scrollbar { … }
  ::-webkit-scrollbar-thumb { … }
  ::-webkit-scrollbar-track { … }
}
```

Notes the plan must honour:

- **`@layer base`, not unlayered.** Tailwind v4's `@import "tailwindcss"` declares the layer
  order `theme, base, components, utilities`. An `@layer base` block written *after* the import
  appends to `base` and therefore comes later in source order than preflight — so it still beats
  preflight, exactly as today, while now correctly *losing* to utilities. That is the whole point
  of the batch, applied to the base rules too: an unlayered `h1 { font-weight: 700 }` would beat a
  `font-normal` utility and reintroduce the bug in a smaller form.
- **`html`, not `:root`.** The typographic declarations move onto `html` so that `:root` in the
  source file unambiguously means "the light token block". The contrast test parses the source
  with `/:root\s*\{([^}]+)\}/` and takes the **first** match (§5.3); keeping a second `:root` in
  the file is a trap for whoever next reorders it. `html` and `:root` match the same element and
  nothing competes with these declarations, so the behaviour is identical.
- **Alias substitution in the surviving rules.** Three surviving base rules currently consume
  aliases that are being deleted. Substitute the canonical token, which has the identical value:
  `--blue` → `--link`, `--ink-0` → `--background`, `--fg` → `--foreground`. `--scrollbar` is a
  real token and stays as it is.
- The form-control block (233–240) does **not** survive. See §5.4.

### 5.2 The 12 source files

Per file the target is: **zero references to any of the 126 names in Appendix A**, and no new
unlayered CSS. Order of work is a plan concern, not a spec concern, but two observations:

- `components/ui.tsx` (57 refs, 33 distinct classes, and the barrel every page imports) is the
  keystone. Migrating it first collapses a large share of the page-level work, because
  `Pill`/`Card`/`Notice`/`EmptyState`/`Markdown`/`Segmented`/`Toggle`/`Modal`/`Overlay`/`KV`/`Metric`
  are already the shared vocabulary. Migrating it last means doing the same work twice.
- `Connections.tsx`, `Inbox.tsx` and `Projects.tsx` were left at "zero migration diff" by batch 0
  on the theory that they'd be rewritten later (`docs/wiki/batch-0-frontend-base.md`, "Page
  tiers"). They are still scheduled for rewrites — Connections in the long tail, Inbox in batch 3,
  Projects later. **They are still in scope here.** The acceptance criterion is zero legacy class
  references across the app, and a rewrite that is not scheduled is not a reason to leave a live
  dependency on a deleted stylesheet. Do the mechanical migration; a later rewrite will replace it
  and that is fine.

### 5.3 What must not move

`apps/web/src/tests/styles.test.tsx:65` reads the **source** file and executes
`/:root\s*\{([^}]+)\}/.exec(source)?.[1]`, taking the first `:root` block, and the 14 contrast
assertions read tokens out of it. The light token block must therefore remain (a) in
`apps/web/src/styles.css`, (b) syntactically a `:root { … }` rule, (c) the first such rule in the
file, and (d) free of nested braces (the regex is `[^}]+`, so wrapping it in `@layer` would break
the parse). These constraints are the reason §5.1 puts the token blocks before the `@layer base`
block and moves the typography onto `html`.

### 5.4 The `Select` gap

12 raw `<select>` elements exist (Tasks ×5, Agents ×4, TaskDetail ×1, Secrets ×1, Goals ×1). They
are styled entirely by the unlayered element rule at 233–240, including a hand-drawn chevron built
from two `linear-gradient` background images. Deleting that rule with no replacement leaves 12
unstyled native dropdowns.

**Add `apps/web/src/components/ui/select.tsx`: a thin wrapper around the native `<select>`**,
shaped like the existing `input.tsx` — `React.forwardRef`, `cn(…, className)`, spreads props —
carrying the current appearance as utilities plus the chevron as an arbitrary
`bg-[image:…]` / `bg-[position:…]` set (or an absolutely-positioned `lucide-react` chevron inside a
relative wrapper, if that reads better; either is acceptable, pick one and use it for all 12).

**Do not install Radix Select.** It replaces the native control with a portalled listbox: different
DOM, different keyboard model, different mobile behaviour, and it walks directly into batch 0
failure mode #4 (generated internal chrome that no legacy selector neutralises) and failure mode #5
(portalled content escaping its wrapper's event handling). That is component work with real
behavioural risk, and this batch is supposed to be mechanical. Marked as an assumption in §10.

The same reasoning applies to the `input[type=…]` and `textarea` rules in the same block: their
call sites already have `Input` and `Textarea` primitives, so the rules are simply deleted and the
remaining raw `<input>` / `<textarea>` sites in `Projects.tsx` and `Inbox.tsx` are converted.
**Every converted `<input>` must carry an explicit `type`** — batch 0 failure mode #2, guarded by
`input-semantics.test.tsx`, which will fail if this is missed.

### 5.5 The responsive block

`@media (max-width: 900px)` at 456–463 restyles `.shell`, `.sidebar`, `.sidebarFoot`, `.page`,
`.overlay`, `.overlayHead`, `.overlayBody`. Tailwind's stock `md` breakpoint is 768px, not 900px,
so these become **arbitrary max-width variants**: `max-[900px]:grid-cols-1`,
`max-[900px]:static`, `max-[900px]:h-auto`, `max-[900px]:flex-row`, `max-[900px]:flex-wrap`,
`max-[900px]:hidden`, `max-[900px]:p-…`, `max-[900px]:inset-0`, `max-[900px]:px-4`. An arbitrary
variant is not a new breakpoint token; do **not** add a `--breakpoint-*` theme entry, which would
be a new design token.

### 5.6 Markdown, and the deliberate preflight exceptions

There are three preflight-restoration rules, not two:

- `styles.css:436` — `.md ul { list-style: disc }`
- `styles.css:437` — `.md ol { list-style: decimal }`
- `styles.css:416` — `.goalCard h3 { font-size: 1.17em }`

The brief asks for a decision on the markdown pair: stay unlayered, move into a layer with
explicit ordering, or become component styles. **Decision: component styles.** The `Markdown`
component in `components/ui.tsx:207` constructs its own `<ul>` / `<ol>` / `<li>` / `<p>` /
`<strong>` / `<code>` nodes in JSX, so the marker type can be a `list-disc` / `list-decimal`
utility on the element itself. Utilities live in `@layer utilities`, which beats preflight's
`@layer base` — so the behaviour is preserved by ordinary cascade order with no exception, no
unlayered rule, and no special case in the layer graph.

This is strictly better than the alternatives: keeping them unlayered contradicts the batch's own
acceptance criterion, and putting them in `@layer base` would leave them tied with preflight and
decided by source order — a fragile ordering dependency for something that has a clean utility
answer. The same treatment applies to `.goalCard h3`, which becomes an explicit size utility on
the heading.

### 5.7 What this batch must not make harder

`docs/reference/danny-agentos-video/detail-gaps.md` §1 and §11 are attached to this batch for one
reason, and it is not styling: **neither section contains a single 🟡/❌ row about appearance.**
Every open row in them is a missing feature or a missing field —

- §1: 15 sidebar nav items vs our 7; project-level aggregate unread badge on the switcher; the
  7-field Runner hover card (`1 of 1 runner online`, runner name, `Busy`, last heartbeat, daemon
  version, CLI version, disk free); `Sign out`.
- §11: an agent `Status` (draft/published) column; `Your Agents` / `System Agents` grouping;
  per-tool toggles (`Bash/Read/Write/Edit/Glob/Grep/Web fetch/Web search`); the
  `AgentOS Foundation` block's version badge and `Read-only` label.

All of those belong to **batch 1** and **batch 5** and are out of scope here (§7). They are
attached as a *constraint on how* this batch migrates, not as work: **do not change page
structure or information architecture in a way that makes those rows harder to land later.**

Practically, that means: keep the sidebar a list of nav items that a 16th item can join without
restructuring; keep the nav-item shape able to carry a right-aligned count/badge slot
(`.navItem .count` today) and keep the project switcher able to carry one too; keep the Runner
footer row a hover-able unit that can grow into a hover card rather than fusing it into the
sidebar chrome; keep the Agents list a real table whose column set can be extended by one column
and whose rows can later be split into two labelled groups; keep the Foundation block a distinct
region that can take a version badge and a `Read-only` label. Concretely: migrate `.navItem` to a
nav-item component or a shared class string, not to eleven bespoke utility strings inlined per
item.

---

## 6. The test change

`apps/web/src/tests/styles.test.tsx` has four tests. Two change, two must pass untouched.

### 6.1 Invert the layer test — and generalise it

Today, `styles.test.tsx:38-53` asserts the *bug*: that `.row`, `.page`, `.projectMark` and
`select` are unlayered while `.flex` is in `utilities`, plus five literal source pins on inline
styles in `App.tsx`, `Shell.tsx`, `Tasks.tsx` and `TaskDetail.tsx`. All of that goes.

The replacement must be **general** — it must fail on *any* new unlayered class selector, not on a
list of four names a future change can sidestep. Required shape:

> Walk every top-level (layer-depth-zero) style rule in the built CSS. A rule is a **violation**
> if its selector contains a class token *and* it declares at least one property that is not a CSS
> custom property. Assert the violation list is empty, and report the offending selectors in the
> failure message.

The "declares only custom properties" carve-out is what admits `.dark { --background: …; … }`
without needing a name allowlist. Prefer that predicate over any hard-coded exemption list; if an
allowlist is unavoidable it must be empty at merge and commented with why an entry would ever be
added.

Two companion assertions keep the parser honest, because a parser bug that finds zero rules would
otherwise make this test vacuously green:

- `.flex{` is still inside `["utilities"]` (retained from the current test).
- The walker finds a non-zero number of unlayered rules overall (`.dark` and `:root` at minimum),
  proving it is actually reading the file.

The existing `layersAt()` helper at `styles.test.tsx:13-30` already does layer-depth tracking and
should be reused rather than rewritten.

**Negative control is required, matching batch 0's practice.** The implementer must demonstrate —
in the PR description, not in committed code — that temporarily re-adding a single unlayered rule
such as `.row { display: flex }` to `styles.css` turns this test red, and that removing it turns
it green again.

### 6.2 Rewrite the markdown test around utilities

`styles.test.tsx:55-63` currently asserts that preflight's list reset is in `base` and that
`.md ul{list-style:outside}` / `.md ol{list-style:decimal}` are unlayered. Under §5.6 those
selectors no longer exist. The replacement asserts the same *behaviour* through the new mechanism:

- preflight's `ol,ul,menu{list-style:none}` is still in `["base"]` (unchanged assertion);
- the `list-disc` and `list-decimal` utilities exist in the built CSS and are in `["utilities"]`;
- `renderToStaticMarkup(<Markdown text={"- a\n\n1. b"} />)` emits a `<ul>` carrying `list-disc`
  and an `<ol>` carrying `list-decimal`.

The third assertion is the one that actually prevents a regression, and it follows the bench
convention in `docs/wiki/batch-0-frontend-base.md` ("use SSR markup for attribute/DOM contract
changes"). Put it in `styles.test.tsx` next to the layer assertions, or in `primitives.test.tsx`
if that reads better — either is acceptable.

### 6.3 Must pass unmodified

- The token-contrast test in `styles.test.tsx:81-103` and its 14 surface pairs. **This is the
  mechanical proof that the design tokens were not altered.** If a token value changes, it either
  fails or it passes for a different reason — in both cases the batch has left its scope. Do not
  touch it, and do not touch the `token()` / `luminance()` / `contrast()` helpers at lines 65–79
  that it uses.
- `input-semantics.test.tsx`, `primitives.test.tsx`, `row-menu.test.tsx`, `storage.test.tsx`.
  These pin the batch-0 behavioural contracts (explicit input types, direct-button group
  structure, `section`/`span` hosts, portalled-menu event isolation). A migration that requires
  editing one of them has changed behaviour; treat that as a stop signal, not a test to update.

### 6.4 Build/test ordering

`styles.test.tsx:8-11` reads `apps/web/dist/assets/*.css` and throws
`"Build apps/web before running CSS regression tests"` if the directory is empty. It does **not**
detect a *stale* artifact — a bare `npm test` after a CSS edit asserts against the previous build
and produces a false green or a false red. This is already logged as an open repair item in
`docs/BACKLOG-V2.md` ("平台修缮", the `styles.test.tsx` entry).

This batch **keeps** the dist-reading approach and the explicit ordering, and does not fix the
staleness gap — making the test self-building or source-reading is a test-infrastructure change
that would obscure the diff this batch exists to produce. The backlog item stays open. Recorded as
an assumption in §10.

The required order is therefore, and must appear in the PR description:

```sh
npm run build -w @agentos/web     # must run first — the CSS tests parse dist/assets/*.css
npm run test -w @agentos/web
```

and repository-wide:

```sh
npm run typecheck
npm run build
npm test
```

---

## 7. Explicitly out of scope

- **No visual redesign.** No new design tokens, no changed token values, no new spacing or type
  scale, no new colour, no new component library, no `tw-animate-css`. §4 governs the boundary
  between "preserving appearance" and "changing it".
- **No information-architecture change.** Same pages, same routes, same sections, same fields,
  same copy, same order. If a page is ugly in a way only a redesign fixes, note it in §11 and
  leave it ugly.
- **No feature work from detail-gaps §1/§11.** Sidebar expansion to 15 items, the project-level
  unread badge, the Runner hover card's 7 fields, `Sign out`, the Agents `Status` column, per-tool
  toggles, System Agents grouping, and the `AgentOS Foundation` version/read-only labels are
  batch 1 and batch 5. §5.7 constrains how this batch migrates so those stay easy; it does not
  authorise any of them.
- **No shadcn generation-vintage upgrade.** Batch 0 shipped v3-era templates
  (`React.forwardRef` + `React.ElementRef`, no `data-slot`, `h-4 w-4` not `size-4`). Upgrading
  them is an explicit batch 1 line item in `docs/BACKLOG-V2.md`. New code written in this batch
  should match the existing vintage so batch 1 upgrades one generation, not two.
- **No Radix Select, no new Radix dependency.** §5.4.
- **No backend, API, schema, migration, or runner change.** `packages/**` is untouched.
- **No `@layer legacy`.** `docs/reference/frontend-css-layering.md` describes wrapping the legacy
  segment in a layer as the option to consider "when a later batch is ready to migrate the whole
  component surface systematically". This batch does the migration and deletes the segment
  instead, which is the stronger form of the same move and does not leave a compatibility layer
  behind to reason about. Do not add one as a shortcut for an unfinished file.
- **No fix for the stale-dist test-ordering gap.** §6.4.
- **No i18n, no copy changes.** Batch 1.

---

## 8. Edge cases and failure behaviour

Ordered by how likely they are to be missed.

1. **A dynamically-built class name is missed.** §2.3 lists the three interpolation sites. A
   per-name grep will show `pill`, `dot` and `toggle` as migrated while `green`/`amber`/`violet`/
   `red`/`grey`/`accent`/`on`/`off` still flow through as tone arguments. Migrate the *function
   signature*, not just the literal.
2. **The ≤900px media block is dropped silently.** Its six classes are also declared in the main
   body of the sheet, so migrating those classes reads as "done" while the responsive collapse is
   gone. Nothing in the automated bench catches this. It needs a manual narrow-viewport check.
3. **An inline style is removed before its legacy class is.** During a partial migration, removing
   `style={{ alignItems: "flex-start" }}` while `.row{align-items:center}` still exists reverts the
   layout — batch 0 failure mode #1, in reverse. Within a file, delete the class reference and the
   inline style in the same edit.
4. **A converted `<input>` loses its `type`.** `Projects.tsx` has two raw inputs and a textarea.
   Dropping `type="password"` silently unmasks a value. Guarded by `input-semantics.test.tsx`;
   it will fail, which is the intended failure behaviour.
5. **A shadcn primitive's internal defaults become visible.** Batch 0 failure mode #4: once no
   legacy rule targets an internal node, generated defaults (`bg-muted h-9 p-1` on `TabsList`,
   `max-w-lg gap-4` on dialog content) apply normally. The existing wrappers already neutralise
   the known cases with `max-w-none gap-0`; **do not remove a neutralisation because it looks
   redundant** — it becomes load-bearing precisely when the legacy sheet goes away.
6. **A portalled menu regains its bubbling bug.** Batch 0 failure mode #5. `RowMenu` stops
   propagation on `DropdownMenuContent`. Guarded by `row-menu.test.tsx`.
7. **The rem scale shifts.** If `font-size: 13px` is dropped or moved somewhere it no longer
   applies to the root element, every `rem`-based utility in the app rescales by 16/13 at once.
   Nothing in the bench catches this; it needs an eyeball at the first screenshot.
8. **The contrast test's `:root` regex latches onto the wrong block.** §5.3. Failure mode is
   *confusing*, not silent: `missing light token --foreground`.
9. **Dark mode drifts.** Every colour decision must go through a token that has both a light and a
   dark value. An arbitrary colour literal (`bg-[#252116]`) is a defect even though it is
   "just moving an existing value" — the existing value was already token-backed. Arbitrary
   *geometry* values are fine (§4, rule 2); arbitrary *colour* literals are not.
10. **A page is left half-migrated.** The build and the type-checker stay green with a mix of
    legacy classes and utilities, and the inverted layer test only proves the *stylesheet* is
    clean, not that no dead class strings remain. A leftover `className="row"` after the rules are
    deleted is a silently broken layout, not an error. The per-file grep in §9 is the guard.

**Overall failure behaviour**: every failure mode above degrades to a *visual* defect, not a data
or availability defect. No API contract, no persisted data, and no runner behaviour is in the
blast radius. That is what makes §12 a clean revert.

---

## 9. Acceptance criteria — reviewer checklist

Mechanical. Each line is checkable by running something or reading a diff.

**A. The stylesheet**

- [ ] A1 — `apps/web/src/styles.css` contains none of the 126 class selectors in Appendix A.
      `grep -oE '^\s*\.[A-Za-z][A-Za-z0-9_-]*' apps/web/src/styles.css | sort -u` returns only `.dark`.
- [ ] A2 — Lines 1–2 (`@import "tailwindcss"`, `@custom-variant dark`) are unchanged.
- [ ] A3 — The `@theme inline` block is unchanged, all 29 mappings present.
- [ ] A4 — The `:root` light block and the `.dark` block are unchanged **byte for byte**, and
      `:root` is still the first `:root` rule in the file and contains no nested braces.
- [ ] A5 — The legacy alias block (old lines 66–75) is gone, and no `.tsx` file references
      `--ink-*`, `--fg`, `--fg-2`, `--fg-dim`, `--fg-faint`, `--line`, `--line-soft`,
      `--accent-hi`, `--accent-ink`, `--accent-soft`, `--green-*`, `--amber-*`, `--violet-*`,
      `--red*`, `--blue`, or `--radius-ctl`.
- [ ] A6 — The root typography survives on `html` inside `@layer base`, with
      **`font-size: 13px` unchanged**.
- [ ] A7 — The element base rules (`*`, `body`, form font inheritance, `a`, `h1`–`h4`, the three
      scrollbar pseudo-elements) survive inside `@layer base`, with `--blue`→`--link`,
      `--ink-0`→`--background`, `--fg`→`--foreground` substituted.
- [ ] A8 — The form-control block (old 233–240) and the `@media (max-width: 900px)` block
      (old 456–463) are both gone.
- [ ] A9 — The file is under ~100 lines and contains no unlayered rule other than `:root`,
      `.dark`, and the `@theme` / `@custom-variant` at-rules.

**B. The source files** — for each of the 12, zero references to any Appendix A name:

```sh
# from the repo root; expected output: nothing
grep -nE "className=[^>]*\b($(paste -sd'|' docs/specs/legacy-classes.txt))\b" \
  apps/web/src/App.tsx apps/web/src/components/Shell.tsx \
  apps/web/src/components/ui.tsx apps/web/src/components/goal-limit-inputs.tsx \
  apps/web/src/pages/*.tsx
```

- [ ] B1 — `pages/Agents.tsx` — 0 (was 83)
- [ ] B2 — `pages/Inbox.tsx` — 0 (was 64)
- [ ] B3 — `components/ui.tsx` — 0 (was 57)
- [ ] B4 — `pages/TaskDetail.tsx` — 0 (was 50)
- [ ] B5 — `pages/Goals.tsx` — 0 (was 48)
- [ ] B6 — `pages/Tasks.tsx` — 0 (was 46)
- [ ] B7 — `pages/Projects.tsx` — 0 (was 42)
- [ ] B8 — `components/Shell.tsx` — 0 (was 25)
- [ ] B9 — `pages/Connections.tsx` — 0 (was 21)
- [ ] B10 — `pages/Secrets.tsx` — 0 (was 20)
- [ ] B11 — `App.tsx` — 0 (was 8)
- [ ] B12 — `components/goal-limit-inputs.tsx` — 0 (was 2)
- [ ] B13 — The three interpolation sites (`ui.tsx:16`, `ui.tsx:125`, `Tasks.tsx:32`) no longer
      build a class name from a tone/state argument.
- [ ] B14 — `components/ui/dialog.tsx` and `components/ui/progress.tsx` are **unchanged** (they
      had no legacy references to begin with).
- [ ] B15 — Eight of the nine compatibility inline styles are gone (§2.5); `progress.tsx:20`'s
      functional `transform` remains.
- [ ] B16 — No new `.css` file, no new `<style>` tag, no `@layer legacy`, no new unlayered rule
      anywhere in `apps/web`.
- [ ] B17 — No arbitrary colour literal (`bg-[#…]`, `text-[rgb(…)]`) was introduced; every colour
      goes through a token.

**C. The tests**

- [ ] C1 — `styles.test.tsx`'s layer test asserts **zero unlayered class rules that declare a
      non-custom-property**, generally — no four-name list, no non-empty allowlist.
- [ ] C2 — The companion assertions are present: `.flex{` is in `["utilities"]`, and the walker
      reports a non-zero total rule count.
- [ ] C3 — The five inline-style source pins (old lines 44–52) are removed.
- [ ] C4 — The markdown test asserts preflight in `["base"]`, `list-disc`/`list-decimal` in
      `["utilities"]`, and SSR markup carrying those utilities.
- [ ] C5 — The token-contrast test and its helpers are **byte-identical** to `master`:
      `git diff master -- apps/web/src/tests/styles.test.tsx` shows no change from the
      `lightBlock` declaration to end of file.
- [ ] C6 — `input-semantics.test.tsx`, `primitives.test.tsx`, `row-menu.test.tsx`,
      `storage.test.tsx` are unmodified.
- [ ] C7 — The PR description records the negative control: re-adding one unlayered class rule
      turns the new assertion red.

**D. The gates**

- [ ] D1 — `npm run build -w @agentos/web` succeeds.
- [ ] D2 — `npm run test -w @agentos/web` is green, **run after D1**.
- [ ] D3 — `npm run typecheck` is green across all six workspaces.
- [ ] D4 — `npm run build && npm test` is green repo-wide. Baseline at `3f712b5` is 59 tests;
      the count may change as tests are rewritten — the PR states the new number and accounts for
      the delta.

**E. Manual, because no test covers them**

- [ ] E1 — A narrow-viewport (≤900px) walk: sidebar collapses to a wrapping row, sidebar footer
      hidden, page padding reduced, overlay full-bleed (S5).
- [ ] E2 — Light and dark, on every one of the 8 pages plus the New Task overlay and a modal.
- [ ] E3 — Markdown with `-` and `1.` lists renders markers (S3); a Goals card `h3` is visibly
      larger than its body text (S4).
- [ ] E4 — All 12 `<select>` sites render styled, with a chevron, and open normally.
- [ ] E5 — Screenshots before/after for at least Agents, Tasks (board), Inbox, Projects — the two
      most-migrated and the two least-migrated pages. Any accepted appearance delta (§4, rule 4)
      is listed with its before/after value.

---

## 10. Assumptions

Every ambiguity in the brief was resolved to the simplest reading. Each choice is recorded here so
it can be overturned cheaply at the gate.

1. **`styles.css` stays a single file.** The tokens and the Tailwind entry point stay where they
   are rather than being split into `tokens.css` + `base.css`. Simplest reading; also the only one
   that leaves the contrast test's source path (`../styles.css`) untouched. *Overturning cost:
   low, but it forces a `styles.test.tsx` edit in the region §6.3 says must not change.*
2. **A native-`<select>` wrapper, not Radix Select** (§5.4). Radix is real component work with
   behavioural risk in a batch that is supposed to be mechanical. *Overturning cost: high — it
   becomes component work with its own test surface, and probably belongs in batch 1 alongside the
   shadcn vintage upgrade.*
3. **Markdown markers become utilities on the JSX, not layered CSS** (§5.6). Chosen because it
   satisfies "no unlayered CSS" and "zero legacy class selectors" simultaneously, with a stronger
   test than the one it replaces. *Overturning cost: low.*
4. **Appearance is preserved with arbitrary-value utilities and new `cva` variants where no token
   maps cleanly** (§4). The alternative reading — "converge onto shadcn's stock geometry" — would
   change how the app looks, which this stage forbids. *This is the assumption most worth Leo's
   attention: it decides whether the app looks the same after this batch or slightly different
   everywhere.*
5. **Extending `buttonVariants` / `badgeVariants` is not "a new design token."** It relocates
   existing values into the primitive that owns them. *Overturning cost: low, but the alternative
   is the same values repeated at ~40 call sites.*
6. **Connections, Inbox and Projects are migrated now** despite scheduled future rewrites (§5.2).
   Leaving them would leave live references to deleted CSS. *Overturning cost: high — it would
   defeat the batch's single acceptance criterion.*
7. **The stale-`dist` test-ordering gap is not fixed here** (§6.4); the backlog item stays open.
   *Overturning cost: low, but it adds test-infrastructure churn to a diff that is already large.*
8. **Base element rules move into `@layer base` rather than staying unlayered** (§5.1). The brief
   only names the 126 class selectors, but leaving `h1 { font-weight: 700 }` unlayered would
   reintroduce the same bug at smaller scale. *Overturning cost: low; it would mean the app keeps
   a small unlayered surface, and since the §6.1 assertion only flags class selectors it would
   still pass — which is exactly why this is written down rather than left implicit.*
9. **`@media (max-width: 900px)` becomes `max-[900px]:` arbitrary variants, not a new theme
   breakpoint** (§5.5). A `--breakpoint-*` entry in `@theme` would be a new design token.
   *Overturning cost: low.*
10. **The batch is one PR on one branch**, not one PR per page. The acceptance criterion is
    app-wide and a partial merge leaves the app broken (§12). *Overturning cost: high.*

**No open questions block the plan step.** Nothing here requires an answer before planning starts;
assumptions 2 and 4 are the two whose reversal would change the plan's shape, and both are
reversible at the plan gate.

---

## 11. Follow-ups (noted, not done)

- **Stage two — the visual language.** Unscheduled. Leo decides after this merges. Anything that
  looks wrong rather than *works* wrong belongs there.
- **The stale-`dist` ordering gap** in `styles.test.tsx` — already in `docs/BACKLOG-V2.md`
  ("平台修缮"); untouched here (§6.4).
- **shadcn vintage upgrade to v4-era templates** — batch 1, already logged.
- **Pages the implementer finds ugly.** Record them in the PR description, page by page, with the
  specific complaint. That list is the input to stage two, and this batch is the only pass over
  every page in `apps/web` before it. Do not act on the list.
- **`docs/reference/frontend-css-layering.md` and `docs/wiki/batch-0-frontend-base.md` become
  partly obsolete** when this merges — the layering contract's central claim ("legacy rules are
  deliberately unlayered") stops being true, and the failure-mode guide's #1 and #3 lose their
  subjects. Updating them is step ⑧ (librarian) of this chain, not this batch's implementation.

---

## 12. Rollback

**Single-branch revert. No data migration, no API surface change, no schema change, no runner
change.** The blast radius is `apps/web/src/**` plus, if a `Select` primitive is added, one new
file. `git revert` of the merge commit, or a branch reset, restores `3f712b5` behaviour exactly.
Nothing persisted anywhere depends on the change, so there is no forward-fix obligation and no
window during which a revert loses data.

**A partial revert is not safe.** The stylesheet and the call sites are one atomic change: the
legacy rules are deleted in `styles.css` and the classes that referenced them are removed from the
12 files in the same commit range.

- Reverting **`styles.css` alone** restores 126 unlayered class rules that now win over the
  migrated utilities on every property they declare — the app regresses to a *worse* state than
  before the batch, because pages now carry both mechanisms.
- Reverting **one page alone** restores that page's legacy class names with no rules behind them:
  the page renders unstyled (no layout, no colour, browser defaults).
- Reverting **the test alone** is harmless but pointless — the new assertion would fail against
  the old stylesheet, which is exactly what it is designed to do.

So the rollback unit is the whole batch. If only part of it needs undoing, revert everything and
re-land, rather than reverting a subset.

---

## Appendix A — the 126 legacy class selectors

Authoritative list, also materialised as `docs/specs/legacy-classes.txt` (one name per line) for
the §9.B grep. `styles.css` must contain none of them after the batch; the 12 source files must
reference none of them. Alphabetical:

```
accent      active      amber       backLink    badge       board       body
bottom      btn         card        cardTitle   check       chevron     chip
choice      choiceList  clamped     clickable   codeBlock   column      columnBody
columnEmpty columnHead  content     count       danger      detailHead  dim
dot         empty       error       eventLog    eventRow    faint       field
fieldRow    flush       foot        gap         goalCard    green       grey
hint        human       iconBtn     inboxItem   inboxList   k           kv
label       longText    md          menuWrap    meta        metaRow     metric
metrics     mid         mine        modal       msgCard     msgHead     name
navItem     notice      nowrap      off         on          over        overlay
overlayBody overlayHead page        pageActions pageHead    payload     pill
primary     progressTrack           projectMark projectName projectSwitcher
radio       red         right       row         rowWrap     runLine     runName
runnerRow   segmented   sender      seq         shell       showMore    side
sidebar     sidebarFoot small       spacer      src         stack       statPill
statPills   state       strong      sub         subtitle    summary     table
tableWrap   tabs        taskCard    three       tight       time        title
titles      toggle      toolbar     top         type        unreadDot   v
violet      waitBar
```

Excluded from the list, and surviving: `.dark` (the dark token block) and `.jpg` (a filename
inside a comment).
