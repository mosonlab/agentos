# SPEC — Batch 0: Frontend base migration to Tailwind v4 + shadcn/ui

Status: draft for review · Author: spec agent · Date: 2026-08-15
Authoritative sources: `docs/reference/danny-agentos-video/decisions.md` §3, `docs/BACKLOG-V2.md` Batch 0.
This is a requirements + acceptance-criteria document. It contains no implementation plan.

## 1. Problem and audience

The AgentOS web frontend (`apps/web`) is a single-user React 19 + Vite 7 app styled by one
hand-written stylesheet (`apps/web/src/styles.css`, 459 lines, ~45 CSS custom properties,
dark-only). Batches 1–5 will build substantial new UI (Settings, Inbox questionnaire,
Sessions viewer, Goals orchestrator, Connections rewrite). Building those on hand-rolled CSS
means hand-writing every new component and a full 45-variable override set for light mode.

Decision §3 fixes this now, at the historical low point of migration cost: adopt
Tailwind v4 + shadcn/ui as the component/styling base, express the existing palette as a
shadcn custom theme with light and dark variants, and migrate the 8 existing pages so no
page is left on the old base. The audience is Leo (sole operator/developer) and the agents
that will implement later batches on top of this base.

## 2. Scope

In scope:

1. Add Tailwind v4 and shadcn/ui to `apps/web`. Keep React 19 and Vite 7 exactly as-is.
2. Map the existing CSS variables in `apps/web/src/styles.css` into a shadcn custom theme
   (see §4): dark theme reproduces today's values; a new light theme is introduced.
3. Theme switching: default follows the OS (`prefers-color-scheme`); a manual toggle
   overrides it and the override persists in `localStorage`.
4. Migrate all 8 pages under `apps/web/src/pages/` plus the shared chrome
   (`components/Shell.tsx`, `components/ui.tsx`, `components/icons.tsx`) per the two-tier
   policy in §5: full migration for Agents, Goals, Secrets, TaskDetail, Tasks;
   minimal migration for Connections, Inbox, Projects.
5. Shrink `styles.css` to a legacy layer that only contains rules still referenced after
   migration, with every color expressed through theme tokens (no hardcoded surface/text
   hex values outside token definitions).

Non-goals (explicitly out of scope):

- No router library and no state-management library (decision §3). The hand-written
  `lib/router.tsx` navigation, `fetch` + polling data layer, and React context usage are
  untouched.
- No visual redesign beyond what the token mapping implies. Layout, spacing, information
  architecture, copy, and interaction patterns stay as they are.
- No behavior change: routes, polling intervals, forms, drag-and-drop on the Tasks board,
  API calls, and the dev-proxy auth model are unchanged.
- No full rewrite of Connections, Inbox, or Projects — those pages are rewritten in
  Batches 10/3/later respectively; here they get minimal migration only (§5).
- No i18n work (Batch 1), no Settings page (Batch 1 — see A3 for where the toggle lives
  meanwhile), no new open-source components (`@uiw/react-md-editor`, SVAR File Manager,
  SurveyJS arrive with their own batches).
- No package-manager change (see A1) and no changes outside `apps/web` other than the
  lockfile.

## 3. Intended behavior — concrete scenarios

1. **Dark parity.** Leo opens the app on a machine whose OS is in dark mode, with no stored
   preference. Every page renders in the dark theme and looks the same as before the
   migration (same palette, same layout, same mono type) within the tolerance of §8.
2. **System default, light.** On an OS in light mode with no stored preference, the app
   renders in the new light theme: warm-paper surfaces, same accent yellow role, all text
   legible per §8. No page or component remains dark-hardcoded (no "dark islands").
3. **Manual override.** Leo uses the theme toggle to force light while the OS is dark. The
   choice takes effect immediately without reload, survives reload and new tabs
   (localStorage), and wins over the OS setting until switched back to "system".
4. **System follows.** With preference "system", changing the OS appearance while the app
   is open switches the app's theme without a reload.
5. **No flash.** Reloading in forced-light on a dark OS (and vice versa) does not flash the
   wrong theme before first paint.
6. **Behavior untouched.** Creating a task, dragging a card between kanban columns,
   answering an inbox message, toggling an agent field, opening the New Task overlay, and
   deep-linking any route all work exactly as before.
7. **Unstyled-state guard.** A shadcn component that ships default styling (e.g. Dialog
   overlay, Select popover) appears in the app's palette, not shadcn's stock zinc palette —
   i.e. the theme tokens are actually wired, not defaulted.

## 4. Token mapping approach

### 4.1 Principles

- **Dark theme is the source of truth.** Every dark-theme token value is copied verbatim
  from today's `styles.css` hex values. Dark mode after migration is a re-expression, not a
  re-tint.
- **Role-for-role mapping.** Each existing variable maps to the shadcn token that plays the
  same role. Variables with no shadcn counterpart become namespaced custom tokens defined
  in both themes — they are part of the theme, not stragglers.
- **Light theme is new, derived by role.** No light palette exists today. Implementation
  picks light values per role (warm paper counterpart to the warm-olive dark), constrained
  by the contrast requirements in §8. Exact light hex values are an implementation choice,
  not fixed by this spec (assumption A2).
- **Tailwind v4 CSS-first.** Theme lives in CSS (`@theme` / `:root` + `.dark` blocks per
  the shadcn Tailwind-v4 convention); no `tailwind.config.js`. Dark mode is class-based
  (`.dark` on the document element) so the manual override can win over the OS.

### 4.2 Mapping table (dark values shown; light column filled at implementation)

| Existing variable(s) | Role today | shadcn/theme token |
|---|---|---|
| `--ink-0` `#0b0a07` | app backdrop | `--background` |
| `--ink-1` `#131109` | sidebar | `--sidebar` (+ `--sidebar-foreground`, `--sidebar-border`, `--sidebar-accent` from the vars below) |
| `--ink-2` `#191710` | content panel, inputs bg, popover surfaces | `--popover` and `--input`-related surface |
| `--ink-3` `#201d12` | card | `--card` |
| `--ink-4` `#272316` | raised/hover, badges | `--secondary` / `--muted` |
| `--ink-5` `#2f2a19` | selected segment, active nav | `--accent` (shadcn's subtle-selection role — not the yellow) |
| `--line` `#2e2919` | default border | `--border` |
| `--line-soft` `#241f13` | soft border | custom `--border-soft` |
| `--fg` `#f1efe4` | primary text | `--foreground` (and `--card-foreground`, `--popover-foreground`) |
| `--fg-2` `#cbc7b6` | secondary text | `--secondary-foreground` |
| `--fg-dim` `#8d8874` | dim text | `--muted-foreground` |
| `--fg-faint` `#6b6655` | faintest text | custom `--faint` |
| `--accent` `#e9c64a` (yellow) | brand/CTA | `--primary`, and `--ring` (focus = yellow today) |
| `--accent-ink` `#1a1608` | text on yellow | `--primary-foreground` |
| `--accent-hi` `#f2d264` | CTA hover | custom `--primary-hover` |
| `--accent-soft` `#4a3d13` | subtle yellow border/bg | custom `--primary-soft` |
| `--red` `--red-fg` `--red-bg` `--red-line` | destructive/error | `--destructive` (+ custom `--destructive-*` trio for fg/bg/line pills) |
| `--green-*` trio | success status | custom `--status-green-fg/bg/line` |
| `--amber-*` trio | warning status | custom `--status-amber-fg/bg/line` |
| `--violet-*` trio | agent/info status | custom `--status-violet-fg/bg/line` |
| `--blue` `#8fa7ff` | links | custom `--link` |
| `--radius-ctl` 8px | control radius | `--radius` (base) |
| `--radius-card` 10px | card radius | derived (`calc(var(--radius) + 2px)`) or custom `--radius-card` |
| `--mono` font stack | the only typeface | Tailwind `--font-mono`, set as the app default (whole app stays mono) |

Status-trio names stay semantic (`--status-*`) rather than being forced into shadcn's
chart/sidebar slots; the Pill/Chip/notice components consume them in both themes.

### 4.3 Theme switching contract

- Persistence: one localStorage key, `agentos.theme`, values `"light" | "dark"`; absence
  of the key means "system". Writing/removing the key is the only persistence side effect.
- Application: a `dark` class on `<html>`, set by a small inline script in `index.html`
  before first paint (reads the key, falls back to `prefers-color-scheme`) and kept in sync
  at runtime; preference "system" tracks `prefers-color-scheme` changes live.
- Toggle UI: a minimal control in the sidebar footer cycling system → light → dark
  (assumption A3; it moves into the Settings page in Batch 1). No other UI is added.

### 4.4 Interface changes

- `apps/web/package.json`: add Tailwind v4 toolchain (`tailwindcss`, `@tailwindcss/vite`),
  shadcn/ui runtime deps (`class-variance-authority`, `clsx`, `tailwind-merge`,
  `lucide-react`, and the Radix primitives pulled in by installed components). No React,
  ReactDOM, or Vite version changes.
- `vite.config.ts`: register the Tailwind Vite plugin; add the `@` → `src` resolve alias
  required by shadcn. Proxy/auth config unchanged.
- `tsconfig.app.json`: matching `paths` alias `@/*`.
- New files: `components.json` (shadcn config), `src/components/ui/*` (installed shadcn
  components), `src/lib/utils.ts` (`cn`), a theme hook/provider module.
- `src/styles.css`: rewritten as import of Tailwind + theme token blocks + shrunken legacy
  layer. Data model, API surface, routes, and everything outside `apps/web`: no changes.

## 5. Page-by-page migration checklist

Two tiers, per the backlog:

- **Full migration** — page markup moves to Tailwind utilities + shadcn components where a
  1:1 counterpart exists (`Button`→`.btn`, `Card`→`.card`, `Tabs`/`Segmented`→shadcn Tabs,
  `Modal`→Dialog, `FullPanel`→overlay (kept custom if Dialog can't reproduce the
  sidebar-visible overlay), inputs/select/textarea→shadcn form controls, `Toggle`→Switch,
  `Check`→Checkbox, `Pill`/`count`→Badge variants, `RowMenu`→DropdownMenu, tables→shadcn
  Table, `progressTrack`→Progress). Bespoke patterns with no counterpart (kanban board,
  event log, metric grid, kv grid) stay as custom CSS/utility classes on theme tokens.
- **Minimal migration** — page code is left substantially alone; it must simply render
  correctly on the new base in both themes because the legacy classes it uses now resolve
  to theme tokens. No component swaps beyond what the shared chrome forces. These pages
  (Connections, Inbox, Projects) are rewritten wholesale in later batches.

Checklist (all boxes are requirements; shared chrome first since every page depends on it):

- [ ] **Shared: `Shell.tsx`** (sidebar, project switcher, nav, runner row) — full. Sidebar
      uses sidebar tokens; active/hover states preserved; unread badge preserved.
- [ ] **Shared: `ui.tsx`** — full. Each exported primitive is either replaced by a shadcn
      component behind the same props, or restyled on tokens. Call sites keep working; the
      module may keep thin wrappers so minimal-tier pages don't churn.
- [ ] **Shared: `icons.tsx`** — kept as-is or swapped icon-for-icon to lucide equivalents
      of identical size/weight; no mixed icon styles on one screen.
- [ ] **`Tasks.tsx`** (kanban + New Task overlay) — full. Drag-and-drop between columns,
      column drop-region highlight, card metadata, template/`fieldRow` forms all intact.
- [ ] **`TaskDetail.tsx`** — full. Event log, stat pills, run tables, notices, message
      cards on tokens; polling and actions unchanged.
- [ ] **`Agents.tsx`** (+ detail) — full. Tables, field editors, code blocks, back links.
- [ ] **`Goals.tsx`** (+ detail) — full. Goal cards, metrics, progress bars, message flow.
- [ ] **`Secrets.tsx`** — full. Table + pills + create/reveal flows.
- [ ] **`Connections.tsx`** — minimal (rewritten in the Connections batch).
- [ ] **`Inbox.tsx`** (+ thread) — minimal (rewritten in Batch 3 questionnaire work).
      Choice/radio answering flow must still work in both themes.
- [ ] **`Projects.tsx`** (+ detail) — minimal (rewritten later).
- [ ] **`App.tsx`** connection banners and any remaining inline styles moved onto tokens.
- [ ] **Legacy CSS sweep** — after the above, `styles.css` contains no rule that is
      referenced nowhere, and no hardcoded color hex outside the token definition blocks
      (one-off hexes like `#3f381f` hover borders, `#15130c` code-block bg get tokens or
      token-derived values).

## 6. Edge cases and failure behavior

- **localStorage unavailable/corrupt** (private mode, weird value in `agentos.theme`):
  treat as "system"; never crash; toggle still works for the session.
- **No `prefers-color-scheme` support / no-JS first paint**: fall back to dark (today's
  only theme) rather than an unstyled or white flash.
- **Overlay/Dialog semantics**: the New Task full-screen overlay must keep its
  content-area-only coverage (sidebar visible, `inset: 0 0 0 214px`) — if shadcn Dialog
  cannot express that, the overlay stays custom. Modal scrim behavior (click-outside,
  scroll containment) must match today's.
- **Narrow viewport** (≤900px): the existing responsive collapse (single column, sidebar
  as top wrap, hidden sidebar footer) must survive; the theme toggle must remain reachable
  or be acceptably hidden with the rest of the sidebar footer (same as runner row today).
- **Mixed-base period does not ship**: within this batch, no state where some pages read
  old raw variables that no longer exist. The legacy layer keeps old variable names alive
  as aliases of the new tokens until the last consumer is migrated, then dead aliases are
  removed.
- **Scrollbar/selection chrome**: the custom scrollbar styling must not become
  light-on-light or dark-on-dark in either theme.

## 7. Acceptance criteria — gates

Build gates (must pass in CI/locally before review):

- Workspace typecheck passes: `npm run typecheck` at the repo root (see A1 — the repo is
  npm workspaces; this is the equivalent of the requested `pnpm -r build` gate's typecheck
  half; `apps/web`'s own `typecheck` script runs `tsc -b`).
- Workspace build passes: `npm run build` at the repo root (builds `@agentos/web` via
  `tsc -b && vite build` along with every other workspace).
- Existing tests still pass: `npm run test` at the repo root (no web tests exist today;
  the suite guards against accidental damage outside `apps/web`).
- `npm ls react react-dom vite` shows the same major versions as before (React 19, Vite 7);
  no router or state-management package appears in any `package.json`.

## 8. Acceptance criteria — dark/light checks

Reviewer walks all 8 pages (+ Agent/Goal/Project/Task detail and Inbox thread routes, and
the New Task overlay + one modal + one dropdown menu) in each theme:

Dark:

- [ ] Side-by-side with pre-migration screenshots, pages are visually equivalent: same
      palette (token values are byte-identical hexes), layout, and type. Tolerance:
      sub-pixel spacing/border-radius differences from component swaps; no color changes.
- [ ] No stock-shadcn zinc/blue leaking into any component (scenario 7 in §3).

Light:

- [ ] Every surface, text level, border, pill, notice, code block, event log, kanban
      column, and scrollbar renders in light values — zero dark islands.
- [ ] Contrast: body text on its surface ≥ 4.5:1; dim/faint text and 11–12px text remain
      legible (≥ 4.5:1 for the sizes in use); primary button (yellow) label ≥ 4.5:1;
      status pills readable on their tinted backgrounds.
- [ ] Focus rings visible on inputs and buttons in both themes.

Switching:

- [ ] Scenarios 1–5 of §3 pass exactly as written (system default, manual override,
      persistence across reload/tabs, live OS tracking, no first-paint flash).

Behavior:

- [ ] Scenario 6 of §3: task create/drag, inbox answer, agent edit, overlay/modal/menu
      open-close, deep links — all unchanged. No API or route diffs.

## 9. Rollback note

The entire batch is one PR touching only `apps/web` (plus the root lockfile). Rollback is
`git revert` of the merge commit: no database migration, no API change, no cross-workspace
dependency, and no data written anywhere except the `agentos.theme` localStorage key, which
pre-migration code simply ignores. After revert, `npm install && npm run build` restores
the previous frontend byte-for-byte. There is no partial-rollback mode — reverting a single
page is not supported, by design (the token base is all-or-nothing).

## 10. How a reviewer verifies

1. Check out the PR branch, `npm install`, run the §7 gates.
2. `npm run dev:api` + `npm run dev:web`, seed state as usual.
3. Walk §8's checklists in dark, then light, then exercise the switching scenarios
   (OS appearance flip + toggle + reload + second tab).
4. Grep-level spot checks: no `react-router`/`zustand`/`redux`/`jotai` in any
   `package.json`; `styles.css` has no hardcoded hex outside token blocks; `localStorage`
   is touched only by the theme module.
5. Confirm Connections/Inbox/Projects diffs are minimal (token/base fallout only).

## 11. Assumptions (need Leo's eyes)

- **A1 — Build gate command.** The task text names `pnpm -r build`, but the repo is npm
  workspaces (`package-lock.json`, root `workspaces` field). Assumed reading: the intent is
  "the whole workspace must typecheck and build", i.e. root `npm run typecheck` +
  `npm run build`; this batch does not switch package managers.
- **A2 — Light palette values.** No light palette exists anywhere in the repo or the
  design reference. Assumed: implementation derives a warm-paper light theme role-for-role
  (§4.1), constrained by §8's contrast checks, with no pixel-parity requirement (there is
  nothing to be parity with). Exact hexes are not fixed by this spec.
- **A3 — Toggle placement.** Batch 0 requires a manual toggle but the Settings page only
  arrives in Batch 1. Assumed: a minimal cycle control in the sidebar footer now,
  relocated to Settings in Batch 1.
- **A4 — "Minimal migration" definition.** For Connections/Inbox/Projects: keep page code
  and legacy class names; correctness in both themes comes from the legacy CSS layer being
  re-expressed on theme tokens. No component swaps in those three files.
- **A5 — shadcn component set.** Only components with a 1:1 existing counterpart are
  installed in this batch (roughly: Button, Card, Badge, Tabs, Dialog, DropdownMenu,
  Input, Textarea, Select, Checkbox, Switch, Table, Progress, Tooltip if needed). No
  speculative installs for future batches.
- **A6 — Focus ring = yellow.** Today every focused input turns accent-yellow; mapped to
  shadcn `--ring` in both themes. If Leo prefers a quieter light-mode focus color, that is
  a one-token change.
- **A7 — Icons.** `icons.tsx` hand-rolled SVGs may be kept as-is; lucide swap is allowed
  only if visually indistinguishable at current sizes. Not a requirement of this batch.
