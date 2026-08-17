# Batch 1 SPEC — Settings, i18n, sidebar globals, agent model & tool controls

> Step ① (spec) of the nine-step chain for Batch 1. Requirements only; no implementation, no plan.
>
> Scope authority, in this order: the task brief (`docs/briefs/batch-1-settings-i18n.md`), `docs/BACKLOG-V2.md` "批次 1", `docs/reference/danny-agentos-video/detail-gaps.md` §1 and §11, `docs/reference/danny-agentos-video/decisions.md` §2 / §3 / §11 / §12 / §13.
>
> Written against the converged codebase — the frontend-convergence chain (`3c1f186`, legacy `styles.css` retired) and batches 4 and 2.5 (`2737113`, `f5c77ae`) are all merged into `master`. Every file/line anchor below was read at `f5c77ae`.

---

## 1. Problem and audience

The audience is Leo, the single operator of a self-hosted AgentOS, plus the readers of the eventual open-source release.

Five concrete pains, all of them daily:

1. **There is no Settings page.** The sidebar's `Settings` entry links to `/secrets` (`apps/web/src/components/Shell.tsx:91`) — a mislink, with the wrong icon (`IconActivity`). Theme switching lives in a one-line button that cycles `system → light → dark` (`Shell.tsx:92-94`); there is nowhere to see how the machine is configured.
2. **The UI is English-with-Chinese-splinters and cannot be switched.** Twelve hardcoded Chinese strings survive in five files (`App.tsx`, `pages/Connections.tsx`, `pages/Agents.tsx`, `pages/Sessions.tsx`, `components/ui.tsx`); everything else is English literals baked into JSX. Decisions §2 fixes the policy — **UI defaults to English, zh via a dictionary switch** — and nothing implements it.
3. **The sidebar cannot answer "is the runner alive?"** It shows *control-plane* health from `GET /health` labelled `Control plane` (`Shell.tsx:59, 86-90`). Whether the runner daemon is polling, which CLI versions it has, and whether the disk is about to fill are invisible — and CLI version drift plus a full disk are two of the three real failure sources this project has actually hit.
4. **Model and runner are free text, and mismatches cost whole runs.** `Agent.model` is a plain `String` (`packages/db/prisma/schema.prisma:220`) edited through a text input (`pages/Agents.tsx:68, 452`), and `runnerPreference` is a separate select. A `gpt-*` model saved against the CLAUDE runner produces `model_not_found` at spawn time — the 2026-08-16 review-run incident that put items 5 and 6 in the backlog.
5. **The Agents page tells the operator less than it knows.** No per-tool capability control (the original has eight toggles), and the `AgentOS Foundation` block shows text with no indication that it is authoritative, unversioned, or meant to be untouched.

Batch 1 closes all five. It is the last frontend batch of the wave precisely so the i18n sweep runs once, over pages that batches 4 and 2.5 already finished.

---

## 2. Verified starting state

Everything in this section was read from the tree at `f5c77ae`. Later steps may rely on it without re-deriving, but **must** re-verify anything they intend to contradict.

### 2.1 Web app (`apps/web`)

- React 19 + Vite 7, no router library, no state library. Routes are a table in `src/App.tsx:21-42`; navigation is `src/lib/router.tsx`; data fetching is `usePoll` in `src/lib/hooks.ts`.
- Pages: `Agents`, `Archived`, `Automations`, `Connections`, `Goals`, `Inbox`, `Projects`, `Secrets`, `Sessions`, `TaskDetail`, `Tasks`, `Triggers` (12 files, 15 route entries).
- Shared primitives live in two places: hand-written ones in `src/components/ui.tsx` (`Card`, `Field`, `Pill`, `Toggle`, `Check`, `Tabs`, `Segmented`, `RowMenu`, `EmptyState`, `ErrorNotice`, `KeyValue`, `Markdown`, plus exported class-name constants), and shadcn components in `src/components/ui/*.tsx` (13 files).
- Tailwind v4 with `@import "tailwindcss"` and an `@theme inline` token bridge (`src/styles.css:1-20`); ~90 CSS custom properties in `:root` / `.dark` (`styles.css:26-64`); base rules live in `@layer base` (`styles.css:80-95`). `html { font-size: 13px }` is load-bearing — it makes Tailwind's spacing unit 3.25px.
- Theme state: `src/lib/theme.tsx`. `localStorage` key `agentos.theme`, values `light` / `dark`, **absence means `system`**; cross-tab sync via the `storage` event; the `dark` class is toggled on `document.documentElement`.
- `src/tests/styles.test.tsx` reads the built sheet from `apps/web/dist/assets/*.css` and throws if the app was not built (`styles.test.tsx:11-14`). It asserts (a) no unlayered class rule styles the app, (b) the guard's own detection on fixtures, (c) Markdown list markers beat preflight, (d) 14 light-mode contrast pairs ≥ 4.5:1.

### 2.2 The shadcn components are v3-generation

All 13 files under `src/components/ui/` are Tailwind-v3-generation shadcn output:

- 36 occurrences of `React.forwardRef` across the 13 files (v4 generation drops it — React 19 passes `ref` as a normal prop).
- No `data-slot` attributes anywhere (v4 generation puts one on every part).
- v3 focus idiom throughout: `focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring` (`button.tsx:23`), `focus-visible:ring-2 … ring-offset-background` (`switch.tsx:14`, `tabs.tsx:30`) — v4 uses `outline-hidden` plus `focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]`.
- No `aria-invalid:` styling on `input` / `textarea` / `select` (v4 generation ships it).
- Batch 0 already removed the dead `animate-*` classes and the v3 `origin-[--radix-…]` idiom, so **there is no animation in the app today** and `tw-animate-css` is not a dependency.
- The repo has added custom variants that must survive regeneration: `button.tsx` carries `legacy`, `legacyPrimary`, `legacyDanger`, `icon` variants and `legacy`, `legacySmall`, `legacyIcon` sizes, each reproducing a retired `.btn` rule exactly and each documented with the reason (`button.tsx:7-21, 37-59`).

### 2.3 Model and reasoning effort are **one** field, not two

The task brief says "fields exist, pure UI". Verified: there is exactly one field.

- `Agent.model` is a single `String` (`schema.prisma:220`). There is no `reasoningEffort` column anywhere in the schema, and `reasoningEffort` appears nowhere in `packages/` or `apps/` except as a comment.
- The effort is a suffix on that string. `packages/runner/src/adapters.ts:328-332`:
  `Run.model` carries `"<model>[:<effort>]"`, split on the **last** colon (`lastIndexOf(":")`, and only when the index is `> 0`).
- The three CLIs consume the two halves differently (`adapters.ts:343-371`):
  - CLAUDE: `--model <model> --effort <effort ?? "high">`
  - CODEX: `-m <model>` plus, when an effort exists, `-c model_reasoning_effort="<effort>"`
  - PI: `--model <model>` plus, when an effort exists, `--thinking <effort>`
- Effort vocabularies from the captured CLI help (`spikes/cli-capabilities/samples/`):
  - `claude-help.stdout:72-73` — `--effort <level>`: `low, medium, high, xhigh, max`
  - `pi-help.stdout:40` — `--thinking <level>`: `off, minimal, low, medium, high, xhigh, max`
  - `codex-exec-help.stdout` documents `-c key=value` overrides generally but does **not** enumerate `model_reasoning_effort` values.
- **Current canonical matrix (superseding the implementation-time roster):** Specification Writer and Planner use `claude-fable-5:medium` / CLAUDE; Plan Reviser, Implementation Plan Executioner, Frontend Developer, and Senior Developer use `claude-opus-5:high` / CLAUDE; Review Coordinator uses `gpt-5.6-sol:high` / CODEX; Librarian uses `gpt-5.6-luna:high` / CODEX. `openai-codex/gpt-5.6-luna` remains a generic PI catalog and substring-regression case, not a current Librarian assignment.
- `Run.model` is copied from `Agent.model` at the moment the next step's run is created, not at chain-build time (`packages/db/src/workflow.ts:32-50`, `:116`; decisions §12 "配置生效时机").
- The runner heuristic that turns a model into a runner when the preference is `INHERIT` / `AUTO` (`workflow.ts:22-30`):
  explicit `CLAUDE`/`CODEX`/`PI` wins; otherwise `codex` in the id → CODEX, `deepseek` or a `pi` token → PI, else CLAUDE. A generic `openai-codex/…` PI catalog selection would be misrouted by substring if the concrete catalog runner were not persisted, so it remains the regression fixture.
- `npm run db:seed` **upserts and overwrites** `model`, `runnerPreference` and `foundationalPrompt` on every role agent from `agents/roles/*.md` (`packages/db/prisma/seed.ts:121-144`).

### 2.4 Runner liveness: what exists and what does not

- `GET /health` (`packages/api/src/app.ts:556-564`) is public and only answers "can the API reach Postgres". This is what the sidebar renders.
- `Run.heartbeatAt` exists and is written by `POST /runner/runs/:runId/heartbeat` (`app.ts:2451-2470`) — a **per-run** heartbeat, only while a run is executing. There is no daemon-level heartbeat.
- `RunnerBackendState` (`schema.prisma:775-787`) is keyed by `RunnerKind` (one row per CLI backend, not per daemon) and holds `cliVersion`, `authMode`, `capabilities`, `lastPreflightAt`, `lastPreflightOk`, `circuitOpen`, `circuitReason`. It is written by `POST /runner/preflight` (`app.ts:2222-2268`) at daemon startup and before each run.
- The daemon polls `POST /runner/tasks/claim` every `RUNNER_POLL_INTERVAL_MS` (default **5000 ms**, `packages/runner/src/config.ts:30`) forever, sending `runnerId` (`app.ts:252-256`, `packages/runner/src/index.ts:23-31`). `runnerId` defaults to `${hostname()}-${pid}` and is overridable with `RUNNER_ID` (`config.ts:29`).
- Therefore: the API already sees a liveness signal every 5 s, but **stores nothing** when a poll finds no work, and no endpoint reports daemon identity, version, or disk.
- Not available anywhere today: daemon version, disk free, workspace root, per-daemon "busy" flag, runner count.

### 2.5 Per-tool restriction: what each CLI can actually enforce

From the captured help output — this decides the honest shape of item 8:

| CLI | Flag | Evidence |
|---|---|---|
| claude | `--allowedTools, --allowed-tools <tools...>` and `--disallowedTools, --disallowed-tools <tools...>`, e.g. `"Bash(git *) Edit"` | `claude-help.stdout:22-24, 69-71` |
| pi | `--tools, -t <tools>` (allowlist), `--exclude-tools, -xt <tools>` (denylist), `--no-tools`, `--no-builtin-tools` | `pi-help.stdout:34-39` |
| codex | **nothing per-tool** — only `-s/--sandbox <SANDBOX_MODE>` policies and `--dangerously-bypass-approvals-and-sandbox` | `codex-exec-help.stdout:52-62` |

Also relevant: the CLAUDE invocation already passes `--dangerously-skip-permissions` (`adapters.ts:347`), and CODEX already passes `--dangerously-bypass-approvals-and-sandbox` (`adapters.ts:362`).

pi's own tool names are lowercase and partly pi-specific: the help text names `read, bash, edit, write` as built-ins and its examples use `read, grep, find, ls, ask_question` (`pi-help.stdout:1, 113-116`).

### 2.6 Agents page as it stands

- List columns: Name / Model / Runner / Inbox / Updated + row menu (`pages/Agents.tsx:148`). A `Your Agents` segmented control exists with a single option (`:141`).
- Create form: model is an `Input` (`:67-69`), runner a `Select` over `["INHERIT","AUTO","CLAUDE","CODEX","PI"]` (`:24, 70-74`).
- Detail: four tabs (`Setup / Prompt / Capabilities / Collaborators`, `:418-427`); edit mode is a local `draft` saved by `PATCH /agents/:id` with exactly seven fields (`:389-397`).
- Prompt tab: `AgentOS Foundation` card with a `prepended` pill, rendered as a code block when viewing and as a **6-row editable textarea when editing** (`:473-478`), plus the note "This text is placed above the agent instructions for every run."
- Capabilities tab (`:295-372`): Repositories, Skills, MCP Connections, Secrets, Filesystem grants. **No Tools card.**
- The Inbox unread badge and the sidebar dot already exist (`Shell.tsx:61-62, 79-81, 86-90`).

### 2.7 Corrections to the task brief (verified; binding on later steps)

1. **"Sidebar bottom: runner online status … + Inbox unread badge" — the Inbox badge is already shipped.** `Shell.tsx:61-62, 79-81` polls `/inbox/messages` every 5 s and renders the `OPEN` count on the Inbox nav row. Item 4's remaining work is the runner row only; the badge must merely survive the i18n sweep and keep its behaviour.
2. **"model dropdown + reasoning-effort dropdown (fields exist)" — one field, not two.** See §2.3. Both dropdowns are views onto `Agent.model`; saving recomposes `"<model>:<effort>"`.
3. **"heartbeat exists" — not for the daemon.** See §2.4. The existing heartbeat is per-run. Item 7's seven fields require a new read endpoint and new telemetry on the existing claim call.
4. **Item 8 cannot be delivered with zero schema changes.** There is no `tools` field on `Agent`. This batch adds exactly one additive column; see §5.1. The brief's "expected: none" is hereby answered explicitly rather than silently.
5. **Item 8's enforcement is real on CLAUDE and PI, and impossible on CODEX.** See §2.5. The UI must say so rather than imply uniform enforcement.
6. **The auto-link rule "gpt-family → CODEX" is wrong for a supported catalog model.** `openai-codex/gpt-5.6-luna` is a PI model even though its id contains `codex`. It is retained as a generic regression fixture, not the Librarian default. The linkage table must key on the catalog entry, not on a substring match; see §4.6.

---

## 3. Scope

### 3.1 In scope

| # | Item | Section |
|---|---|---|
| 1 | Upgrade the 13 shadcn components to v4 generation; one decision on animations | §4.1 |
| 2 | A real `/settings` page (language, theme, runner and control-plane info) and the sidebar mislink fix | §4.2 |
| 3 | i18n: `en` / `zh` dictionaries, context hook, full extraction sweep, English default | §4.3 |
| 4 | Sidebar bottom: runner online status; keep the Inbox unread badge | §4.4 |
| 7 | Runner status hover popover with seven fields | §4.5 |
| 5 | Agents page: model dropdown + reasoning-effort dropdown | §4.6 |
| 6 | Model choice drives `runnerPreference`; a mismatched pair cannot be saved | §4.6 |
| 8 | Per-tool toggles on the Agents page, wired to CLI-native flags | §4.7 |
| 9 | Foundation block: revision tag, `Read-only` tag, one-line note | §4.8 |

### 3.2 Explicitly out of scope (non-goals)

- **Sign out entry.** Meaningless on single-user localhost with no login (detail-gaps §1). Revisit in the open-source batch.
- **Project-level aggregate unread badge on the project switcher.** Only the Inbox nav badge is in scope (detail-gaps §1).
- **Agent `Status` column (draft / published / archived).** Lands with batch 5's system-agents work (detail-gaps §11, BACKLOG-V2 批次 5).
- **`Default` / `Memory` row tags, agent folders, the memory toggle, MCP quota and `Global` labels, init scripts, `maxNestingDepth`.** All ❌ in detail-gaps §11 — low value, or not needed at a 7-agent roster.
- **Application-layer permission enforcement / sandboxing** (decisions §13). Item 8 is not this: it hands a flag to a CLI that enforces it in-process. Filesystem grants, MCP toggles and `GIT_READ/WRITE` stay unenforced metadata, and this batch does not label them — the honesty pass is an open-source-batch item.
- **Server-side validation of the model/runner pair.** The UI makes a mismatch unsaveable; `PATCH /agents/:id` keeps accepting whatever it is given, and the YAML seed path is untouched. Follow-up in §12.
- **Backend / outbound copy.** Feishu card text and API error strings are not translated here; decisions §2 assigns the Feishu wording to batch 3.
- **New sidebar navigation entries.** Only `Settings` changes destination.
- **Any change to task, run, chain, trigger or session behaviour.** This batch does not touch `workflow.ts` semantics, the scheduler, or delivery.

---

## 4. Intended behaviour, in concrete scenarios

### 4.1 shadcn components move to v4 generation

**Scenario.** A developer opens `src/components/ui/button.tsx` after this batch. It reads like current shadcn output: a plain function component, `data-slot="button"` on the root, `outline-hidden` and the `ring-[3px]` focus idiom — and the `legacy*` variants are still there, still carrying their comments.

Requirements:

1. All 13 components are regenerated to the current (Tailwind-v4) generation. Concretely: no `React.forwardRef` remains under `src/components/ui/`; every exported part carries a `data-slot` attribute; focus rings use the v4 idiom (`focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]`, `outline-hidden`); form controls (`input`, `textarea`, `select`, `checkbox`) carry the v4 `aria-invalid:` treatment.
2. **Local customisations survive byte-identically in effect.** The `legacy*` button variants/sizes, and any other repo-specific class string, are carried across unchanged; their explanatory comments come with them. If a v4 base string would change a `legacy*` rendering, the `legacy*` string wins and the deviation is noted in a comment.
3. **Animation decision, made once here: no animations, and `tw-animate-css` is not added.** Rationale: the app ships zero motion today (batch 0 removed the dead `animate-*` classes); the visual baseline was pixel-verified during the convergence batch; adding motion now would cost a dependency, invalidate that baseline, and deliver no product value. Consequence: regenerated components must have their `animate-in` / `data-[state=closed]:animate-out` utility classes **removed**, exactly as batch 0 did, while keeping the `data-[state=…]` styling hooks that carry non-motion appearance. Reopening this is a scoped follow-up (`@import "tw-animate-css";` plus the classes), not a hidden option left half-wired.
4. Token usage does not change: components keep consuming `--color-*` bridge tokens from `@theme inline` and the semantic custom properties in `styles.css`. No new colour token is introduced by this item.
5. Visual result is unchanged in both themes, on every page, with the sole exception of focus rings, which may thicken from 1–2 px to the v4 3 px. That exception is stated here so review does not treat it as a regression.

### 4.2 A real Settings page

**Scenario.** Leo clicks `Settings` at the bottom of the sidebar. `/settings` opens (not `/secrets`). Three cards: `Appearance`, `Runner`, `Control plane`. He switches the language to 中文; the whole UI is Chinese before the next paint, and it is still Chinese after a reload and in the other browser tab he left open.

Requirements:

1. New route `/settings` in `App.tsx`, new page `src/pages/Settings.tsx`. `/secrets` and its nav entry are untouched.
2. The sidebar's bottom `Settings` link points at `/settings` and uses a settings-appropriate icon (not `IconActivity`). It highlights as active on `/settings` like every other nav row.
3. **Appearance card**
   - `Language`: a segmented control with `English` and `中文`. Default English. Selection is applied immediately, persisted, and mirrored across tabs (§4.3).
   - `Theme`: a segmented control with `System`, `Light`, `Dark` bound to the existing `useTheme` store. The one-line cycling button in the sidebar stays (it is fast and already tested); both controls write the same store and must stay in sync live.
4. **Runner card** — the full version of the popover in §4.5: one row per known daemon (`runnerId`, online/offline dot, `Busy` badge, last seen, daemon version, disk free, poll interval, workspace root) and one row per CLI backend (`claude` / `codex` / `pi`: CLI version, auth mode, last preflight time and result, circuit state and reason). Missing data renders as `—`, never as `0`, `unknown` or a blank cell.
5. **Control plane card**: `/health` status (`ok` / `degraded` / unreachable), the API base URL the web app is talking to, and the time of the last successful poll. No token, no secret, ever — the operator token is injected by the Vite proxy and must not be displayed or logged.
6. The page is read-only apart from the two Appearance controls. It offers no destructive action.
7. Polling: the page refreshes runner data on the same 30 s cadence as the popover (§4.5) and re-uses the same fetch, so opening Settings does not double the request rate.

### 4.3 i18n

**Scenario.** With the language set to 中文, Leo opens every page in the app. There is no English left except proper nouns, identifiers and data that came from the API (agent names, task names, branch names, model ids, enum-shaped ids shown as code). With the language set back to English, there is no Chinese left anywhere — including the five files that hardcode Chinese today.

Requirements:

1. **Module.** `src/lib/i18n.tsx` exports `LocaleProvider`, `useLocale()` (`{ locale, setLocale }`) and `useT()` returning `t(key, vars?)`. `LocaleProvider` wraps the app inside `App.tsx` (outside `Shell`, so the shell itself is translated).
2. **Dictionaries.** `src/locales/en.ts` and `src/locales/zh.ts`, each a flat `Record<string, string>` keyed by dotted namespace: `<area>.<screen>.<thing>`, e.g. `agents.detail.save`, `sidebar.runner.busy`, `common.loading`. Flat and dotted, not nested objects — it keeps the completeness test a set comparison and keeps diffs readable.
3. **Default and persistence.** Default locale is `en` (decisions §2). Persisted in `localStorage` under `agentos.locale`; an absent or unrecognised value means `en`. **The browser's `navigator.language` is not consulted** — a deterministic default is worth more than a clever one here, and Leo reads both languages. Cross-tab sync uses the `storage` event, mirroring `theme.tsx:31-36`.
4. **Lookup and fallback.** `t(key)` returns the active locale's string; if the key is missing there, the `en` string; if that is missing too, the key itself. A missing key never renders blank and never throws in production. §7 makes shipping a missing key impossible anyway.
5. **Interpolation.** `{placeholder}` syntax, substituted from `vars`. No plural engine: counts render as `{n}` inside a fixed phrase (`tasks.count` → `{n} tasks`), and any string where English and Chinese genuinely need different plural shapes gets separate keys. Placeholder sets must be identical between `en` and `zh` for the same key (tested).
6. **What gets extracted.** Every user-visible string in `apps/web/src`: JSX text, button and link labels, table headers, tab and segmented labels, empty states, error notices, hints and field labels, `placeholder`, `title`, `aria-label`, `alt`, and the text passed to `window.confirm`. Including the twelve hardcoded Chinese strings, whose English becomes the `en` entry and whose existing Chinese wording becomes the `zh` entry.
7. **What does not get extracted.** Values from the API (names, ids, paths, branches, shas, model ids, error text from the server); code blocks and JSON; the string `AgentOS`; punctuation-only and symbol-only strings (`·`, `—`, `/`). Enum-shaped values that the UI presents as human labels (run status, task status, runner kind, permission level) **do** get keys, one per value, under `status.*` / `runner.*` / `permission.*`; the raw enum token may still be shown as code where it is a technical identifier.
8. **Formatting follows the locale.** `src/lib/format.ts` currently pins `en-US` (`format.ts:1-2`). After this batch the date/time formatters take the active locale (`en-US` / `zh-CN`), and the English fragments inside `timeAgo` and `duration` (`just now`, `{n}m ago`, `{n}h ago`, `{n}d ago`, `{n}m {n}s`) become dictionary keys. The `—` placeholder, `$` money formatting and `compactTokens` suffixes (`K`, `M`) stay as they are.
9. **Size.** The brief's "~548 strings" is a 2026-08-15 estimate, taken before batches 2, 2.5 and 4 added `Sessions`, `Automations`, `Triggers`, `Archived`, `chain-list` and `tasks-tabs`. A crude literal sweep over the current 21 source files already finds ~370 occurrences with a pattern that cannot see template literals, ternaries or array-literal labels, so the real figure is comfortably above the estimate; plan for **600–800**. The count is not an acceptance criterion — §7's sweep test is.
10. **Batching is allowed, incompleteness is not.** The mechanical sweep may land as several commits (per the brief), but the batch is not complete while any user-visible literal remains outside the dictionary, and the zh dictionary must cover 100 % of `en` keys — not only "touched pages", since the sweep touches every page.

### 4.4 The sidebar's bottom block

**Scenario.** The runner daemon is running. The sidebar bottom shows a green dot, `Runner`, and `Running`. Leo stops the daemon; within ~30 s the dot goes grey and the label reads `Offline`. He starts it again; within ~30 s it is green again. Throughout, the Inbox badge keeps showing the open-message count.

Requirements:

1. The runner row replaces today's `Control plane` row: dot + `Runner` + a state word (`Running` when online and idle, `Busy` when online with an active run, `Offline` when stale, `Never seen` when the API has no record of any daemon).
2. Dot tone: green = online, amber = online-but-degraded (any CLI backend circuit open), grey = offline or never seen.
3. Control-plane health does not disappear — it moves into the popover (§4.5) and the Settings page (§4.2). If `/health` is failing, the popover says so at the top, because in that state the runner information is untrustworthy.
4. The Inbox unread badge is unchanged in behaviour, count source (`GET /inbox/messages`, `status === "OPEN"`), and cadence (5 s). Only its `aria-label` and any adjacent copy pass through `t()`.
5. Nothing in this row links anywhere; the popover is the interaction, and the Settings page is the full view.

### 4.5 Runner status popover

**Scenario.** Leo hovers the runner row. A popover appears with the header `Local runner`, the line `1 of 1 runner online`, then: `agentos-runner-1` with a `Busy` badge, `Last heartbeat 20s ago`, `Daemon version 0.1.0`, `Claude CLI 2.1.226`, `Codex CLI 0.147.0`, `Pi CLI —`, `Disk free 132.4 GB`, and the footer `Refreshes every 30s`. He tabs to the row with the keyboard; the same popover opens.

Requirements:

1. All seven fields from detail-gaps §1 are present: runner name, `Busy` badge, last heartbeat, daemon version, CLI version, disk free, refresh cadence. CLI version is shown per backend (three lines) because our daemon drives three CLIs; the original's single line is a one-CLI simplification.
2. Opens on hover **and on keyboard focus**, dismissible with `Escape`. A hover-only affordance is not acceptable for the sidebar's only status surface.
3. Values and their empty states:
   - runner name — the `runnerId` reported by the daemon; if several daemons are known, one block per daemon, sorted by name.
   - `Busy` — shown when that daemon owns at least one run in an active status; otherwise the badge is absent (not a grey `Idle` badge).
   - last heartbeat — relative (`20s ago`, `3m ago`), from the last time that daemon called the API for any reason.
   - daemon version — the `@agentos/runner` package version reported by the daemon; `—` if the daemon predates this batch.
   - CLI versions — from `RunnerBackendState.cliVersion` per `RunnerKind`; `—` when a backend has never preflighted.
   - disk free — free bytes on the workspace-root filesystem, rendered with one decimal in GB; `—` if unavailable.
   - refresh cadence — the web app's own polling interval, stated as a fact (`Refreshes every 30s`), not a configurable.
4. Degraded states are visible, not hidden: a backend with `circuitOpen` shows its `circuitReason`, truncated to one line; a `/health` failure shows a line at the top of the popover.
5. Online rule: a daemon is online when its last-seen timestamp is within `max(3 × its reported poll interval, 30 s)`. This tolerates one missed poll and a slow request without flapping.
6. The popover must not become a second polling loop: it renders whatever the sidebar's 30 s `GET /runners` poll last returned, and does not fetch on open.

### 4.6 Model, reasoning effort, and the runner they imply

**Scenario A.** Leo edits `senior-dev`. `Model` is a dropdown showing `Claude Opus 5`; `Reasoning effort` shows `high`; `Runner` shows `claude` and is read-only with the hint `Set by the model`, matching the canonical default. Selecting another catalog model changes the runner in the same interaction; cancelling leaves the stored canonical pair unchanged.

**Scenario B.** Leo picks the effort `max` for a claude model, then switches to a model whose vocabulary lacks it. The effort falls back to that model's default rather than silently sending an invalid flag.

**Scenario C.** Leo needs a model that is not in the catalog. He picks `Custom…`, types the id, and the `Runner` select becomes editable again with a visible warning that the pairing is his responsibility.

Requirements:

1. **Catalog module** `src/lib/models.ts`, config only (decisions §6.4: "模型 ID 只准出现在配置"): entries of `{ id, label, runner: "CLAUDE" | "CODEX" | "PI", efforts: string[], defaultEffort: string }`.
2. The catalog must contain every model the current roster uses, so that no existing agent renders as `Custom` after this batch: `claude-fable-5`, `claude-opus-5`, `gpt-5.6-sol`, `gpt-5.6-luna`, `openai-codex/gpt-5.6-luna` (runner PI — the case that breaks substring matching). It should also carry the other current Claude models (`claude-sonnet-5`, `claude-haiku-4-5`) so changing an agent remains a two-click operation. **Supersession (2026-08-17):** Leo restored Fable as the canonical medium-effort model for Specification Writer and Planner; this replaces the earlier Fable-retirement clause.
3. **Effort vocabularies come from the CLI, not from taste**: CLAUDE `low, medium, high, xhigh, max` (`claude-help.stdout:72-73`); PI `off, minimal, low, medium, high, xhigh, max` (`pi-help.stdout:40`). CODEX's `model_reasoning_effort` values are not documented in the captured help; the implementation step must verify them against the installed `codex` before widening beyond the values already in production use (`high`, `xhigh`, `max`). Offering an effort the CLI rejects would trade a model mismatch for an effort mismatch.
4. **Encode / decode in one place.** A single pair of helpers splits `"<model>[:<effort>]"` on the last colon and recomposes it, matching `adapters.ts:329-331` exactly — including the `> 0` index rule and provider-prefixed ids like `openai-codex/gpt-5.6-luna:xhigh`. An agent whose stored model carries no effort suffix shows the model's default effort in the dropdown but **is not rewritten on load**; only an explicit save writes a suffix.
5. **Linkage (item 6).** Selecting a catalog model sets `runnerPreference` to that entry's `runner` — a concrete kind, never `INHERIT`, so the `workflow.ts:22-30` heuristic is bypassed and a provider-prefixed PI catalog model such as `openai-codex/…` cannot be routed to CODEX.
6. **Mismatch is unsaveable.** With a catalog model selected, the `Runner` control is read-only and displays the derived value. If the loaded agent has a contradictory stored pair (possible: it was written by seed or by an earlier build), the form shows an inline notice naming both values and the save writes the corrected pair. Save is disabled while any inline validation error is present.
7. **`Custom…` keeps the escape hatch.** Free-text model id, free choice of runner (including `INHERIT` / `AUTO`), and a visible warning line. Losing the ability to type a model id would make the app unable to run a model released after the last catalog edit.
8. Both the create form and the detail edit form use the same control, with the same rules.
9. The Agents list `Model` column shows the model label and the effort as a separate muted token, so the roster review Leo does after this batch (decisions §12) is readable at a glance.
10. **Known interaction, must be documented in the UI hint**: `npm run db:seed` overwrites `model` and `runnerPreference` from `agents/roles/*.md` (`seed.ts:121-144`). A model chosen in the UI survives restarts but not a re-seed. One line in the Agents page hint or the Settings runner card saying so is required; changing seed behaviour is out of scope (§12).

### 4.7 Per-tool toggles

**Scenario.** Leo opens `senior-dev` → Capabilities. A `Tools` card lists eight toggles — Bash, Read, Write, Edit, Glob, Grep, Web fetch, Web search — all on. He turns Bash off and saves. The next run of that agent spawns with the CLI told to refuse Bash, and the agent's own attempt to run a shell command fails inside the session rather than being politely ignored by the app.

**Scenario B.** The agent runs on CODEX. The same eight toggles are shown, and a line above them reads `codex has no per-tool switch — these toggles are not enforced for this agent`. The toggles are still editable and still stored, so switching the agent to a CLAUDE model later makes them take effect.

Requirements:

1. Eight canonical tool keys, stored per agent: `BASH, READ, WRITE, EDIT, GLOB, GREP, WEB_FETCH, WEB_SEARCH`.
2. **The stored value is the denied set** (`Agent.disabledTools`, §5.1). Empty means "everything allowed", which is exactly today's behaviour, so existing agents need no backfill and a rollback loses nothing.
3. **Mapping to CLI flags** (`packages/runner/src/adapters.ts`, inside `argsForRunner`):
   - CLAUDE — `--disallowedTools <names…>` with the canonical claude names `Bash Read Write Edit Glob Grep WebFetch WebSearch`. A deny list is used rather than `--allowedTools` because the invocation already carries `--dangerously-skip-permissions`, and a deny list is the form that cannot be read as "these are pre-approved".
   - PI — `--exclude-tools <names…>` with pi's lowercase names, **only for keys whose pi name the implementation step verifies against the installed `pi --help`** (`bash`, `read`, `write`, `edit`, `grep` are named in the help text; `GLOB`, `WEB_FETCH`, `WEB_SEARCH` have no verified pi equivalent).
   - CODEX — nothing. No flag exists (§2.5).
   - When the denied set is empty, the emitted argument list must be **byte-identical to today's** for all three runners.
4. **The UI states the truth per agent.** The Tools card shows which runner the agent resolves to and which of its OFF toggles that runner enforces; unenforceable keys carry a `not enforced on <runner>` tag. This is the decisions §13 honesty principle applied at the point of the claim, not a footnote.
5. **Enforcement must be demonstrated, not assumed.** Before the batch may claim enforcement, the implementation step runs one real CLAUDE session with a tool denied and captures the evidence into `spikes/cli-capabilities/samples/` (the existing capture harness). If the deny list turns out not to bind under `--dangerously-skip-permissions`, the fallback order is: (a) `--allowedTools` with the complement set, verified the same way; (b) if that fails too, ship the toggles as stored-but-unenforced with the honest tag on every runner and open a follow-up. **Under no circumstance does the UI claim enforcement that was not observed.**
6. The toggles are read at claim time like the model (`workflow.ts:32-50`), so a change applies to runs not yet started and never to a run in flight.

### 4.8 Foundation block

**Scenario.** Leo opens an agent's Prompt tab. The `AgentOS Foundation` card carries two tags — a revision tag and `Read-only` — and the line `Sits above your instructions`. The text is no longer editable; the card says where to change it.

Requirements:

1. Tags: a revision tag and `Read-only`, plus the one-line note `Sits above your instructions` (replacing today's longer sentence, which stays available as the card's hint).
2. **`Read-only` must be true, so the textarea goes.** The foundation is authoritative by design (`agents/foundational.md` → seeded into every agent, `seed.ts:56-57, 128, 138`), and per-agent divergence is a bug, not a feature. Editing moves out of the UI, and `foundationalPrompt` is removed from the `PATCH /agents/:id` payload the web app sends (`Agents.tsx:389-397`) and from the create form. The card names the real edit path: `agents/foundational.md` + `npm run db:seed`.
3. **The revision tag says what we actually know.** We store a per-agent copy with no version marker (`agents/foundational.md` frontmatter is `name: foundational` only). The tag therefore renders a content revision — the first 7 hex characters of a hash of the agent's stored foundation, shown as `rev 3f9a2c1`, with a title attribute explaining it. This is honest, costs nothing, and makes divergence between two agents visible immediately. A semantic `v6`-style version needs a versioned foundation source and is recorded as an open question (§11).
4. The full text stays visible in the existing code block; no collapsing is introduced.

---

## 5. Data and interface changes

### 5.1 Schema — one additive column, one migration

This is the batch's only schema touch, and it exists because item 8 has nothing to store into (§2.7 correction 4).

```prisma
model Agent {
  // …
  disabledTools String[] @default([])
}
```

- Values are the canonical keys from §4.7.1. Prisma `String[]` (Postgres `text[]`), consistent with `MCPConnection.allowedOperations` (`schema.prisma:285`) and `Environment.allowedHosts`.
- One migration under `packages/db/prisma/migrations/`, additive only: `ALTER TABLE "Agent" ADD COLUMN "disabledTools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];`
- **No data is dropped or rewritten**, so no precheck script and no row-count guard are required (contrast BACKLOG-V2 "迁移的破坏性守卫不对称"). The rollback runbook (§9) must nonetheless exist because the column is new.
- `seed.ts` is not changed: its `update` block does not mention `disabledTools`, so re-seeding preserves whatever the UI stored.

Nothing else in the schema changes. `Agent.model` keeps its `"<model>[:<effort>]"` encoding; no `reasoningEffort` column is added (a second column would create two sources of truth against `adapters.ts:329`).

### 5.2 HTTP endpoints

**New: `GET /runners`** — operator-readable, runner-token-forbidden, project-independent.

```jsonc
{
  "checkedAt": "2026-08-17T01:22:03.114Z",
  "online": 1,
  "total": 1,
  "daemons": [{
    "runnerId": "agentos-runner-1",
    "lastSeenAt": "2026-08-17T01:22:01.002Z",
    "online": true,
    "busy": true,
    "activeRuns": 1,
    "daemonVersion": "0.1.0",
    "diskFreeBytes": 142234763264,
    "pollIntervalMs": 5000,
    "workspaceRoot": "/Users/leo/.agentos/runs"
  }],
  "backends": [{
    "runner": "CLAUDE",
    "cliVersion": "2.1.226",
    "authMode": "subscription",
    "lastPreflightAt": "2026-08-17T00:58:11.000Z",
    "lastPreflightOk": true,
    "circuitOpen": false,
    "circuitReason": null
  }]
}
```

- `backends` is read from `RunnerBackendState` (all three `RunnerKind` values are always present in the array; unknown ones carry nulls).
- `busy` / `activeRuns` are computed from `Run` rows whose `runnerId` matches and whose status is in `ACTIVE_RUN_STATUSES` (`packages/db/src/workflow.ts:205`) — the shared set, not a second list.
- `online` uses §4.5.5's rule.
- **The path must not begin with `/runner/`.** `principalMayAccess` (`packages/api/src/auth.ts:48-53`) forbids the operator principal from `/runner/*` outright and confines the runner principal to it. `/runners` satisfies this (the guard tests the prefix `"/runner/"`, trailing slash included), but the constraint is what matters: if a different name is chosen it must stay outside that prefix, and the guard must not be loosened to accommodate it. A test asserts operator-allowed / runner-forbidden either way.

**Changed: `POST /runner/tasks/claim`** — the request body gains four optional telemetry fields, all validated and all ignorable:

```ts
daemonVersion?: string      // ≤ 40 chars
diskFreeBytes?: number      // non-negative integer
pollIntervalMs?: number     // positive integer
workspaceRoot?: string      // ≤ 500 chars
```

They are optional so that an older daemon polling a newer API keeps working (it just reports `—` for those fields). The same fields are accepted, with the same semantics, on `POST /runner/runs/:runId/heartbeat` so a busy daemon mid-run also refreshes its last-seen without waiting for its next claim.

**Changed: the claim response's agent projection** gains `disabledTools: string[]` (`app.ts` claim handler; `packages/runner/src/api.ts:28-34` type).

**Unchanged**: `/health`, `/runner/preflight`, and every task/run/session/inbox endpoint. `PATCH /agents/:id` gains `disabledTools` as an accepted field and **loses nothing** — but the web client stops sending `foundationalPrompt` (§4.8.2); the server keeps accepting it so the CLI and any script are unaffected.

### 5.3 Daemon-side changes (`packages/runner`)

- Reports `daemonVersion` (its own package version), `diskFreeBytes` (free space on `config.workspaceRoot`), `pollIntervalMs` and `workspaceRoot` on every claim poll and every run heartbeat. A failure to read disk stats is not fatal: the field is omitted and the poll proceeds.
- `argsForRunner` applies the tool mapping from §4.7.3.
- No change to preflight, delivery, workspace provisioning, or the failure classifier.

### 5.4 API-side state

The daemon registry is **in-process**: a `Map<runnerId, telemetry>` in the API, updated on claim and heartbeat, read by `GET /runners`. Rationale: on a single-user localhost control plane, this state is worthless one poll interval after a restart, and a table for it would be the batch's second migration for no gain. Consequences, both acceptable and both required to be visible in the UI: an API restart shows `Never seen` until the next claim poll (≤ 5 s by default), and a multi-process API deployment would show a partial view. If a later batch makes the API multi-process, this moves to a table.

### 5.5 Frontend modules

| Path | Kind | Purpose |
|---|---|---|
| `src/lib/i18n.tsx` | new | provider, `useLocale`, `useT`, fallback chain |
| `src/locales/en.ts`, `src/locales/zh.ts` | new | flat dictionaries |
| `src/lib/models.ts` | new | model catalog, effort vocabularies, split/join helpers, `runnerForModel` |
| `src/lib/tools.ts` | new | the eight canonical keys, per-runner enforcement map, labels |
| `src/pages/Settings.tsx` | new | the Settings page |
| `src/components/runner-status.tsx` | new | sidebar row + popover, fed by one `/runners` poll |
| `src/components/ui/hover-card.tsx` | new | shadcn v4 hover-card (opens on hover and focus) |
| `src/components/ui/*.tsx` | rewritten | v4 generation (§4.1) |
| `src/components/Shell.tsx` | changed | Settings link and icon, runner row, translated labels |
| `src/App.tsx` | changed | `/settings` route, `LocaleProvider`, translated fallbacks |
| `src/lib/format.ts` | changed | locale-aware dates, dictionary-driven relative time |
| `src/pages/*.tsx`, `src/components/*.tsx` | changed | i18n sweep; Agents also gets §4.6–§4.8 |

The hover-card is the batch's only new runtime dependency (`@radix-ui/react-hover-card`), and it is required because item 7 asks for a hover affordance that must also be keyboard-reachable.

### 5.6 What must not change

- The token set and values in `styles.css`, `html { font-size: 13px }`, and the `@layer` discipline the convergence batch established. `styles.test.tsx` stays green **without being edited**.
- `workflow.ts` semantics: `runnerFor`, `deriveRunConfig`, chain activation, branch derivation.
- Run/task/session/trigger behaviour, the scheduler, delivery, the failure classifier.
- The Inbox badge's count source and cadence.
- The `legacy*` button variants' rendering.
- `agents/roles/*.md` and `agents/foundational.md` content (Leo's model re-review after merge is done in the UI, per decisions §12).

---

## 6. Edge cases and failure behaviour

1. **`GET /runners` fails or 500s.** The sidebar shows the grey dot with `Unknown`, the popover shows the error and the last known values with their age. It never shows a stale `Running`.
2. **API restarted, daemon not yet polled.** `Never seen` (distinct from `Offline`), with a popover line saying the control plane has not heard from a daemon since it started.
3. **Daemon older than this batch.** It sends no telemetry; `daemonVersion`, `diskFreeBytes`, `workspaceRoot` render `—`, `online` still works (last-seen is recorded from the request itself), and the popover does not pretend the fields are zero.
4. **Two daemons registered** (the multi-process concurrency the backlog contemplates). The popover shows `N of M runner online` and one block per daemon; the sidebar dot is green if any daemon is online.
5. **Disk nearly full.** `Disk free 1.2 GB` renders in the destructive tone below a stated threshold (2 GB), because this is one of the three failure modes the field exists to catch. No modal, no alert — a colour.
6. **A CLI backend's circuit is open.** Amber dot, the reason on one line in the popover, full reason in Settings.
7. **Language switched while a poll is in flight.** Rendering is pure; the next paint is in the new language. No refetch, no data loss, no form reset — including a half-filled agent edit draft.
8. **A dictionary key is missing at runtime.** Falls back to English, then to the key. The sweep test (§7) makes this unreachable in a merged build.
9. **Stored model is not in the catalog** (typed by an older build or written by seed). The dropdown shows `Custom…` pre-filled with the stored id; nothing is silently rewritten.
10. **Stored model/runner pair is contradictory.** Inline notice naming both; the next save corrects it. Loading such an agent must not auto-save.
11. **Effort suffix that the target CLI does not accept** (e.g. `:max` carried onto a CODEX model whose vocabulary lacks it). On model change, an unavailable effort falls back to the new model's default and the change is visible in the control before saving.
12. **Model string with several colons** (`openai-codex/gpt-5.6-luna:xhigh`). Split on the last colon only, matching `adapters.ts:330`. A model id containing a colon in its provider segment stays intact.
13. **All eight tools disabled.** Allowed, and the UI says plainly that the agent will have no tools. This is a legitimate configuration for a pure-reasoning agent.
14. **Tools disabled on a CODEX agent.** Stored, tagged as not enforced (§4.7.4), applied automatically if the agent later moves to a CLAUDE model.
15. **A run is in flight when tools or model change.** The running run is unaffected (config is read at claim time); the UI does not suggest otherwise.
16. **Re-seed after a UI model change.** `npm run db:seed` reverts `model` and `runnerPreference` to the role file (`seed.ts:121-144`). Documented in the UI hint (§4.6.10); `disabledTools` is preserved.
17. **`localStorage` unavailable** (private mode, disabled storage). `src/lib/storage.ts` already swallows this; language falls back to `en` per session and the app keeps working.
18. **Foundation card on an agent whose stored foundation diverges from the seed.** The revision tag differs from other agents' — which is the point of showing it. No warning banner, no auto-repair.

---

## 7. Test expectations

Every item below is a `node --test` file under the existing harness (`apps/web` runs `TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx --test src/**/*.test.tsx`).

**i18n**

1. `zh` and `en` have identical key sets (assert both directions, so a removed English key cannot leave an orphan).
2. No dictionary value is empty or whitespace-only.
3. For every key, the `{placeholder}` set is identical in both locales.
4. `t()` returns the active locale's string; falls back to `en` for a key missing in `zh`; returns the key when it is in neither.
5. Locale persistence: unknown/absent `agentos.locale` → `en`; setting a locale writes it; a `storage` event from another tab updates the provider.
6. **Sweep guard**: a source scan over `src/pages/**` and `src/components/**` finds no user-visible literal outside the dictionary — JSX text nodes and the attribute set from §4.3.6 containing two or more consecutive letters. An explicit allowlist file holds the justified exceptions (proper nouns, symbols) and is asserted to be small. This test is the batch's real acceptance mechanism for item 3, and it must fail loudly on a fixture that reintroduces a literal.

**Models, effort, runner linkage**

7. Catalog integrity: every model id in `agents/roles/*.md` is either in the catalog or explicitly listed as intentionally absent; every entry's `defaultEffort` is in its `efforts`; no entry has an empty `efforts`.
8. Split/join round-trips for `claude-opus-5:high`, `gpt-5.6-luna:max`, `openai-codex/gpt-5.6-luna:xhigh`, and a bare `claude-opus-5` — and matches `adapters.ts`'s rule on a leading-colon input.
9. `runnerForModel` returns `PI` for `openai-codex/gpt-5.6-luna` — the case the `workflow.ts:22-30` substring heuristic gets wrong.
10. Form behaviour: choosing a gpt catalog model sets `CODEX`; choosing a claude model sets `CLAUDE`; the runner control is read-only for catalog models and editable for `Custom…`; a contradictory loaded pair renders the notice; save is blocked while a validation error is present; switching to a model without the current effort falls back to that model's default.

**Runner status**

11. `GET /runners`: shape; `online` computed from last-seen versus `max(3 × pollInterval, 30 s)`; `busy` from active runs; all three backends always present; operator token allowed, runner token forbidden.
12. The claim handler records telemetry into the registry, tolerates a claim body with none of the four optional fields, and rejects out-of-range values without failing the claim itself.
13. Popover rendering: all seven fields; `Busy` badge present only when busy; `Never seen` versus `Offline`; `—` for missing daemon version and disk; disk below the threshold renders in the destructive tone; circuit reason shown.

**Tools**

14. `argsForRunner` with an empty denied set produces argument lists byte-identical to the current ones for CLAUDE, CODEX and PI (a snapshot assertion, so the no-op case cannot drift).
15. With `["BASH","WEB_SEARCH"]`: CLAUDE gets `--disallowedTools Bash WebSearch` (stable order); PI gets `--exclude-tools bash` only (no verified pi name for web search); CODEX's arguments are unchanged.
16. The claim payload carries `disabledTools`; `PATCH /agents/:id` accepts and persists it; an unknown key is rejected rather than stored.
17. The Tools card renders all eight toggles, marks the unenforceable ones for the agent's resolved runner, and shows the CODEX-wide notice.

**Components and regressions**

18. `src/components/ui/**` contains no `forwardRef`, and every component file exports a part carrying `data-slot`.
19. `styles.test.tsx` passes **unmodified**, including the layer guard and the 14 contrast pairs.
20. The existing `primitives.test.tsx`, `input-semantics.test.tsx`, `row-menu.test.tsx` and the batch-2.5/4 test files pass unchanged except where a label they assert is now a dictionary lookup — in which case they assert the English string via `t()`, not a hardcoded literal.

**Command sequence for acceptance** (order matters — the styles test reads `dist`):

```
npm run build          # all six workspaces, including @agentos/web
npm test               # all workspaces
npm run typecheck
npm run db:migrate     # the one additive migration
```

---

## 8. Reviewer verification (how a human checks the feature works)

With the API, the web app and the runner daemon running against the real database:

1. **Build first, then test.** `npm run build && npm test` — green, including `styles.test.tsx`. Then confirm `git status` is clean and no test file was weakened to pass (diff `src/tests/` deliberately).
2. **Settings.** Click `Settings` in the sidebar → lands on `/settings`, not `/secrets`. The `Secrets` nav entry still opens `/secrets`.
3. **Language.** Switch to 中文. Walk all 15 routes (`/tasks`, a task detail, `/automations`, `/triggers`, a trigger detail, `/archived`, `/sessions`, a session detail, `/agents`, an agent detail with all four tabs, `/inbox`, a thread, `/goals`, a goal, `/projects`, a project, `/connections`, `/secrets`, `/settings`): no English copy other than proper nouns, identifiers and API data. Switch back to English: no Chinese anywhere — specifically check the two error banners in `App.tsx` (stop the API to see the connection banner) and the Connections page.
4. **Persistence.** Reload with 中文 selected → still Chinese. Open a second tab, switch language there → the first tab follows.
5. **Theme.** Toggle from the sidebar and from Settings; both stay in sync; `system` follows the OS appearance; reload preserves the choice.
6. **Runner popover.** Hover the runner row: seven fields present with real values. `Tab` to the row: the same popover opens; `Escape` closes it. Stop the daemon (`launchctl` is off-limits for the agent steps of this chain — the reviewer does this by hand): within ~30 s the dot goes grey and the state reads `Offline`. Start it: green again within ~30 s. Start a run: `Busy` appears.
7. **Disk and CLI facts are real, not hardcoded.** Compare `Disk free` against `df -h` on the workspace volume and `Claude CLI` against `claude --version`.
8. **Model dropdown.** Open `senior-dev`: model shows `Claude Opus 5`, effort shows `high`, and runner shows `claude` read-only. Confirm the database already has `Agent.model = 'claude-opus-5:high'` and `runnerPreference = 'CLAUDE'`. A temporary unsaved catalog change updates the displayed runner in the same interaction; cancel it without changing the canonical pair.
9. **Mismatch is unreachable.** Try to produce a `gpt-*` model on the CLAUDE runner through the UI: impossible with a catalog model; possible only under `Custom…`, where the warning is visible.
10. **Canonical Librarian and generic PI regression.** Open `librarian`: it shows `gpt-5.6-luna:high` on `codex`. Separately select the generic `openai-codex/gpt-5.6-luna` catalog entry in an unsaved form and confirm its derived runner is `pi`, not `codex`; cancel without mutating the Librarian default.
11. **Tools.** Turn Bash off on a CLAUDE agent, dispatch a trivial task that requires a shell command, and read the session events: the tool call is refused by the CLI. Then check `spikes/cli-capabilities/samples/` for the captured evidence the implementation step was required to produce (§4.7.5). On a CODEX agent, confirm the "not enforced" notice is present.
12. **Foundation.** Prompt tab shows the revision tag, `Read-only`, and `Sits above your instructions`; the text cannot be edited; the card names `agents/foundational.md` + `npm run db:seed`.
13. **Component generation.** `grep -rn "forwardRef" apps/web/src/components/ui/` returns nothing; spot-check two components for `data-slot`; confirm no `tw-animate-css` import and no `animate-in` class anywhere.
14. **Migration.** `npm run db:migrate` applies one additive migration; `npm run db:drift-check` is clean; existing agents have `disabledTools = {}`.
15. **Rollback rehearsal.** Follow §9 on a scratch database and confirm the app runs on the reverted code with the column dropped.

---

## 9. Rollback notes

The batch is UI-heavy with exactly one schema touch, called out here as the brief requires.

**Schema.** One additive column, `Agent.disabledTools TEXT[] NOT NULL DEFAULT '{}'`. No table is dropped, no column is removed, no data is rewritten; therefore no precheck script and no row-count guard.

**Rollback procedure** (to be written up as `docs/runbooks/batch-1-rollback.md` by the implementation step, matching `docs/runbooks/batch-2.5-rollback.md`):

1. Revert the merge commit. The web app returns to its previous behaviour immediately; nothing in the app reads `disabledTools` any more.
2. The column may be left in place indefinitely — the reverted code never selects it and `seed.ts` never writes it. **Leaving it is the recommended action**: dropping it discards the only data the batch creates.
3. If it must go: `ALTER TABLE "Agent" DROP COLUMN "disabledTools";` — this permanently discards every per-agent tool restriction. Capture them first: `SELECT name, "disabledTools" FROM "Agent" WHERE array_length("disabledTools", 1) > 0;`
4. Nothing else needs rollback. The daemon-registry telemetry is in-process (§5.4) and disappears with the process; the extra claim-body fields are optional, so a reverted API ignores a newer daemon's telemetry and a reverted daemon simply sends none.
5. The runner-side tool flags disappear with the reverted `adapters.ts`; an in-flight run is unaffected because arguments are fixed at spawn.

**Blast radius if the batch is bad but not reverted.** The worst realistic failures are (a) a wrong tool-flag mapping making agents unable to work — mitigated by the empty default and by the byte-identical no-op assertion in §7.14; (b) a bad effort value reaching a CLI — mitigated by CLI-derived vocabularies (§4.6.3); (c) an i18n key mistake showing a raw key — cosmetic, and caught by §7.6.

---

## 10. Assumptions

Every one of these is a place where the request was ambiguous and this spec picked the simplest reading. The plan step may overturn any of them with evidence; it must not overturn them silently.

1. **No animations; `tw-animate-css` is not added** (§4.1.3). Simplest reading of "decide once": keep the current motion-free baseline. Reversing this is one import plus the classes.
2. **The i18n dictionaries are flat `Record<string, string>` in TypeScript files, not JSON, not nested** — it keeps type-checking, completeness testing and diffs simple. No i18n library is added.
3. **No `navigator.language` detection** (§4.3.3). English is the stated default; auto-detection would make the default machine-dependent.
4. **No plural engine** (§4.3.5). Chinese has no plural morphology and the English strings involved are counts inside fixed phrases.
5. **Reasoning effort stays a suffix on `Agent.model`** rather than becoming its own column (§5.1) — `adapters.ts:329` is the consumer, and a second column would be a second source of truth.
6. **The model catalog lives in the frontend as configuration** (decisions §6.4), not in the database and not fetched from the CLIs. Model lists change faster than schemas, and `Custom…` covers the gap.
7. **CODEX effort values are treated as unverified** until the implementation step checks the installed CLI; until then only `high`, `xhigh`, `max` (the values in production use) are offered (§4.6.3).
8. **The daemon registry is in-process, not a table** (§5.4). Single-user localhost; a restart re-populates in ≤ 5 s.
9. **The web app polls `/runners` every 30 s**, matching the original's stated cadence and the string the popover displays.
10. **`disabledTools` stores the denied set, not the allowed set** (§4.7.2) — empty default equals today's behaviour, so no backfill and a lossless rollback.
11. **CLAUDE enforcement uses `--disallowedTools`** rather than `--allowedTools`, because the invocation already carries `--dangerously-skip-permissions` (§4.7.3). Flagged for empirical verification in §4.7.5 — this is the assumption most likely to be wrong, and the one with a mandated falsification procedure.
12. **PI enforcement covers only the tool names verifiable from `pi --help`**; the rest are labelled not enforced rather than guessed (§4.7.3).
13. **The foundation becomes read-only in the UI** and its version tag is a content revision, not a semantic version (§4.8). The alternative — inventing a `v6` — would be a display that no data backs.
14. **The sidebar keeps its theme-cycling button** in addition to the Settings control; both write the same store.
15. **`/health` polling stays at its current 10 s** and is not folded into `/runners`; the two answer different questions and the existing behaviour is already tested.
16. **A new dependency, `@radix-ui/react-hover-card`, is acceptable** for item 7 (§5.5). It is MIT and from the Radix family already in `package.json`.

---

## 11. Open questions (recorded, not blocking — no step of this chain calls `inbox_ask`)

1. **Should the foundation get a real version?** §4.8.3 ships a content revision because nothing versions `agents/foundational.md`. A semantic `v6` needs a `version:` key in that file plus a way to surface it at runtime (a column, or an API endpoint that reads the file). Cheap, but out of this batch's shape. — For Leo at the ⑨ PR review.
2. **Should `npm run db:seed` stop overwriting `model` / `runnerPreference`?** After this batch Leo picks models in the UI (decisions §12), and the next re-seed reverts them (§6.16). Options: seed writes those fields only on create; or the role files become the source of truth and the UI dropdown is advisory. This spec documents the behaviour rather than changing it. — Recommend deciding before the post-merge model review.
3. **Should `PATCH /agents/:id` reject a model/runner mismatch server-side?** The UI makes it unreachable; the CLI and the seed path do not. Small, and a natural companion to question 2. — §12.
4. **Is the `Capabilities` panel's 3.00 CSS px drift** (BACKLOG-V2 平台修缮, found after `3c1f186`) caused by something this batch will touch? The backlog suggests batch 1 look while it is in that file. This spec does **not** put it in scope — the brief's in-scope list is closed — but §12 asks the implementation step to record any observation it makes for free.

---

## 12. Deliberately not done here (follow-ups)

1. **Server-side model/runner validation** and the seed-overwrite question (open questions 2 and 3).
2. **The `Capabilities` 3 px drift.** If the cause becomes visible while editing that tab, note it in the PR description; do not chase it. It stays on the platform-repair list.
3. **Honesty labels for the genuinely unenforced permission surfaces** (filesystem grants, MCP toggles, `GIT_READ/WRITE`, Environment networking). Decisions §13 assigns these to the open-source batch; item 8's labels cover only the tool toggles.
4. **Backend and outbound i18n** (Feishu cards, API error strings) — batch 3 and the open-source batch.
5. **Sign out, the project-level unread badge, the agent `Status` column** — §3.2, each with its own home.
6. **Persisting daemon telemetry** — only if the API ever becomes multi-process (§5.4).
7. **A semantic foundation version** — open question 1.
8. **Motion** — if `tw-animate-css` is ever wanted, it is an import plus the utility classes on the regenerated components (§4.1.3).
