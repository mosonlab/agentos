# W13 part 3 — selector-destination checklist

Every selector deleted from `apps/web/src/styles.css` at W13, against the file and
class string that carries it now. Source: `git show 3f712b5:apps/web/src/styles.css`,
lines 66–463 — 208 rules in all (10 element/pseudo-element rules, 198 class rules,
6 of which are the narrow-viewport overrides at the foot of the file).

`legacy-class-check.sh` returning 0 proves each class **name** is gone. It does not
prove the **declarations** were relocated. This table is what proves the second, and
it is the artifact the reviewer at step ⑥ reads.

Conventions: `ui.tsx` means `apps/web/src/components/ui.tsx`; page paths are relative
to `apps/web/src/`. A **DROP** row is an intentional deletion under spec §4 rule 4 and
carries its before/after value.

## 1. Element and pseudo-element rules (styles.css:66–98)

These did not move to a component — they moved into the new `@layer base` block at the
foot of the same file, so that utilities now beat them instead of losing to them.

| Legacy selector | Destination | Note |
|---|---|---|
| `:root { --ink-0 … --radius-ctl }` | — | **DROP.** 30 alias variables. Every consumer now names the canonical token (`--foreground`, `--background`, `--link`, `--border-soft`, `--faint`, `--status-*`, `--destructive-*`, `--radius`). Verified: no `var(--ink-*)`, `var(--fg*)`, `var(--line*)`, `var(--blue)`, `var(--red*)`, `var(--green-*)`, `var(--amber-*)`, `var(--violet-*)`, `var(--accent-*)` or `var(--radius-ctl)` remains under `apps/web/src`. |
| `:root { font-family … text-rendering }` | `styles.css` `@layer base` → `html` | `font-size: 13px` is byte-identical, deliberately (spec §8.7). `color`/`background` re-pointed to `--foreground`/`--background`. |
| `* { box-sizing }` | `styles.css` `@layer base` → `*` | Kept even though Tailwind preflight sets it: preflight is earlier in `base`, and keeping it makes the intent explicit. |
| `body { margin; min-height; background }` | `styles.css` `@layer base` → `body` | |
| `button, input, textarea, select { font: inherit; color: inherit }` | `styles.css` `@layer base` | **The §2.5 payout.** Now layered, so `button.tsx`'s `font-medium` / `text-sm` / `disabled:opacity-50` become live — which is why all four legacy variants pin `font-normal`/`font-bold`, an explicit `text-[…]` and `disabled:opacity-45`. |
| `button { cursor: pointer }` | `styles.css` `@layer base` | Load-bearing: Tailwind v4 preflight does **not** set `cursor: pointer` on buttons. |
| `a { color: var(--link); text-decoration: none }` | `styles.css` `@layer base` | Now layered, so `BACK_LINK`'s and `NAV_ITEM`'s colour utilities win; a link with no colour utility is still `--link` blue, exactly as before. |
| `h1, h2, h3, h4 { margin: 0; font-weight: 700 }` | `styles.css` `@layer base` | |
| `::-webkit-scrollbar`, `-thumb`, `-track` | `styles.css` `@layer base` | Byte-identical. |

## 2. Shell (styles.css:101–155)

| Legacy selector | Destination |
|---|---|
| `.shell` | `ui.tsx` `SHELL` |
| `.sidebar` | `ui.tsx` `SIDEBAR` |
| `.projectSwitcher` | `ui.tsx` `PROJECT_SWITCHER` |
| `.projectSwitcher:hover` | `ui.tsx` `PROJECT_SWITCHER` → `hover:bg-secondary` |
| `.projectMark` | `ui.tsx` `PROJECT_MARK` |
| `.projectName` | `ui.tsx` `PROJECT_NAME` |
| `.chevron` | `ui.tsx` `CHEVRON` |
| `.navItem` | `ui.tsx` `NAV_ITEM` |
| `.navItem:hover` | `ui.tsx` `NAV_ITEM` → `hover:bg-secondary hover:text-secondary-foreground` |
| `.navItem.active` | `ui.tsx` `NAV_ITEM_ACTIVE` — restates the hover pair, because among utilities `hover:` beats the unprefixed form whereas the stylesheet relied on source order |
| `.navItem svg` | `ui.tsx` `NAV_ITEM` → `[&_svg]:flex-none [&_svg]:opacity-85` |
| `.navItem .count` | `ui.tsx` `NAV_COUNT` (`ml-auto`), applied as `cn(COUNT, NAV_COUNT)` in `Shell.tsx` |
| `.badge` | `ui.tsx` `BADGE_COUNT` |
| `.sidebarFoot` | `ui.tsx` `SIDEBAR_FOOT` |
| `.runnerRow` | `ui.tsx` `RUNNER_ROW` |
| `.runnerRow .state` | `ui.tsx` `RUNNER_STATE` |
| `.dot` | `ui.tsx` `DOT` |
| `.dot.on` | `ui.tsx` `DOT_TONE.on` (keeps the `box-shadow` glow) |
| `.dot.off` | `ui.tsx` `DOT_TONE.off` |
| `.dot.green` / `.dot.amber` / `.dot.red` | `ui.tsx` `DOT_TONE.green` / `.amber` / `.red` — used by `Tasks.tsx` and `Tasks.tsx`'s `RunLine` |
| `.content` | `ui.tsx` `CONTENT` |

## 3. Page frame (styles.css:156–176)

| Legacy selector | Destination |
|---|---|
| `.page` | `ui.tsx` `PAGE` (via the `Page` component) |
| `.pageHead` | `ui.tsx` `PAGE_HEAD` |
| `.pageHead .titles` | `ui.tsx` `PAGE_HEAD_TITLES` |
| `.pageHead h1` | `ui.tsx` `PAGE_HEAD_H1` |
| `.pageHead .subtitle` | `ui.tsx` `PAGE_HEAD_SUBTITLE` |
| `.pageActions` | `ui.tsx` `PAGE_ACTIONS` |
| `.detailHead` | `ui.tsx` `DETAIL_HEAD` |
| `.detailHead h1` | `ui.tsx` `DETAIL_HEAD_H1` |
| `.detailHead .spacer` | `flex-1` at each call site (`Agents.tsx`, `Goals.tsx`, `TaskDetail.tsx`) |
| `.backLink` | `ui.tsx` `BACK_LINK` |
| `.backLink:hover` | `ui.tsx` `BACK_LINK` → `hover:text-foreground` |
| `.stack` | `ui.tsx` `STACK` |
| `.row` | `ui.tsx` `ROW` |
| `.rowWrap` | `ui.tsx` `ROW_WRAP` |
| `.spacer` | `flex-1` at each call site |
| `.toolbar` | `ui.tsx` `TOOLBAR` |

## 4. Buttons and controls (styles.css:178–243)

| Legacy selector | Destination |
|---|---|
| `.btn` | `ui/button.tsx` `variant.legacy` + `size.legacy` |
| `.btn:hover` | `variant.legacy` → `hover:border-… hover:bg-secondary hover:text-foreground` |
| `.btn:disabled` | `disabled:opacity-45`, pinned on **all four** legacy variants (§2.5) |
| `.btn.primary` / `:hover` | `variant.legacyPrimary` |
| `.btn.danger` / `:hover` | `variant.legacyDanger` — runs on `--danger-button*`, not the stock `destructive` variant, whose `text-destructive-foreground` names a token that does not exist here |
| `.btn.small` | `size.legacySmall` |
| `.iconBtn` / `:hover` | `variant.icon` + `size.legacyIcon`; `shadow-none` lives in the variant because its only host is a raw `<button>` |
| `.iconBtn.danger:hover` | `ui.tsx` `RowMenu` → `text-destructive focus:bg-destructive/10 focus:text-destructive` on the menu item |
| `.segmented` | `ui.tsx` `Segmented` root |
| `.segmented button` | `ui.tsx` `SEGMENTED_BUTTON` |
| `.segmented button:hover` | `SEGMENTED_BUTTON`, attached to **unselected** buttons only, matching the legacy `:not(.on)` effect |
| `.segmented button.on` | `ui.tsx` `Segmented` selected branch |
| `.segmented.accent button.on` | `ui.tsx` `Segmented` `accent` prop |
| `.tabs` / `.tabs button` / `.tabs button.on` | `ui.tsx` `Tabs` root and `TABS_BUTTON` |
| `.toggle`, `.toggle::after`, `.toggle.on`, `.toggle.on::after`, `.toggle:disabled` | `ui.tsx` `Toggle` — track on the Radix root, knob via `[&>span]:…`, both states via `data-[state=checked]`/`data-[state=unchecked]` |
| `.check` / `.check.on` | `ui.tsx` `Check` (Radix `Checkbox`) |
| `input[type=…], select, textarea` | `ui/input.tsx`, `ui/select.tsx`, `ui/textarea.tsx` |
| `input:focus, select:focus, textarea:focus` | the same three primitives → `focus:border-primary` |
| `textarea` (min-height, resize) | `ui/textarea.tsx` |
| `select` (chevron gradients) | `ui/select.tsx` — the two `linear-gradient`s ported verbatim, with `--fg-faint` → `--faint` |
| `.field` | `ui.tsx` `FIELD` (used by the `Field` component and by the two spacer-label fields in `Agents.tsx`) |
| `.field > label` | `ui.tsx` `FIELD_LABEL` |
| `.field .hint` | `ui.tsx` `Field`'s hint slot |
| `.fieldRow` | `ui.tsx` `FIELD_ROW` |

## 5. Cards, tables and data display (styles.css:245–300)

| Legacy selector | Destination |
|---|---|
| `.card` | `ui.tsx` `Card` → `ui/card.tsx` + `border-border` (preflight's `border: 0 solid` supplies no colour) |
| `.card > h2, .cardTitle` | `ui.tsx` `CARD_TITLE` |
| `.cardTitle .spacer` | `flex-1` inside `Card`'s title row |
| `.card.flush` / `.card.flush > .cardTitle` | `ui.tsx` `Card`'s `flush` prop |
| `.count` | `ui.tsx` `COUNT` |
| `.kv`, `.kv > div`, `.kv .k`, `.kv .v`, `.kv.three` | `ui.tsx` `KeyValue` (`columns` prop covers `.three`) |
| `.metrics` | `ui.tsx` `METRICS` |
| `.metric`, `.metric .k`, `.metric .v` | `ui.tsx` `Metric` |
| `.longText` | `ui.tsx` `LONG_TEXT` |
| `.clamped` | `ui.tsx` `ShowMore` → `overflow-hidden [-webkit-box-orient:vertical] [display:-webkit-box]`; the `-webkit-line-clamp` value stays an inline style because it is driven by the `lines` prop |
| `.showMore` / `:hover` | `ui.tsx` `ShowMore`'s trigger button |
| `.codeBlock` | `ui.tsx` `CODE_BLOCK` |
| `.table` | `ui/table.tsx` `Table` |
| `.table th` | `ui/table.tsx` `TableHead` |
| `.table td` | `ui/table.tsx` `TableCell` |
| `.table tbody tr:hover` | `ui/table.tsx` `TableRow` → `hover:bg-[color:var(--row-hover)]` |
| `.table tbody tr:last-child td` | `ui/table.tsx` `TableBody` → `[&_tr:last-child>td]:border-b-0` |
| `.table .name` | `ui.tsx` `TABLE_NAME` |
| `.table .name .sub` | `ui.tsx` `TABLE_SUB` |
| `.table td.right, .table th.right` | — | **DROP.** `text-align: right`. Dead at baseline: `git grep 'className="right"' 3f712b5` returns nothing, so no element ever carried it. No visual change. |
| `.table td.tight` | `ui.tsx` `TABLE_TIGHT` |
| `.clickable` | `cursor-pointer` at each call site |
| `.tableWrap` | `ui/table.tsx` `Table`'s own `<div class="relative w-full overflow-auto">` wrapper |

## 6. Pills and chips (styles.css:302–330)

| Legacy selector | Destination |
|---|---|
| `.pill` | `ui/badge.tsx` `shape.pill` |
| `.pill.green` / `.amber` / `.violet` / `.red` / `.grey` / `.accent` | `ui/badge.tsx` `tone.*` — declared after `shape` so a tone's border colour beats `shape`'s `border-transparent` under tailwind-merge |
| `.chip` / `.chip.human` | `ui.tsx` `CHIP` and `AgentChip` |
| `.statPills` | `ui.tsx` `STAT_PILLS` |
| `.statPill` | `ui.tsx` `STAT_PILL` |

## 7. Tasks board (styles.css:332–355)

| Legacy selector | Destination |
|---|---|
| `.board` | `pages/Tasks.tsx` `BOARD` |
| `.column` | `pages/Tasks.tsx` `COLUMN` |
| `.columnHead` | `pages/Tasks.tsx` `COLUMN_HEAD` |
| `.columnBody` | `pages/Tasks.tsx` `COLUMN_BODY` (keeps the 1% `color-mix` tint) |
| `.columnBody.over` | `pages/Tasks.tsx` `COLUMN_BODY_OVER` |
| `.columnEmpty` | `pages/Tasks.tsx` `COLUMN_EMPTY` |
| `.taskCard` / `:hover` | `pages/Tasks.tsx` `TASK_CARD` |
| `.taskCard h3` | `pages/Tasks.tsx` — `"flex-1 text-[13px] leading-[1.45]"` on the heading |
| `.taskCard .meta` | `pages/Tasks.tsx` `TASK_META` |
| `.taskCard .metaRow` | `pages/Tasks.tsx` `TASK_META_ROW` |
| `.taskCard .foot` | `pages/Tasks.tsx` `TASK_FOOT` |
| `.taskCard .foot svg` | `TASK_FOOT` → `[&_svg]:size-[13px] [&_svg]:flex-none [&_svg]:opacity-85` — overrides the button base's `[&_svg]:size-4` |
| `.runLine` | `pages/Tasks.tsx` `RunLine` → `"inline-flex items-center gap-[6px] whitespace-nowrap"` |
| `.runLine .runName` | `pages/Tasks.tsx` `RunLine` → `text-primary` |

## 8. Inbox (styles.css:357–396)

| Legacy selector | Destination |
|---|---|
| `.inboxList` | `pages/Inbox.tsx` `LIST` |
| `.inboxItem` / `:hover` | `pages/Inbox.tsx` `INBOX_ITEM` |
| `.inboxItem .body` | `pages/Inbox.tsx` — `"min-w-0 flex-1"` |
| `.inboxItem .sender` | `pages/Inbox.tsx` — `"flex items-center gap-[8px] text-[12.5px] font-bold text-foreground"` |
| `.inboxItem .title` | `pages/Inbox.tsx` — `"mt-[5px] flex items-center gap-[8px] text-[13px] text-foreground"` |
| `.inboxItem .summary` | `pages/Inbox.tsx` — `"mt-[4px] overflow-hidden text-[12px] text-ellipsis whitespace-nowrap text-muted-foreground"` |
| `.inboxItem .side` | `pages/Inbox.tsx` — `"flex-none text-right text-[11.5px] text-muted-foreground"` |
| `.inboxItem .side .src` | `pages/Inbox.tsx` — `"mt-[5px] text-[color:var(--faint)]"` |
| `.unreadDot` | `pages/Inbox.tsx` — `"size-[7px] flex-none rounded-full bg-primary"` |
| `.msgCard` | `ui.tsx` `MSG_CARD` |
| `.msgCard + .msgCard` | `pages/Inbox.tsx` `MSG_LIST` (`[&>*+*]:mt-[12px]`) where every child is a card; per-index `mt-[12px]` where the first card follows a non-card sibling. `space-y-*` is unusable: Tailwind v4 emits it through `:where()`, i.e. at zero specificity. |
| `.msgCard.mine` | `pages/Inbox.tsx` — `cn(MSG_CARD, "ml-[40px] bg-secondary")` |
| `.msgHead` | `ui.tsx` `MSG_HEAD` |
| `.msgHead .time` | `ui.tsx` `MSG_TIME` |
| `.waitBar` | `pages/Inbox.tsx` — the amber `color-mix` bar, inline on the element |
| `.choiceList` | `pages/Inbox.tsx` `LIST` |
| `.choice` / `:hover` / `.choice.on` | `pages/Inbox.tsx` `CHOICE` |
| `.choice .radio` / `.choice.on .radio` | `pages/Inbox.tsx` — `"mt-[2px] size-[15px] flex-none rounded-full border border-[color:var(--radio-border)]"` |
| `.choice .label` | `pages/Inbox.tsx` — `"flex-1 text-[12.5px]"` |
| `.choice .hint` | `pages/Inbox.tsx` — `"mt-[3px] block"` **only**. Deliberately not `HINT`: `.choice` has no `.field` ancestor, so `.field .hint`'s colour and size never applied here; the plan's A.3 mapping would have shrunk and greyed it. |

## 9. Notices, goals, overlays (styles.css:398–441)

| Legacy selector | Destination |
|---|---|
| `.empty` | `ui.tsx` `EmptyState` |
| `.notice` | `ui.tsx` `NOTICE` |
| `.notice.gap` | `ui.tsx` `NOTICE_GAP` (via `GapNotice`) |
| `.notice.error` | `ui.tsx` `NOTICE_ERROR` (via `ErrorNotice`) |
| `.notice code` | `ui.tsx` `NOTICE` → `[&_code]:text-inherit [&_code]:opacity-90` |
| `.notice .spacer` | `ui.tsx` `ErrorNotice` → `flex-1` before the Retry button |
| `.progressTrack` | `pages/Goals.tsx` `PROGRESS_TRACK` on `ui/progress.tsx` |
| `.goalCard` | `pages/Goals.tsx` `GOAL_CARD` |
| `.goalCard + .goalCard` | `pages/Goals.tsx` — per-index `mt-[12px]`, because the first goal card can follow an `ErrorNotice` rather than another card |
| `.goalCard .top` | `ui.tsx` `ROW` |
| `.goalCard h3` | `pages/Goals.tsx` — `text-[1.17em]` (em, as in the original) |
| `.goalCard .mid` | `pages/Goals.tsx` `GOAL_MID` |
| `.goalCard .bottom` | `pages/Goals.tsx` — `"mt-[9px] text-[12px] text-muted-foreground"` |
| `.overlay` | `ui.tsx` `FullPanel` |
| `.overlayHead` | `ui.tsx` `FullPanel` head row |
| `.overlayBody` | `ui.tsx` `FullPanel` body |
| `.modal` | `ui.tsx` `Modal` → `ui/dialog.tsx`; `sm:rounded-[12px]` is restated because a `sm:`-prefixed utility is a different tailwind-merge group key and sorts after the unprefixed one |
| `.menuWrap` | `ui.tsx` `RowMenu` → `"relative"` on the trigger wrapper |

## 10. Markdown and event log (styles.css:437–448)

| Legacy selector | Destination |
|---|---|
| `.md` | `ui.tsx` `Markdown` root — `"text-[12.5px] leading-[1.75] text-secondary-foreground [&>*:last-child]:mb-0"` |
| `.md p` | `ui.tsx` `MD_PARAGRAPH` |
| `.md ul, .md ol` | `ui.tsx` `MD_LIST` |
| `.md ul` | `list-disc` on the `<ul>` — now a **layered utility** beating preflight's `ol,ul,menu{list-style:none}` instead of an unlayered rule. Asserted three ways in `styles.test.tsx`: preflight is in `["base"]`, `list-disc` is in `["utilities"]`, and `renderToStaticMarkup(<Markdown …/>)` actually emits it. |
| `.md ol` | `list-decimal` on the `<ol>`, same three assertions |
| `.md li` | `ui.tsx` `Markdown` → `"my-[3px]"` |
| `.md strong` | `ui.tsx` `Markdown` → `text-foreground` |
| `.md code` | `ui.tsx` `MD_CODE` |
| `.md > :last-child` | `ui.tsx` `Markdown` root → `[&>*:last-child]:mb-0` |
| `.eventLog` | `pages/TaskDetail.tsx` `EVENT_LOG` |
| `.eventRow` | `pages/TaskDetail.tsx` `EVENT_ROW` |
| `.eventRow:last-child` | `EVENT_ROW` → `last:border-b-0` |
| `.eventRow .seq` | `pages/TaskDetail.tsx` — `text-[color:var(--faint)]` |
| `.eventRow .type` | `pages/TaskDetail.tsx` — `"overflow-hidden text-ellipsis text-primary"` |
| `.eventRow .payload` | `pages/TaskDetail.tsx` — `"overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"` |

## 11. Utility classes (styles.css:449–454)

| Legacy selector | Destination |
|---|---|
| `.dim` | `text-muted-foreground` at each call site (`ui.tsx` `Label`, `Inbox.tsx` ×2, `TaskDetail.tsx` ×2) |
| `.faint` | `text-[color:var(--faint)]` at each call site |
| `.strong` | `text-foreground` at each call site |
| `.nowrap` | `whitespace-nowrap` at each call site (`Tasks.tsx` ×3) |
| `.small` | `text-[11.5px]` at each call site |

## 12. Narrow viewport — `@media (max-width: 900px)` (styles.css:456–463)

Tailwind's `max-[900px]:` compiles to `@media not all and (min-width:900px)`, which
**excludes** a viewport of exactly 900px where the legacy query applies. All six use the
arbitrary-variant form `[@media(max-width:900px)]:` instead. Verified present in the
built sheet: `grep -c "max-width: *900px" apps/web/dist/assets/*.css` → 1.

| Legacy selector | Destination |
|---|---|
| `.shell { grid-template-columns: 1fr }` | `ui.tsx` `SHELL` → `[@media(max-width:900px)]:grid-cols-[1fr]` |
| `.sidebar { position: static; height: auto; flex-direction: row; flex-wrap: wrap }` | `ui.tsx` `SIDEBAR` → `[@media(max-width:900px)]:static [@media(max-width:900px)]:h-auto [@media(max-width:900px)]:flex-row [@media(max-width:900px)]:flex-wrap` |
| `.sidebarFoot { display: none }` | `ui.tsx` `SIDEBAR_FOOT` → `[@media(max-width:900px)]:hidden` |
| `.page { padding: 20px 16px 60px }` | `ui.tsx` `PAGE` → the three `[@media(max-width:900px)]:` padding utilities |
| `.overlay { inset: 0 }` | `ui.tsx` `FullPanel` → `[@media(max-width:900px)]:left-0` (the base already pins the other three sides) |
| `.overlayHead, .overlayBody { padding-left/right: 16px }` | `ui.tsx` `FullPanel` → `[@media(max-width:900px)]:px-[16px]` on both |

## 13. Intentional drops, collected

| Legacy selector | Before | After | Why |
|---|---|---|---|
| `:root { --ink-* … --radius-ctl }` | 30 alias custom properties | canonical token names used directly | The aliases had exactly one consumer each — the legacy stylesheet. |
| `.table td.right, .table th.right` | `text-align: right` | — | Dead at baseline; no element in the app carried `right`. |

## 14. Appearance deltas recorded elsewhere

These are **not** drops — they are changes the plan itself chose, restated here so the
reviewer sees the complete set in one place.

1. **Raw `<select>` gains `shadow-sm`** (plan §W3). `ui/select.tsx` matches `ui/input.tsx`
   exactly, including its shadow, so a select sits flush with the Input beside it. Twelve
   selects are affected.
2. **The Connections agent pill `<Link>` gains a focus ring** — `badgeVariants`' base
   carries `focus:ring-2`, which `.pill` did not have.
3. **`color-mix()` gets an `@supports` wrapper.** Tailwind emits arbitrary `color-mix()`
   values inside `@supports` with a solid fallback outside it. Identical in every browser
   that supports `color-mix`; a browser-support difference only.

## 15. Plan deviations found at W16, with their measurements

Six repairs that the W0 baseline contradicted after the fact. Each is a separate
commit; each was found by measuring, not by reading. The shared shape is that a
legacy declaration and a primitive utility were competing for the same property,
and the plan predicted the wrong winner.

| # | Plan said | The baseline said | Repair |
|---|---|---|---|
| 1 | §1.5: an Input is 38.75px and collapses to `h-9` when the legacy rule goes | The legacy rule sets `padding`, never `height`, so `h-9` always won: 29.25px | `input.tsx` keeps `h-9`; ~26 call sites unchanged |
| 2 | §W6: `text-sm` → `text-[12.5px]` is size-for-size | `text-sm` also paired a line-height that `.table td`'s font-size override left inherited | `table.tsx` pins `leading-[1.4285714]`; 4 raw-`<table>` call sites take `leading-normal` |
| 3 | `.hint` is a legacy class to translate | No standalone `.hint` rule exists — only `.field .hint` and `.choice .hint` | `HINT` removed from 12 sites; kept at the one `.field .hint` |
| 4 | `.small` is a legacy class to translate | `.table td` outranks `.small` on specificity, so it was inert in that `<td>` | size class dropped from the commit-range cell; the 4 non-table spans keep it |
| 5 | §1.5 covers every input | Two Projects inputs were raw `<input>`: 38.75px and a preflight placeholder | `h-auto placeholder:text-foreground/50` at those two sites |
| 6 | `CARD_TITLE` carries the modal title | `h1..h4 { font-weight: 700 }` was unlayered and beat `font-semibold`; and tailwind-merge deletes `leading-none` behind a font-size utility | `font-bold leading-none` at the DialogTitle call site |

Measured heights, baseline → after repair, all in CSS px:

| Control | Baseline | Before repair | After repair |
|---|---|---|---|
| Input (TaskDetail comment) | 29.00 | 39.00 | 29.25 |
| Table row (`tr`, Agents) | 64.00 | 66.00 | 64.27 |
| Projects form input | 38.75 | 29.25 | 38.75 |
| Modal title `h2` | 13.50 line-height / 700 | 20.25 / 600 | 13.50 / 700 |
| Commit-range `<td>` | 12.50px | 11.50px | 12.50px |

### How the residue was checked

Two independent sweeps, both against a 3f712b5 worktree served beside the migrated
tree so the same fixture answers both:

- **Computed-style sweep.** Every element with a text child on 9 routes — the 8
  pages plus the agent detail, each with its create form opened — keyed by tag and
  text, comparing `font-size`, `line-height`, `font-weight`, `color`,
  `letter-spacing` and box height. **0 differing leaves.** The only three unmatched
  keys are fixture clocks (`7h ago` → `8h ago`, two elapsed counters).
- **Pixel sweep.** The 20 committed W0 frames plus 10 form/overlay frames. What
  remains is the §14 `<select>` shadow (one 69px band per select), the same fixture
  clock drift, and sub-pixel antialiasing on the `⋮` glyph and the New Project
  button corner (16–411px per frame, ≤0.007%). `connections-*` and
  `walk-newtask-dark` diff at exactly 0.

Residual risk, stated rather than resolved: both sweeps only see what the fixture
renders. Empty states, error states and the tabs behind a second click are covered
by neither, and no fixture exercises a `<Textarea>` inside a captured frame — that
primitive was checked by deriving its geometry from the legacy declarations
instead (every call site passes `rows`, and `text-[12.5px] leading-[1.6] py-[9px]`
reproduces the retired `textarea` rule exactly).
