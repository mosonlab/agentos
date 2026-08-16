# PLAN — Batch 0: Frontend base migration to Tailwind v4 + shadcn/ui

Status: rev 1, for review · Author: plan agent · Date: 2026-08-16
Spec: `docs/specs/batch-0-frontend-base.md` rev 2 (commit 3be0eaa, PR #1).
Sources honored: `docs/reference/danny-agentos-video/decisions.md` §3, `docs/BACKLOG-V2.md` Batch 0.
This is an implementation plan only. No code changes ship with it.

## 0. Approach summary

Land the base bottom-up in strict dependency order, keeping the app green after every
commit: (1) toolchain, (2) theme tokens with the dark palette copied verbatim and the old
`--ink-*`-style variable names kept alive as aliases, (3) the guarded storage helper,
(4) theme switching (inline pre-paint script + provider + sidebar toggle), (5) the
acceptance fixture in `packages/db`, (6) the dark baseline capture at the merge-base,
(7) shared chrome (`ui.tsx` → shadcn-backed primitives behind unchanged props, then
`Shell.tsx`, `icons.tsx`), (8) the five full-tier pages one commit each, (9) minimal-tier
verification pass, (10) legacy-CSS sweep that deletes the now-dead aliases, (11) the full
acceptance run (§7 gates, §8.3/§8.4 walks, §8.5 matrix).

The alias layer is the load-bearing trick: because every legacy class in `styles.css` is
re-expressed on theme tokens in step 2, all 8 pages render correctly in both themes from
that commit on ("mixed-base period does not ship", spec §6), and page migration becomes a
pure markup refactor with zero visual risk budget.

Recommended execution: **one serial pass for steps 1–7 and 9–11** (they share
`styles.css`, `ui.tsx`, and config files), with **two safe parallel carve-outs**: the
fixture (step 5, touches only `packages/db`) can run as a parallel sub-task any time, and
the five full-tier pages (step 8) can split into two parallel lanes after step 7 lands,
under a "no `styles.css` / no `components/` edits inside page lanes" rule. Details in §3.

## 1. Ambiguities flagged (not decided silently)

The spec leaves these open; the plan proposes a default for each but the review/Leo can
override before implementation:

- **AMB-1 — native `<select>` vs Radix Select.** Spec §5 lists "inputs/select/textarea →
  shadcn form controls", but §3.6 requires interactions to behave *exactly* as before.
  shadcn's Select is Radix-based (custom popover, different keyboard/scroll semantics);
  a swap is a real behavior change on Tasks/Agents forms. **Proposed:** keep native
  `<select>` elements, restyled on tokens (this is the same escape hatch §5 already grants
  the FullPanel overlay); swap Input/Textarea/Button/Checkbox/Switch etc. where behavior
  is genuinely 1:1. If review insists on Radix Select, §8.5 rows using selects get extra
  keyboard-interaction checks.
- **AMB-2 — `--ink-2` mapping is double-booked.** Spec §4.2 maps `--ink-2` to
  "`--popover` and `--input`-related surface", but in shadcn's vocabulary `--input` is a
  *border* color, not a background. **Proposed:** `--ink-2` → `--popover` plus a custom
  `--surface-input` token consumed by form controls; shadcn's `--input` (border role) gets
  `--line` (`#2e2919`), same as `--border`. One extra custom token, no visual delta.
- **AMB-3 — toggle placement vs the misrouted Settings link.** The sidebar footer already
  holds a "Settings" link that points at `/secrets` (known wart, fixed in Batch 1).
  **Proposed:** the theme toggle is a separate third row in `sidebarFoot` (icon-only
  cycle button labeled with the active mode), leaving the misrouted link untouched — no
  scope creep into Batch 1's fix.
- **AMB-4 — fixture invocation surface.** Spec §8.1 says "seed extension or separate
  script". **Proposed:** separate script `packages/db/prisma/acceptance-fixture.ts` with
  npm script `db:fixture` (mirroring `db:seed`), *requiring* the normal seed to have run
  first (it reuses the seeded project/agents). Keeps the production seed byte-identical.
- **AMB-5 — who captures the §8.2 baseline.** The procedure is reviewer-reproducible by
  design; the plan assigns the *first* capture to the implementer (step 6) so the PR ships
  with the artifact attached, and the reviewer regenerates only on suspicion. If Leo wants
  reviewer-side capture instead, step 6 becomes documentation-only.
- **AMB-6 — `GapNotice` hardcoded Chinese copy** (`ui.tsx:154`). Language policy says UI
  English, but i18n is explicitly Batch 1 and Batch 0 forbids copy changes. **Proposed:**
  leave the string byte-identical; note it for the Batch 1 extraction list.

## 2. Numbered steps

Conventions for every step: "Files" is exhaustive for intended edits; "Commit" is the
suggested boundary (one PR, ~13 commits total, each leaving `npm run typecheck && npm run
build` green); "Unlocks" names the spec acceptance items the step makes passable.

### Step 1 — Tailwind v4 + shadcn toolchain

- Add deps to `apps/web/package.json`: `tailwindcss`, `@tailwindcss/vite`,
  `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react` (Radix primitives
  arrive per-component in step 7). No React/ReactDOM/Vite version changes.
- `apps/web/vite.config.ts`: register `tailwindcss()` plugin; add `resolve.alias`
  `@` → `./src`. Proxy/auth block untouched.
- `apps/web/tsconfig.app.json`: add `baseUrl`/`paths` for `@/*`.
- `apps/web/components.json`: shadcn config (style "default", CSS variables mode, css
  `src/styles.css`, alias `@/components`, `@/lib/utils`).
- `apps/web/src/lib/utils.ts`: `cn()`.
- `apps/web/src/styles.css`: prepend `@import "tailwindcss";` only — no token work yet.
- **Files:** `apps/web/package.json`, `package-lock.json`, `apps/web/vite.config.ts`,
  `apps/web/tsconfig.app.json`, `apps/web/components.json`, `apps/web/src/lib/utils.ts`,
  `apps/web/src/styles.css` (1 line).
- **Commit 1:** `feat(web): tailwind v4 toolchain + shadcn scaffolding`.
- **Verification:** root `npm run typecheck` + `npm run build`; `npm ls react react-dom
  vite` majors unchanged; app renders pixel-identical (Tailwind preflight must not fight
  the legacy stylesheet — if preflight resets visibly change anything, scope it or layer
  `styles.css` after it and record the resolution in the commit message).
- **Unlocks:** §7 build gates stay the standing proof for every later step.

### Step 2 — Theme tokens: dark verbatim, light derived, legacy aliases

- Rewrite `apps/web/src/styles.css` head into: Tailwind import → `@theme inline` block
  wiring shadcn token names to CSS vars → `:root { …light values… }` +
  `.dark { …dark values… }` per the spec §4.2 table (dark hexes byte-copied from today's
  file; custom tokens `--border-soft`, `--faint`, `--primary-hover`, `--primary-soft`,
  `--destructive-fg/bg/line`, `--status-{green,amber,violet}-fg/bg/line`, `--link`,
  `--surface-input` per AMB-2, `--radius-card`; `--font-mono` = today's `--mono` stack,
  set as the app default).
- Light values: derived role-for-role (warm paper), recorded by filling the §4.2 table's
  light column in the PR description; constrained by §8.4 contrast gates (checked in
  step 11, adjusted here if they fail).
- **Alias layer:** immediately after the token blocks, re-bind every legacy variable name
  (`--ink-0…5`, `--line*`, `--fg*`, `--accent*`, trios, `--blue`, `--radius-*`, `--mono`)
  to the new tokens (`--ink-0: var(--background);` …). Every existing rule in the file
  then resolves through tokens in both themes without touching the 400 lines of legacy
  rules yet. Also tokenize the file's stray one-off hexes now (scrollbar `#3a3421`, hover
  `#3f381f`, code-bg `#15130c` → token-derived values in both themes).
- Temporarily add `class="dark"` to `<html>` in `apps/web/index.html` (removed in step 4
  when real switching lands) so this commit ships dark-only, exactly as today.
- **Files:** `apps/web/src/styles.css`, `apps/web/index.html`.
- **Commit 2:** `feat(web): shadcn theme tokens — dark verbatim, light derived, legacy vars aliased`.
- **Verification:** build green; dark app visually identical (spot-check /tasks,
  /inbox, a modal); toggling `.dark` off in devtools shows a complete light render with
  zero dark islands on all 8 pages — this is the early §8.4 smoke test.
- **Unlocks:** §6 "mixed-base period does not ship"; precondition for every §8.3/§8.4
  check; minimal-tier pages (§5) are effectively *done* after this step, pending step 9
  verification.

### Step 3 — Guarded storage helper

- New `apps/web/src/lib/storage.ts`: `storage.get(key)`, `storage.set(key, value)`,
  `storage.remove(key)` — try/catch around `window.localStorage`, falling back to a
  module-level in-memory `Map` when storage throws (private mode/disabled); corrupt
  values are the caller's concern (theme module treats unknown as "system", spec §6).
- `apps/web/src/lib/hooks.ts`: `useLocalStorage` initializer and setter route through the
  helper (fixes the unguarded `window.localStorage.getItem` at `hooks.ts:91` that crashes
  startup via `ProjectProvider` — spec A8, the batch's one deliberate behavior delta).
- **Files:** `apps/web/src/lib/storage.ts` (new), `apps/web/src/lib/hooks.ts`.
- **Commit 3:** `feat(web): guarded storage helper; useLocalStorage degrades instead of crashing`.
- **Verification:** build green; in devtools with storage blocked (Chrome "block all
  cookies" or a `localStorage` getter override), app starts, project selection works for
  the session; grep `apps/web/src` for `window.localStorage` — only `storage.ts` hits
  (reviewer step §10.4).
- **Unlocks:** §2 item 6; §6 storage edge cases; §10.4 grep check. Prerequisite for
  step 4's persistence.

### Step 4 — Theme switching: pre-paint script, provider, sidebar toggle

- `apps/web/index.html`: remove step 2's hardcoded `class="dark"`; add a small inline
  `<script>` before the module script: read `agentos.theme` inside try/catch (bare
  `localStorage` here is fine and necessary — it runs before any module loads; document
  the exemption in the helper and the PR for the §10.4 grep), validate against
  `"light"|"dark"` (anything else = system), fall back to `prefers-color-scheme`, and on
  *any* failure default to dark (spec §6 no-JS/no-matchMedia rule); set `.dark` on
  `<html>`. Also make `<meta name="theme-color">` theme-aware (two tags with `media`
  attributes) — the current hardcoded `#0d1117` is a leftover wart.
- New `apps/web/src/lib/theme.tsx`: `ThemeProvider` + `useTheme()` — state
  `"system" | "light" | "dark"`, persisted via `storage.set/remove` on `agentos.theme`
  (remove = system, spec §4.3); keeps `<html>.dark` in sync; subscribes to
  `matchMedia("(prefers-color-scheme: dark)").change` while in system mode; listens to
  `window.storage` events so new-tab/other-tab changes apply live.
- `apps/web/src/main.tsx`: mount `ThemeProvider`.
- `apps/web/src/components/Shell.tsx`: add the toggle to `sidebarFoot` (AMB-3): one
  button cycling system → light → dark, showing the active mode (lucide
  `Monitor`/`Sun`/`Moon`), `aria-label` included. Hidden ≤900px along with the rest of
  the footer, which spec §6 explicitly accepts.
- **Files:** `apps/web/index.html`, `apps/web/src/lib/theme.tsx` (new),
  `apps/web/src/main.tsx`, `apps/web/src/components/Shell.tsx`.
- **Commit 4:** `feat(web): theme switching — system default, manual override, no-flash boot`.
- **Verification:** walk spec §3 scenarios 1–5 manually now (OS dark/light × no key /
  forced key; reload for flash; second tab; OS live-switch via system settings). Build
  green.
- **Unlocks:** §3 scenarios 1–5; §8.4 "Switching" block; §8.5 Shell theme-toggle row;
  BACKLOG Batch 0 item 3.

### Step 5 — Acceptance fixture (parallel-safe; only step touching `packages/db`)

- New `packages/db/prisma/acceptance-fixture.ts` + npm script `db:fixture` in
  `packages/db/package.json` (AMB-4). Idempotent: keyed on stable slugs
  (`fixture-task-todo`, `fixture-goal`, …), delete-then-recreate so re-running resets.
- Creates, against the seeded project (spec §8.1): 4 tasks, one per status, the DOING one
  with a run, run events, and activity-log entries; 1 goal + progress-log entry; 1 secret
  (value `fixture`); 1 MCP connection; 1 OPEN `MULTIPLE_CHOICE` inbox message (≥2
  choices) attached to a synthetic session + run in `WAITING_INBOX` so
  `applyInboxDecisionTx` accepts the answer with no live runner; 1 answered TEXT thread.
  Exact model/relation names come from `packages/db/prisma/schema.prisma` at
  implementation time; the constraint that matters is the `WAITING_INBOX` gate in
  `packages/db/src/workflow.ts`.
- Document invocation + reset in a header comment and one line in the PR description.
- **Files:** `packages/db/prisma/acceptance-fixture.ts` (new),
  `packages/db/package.json`.
- **Commit 5:** `feat(db): dev-only acceptance fixture for the Batch 0 walk`.
- **Verification:** run seed → fixture → fixture again (idempotent); open every §8.3
  route against it; answer the inbox choice from the UI and see ANSWERED +
  run leaving WAITING_INBOX.
- **Unlocks:** §8.1 entirely; makes §8.2 capture and §8.5 execution possible; A9.

### Step 6 — Dark-parity baseline capture (procedure execution, no repo files)

- At the merge-base of the PR branch with the mainline (record the hash in the PR
  description): `npm install`, run API + web, cherry-pick or script-replay the step 5
  fixture records (spec §8.2 allows either; cherry-pick of commit 5 is the cheap path),
  OS dark, viewport 1440×900, capture full-page screenshots of the §8.3 route list
  (12 routes + New Task overlay + one modal + one open dropdown), named by route.
- Zip and attach to PR #1 as the baseline artifact (spec A10 — not committed).
- Repeat the identical capture on the PR head at the end (step 11) for the comparison set.
- **Files:** none in the repo (artifact + PR-description procedure notes only).
- **Commit:** none.
- **Verification:** artifact contains all 15 named captures; hash + viewport + fixture
  noted in the PR description so a reviewer can regenerate.
- **Unlocks:** §8.2; the comparison half of §8.3.
- **Ordering note:** only requires step 5 (fixture) and can run any time before step 11;
  scheduling it here keeps the capture rig warm while the head-side capture rules are
  fresh.

### Step 7 — Shared chrome: `ui.tsx`, `Shell.tsx`, `icons.tsx`

Everything in §5 depends on this; it stays serial and lands as three commits.

- **7a — install shadcn components + migrate `ui.tsx` (full).** `npx shadcn add` for the
  A5 set actually consumed: `button`, `card`, `badge`, `tabs`, `dialog`,
  `dropdown-menu`, `input`, `textarea`, `checkbox`, `switch`, `table`, `progress`
  (+ `select` only if AMB-1 resolves to Radix; `tooltip` only if a call site needs it).
  Generated files land under `apps/web/src/components/ui/*`; restyle their variants to
  tokens where the generated defaults disagree (this is where §3.7 "no stock zinc" is
  won). Then rework `apps/web/src/components/ui.tsx` primitive-by-primitive **behind
  unchanged exported props** so call sites don't churn: `Pill`→Badge variants (tones via
  `--status-*`), `Card`→shadcn Card (keep `flush`), `Tabs`/`Segmented`→shadcn Tabs (two
  styled variants), `Toggle`→Switch, `Check`→Checkbox, `RowMenu`→DropdownMenu (replaces
  `useDismiss` usage there), `Modal`→Dialog (preserve click-outside + scroll containment),
  `FullPanel` stays custom (spec §6 mandates the `inset: 0 0 0 214px` sidebar-visible
  overlay; Dialog can't express it) but its internals restyle on tokens/utilities;
  `Field`, `KeyValue`, `Metric`, `EmptyState`, notices, `ShowMore`, `Markdown`, `Label`,
  `AgentChip` restyle on tokens (no shadcn counterpart). AMB-6: `GapNotice` copy
  untouched.
  **Files:** `apps/web/src/components/ui/*` (new), `apps/web/src/components/ui.tsx`,
  `apps/web/package.json` + lockfile (Radix deps), possibly `apps/web/src/styles.css`
  (retiring rules `ui.tsx` no longer needs — allowed here; forbidden inside step 8 lanes).
  **Commit 6:** `feat(web): shadcn components installed; ui.tsx primitives re-backed, props unchanged`.
- **7b — `Shell.tsx` (full).** Sidebar onto `--sidebar*` tokens via Tailwind utilities;
  project switcher menu → DropdownMenu (or restyled custom — it must keep
  `agentos.projectId` semantics either way); nav active/hover states on `--accent`;
  unread badge preserved; runner row restyled; theme toggle from step 4 restyled if
  needed. Keep the ≤900px collapse behavior.
  **Files:** `apps/web/src/components/Shell.tsx`, maybe `apps/web/src/styles.css`.
  **Commit 7:** `feat(web): shell chrome migrated`.
- **7c — `icons.tsx`.** Keep hand-rolled SVGs as-is (spec A7 default). Only swap
  icon-for-icon to lucide if indistinguishable at current sizes; never mixed styles on
  one screen. Likely a no-op commit folded into 7b.
- **Verification (whole step):** build green; walk all 8 pages in both themes — every
  primitive renders in-palette (§3.7); open Dialog/DropdownMenu and confirm palette +
  click-outside; §8.5 Shell rows (project switcher persistence, nav/badge) pass.
- **Unlocks:** §5 shared-chrome checkboxes; §3.7; §8.5 Shell rows; precondition for
  step 8.

### Step 8 — Full-tier pages (parallelizable, two lanes)

Ground rules for every page commit: markup moves to Tailwind utilities + step 7
components where 1:1 (per AMB-1 resolution for selects); bespoke patterns (kanban board,
event log, metric grid, kv grid, code blocks) become custom classes/utilities on tokens;
**no edits to `styles.css`, `components/`, or `lib/` inside page commits** — needed
shared changes go through a rebase point between lanes or wait for step 10. Zero API,
route, or copy changes; verification for each page = its §8.5 rows in dark, plus a light
render pass.

- **8a — `Tasks.tsx`** (kanban + New Task FullPanel): drag between columns +
  drop-region highlight intact; template picker + `fieldRow` forms intact.
  **Commit 8:** `feat(web): Tasks migrated`. Unlocks §8.5 Tasks rows (5).
- **8b — `TaskDetail.tsx`**: event log, stat pills, run tables, notices, comment box;
  polling untouched. **Commit 9.** Unlocks §8.5 TaskDetail rows (3).
- **8c — `Agents.tsx`** (+ detail): tables, field editors (Switch/Checkbox from step 7),
  code blocks, back links. **Commit 10.** Unlocks §8.5 Agents rows (7).
- **8d — `Goals.tsx`** (+ detail): goal cards, metrics, Progress bars, Tabs, message
  flow. **Commit 11.** Unlocks §8.5 Goals rows (2).
- **8e — `Secrets.tsx`**: table + pills + create/edit-rotate (blank value = keep)/delete
  modals; values stay write-only. **Commit 12.** Unlocks §8.5 Secrets rows (3).
- **Files:** exactly one page file per commit.
- Lane split (if parallelized): lane A = 8a+8b (Tasks domain), lane B = 8c+8d+8e.

### Step 9 — Minimal tier + `App.tsx` sweep

- Verify `Connections.tsx`, `Inbox.tsx`, `Projects.tsx` render correctly in both themes
  on the alias layer with **zero code edits** (spec A4); fix any residue found by
  adjusting the *legacy CSS layer*, not the page files. Walk their §8.5 rows (project
  CRUD/YAML, inbox choice-answer + reply, connections list).
- `apps/web/src/App.tsx`: connection banners and any inline styles onto tokens.
- **Files:** `apps/web/src/App.tsx`, possibly `apps/web/src/styles.css`; ideally not the
  three page files.
- **Commit 13:** `feat(web): App banners on tokens; minimal-tier verified`.
- **Verification:** three pages + banners in both themes; §8.5 *(minimal)* rows pass;
  reviewer check §10.5 (minimal diffs) holds by construction.
- **Unlocks:** §5 minimal checkboxes + App.tsx checkbox; §8.5 minimal rows.

### Step 10 — Legacy CSS sweep

- Remove every `styles.css` rule no longer referenced (grep class names against `src/`);
  remove now-dead legacy variable aliases (any alias still consumed by surviving legacy
  rules — the minimal-tier pages' classes — stays, but re-pointed names are fine since
  they resolve to tokens); confirm no hardcoded surface/text hex outside the token
  blocks.
- **Files:** `apps/web/src/styles.css`.
- **Commit 14:** `chore(web): legacy css sweep — dead rules and aliases removed`.
- **Verification:** `grep -E '#[0-9a-fA-F]{3,8}' apps/web/src/styles.css` hits only token
  definition blocks (§10.4); all 8 pages spot-checked in both themes after the deletion;
  build green.
- **Unlocks:** §5 "Legacy CSS sweep" checkbox; §2 item 5.

### Step 11 — Full acceptance run and PR finalization

Execution procedure for the whole §8 battery (this is where the §8.5 matrix runs):

1. Reset: re-run seed + `db:fixture`; `npm run typecheck && npm run build && npm run
   test` at root; `npm ls react react-dom vite`; grep checks of §10.4 (no
   router/state libs, no bare `window.localStorage` outside `storage.ts` + the documented
   `index.html` boot script, `agentos.theme` only in `theme.tsx`/boot script, no stray
   hex).
2. Head-side §8.2 capture (same rig as step 6), attach artifact, do the side-by-side §8.3
   dark-parity verdict route-by-route.
3. §8.4 light walk on the same route list: dark-island hunt, contrast spot-measurement
   (devtools contrast checker on body text, dim/faint text, yellow button label, each
   status pill), focus-ring visibility both themes. Light token values adjusted here if a
   contrast gate fails (edit is confined to the `:root` block).
4. Switching scenarios §3.1–3.5 re-run (they were first proven in step 4; re-proof on
   final head).
5. **§8.5 matrix execution:** manual walk, devtools Network panel open, fixture freshly
   reset; one pass down the table's 30 rows in dark (the matrix is behavior, not
   theming); tick each row in a checklist copied into the PR description with the
   observed API call. Rows are grouped per page so this folds into ~20 minutes. Any API
   or route diff is a stop-the-line bug.
6. Storage-blocked boot check (§6) and narrow-viewport (≤900px) check.
- **Files:** none beyond fixes the run forces (each fix amends the owning step's area).
- **Commit:** fixes only, plus the PR-description checklist/artifacts.
- **Unlocks:** closes §7, §8.3, §8.4, §8.5, §10.

## 3. Parallelization recommendation

Safe split, in order of value:

1. **Fixture lane (step 5)** — fully independent (`packages/db` only). Can start
   immediately, in parallel with steps 1–4. Zero file overlap.
2. **Page lanes (steps 8a–8e)** — after step 7 merges, lane A (Tasks, TaskDetail) and
   lane B (Agents, Goals, Secrets) touch disjoint single files under the "no shared-file
   edits" rule above; conflicts are structurally impossible. Worth doing: these five
   commits are the bulk of the mechanical work (~1,470 lines of page code).
3. Everything else stays **serial**: steps 1–4 form a strict dependency chain on
   `styles.css`/config; step 7 rewires the module every page imports; steps 9–11 are
   whole-app passes that need all lanes merged.

If sub-agents are unavailable or Leo prefers simplicity, a single serial pass is entirely
reasonable — total code volume is ~3,000 lines of TSX + 459 lines of CSS; the parallel
split saves wall-clock, not risk.

## 4. Coverage map (spec requirement → plan step)

| Spec item | Step(s) |
|---|---|
| §2.1 toolchain, §4.4 interface changes | 1, 7a |
| §2.2 + §4.1–4.2 token mapping, dark verbatim | 2 |
| §2.3 + §4.3 theme switching, §3.1–3.5 | 4, 11.4 |
| §2.4 + §5 page migration (full tier) | 7, 8 |
| §5 minimal tier + App.tsx | 2 (mechanism), 9 (verification) |
| §2.5 legacy layer shrink | 2 (aliases), 10 (sweep) |
| §2.6 guarded storage (A8) | 3 |
| §2.7 + §8.1 fixture (A9) | 5 |
| §3.6 + §8.5 behavior matrix | 8/9 per-page, 11.5 full run |
| §3.7 no stock shadcn | 7a, 11.2 |
| §6 edge cases (storage, no-matchMedia, overlay, ≤900px, mixed-base, scrollbar) | 3, 4, 7a (FullPanel), 2 (scrollbar tokens), 11.6 |
| §7 build gates | every commit; final at 11.1 |
| §8.2 baseline, A10 | 6, 11.2 |
| §8.3 dark checks | 11.2 |
| §8.4 light + switching | 2 (smoke), 11.3–11.4 |
| §9 rollback (single PR, revert-clean) | plan-wide: one PR, no schema/API changes anywhere |
| §10 reviewer procedure | artifacts + checklists produced in 6, 11 |
| A1–A10 | A1→§7 usage throughout; A2→2; A3→4/AMB-3; A4→9; A5→7a; A6→2; A7→7c; A8→3; A9→5; A10→6 |

## 5. Review-loop note

A review pass follows this plan; rev 2 will address its findings must-fix/should-fix
individually. The six AMB items in §1 are the places where a reviewer ruling changes the
plan's shape; everything else should only need local edits.
