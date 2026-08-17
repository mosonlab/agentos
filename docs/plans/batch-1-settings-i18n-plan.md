# PLAN — Batch 1: Settings, i18n, sidebar globals, agent model & tool controls

Status: **revision 1** · Author: plan agent (chain steps ② and ④) · Date: 2026-08-16
Spec: `docs/specs/batch-1-settings-i18n.md` (approved, commit `9c49e60`).
Review answered: `docs/reviews/2026-08-16-batch-1-plan-review.md` (9 must-fix, 4 should-fix).
**§0.4 is the review response** — every finding, what changed, and where. Nothing was
rejected; nothing was dropped silently.
Brief: `docs/briefs/batch-1-settings-i18n.md`. Authority behind the spec:
`docs/BACKLOG-V2.md` 批次 1 · `docs/reference/danny-agentos-video/detail-gaps.md` §1/§11 ·
`decisions.md` §2/§3/§11/§12/§13.

Plan verified against the working tree at commit `9c49e60` (spec commit; code state
`f5c77ae`). **Every file, line anchor, class string, CLI flag and constant quoted
below was read in the source while writing this plan** — not carried over from the
spec. §0.2 lists the eleven places where the code contradicts or under-specifies
the spec (C1–C11); §0.3 is the binding errata against the approved spec; §0.4 is the
revision-1 response to the plan review; §17 lists everything this plan is still
guessing about; §19 answers the out-of-chain note about the `Capabilities` 3.00 px
drift.

Every source anchor added in revision 1 was re-read in the tree at `9c49e60`, not
taken from the review's citation.

Planning only. **Eighteen work items in dependency order, one commit each, on one
feature branch, landing as one PR with one migration folder.** Every spec
requirement maps to a numbered work item in §14.

---

## 0. Approach summary

- **Schema first (WI-1), because the generated Prisma client gates the API, the
  daemon and the web type.** One additive column, `Agent.disabledTools TEXT[] NOT
  NULL DEFAULT '{}'`. No backfill, no precheck, no drop.
- **Components before pages (WI-2).** The 13 shadcn files are rewritten to v4
  generation **by hand, not by re-running the shadcn CLI** — every one of them
  carries repo-specific class strings and a paragraph of comment explaining why
  (C1). The new `hover-card.tsx` is authored in v4 shape from the start.
- **i18n runtime and the sweep guard land before the new UI, not after (WI-3 →
  WI-8).** The order is deliberate: once the guard test exists, every feature work
  item after it is *born translated* and cannot regress the sweep. The sweep of the
  existing surface is three mechanical commits (WI-5/6/7) that change no behaviour,
  so they can be reviewed as pure string moves. **The guard is a TypeScript AST
  scan, not a regex sweep** (revision 1): the copy in this app lives in props,
  object literals and returned template strings at least as often as in JSX text,
  and a regex guard would have gone green over hundreds of survivors.
- **`format.ts` keeps its function signatures (C2).** Forty-one call sites across
  17 files, two of them in the non-component module `lib/schedule.ts`, make a hook
  refactor a ripple this batch has no reason to pay for. The locale and the
  translator are registered into the module by `LocaleProvider` during render — the
  registration seam ships in WI-3 (the commit that calls it) and WI-4 is what makes
  it bite. `lib/schedule.ts` goes with `format.ts`: cron prose and the future-time
  fragments are user-visible English and belong to the same commit as the plumbing.
- **The batch touches the API in two places, not one.** WI-9 (`GET /runners`,
  telemetry) is the expected one; WI-17 is the second — the create form cannot drop
  `foundationalPrompt` (spec §4.8.2) while `agentInput` requires it, so the API
  supplies the canonical value instead (E8).
- **Backend before the surfaces that consume it (WI-9 → WI-11).** `GET /runners`
  and the daemon telemetry exist before the sidebar renders them; the CLI tool
  flags exist, and their enforcement is *captured from a real session*, before the
  UI is allowed to claim enforcement (spec §4.7.5).
- **Then the four visible features (WI-13 → WI-17)**: runner row + popover,
  Settings page, Agents model/effort/runner controls, Agents Tools card, Foundation
  read-only.
- **Two pure frontend modules carry all the logic that has rules** (`lib/models.ts`,
  `lib/tools.ts`, WI-12). They are plain data plus pure functions with no React in
  them, so the batch's hardest assertions (split/join must match `adapters.ts:329-331`
  byte for byte; `openai-codex/gpt-5.6-luna` must resolve to `PI`) are unit tests
  rather than DOM tests.
- **One deliberate, sanctioned visual change**: focus rings thicken from 1–2 px to
  3 px (spec §4.1.5). Everything else must be pixel-stable, and §19 explains the one
  place where the tree is *already* 3.00 px off its baseline and how to fix it in
  one line inside WI-16.

---

## 0.1 What was verified in the tree (the spec's §2, re-checked rather than assumed)

Held, exactly as the spec states:

| Spec claim | Verified at |
|---|---|
| `Settings` links to `/secrets` with `IconActivity` | `apps/web/src/components/Shell.tsx:91` |
| Theme cycle button `system → light → dark` | `Shell.tsx:64, 92-94` |
| Sidebar renders `/health` as `Control plane` | `Shell.tsx:59, 86-90` |
| Inbox badge already ships, 5 s, `status === "OPEN"` | `Shell.tsx:61-62, 79-81` |
| Routes are a table; 18 entries in `ROUTES` | `App.tsx:21-42` |
| `Agent.model` is one `String`; no `reasoningEffort` column | `packages/db/prisma/schema.prisma:220`; absent repo-wide |
| Effort is a suffix split on the **last** colon, index `> 0` | `packages/runner/src/adapters.ts:329-331` |
| Three CLIs consume the halves differently | `adapters.ts:343-371` |
| claude effort vocabulary `low, medium, high, xhigh, max` | `spikes/cli-capabilities/samples/claude-help.stdout:72-73` |
| pi thinking vocabulary `off … max` | `pi-help.stdout:40` |
| codex effort values not enumerated in the captured help | `codex-exec-help.stdout` (searched; only `-s/--sandbox` values are enumerated) |
| `runnerFor` heuristic sends `…codex…` to CODEX | `packages/db/src/workflow.ts:22-30` |
| `seed.ts` overwrites `model` / `runnerPreference` on every run | `packages/db/prisma/seed.ts:121-144` |
| `RunnerBackendState` is keyed by `RunnerKind`, one row per CLI | `schema.prisma:775-787` |
| Daemon polls claim every 5 s with `runnerId`; API stores nothing on 204 | `packages/runner/src/config.ts:29-30`, `packages/runner/src/index.ts:23-31`, `packages/api/src/app.ts:252-255, 2270-2409` |
| `principalMayAccess` forbids operator on `/runner/` | `packages/api/src/auth.ts:48-53` |
| claude has `--disallowedTools`; pi has `--exclude-tools`; codex has neither | `claude-help.stdout:22-24, 69-71` · `pi-help.stdout:36-39` · `codex-exec-help.stdout:52-62` |
| CLAUDE already passes `--dangerously-skip-permissions` | `adapters.ts:347` |
| 13 shadcn files, **36** `forwardRef`, **0** `data-slot` | counted per file: badge 0, button 1, card 6, checkbox 1, dialog 4, dropdown-menu 8, input 1, progress 1, select 1, switch 1, table 8, tabs 3, textarea 1 |
| No animation anywhere; `tw-animate-css` not a dependency | `apps/web/package.json`; no `animate-in` in `src/` |
| Agents page anchors (list `:148`, create `:67-74`, tabs `:418-427`, save `:389-397`, foundation textarea `:473-478`, Capabilities `:295-372`) | all confirmed |
| `storage.ts` swallows a dead `localStorage` | `apps/web/src/lib/storage.ts:5-23` |
| `theme.tsx` cross-tab `storage` listener to mirror | `apps/web/src/lib/theme.tsx:31-36` |

Additional facts this plan depends on that the spec does not state:

- **`createApp` is a factory** (`app.ts:537`) and already holds per-app closures
  (`createArchivedRunNoticeScheduler(db)`, `:539`). The daemon registry must be one
  of those closures, not a module-level singleton, or `app.test.ts` instances leak
  state into each other.
- **`usePoll` skips a load when `document.hidden`** (`apps/web/src/lib/hooks.ts:41`).
  A backgrounded tab therefore holds stale runner data indefinitely — see C6.
- **The claim handler returns the whole agent record**, not a projection
  (`app.ts:2393-2407 return { … agent: candidate.agent … }`, built from the `include` at
  `:2298-2304`). `disabledTools` therefore reaches the daemon for free once the
  column exists — see C3.
- **`agentFields` is the single zod source for both create and patch**
  (`app.ts:86-101`), so one added key covers `POST /projects/:id/agents` and
  `PATCH /agents/:id` together.
- **`@agentos/runner`'s package version is `0.0.0`** (`packages/runner/package.json`),
  not the `0.1.0` the spec's example payload shows — see C4.
- **`activeRunStatuses` (`app.ts:445`) and `ACTIVE_RUN_STATUSES` (`workflow.ts:205`)
  are two different sets**, and `workflow.ts:200-204` says so in a comment — see C5.
- **pi documents its built-in tool names**: `read, bash, edit, write, grep, find, ls`
  (`pi-help.stdout:173-179`), and says `grep`, `find` and `ls` are **off by default**
  — see C8.
- **`Toggle` was already a Radix `Switch` at the screenshot baseline**, with its
  thumb `display:none` (`git show 82b1de5:apps/web/src/components/ui.tsx:122-128`,
  `className={…} [&>span]:hidden`). This is what §19 turns on.
- **Existing tests render components with no providers** (`renderToStaticMarkup`
  straight onto `Card`, `Tabs`, `Segmented`, board columns, …). `useT()` therefore
  cannot throw outside a provider the way `useTheme` does — see C7.

---

## 0.2 Corrections — where the code contradicts or under-specifies the spec

Each is stated once here and referenced from the work item that implements it.
None of them is a licence to change scope; they change *how*, not *what*.

### C1 — the shadcn components cannot be regenerated by the CLI; they must be hand-migrated

`components.json` exists (`style: new-york`, `baseColor: neutral`), so
`npx shadcn add --overwrite` would run. It must not be used. Every one of the 13
files carries repo-specific deviations that the CLI would silently discard:

- `button.tsx:7-21` — a 15-line comment plus six repo variants/sizes
  (`legacy`, `legacyPrimary`, `legacyDanger`, `icon`; `legacy`, `legacySmall`,
  `legacyIcon`) that reproduce retired `.btn` rules exactly.
- `input.tsx:6-19` — `h-9` retained against the convergence plan's own §1.5, with
  the measurement (`29px` in `docs/plans/baseline-screenshots`) written into the
  comment, and `md:text-sm` deliberately deleted.
- `select.tsx:5-15` — a native `<select>` on purpose, with the two-gradient chevron
  ported verbatim and a note that `pr-[30px]` must be written after `px-[11px]`
  because of tailwind-merge ordering.
- `checkbox.tsx:14` — `grid place-content-center` prepended to the stock string.

**Rule for WI-2: edit each file in place.** Four mechanical transforms per file
(drop `forwardRef` and `displayName`, add `data-slot`, swap the focus idiom, add
`aria-invalid:` on form controls). Every existing class string and every existing
comment survives the diff. Where a v4 base string would change a repo string, the
repo string wins and the deviation gets a one-line comment (spec §4.1.2).

### C2 — `format.ts` cannot become a hook without a ripple this batch does not want

Call sites counted in `apps/web/src`: `formatDateTime` 19, `timeAgo` 11, `formatDate`
7, `duration` 4 — 41 in 17 files, including `apps/web/src/lib/schedule.ts:3`, which
is a **pure module** (no React) consumed by `Triggers` and `Automations`. Converting
to `useFormat()` would force `schedule.ts` to take a formatter parameter and would
touch every one of its callers.

**Decision:** `format.ts` keeps every signature. It gains

```ts
export type FormatTranslate = (key: string, vars?: Record<string, string | number>) => string;
export const setFormatLocale = (locale: Locale, translate: FormatTranslate): void;
```

which `LocaleProvider` calls **in its render body** (an idempotent assignment, not
an effect) so the very paint that switches the language already formats in it —
spec §6.7's requirement. `Intl.DateTimeFormat` instances are memoised per locale in
a `Map`, so the switch does not rebuild them on every render.

Three consequences the review caught (must-fix 1), binding on WI-3 and WI-4:

1. **The registration seam lands in WI-3, not WI-4.** WI-3's provider calls
   `setFormatLocale`, so that export must already exist at the WI-3 commit or that
   commit does not typecheck. WI-3 therefore adds the *seam* to `format.ts`
   (the setter, the module-private `activeLocale`/`activeTranslate`, and the
   `format.*` dictionary keys) while leaving the rendered output byte-identical to
   today's; WI-4 is the commit that makes the formatters *consume* it.
2. **The provider passes a locale-bound closure, not `translate` itself.**
   `translate` is `(locale, key, vars)`; the callback type is `(key, vars)`. The
   call is
   `setFormatLocale(locale, (key, vars) => translate(locale, key, vars))`.
   Passing `translate` directly is a type error, and would have been one at the
   first `tsc -b`.
3. **The dictionaries and `translate` move into a React-free module,
   `lib/i18n-core.ts`.** `format.ts` needs `translate` for its provider-free
   default (`(key, vars) => translate("en", key, vars)`), and `i18n.tsx` needs
   `setFormatLocale` from `format.ts`. Importing across `i18n.tsx ↔ format.ts`
   would be a module cycle. With `i18n-core.ts` holding `Locale`, `LOCALE_KEY`,
   the two dictionaries, `interpolate` and `translate`, the graph is acyclic:
   `format.ts → i18n-core`, `i18n.tsx → i18n-core + format.ts`,
   `schedule.ts → format.ts + i18n-core`.

Because the default translator resolves through `en.ts`, `format.ts` holds **no
English fragments of its own** after WI-4 — which is also what lets WI-8's guard
scan `src/lib/**` without an allowlist entry for it.

Rejected alternative: reading the locale from `localStorage` inside `format.ts`.
That would make it read a second source of truth and would not update cross-tab.

### C3 — `disabledTools` needs **no** claim-response change on the API

The spec (§5.2, "Changed: the claim response's agent projection") assumes a
projection. There is none: `app.ts:2296-2303` includes the agent with three nested
relations and `:2394` returns `agent: candidate.agent` whole. Adding the column
therefore ships it to the daemon with zero API edits. The only change needed is the
**type** in `packages/runner/src/api.ts:28-34`, which is a hand-written mirror and
will not update itself.

Consequence for WI-11: it is a one-line type change plus the mapping, and the
"claim payload carries `disabledTools`" test (spec §7.16) asserts an existing
behaviour rather than a new one — which is exactly why it is worth writing.

### C4 — `daemonVersion` will report `0.0.0`, not `0.1.0`

`packages/runner/package.json` has `"version": "0.0.0"`, as do all six workspaces.
The spec's example payload and its popover mock show `Daemon version 0.1.0`; that
is illustrative, not a requirement. WI-10 reports the real value and WI-13's test
asserts *presence and shape*, never the literal `0.1.0`.

Reading it: `new URL("../package.json", import.meta.url)` resolves identically from
`src/config.ts` under `tsx` and from `dist/config.js` after `tsc`, because `src/`
and `dist/` sit at the same depth under `packages/runner/` — the same trick
`index.ts:3` already uses for `.env`. Use `createRequire(import.meta.url)("../package.json")`
or `readFileSync` + `JSON.parse`; **do not** use a JSON import assertion, which
would need `resolveJsonModule` and would emit into `dist` differently.

### C5 — `busy` must be computed from `activeRunStatuses`, not `ACTIVE_RUN_STATUSES`

Spec §5.2 says to use `ACTIVE_RUN_STATUSES` (`workflow.ts:205`), "the shared set,
not a second list". That set exists to answer *"does this task already have a live
run"* and its own comment (`workflow.ts:200-204`) says `activeRunStatuses` is a
different concept — "a run holding a lease". "Is this daemon busy" is the
lease-holding question, not the task question:

- `ACTIVE_RUN_STATUSES` includes `QUEUED`. A `QUEUED` run has no owner. Today every
  requeue path nulls `runnerId` (`workflow.ts:558` on the Inbox resume;
  the reconciler turns an orphan into `LOST` and retry creates a *new* run,
  `reconcile.ts:130-147`), so the join is empty in practice — but the set is one
  forgotten `runnerId: null` away from making an idle daemon read `Busy` forever.
- `activeRunStatuses` (`app.ts:445` — `CLAIMED, PROVISIONING, RUNNING,
  WAITING_INBOX`) is what the heartbeat handler itself gates on (`app.ts:2461`).

**Decision:** `GET /runners` uses `activeRunStatuses`. This is a deviation from the
spec, recorded in §0.3, and the WI-9 test asserts that a `QUEUED` run never makes a
daemon `Busy`.

### C6 — a backgrounded tab makes `online` a lie; the client must age the payload

`usePoll` returns early when `document.hidden` (`hooks.ts:41`), so a tab left in
the background keeps whatever `/runners` last said. The server-computed `online:
true` from twenty minutes ago would render a green dot on a machine whose daemon
died nineteen minutes ago.

**Decision:** the sidebar and Settings both treat the payload as stale when
`Date.now() - Date.parse(checkedAt) > 2 × 30 s`, and render the grey dot with
`Unknown` — the same state spec §6.1 defines for a failed fetch. One rule, two
causes. WI-13 tests it with a frozen clock.

### C7 — `useT()` must not throw outside a provider

`useTheme` throws when no provider is present (`theme.tsx:45`). Copying that shape
would break eight existing test files, which render components directly with
`renderToStaticMarkup` and no provider (`primitives.test.tsx`, `tasks-board.test.tsx`,
`tasks-tabs.test.tsx`, `chain-list.test.tsx`, `row-menu.test.tsx`, `sessions.test.tsx`,
`triggers.test.tsx`, `task-detail.test.tsx`).

**Decision:** `useLocale()`/`useT()` fall back to a provider-less default of `en`.
This is also what spec §7.20 wants — those tests keep asserting the English string,
now sourced from `en.ts` via `t()` rather than from a JSX literal. A test that wants
Chinese wraps the subject in `<LocaleProvider initialLocale="zh">`.

### C8 — pi's tool vocabulary is documented, and three of its tools are off by default

`pi-help.stdout:173-179` names every built-in and its default:

```
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  grep   - Search file contents (read-only, off by default)
  find   - Find files by glob pattern (read-only, off by default)
  ls     - List directory contents (read-only, off by default)
```

Two consequences the spec does not carry:

1. **`GLOB` does have a pi counterpart** — `find`, documented as "Find files by
   glob pattern". Spec §4.7.3 lists `GLOB` as having "no verified pi equivalent".
2. **`GREP` and `GLOB` are off by default on pi**, and `argsForRunner`'s pi branch
   passes no `--tools` (`adapters.ts:364-370`), so on a PI agent those two tools are
   already unavailable. Rendering their toggles as ON would be the exact dishonesty
   decisions §13 forbids.

**Decision, conservative on purpose:** the PI deny map covers **`BASH, READ, WRITE,
EDIT` only**. `GREP` and `GLOB` are tagged `not enforced on pi` — not because pi
lacks the name, but because their *default* is already off and a deny flag would
be theatre. The tag's tooltip cites `pi-help.stdout:177-178`. `WEB_FETCH` and
`WEB_SEARCH` are tagged because pi has no such tool at all. This keeps spec §7.15's
assertion (`["BASH","WEB_SEARCH"]` → PI gets `--exclude-tools bash` only) true
byte for byte, and it is stricter than the spec rather than looser.

### C9 — `--disallowedTools` is variadic; a space-separated list would eat the prompt

`claude-help.stdout:22-24` declares `--disallowedTools, --disallowed-tools <tools...>`
— commander variadic. `argsForRunner` puts the prompt last as a bare positional
(`adapters.ts:354`). Emitting `["--disallowedTools", "Bash", "WebSearch", …, input]`
would let the variadic swallow `input` as a tool name, and the CLI would run with
an empty prompt. The help text says "Comma **or** space-separated", so the safe
form is one argument:

```ts
["--disallowedTools", "Bash,WebSearch"]
```

Same for pi, where it is not optional: `--exclude-tools, -xt <tools>` is documented
as "Comma-separated denylist" taking one value (`pi-help.stdout:38-39`, example
`pi --exclude-tools ask_question`).

**Decision:** both flags emit exactly two argv entries — the flag and one
comma-joined value — inserted **before** an existing flag (`--mcp-config` for
claude, `--extension` for pi), never adjacent to the trailing positional. Spec
§7.15's expectation "`--disallowedTools Bash WebSearch`" is restated in §0.3 as
`--disallowedTools Bash,WebSearch`.

### C10 — `LocaleProvider` belongs in `main.tsx`, next to `ThemeProvider`

Spec §4.3.1 says it wraps the app "inside `App.tsx`". `ThemeProvider` — the store
this one mirrors in every other respect — is mounted in `main.tsx:16` outside
`<App/>`. Mounting `LocaleProvider` in `App.tsx` would put the two stores at
different levels for no reason and would leave `App`'s own three banners
(`App.tsx:52-55, 62, 81`) *outside* the provider unless a second inner wrapper is
added.

**Decision:** `main.tsx` renders `<ThemeProvider><LocaleProvider><App/></LocaleProvider></ThemeProvider>`.
The spec's constraint that matters — "outside `Shell`, so the shell itself is
translated" — is satisfied strictly more.

### C11 — `Agents.tsx`'s runner hints point at the wrong file

`Agents.tsx:70` says "INHERIT falls back to the model heuristic in execution.ts."
and `:453` says "INHERIT 时按 execution.ts 的模型名启发式选 runner。". The heuristic
is `runnerFor` in `packages/db/src/workflow.ts:22-30`; `packages/api/src/execution.ts`
exists but does not contain it. Both hints are replaced wholesale by WI-15 (the
runner control becomes read-only for catalog models), so this is a note for the
reviewer rather than a work item: **do not port the stale filename into the new
dictionary strings.**

---

## 0.3 Errata against the approved spec (binding for implementation and review)

Where this plan and the spec disagree, the plan wins on these seven points and only
these. Each is a *narrowing* or a *correction of fact*, none is a scope change.

| # | Spec says | Plan does | Why |
|---|---|---|---|
| E1 | §5.2 claim response gains a `disabledTools` projection | API unchanged; only `runner/src/api.ts`'s type gains it | C3 — the agent is returned whole |
| E2 | §5.2 `busy` from `ACTIVE_RUN_STATUSES` | `activeRunStatuses` (`app.ts:445`) | C5 — lease ownership, not task liveness |
| E3 | §7.15 CLAUDE gets `--disallowedTools Bash WebSearch` | `--disallowedTools Bash,WebSearch` (one argv value) | C9 — variadic flag would eat the prompt |
| E4 | §4.7.3 `GLOB` has no verified pi name | `GLOB` has one (`find`) but stays **unenforced** on pi, with `GREP` | C8 — both are off by default on pi already |
| E5 | §4.3.1 `LocaleProvider` mounts in `App.tsx` | mounts in `main.tsx` | C10 — mirrors `ThemeProvider`, covers App's banners |
| E6 | §4.5 example shows `Daemon version 0.1.0` | reports `0.0.0`, the real version | C4 |
| E7 | §1/§2 "twelve hardcoded Chinese strings in five files" | 12 matching **lines** in 5 files, of which `ui.tsx:142` is a source comment; 11 user-visible lines forming **8 distinct strings** | verified by `grep -rn '[一-龥]' apps/web/src` |
| E8 | §5.2 "the server keeps accepting `foundationalPrompt`" (implying no API change) | `POST /projects/:id/agents` makes it **optional** and fills it server-side from the project's first agent; `PATCH` is untouched and still accepts it | added in revision 1 — §4.8.2 orders the field out of the create form, and `agentInput` (`app.ts:96-100`) requires it, so one of the two had to move. See §0.4 must-fix 6 |

The full Chinese inventory, so WI-5/6/7 cannot miss one:

| File:line | String |
|---|---|
| `App.tsx:53-54` | the 401 banner (two lines, one string) |
| `App.tsx:62` | the connection-refused banner |
| `App.tsx:81` | `未知路由 <code>{path}</code>。` |
| `components/ui.tsx:326` | `GapNotice` body |
| `pages/Sessions.tsx:172` | `what="会话列表"` (a prop, not a literal in JSX) |
| `pages/Agents.tsx:77` | the missing-environments hint |
| `pages/Agents.tsx:453` | the INHERIT runner hint (see C11) |
| `pages/Connections.tsx:99-101` | the bindings explainer (three lines, one string) |
| `components/ui.tsx:142` | **a code comment — not translated, not counted** |

---

## 0.4 Review response (revision 1)

Source: `docs/reviews/2026-08-16-batch-1-plan-review.md`. **All nine must-fix and all
four should-fix findings are applied. Nothing is rejected** — if a later reader
expects a rejection section, its absence is the answer, not an omission. Every
finding was re-verified against the tree before being applied; the table below
records what the verification found, because two of them (5 and 6) were right about
the defect and left the mechanism open — and the implementation step must follow the
plan, not the review.

### Must-fix

| # | Finding | Verified? | What changed, and where |
|---|---|---|---|
| 1 | WI-3 calls `setFormatLocale` before WI-4 creates it; the callback type is wrong | Yes — `format.ts:1-29` has no such export, and `translate(locale,key,vars)` is not `(key,vars)=>string` | C2 rewritten: the seam lands in WI-3, the provider passes a locale-bound closure, and the dictionaries move to a React-free `lib/i18n-core.ts` to break the `format.ts ↔ i18n.tsx` cycle. WI-3 now carries a **commit-boundary build/typecheck gate** |
| 2 | The sweep guard's regexes cannot see prop copy, object-literal labels or template literals | Yes — `Secrets.tsx:48,56-58` (`label`/`hint` props), `Tasks.tsx:33-41` (`COLUMNS[].label`), `Automations.tsx:23-28` (returned literals + a template literal) all evade the WI-8 rules as written | WI-8 rewritten around a **TypeScript AST scan** with an explicit node-kind list, extended to `src/lib/**`, and **six** fixtures — one per syntax category — each asserted to fail the guard |
| 3 | `cronstrue` prose and `nextRunLabel` fragments stay English | Yes — `schedule.ts:18` takes cronstrue's default locale; `:32-35` emits `in under a minute` / `in {n}m` / `in {n}h` | `schedule.ts` moves **into WI-4** (out of WI-6's optional list): `cronstrue/i18n` with an explicit `locale`, the three future-time fragments become `format.*` keys, and WI-4 gains en/zh schedule tests. The zh_CN locale's presence is verified by command, with a stated fallback (below) |
| 4 | A bad optional telemetry value 400s the whole claim | Yes — `readJson` (`app.ts:371-372`) parses before the handler body, so the plan's deviation would have idled the daemon | Deviation withdrawn. The four telemetry fields are declared `…​.optional().catch(…)` (zod 4.1, `packages/api/package.json:22`), so an out-of-range value is dropped **inside the same single parse** and the claim proceeds. WI-9 tests both the 204 and the successful-claim case; §17.2 is struck through rather than removed, so the finding stays traceable |
| 5 | The registry never evicts, and merging telemetry can report a dead daemon's values as current | Yes — `config.ts:29` defaults `runnerId` to `` `${hostname()}-${process.pid}` ``, so every restart is a new key | `note()` now **replaces** rather than merges; `snapshot()` forgets entries unseen for 15 min and the map is hard-capped at 16 entries. Identity is deliberately **not** stabilised (see below). Tests: three restarts, and a telemetry-less daemon reusing a configured `RUNNER_ID` |
| 6 | WI-17 keeps posting a divergent foundation from the create form | Yes — `Agents.tsx:35` posts a one-sentence web constant; the canonical text is `agents/foundational.md` (`seed.ts:56-57`), and `app.ts:785` spreads the body straight into `agent.create` | The create form stops sending the field (spec §4.8.2), `agentInput.foundationalPrompt` becomes optional, and the API fills it from the project's **first-created agent** — the seeded row. No project agent yet → 400 naming `npm run db:seed`. Errata E8; §17.5 rewritten; open question 5 records the alternative |
| 7 | The Tools card cannot resolve a Custom model on `INHERIT`/`AUTO` | Yes — `runnerFor` (`workflow.ts:22-30`) resolves those through the model heuristic; `ENFORCED_BY` has no `INHERIT`/`AUTO` key | WI-12 gains `resolveRunner(preference, model)`, a byte-faithful mirror of `workflow.ts:22-30` including its `split(/[\/:_-]+/u).includes("pi")` rule; WI-16 uses it. Tests cover Custom × {explicit, INHERIT, AUTO} × {codex-, pi-, claude-shaped ids} |
| 8 | The shared `/runners` fetch has no provider and no acceptance check | Yes — `Shell.tsx:57-99` renders both the sidebar and the routed children, so placement is load-bearing | WI-13 defines `RunnersProvider`, mounted once in `App.tsx` inside `ProjectProvider`. It also absorbs the `/health` poll (`Shell.tsx:59`), which Settings would otherwise duplicate. A fetch-counting test with fake timers proves one request per path per tick with both consumers mounted |
| 9 | Picker validation cannot disable the parents' buttons | Yes — Create (`Agents.tsx:52-53`) and Save (`Agents.tsx:413`) live in the parents and know only `pending` and two emptiness checks | Validation becomes the pure `validateModelPair(model, runnerPreference)` in `lib/models.ts` (WI-12), consumed by the picker for its notice **and** by both parents in their `disabled` expressions. WI-15's tests assert the real Create and Save buttons |

### Should-fix — all four adopted

| # | Finding | What changed |
|---|---|---|
| 1 | One `data-slot` per file proves too little | WI-2's test now enumerates **every exported part** per file with its expected slot name and asserts each in source |
| 2 | "Last successful poll" has no data source | `usePoll` gains `lastSuccessAt: string \| null` (set on success, **preserved** across a later failure) in WI-13; WI-14 renders it and tests the failure-preserves-timestamp case |
| 3 | Rapid tool toggles can overwrite each other | WI-16 keeps an optimistic local denied set and serialises writes through a promise-chain ref; a rapid two-toggle test asserts the union persists |
| 4 | A semver-shaped daemon version proves nothing | WI-10's test asserts **equality with `packages/runner/package.json`'s `version`**, read in the test, and that claim and heartbeat carry the same value |

### Three judgement calls made while applying the findings

1. **Daemon identity is not stabilised** (must-fix 5). The review offered "stable
   daemon identity plus boot id" as one option. `runnerId` is a co-predicate of every
   fencing write (`app.ts:2484`, `:2726` — `where: { id, runnerId, fencingToken,
   leaseExpiresAt, status }`), so changing what the daemon calls itself changes
   which stale writes the control plane accepts. That is a runtime-semantics change
   this batch does not authorise. The registry absorbs the churn instead, and the
   consequence is written down rather than hidden: after a daemon restart the old
   incarnation lingers as `Offline` for up to 15 minutes and the row reads
   `1 of 2 runner online`. Setting `RUNNER_ID` in the daemon env removes it; the
   Settings runner card says so in one line.
2. **`cronstrue`'s Chinese locale is verified, not assumed** (must-fix 3).
   `apps/web/package.json:19` pins `cronstrue ^3.24.0`, whose locales ship under
   `cronstrue/i18n`. The implementation step runs
   `node -e "console.log(Object.keys(require('cronstrue/i18n').locales ?? {}))"` (or
   `ls node_modules/cronstrue/dist/i18n/locales | grep zh`) **before** writing the
   call. If `zh_CN` is absent, the fallback is: keep the English prose, add the one
   allowlist entry naming it as third-party output, and open a follow-up — do not
   hand-roll a cron describer. Recorded as guess §17.4.
3. **The API gains one optional field, not a filesystem dependency** (must-fix 6).
   The review's "obtain the canonical foundation server-side from one authoritative
   source" could mean reading `agents/foundational.md`. The API reads no repo file
   today (`grep -rn 'readFile' packages/api/src` → nothing outside tests) and
   `seed.ts:8` resolves that path relative to `packages/db`, so teaching the API to
   read it would add a deployment coupling a containerised API would not satisfy.
   The project's first-created agent already holds the seeded text and is the
   runtime source of truth; open question 5 hands the alternative to Leo.

---

## WI-1 — Schema: `Agent.disabledTools`, the migration, and the three type mirrors

**Depends on:** nothing. **Blocks:** WI-11, WI-12, WI-16.

**Files**

- `packages/db/prisma/schema.prisma` — add to `model Agent` (between `inboxAccess`
  at `:224` and `createdAt` at `:225`):
  `disabledTools String[] @default([])`.
  Placement matters only for diff readability; it must sit with the scalar columns,
  above the relation block that starts at `:228`.
- `packages/db/prisma/migrations/<timestamp>_agent_disabled_tools/migration.sql` — one statement:
  `ALTER TABLE "Agent" ADD COLUMN "disabledTools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];`
- `packages/api/src/app.ts:86-95` — add to `agentFields`:
  `disabledTools: z.array(z.enum(TOOL_KEYS)).max(8).optional()` where `TOOL_KEYS` is
  the eight canonical keys. Because `agentInput` (`:96`) and `agentPatch` (`:101`)
  are both built from `agentFields`, this covers create and patch at once. An
  unknown key is rejected by `z.enum` with a 400 — spec §7.16.
  Note: `agentPatch` is `.partial()`, so `optional()` on the field is only needed
  for the create path, where the column's default already covers omission.
- `packages/runner/src/api.ts:28-34` — `ClaimedTask["agent"]` gains
  `disabledTools: string[]`.
- `apps/web/src/lib/types.ts:40-61` — `Agent` gains `disabledTools: string[]`.
  Not optional: the API returns the column on every agent read, and making it
  optional would push `?? []` into every consumer.

**Not changed:** `packages/db/prisma/seed.ts`. Its `update` block (`:124-132`) does
not mention `disabledTools`, so a re-seed preserves whatever the UI stored (spec
§6.16). Verify this by reading, not by assuming — it is the only reason the batch
needs no backfill story.

**Migration and restart steps**

1. `npm run db:generate` — regenerates the client; without it the API and the
   daemon do not typecheck.
2. `npm run db:migrate` (`prisma migrate dev`, `packages/db/package.json`) against
   the live dev database. It is interactive when it detects drift; it must not be
   run with `--force-reset`, ever, on this database.
3. **Restart the API and the daemon** after the migration — both hold a Prisma
   client built against the old schema. Restarting is `launchctl`-free: this plan
   does not touch launchd, and the implementation step must not either. If the
   services are launchd-managed, the human restarts them; the agent stops after
   the migration and says so.
4. `npm run db:drift-check` — must be clean.

**Verification**

- `npm run db:validate` passes.
- `npm run db:drift-check` reports no drift.
- A dbtest (in `packages/api/src/tasks.dbtest.ts`'s harness style, `testdb.ts:19-29`)
  asserting an agent created without the field reads back `disabledTools: []`.
- `PATCH /agents/:id` with `{"disabledTools":["BASH"]}` persists; with
  `{"disabledTools":["NOPE"]}` returns 400 and does **not** write.

**Rollback:** the column is additive with a default. Reverting the code leaves it
unread. Dropping it is `ALTER TABLE "Agent" DROP COLUMN "disabledTools";` and
permanently discards per-agent restrictions — capture first, see §16.

---

## WI-2 — shadcn components to v4 generation, plus `hover-card.tsx`

**Depends on:** nothing. **Blocks:** WI-13 (needs `hover-card`).

**Files** — all 13 under `apps/web/src/components/ui/`, plus one new file and one
dependency.

Per-file transform, applied by hand (C1):

1. **Drop `forwardRef`.** `const X = React.forwardRef<A, B>(({…}, ref) => …)` becomes
   `function X({ className, ...props }: React.ComponentProps<"tag">)` (or
   `React.ComponentProps<typeof Primitive.Root>` for Radix parts), with `ref` passed
   through as a normal prop by React 19. Delete the matching `X.displayName = …`
   line. **36 occurrences** across 12 files (`badge.tsx` has none).
2. **Add `data-slot`.** Every exported part gets one, kebab-cased from its name:
   `data-slot="button"`, `data-slot="card-header"`, `data-slot="dropdown-menu-item"`,
   `data-slot="table-cell"`, and so on. **"Every exported part" includes the bare
   aliases**, which today are assignments with no body — `const Dialog =
   DialogPrimitive.Root` (`dialog.tsx:9`), `DialogTrigger`, `DialogPortal`,
   `DialogClose`, `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuGroup`,
   `DropdownMenuPortal`, `DropdownMenuSub`, `DropdownMenuRadioGroup`
   (`dropdown-menu.tsx:7-17`) and `Tabs` (`tabs.tsx:6`). Each becomes the v4
   one-line wrapper
   `function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
   return <DialogPrimitive.Root data-slot="dialog" {...props} /> }`.
   A Radix `Root`/`Portal` renders no DOM node of its own, so the attribute is inert
   at runtime there — it is asserted **in source**, which is what makes the file
   uniformly v4 instead of half-migrated.
   **The inventory is 51 parts across the 13 files** (badge 1, button 1, card 6,
   checkbox 1, dialog 10, dropdown-menu 15, input 1, progress 1, select 1, switch 1,
   table 8, tabs 4, textarea 1) plus 3 in the new `hover-card.tsx`. Counted from
   each file's final `export { … }` list; `badgeVariants` and `buttonVariants` are
   the only two exports that are not parts.
3. **Swap the focus idiom.** `focus-visible:outline-none focus-visible:ring-1
   focus-visible:ring-ring` → `outline-hidden focus-visible:border-ring
   focus-visible:ring-ring/50 focus-visible:ring-[3px]`. The v3 offset idiom on
   `switch.tsx:14` and `tabs.tsx:30` (`focus-visible:ring-2 … ring-offset-background`)
   goes with it. This is the one sanctioned visual change (spec §4.1.5).
4. **Add `aria-invalid:` to form controls** — `input.tsx`, `textarea.tsx`,
   `select.tsx`, `checkbox.tsx`:
   `aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive`.
5. **No animation classes are introduced** (spec §4.1.3). `dialog.tsx` and
   `dropdown-menu.tsx` keep their non-motion `data-[state=…]` styling and gain no
   `animate-in`/`animate-out`. `tw-animate-css` is **not** added to
   `apps/web/package.json`.

**Preserved verbatim** — the review checklist for this WI is "did any of these
change?":

| File | Must survive |
|---|---|
| `button.tsx:7-21` | the whole comment block |
| `button.tsx:37-59` | `legacy`, `legacyPrimary`, `legacyDanger`, `icon` variants incl. their inline comments |
| `button.tsx:61-67` | `legacy`, `legacySmall`, `legacyIcon` sizes |
| `input.tsx:5-19, 26` | the comment and `h-9`, `text-[12.5px]`, `px-[11px] py-[9px]`, `shadow-sm`, **no** `md:text-sm` |
| `select.tsx:5-15, 20-22` | the comment, the two-gradient chevron, `pr-[30px]` **after** `px-[11px]` |
| `checkbox.tsx:14` | `grid place-content-center` leading the string |
| `switch.tsx:14` | `h-5 w-9 border-2 border-transparent` (the `Toggle` in `ui.tsx` overrides these; changing the base would move the knob) |

**New file** `apps/web/src/components/ui/hover-card.tsx` — v4-shape shadcn hover-card
(`HoverCard`, `HoverCardTrigger`, `HoverCardContent`), `data-slot` on each,
`openDelay={150} closeDelay={100}` set at the call site not baked in, no animation
classes. **New dependency** `@radix-ui/react-hover-card` in
`apps/web/package.json` `dependencies` (spec §10.16).

**Verification**

- New test `apps/web/src/tests/component-generation.test.tsx`:
  - `grep`-equivalent over `src/components/ui/**`: zero `forwardRef`, zero
    `displayName =`, zero `animate-in` / `animate-out` / `tw-animate-css`.
  - **Per part, not per file** (review should-fix 1 — a per-file assertion would
    pass on a `card.tsx` where five of six parts stayed v3). The test reads each
    file's final `export { … }` list, subtracts the named `NOT_A_PART = ["badgeVariants",
    "buttonVariants"]`, and asserts for each remaining name that the source contains
    `data-slot="<kebab-case of the name>"`. The expected count is asserted too
    (**51** across the 13 files, 3 in `hover-card.tsx`), so a part deleted from the
    export list cannot silently shrink the check.
  - Parts that render a DOM element are additionally rendered with
    `renderToStaticMarkup` and asserted to emit the attribute; the Radix
    `Root`/`Portal`/`Trigger` aliases are source-only, and the test says which is
    which in a literal list rather than deciding at runtime.
  - The seven preserved strings above are asserted **as substrings of the source
    file**, so a future regeneration that drops `legacyDanger` fails loudly.
- `npm run build && npm test` — `styles.test.tsx` must pass **unmodified**,
  including the layer guard and the 14 contrast pairs. It reads
  `apps/web/dist/assets/*.css` (`styles.test.tsx:11-14`), so the build must precede
  the test in every invocation.
- `primitives.test.tsx`, `input-semantics.test.tsx`, `row-menu.test.tsx` pass
  unchanged. If one fails, the transform changed a host element or a class — fix the
  component, not the test.

**Rollback:** `git revert` of this commit alone restores all 13 files; nothing else
in the batch imports `hover-card` until WI-13, so reverting WI-2 before WI-13 lands
is self-contained. `@radix-ui/react-hover-card` may stay in `package.json` harmlessly.

---

## WI-3 — i18n runtime: `i18n-core.ts`, `i18n.tsx`, the dictionaries, and the `format.ts` seam

**Depends on:** nothing. **Blocks:** WI-4 … WI-8, and every later web WI.

**Files**

- `apps/web/src/lib/i18n-core.ts` (new, **React-free** — C2/must-fix 1):

```ts
export type Locale = "en" | "zh";
export const LOCALE_KEY = "agentos.locale";
export const DICTIONARIES: Record<Locale, Record<string, string>>;
export const translate: (locale: Locale, key: string, vars?: Record<string, string | number>) => string;
export const isLocale: (value: unknown) => value is Locale;
```

- `apps/web/src/lib/i18n.tsx` (new, the React surface):

```ts
export const LocaleProvider: ({ children, initialLocale }: {...}) => ReactNode
export const useLocale: () => { locale: Locale; setLocale: (next: Locale) => void }
export const useT: () => (key: string, vars?: Record<string, string | number>) => string
export type { Locale };            // re-exported so call sites import one module
```

  The split exists because `format.ts` must call `translate` for its provider-free
  default while `i18n.tsx` must call `setFormatLocale` from `format.ts`. Without
  the core module that is an import cycle. `i18n-core.ts` imports nothing from
  `format.ts`, and nothing from React.

  In `i18n-core.ts`:

  - Fallback chain `zh → en → key` (spec §4.3.4). A miss never throws and never
    renders empty.
  - Interpolation is `{name}` replaced from `vars`; an unmatched placeholder is
    left in place rather than blanked, so a missing var is visible in review.

  In `i18n.tsx`:

  - Storage through `lib/storage.ts` (spec §6.17), key `agentos.locale`, values
    `"en" | "zh"`. Anything else, or absent, means `en`.
  - Cross-tab sync copies `theme.tsx:31-36` exactly: one `storage` listener,
    `event.key === LOCALE_KEY`, unrecognised `newValue` → `en`.
  - **No provider → `en`** (C7). This is the one intentional divergence from
    `useTheme`'s throwing shape and it carries a comment saying why.
  - The provider body calls
    **`setFormatLocale(locale, (key, vars) => translate(locale, key, vars))`**.
    The closure is not optional: `translate` is `(locale, key, vars)` and the
    callback is `(key, vars)`, so passing it bare is a type error (must-fix 1).

- `apps/web/src/lib/format.ts` — **the registration seam lands here, in this WI**,
  not in WI-4 (must-fix 1):

```ts
export type FormatTranslate = (key: string, vars?: Record<string, string | number>) => string;
export const setFormatLocale = (locale: Locale, translate: FormatTranslate): void;
```

  plus the module-private `activeLocale` / `activeTranslate`, defaulting to `"en"`
  and `(key, vars) => translate("en", key, vars)`. **Nothing in `format.ts`'s output
  changes in this commit** — the setter is stored and unused until WI-4. This is the
  smallest edit that makes WI-3 a commit that builds.
- `apps/web/src/locales/en.ts`, `apps/web/src/locales/zh.ts` (new): flat
  `Record<string, string>`, dotted keys `<area>.<screen>.<thing>`, sorted by key so
  a diff is readable and a duplicate key is visible. Both files exist from this WI
  with the shell/common keys **and the whole `format.*` namespace** (`justNow`,
  `minutesAgo`, `hoursAgo`, `daysAgo`, `seconds`, `minutesSeconds`, `inUnderAMinute`,
  `inMinutes`, `inHours`) so WI-4 is a pure consumer change; WI-5/6/7 grow the rest.
- `apps/web/src/main.tsx:15-17` — wrap: `<ThemeProvider><LocaleProvider><App /></LocaleProvider></ThemeProvider>` (C10/E5).

**Key-namespace convention** (binding, so three sweep commits agree):
`common.*` (`save`, `cancel`, `edit`, `delete`, `loading`, `retry`, `none`),
`sidebar.*`, `settings.*`, `status.task.*` / `status.run.*` / `status.goal.*` /
`status.inbox.*`, `runner.*`, `tools.*`, `agents.*`, `tasks.*`, `sessions.*`,
`goals.*`, `inbox.*`, `projects.*`, `connections.*`, `secrets.*`, `triggers.*`,
`automations.*`, `archived.*`, `errors.*`, `format.*`.

**Verification** — new `apps/web/src/tests/i18n.test.tsx`, spec §7.1-§7.5:

1. `Object.keys(en)` and `Object.keys(zh)` are equal as sets, asserted **both
   directions**.
2. No value in either dictionary is empty or whitespace-only.
3. For every key, the `{placeholder}` set extracted by `/\{(\w+)\}/g` is identical
   in both locales.
4. `translate("zh", k)` returns the zh string; falls back to `en` for a key deleted
   from `zh`; returns the key itself when it is in neither. (Tested against a local
   fixture pair, not by mutating the real dictionaries.)
5. Persistence: absent/garbage `agentos.locale` → `en`; `setLocale("zh")` writes
   `"zh"`; a synthetic `storage` event with `newValue: "zh"` updates the provider;
   one with `newValue: "de"` resets it to `en`.
6. `setFormatLocale` is called with a **two-argument** callback: render
   `<LocaleProvider initialLocale="zh">` and assert `formatDateTime` still returns
   today's `en-US` output (WI-3 registers the locale; WI-4 is what makes it bite).
   This is the assertion that would have caught the revision-0 ordering bug.

**Commit-boundary gate** (must-fix 1): `npm run build && npm test && npm run typecheck`
must pass **on this commit alone**, before WI-4 exists. WI-3 is the commit the review
showed could not build, so it is the commit that gets the explicit gate.

**Rollback:** self-contained. Reverting this commit and its dependants restores the
literals; nothing outside `apps/web/src` knows the module exists.

---

## WI-4 — `format.ts` and `schedule.ts`: locale-aware dates, relative time and cron prose

**Depends on:** WI-3. **Blocks:** WI-5/6/7.

**Files** — `apps/web/src/lib/format.ts` and `apps/web/src/lib/schedule.ts`.
`schedule.ts` was WI-6's "if it carries user-visible English" footnote in revision 0;
the review was right that this is not a maybe (must-fix 3), so it moves here, where
the locale plumbing is.

- Replace the two module-level `Intl.DateTimeFormat` constants (`:1-2`) with a
  `Map<Locale, Intl.DateTimeFormat>` per style, built lazily. Locales: `en-US`
  (unchanged from today) and `zh-CN`.
- `setFormatLocale` already exists (WI-3). This WI makes `formatDate`,
  `formatDateTime`, `timeAgo` and `duration` **read** `activeLocale` /
  `activeTranslate`, and exports `formatT(key, vars)` — the module-level translator
  `schedule.ts` uses, so that pure module stays parameter-free (C2).
- `timeAgo` (`:10-20`) — the five English fragments become keys:
  `format.justNow` (`just now` / `刚刚`), `format.minutesAgo` (`{n}m ago` / `{n} 分钟前`),
  `format.hoursAgo`, `format.daysAgo`. The `≥30 days → formatDate` branch is unchanged.
- `duration` (`:22-29`) — `{n}s` and `{n}m {n}s` become `format.seconds` and
  `format.minutesSeconds` (two vars, `m` and `s`).
- **Unchanged, explicitly** (spec §4.3.8): the `—` placeholder everywhere, `money`'s
  `$` prefix and `toFixed(2)`, `compactTokens`'s `K`/`M` suffixes and its two
  threshold comments, `sha`, `titleCase`, `firstLine`, `restLines`, `initial`,
  `repoWebUrl`, `compact`.

**`schedule.ts` — the three English surfaces the review found** (must-fix 3):

1. `nextRunLabel` (`:27-37`) emits `in under a minute`, `in ${minutes}m`,
   `in ${hours}h`. These become `format.inUnderAMinute`, `format.inMinutes`,
   `format.inHours` through `formatT`. The `delta < 0 → timeAgo` branch and the
   `≥ 24 h → formatDateTime` branch are already covered by `format.ts`.
2. `cronProse` (`:14-23`) calls `cronstrue.toString(expression, {
   throwExceptionOnParseError: true })` and takes the library's default English.
   It becomes `import cronstrue from "cronstrue/i18n"` with
   `{ throwExceptionOnParseError: true, locale: activeLocale() === "zh" ? "zh_CN" : "en" }`.
   The `catch → return expression` fallback and the `(timezone)` suffix are
   unchanged — an unparseable expression still renders verbatim, in every locale.
3. `scheduleLabel` (`:68-74`) and `automationState` return no prose and are
   untouched; `Automations.tsx:23-28`'s `stateLabel` is WI-6's, not this WI's.

**Before writing the `locale` argument, verify the locale exists** — one command,
because a wrong locale id makes `cronstrue` throw and every schedule cell would fall
back to the raw expression:

```sh
node -e "console.log(Object.keys(require('cronstrue/i18n').locales ?? {}).join(' '))"
# or: ls node_modules/cronstrue/dist/i18n/locales | grep -i zh
```

If `zh_CN` is not among them, the fallback is: keep English prose, add **one**
allowlist entry in WI-8 naming it as third-party output, and open a follow-up.
Do not hand-roll a cron describer. (`apps/web/package.json:19` pins `cronstrue ^3.24.0`.)

**Verification** — extend `apps/web/src/tests/i18n.test.tsx` or a new
`format-locale.test.tsx`:

- `formatDate` / `formatDateTime` of a fixed ISO instant differ between `en` and
  `zh`, and the `en` output is **byte-identical to today's** (guard against an
  accidental option change — capture the current strings first and pin them).
- `timeAgo` with a frozen clock returns the `en` fragments today produces, and the
  zh fragments after `setFormatLocale("zh", …)`.
- `duration(null, x) === "—"` in both locales.
- `money`, `compactTokens`, `sha` outputs are locale-invariant.
- **`nextRunLabel`** with a frozen clock: `in 3h` under `en`, the zh string under
  `zh`, and `—` for `null` in both.
- **`cronProse("0 9 * * 1", null)`** returns different, non-empty prose under `en`
  and `zh`, and **the `en` output is byte-identical to today's** — the assertion
  that catches a locale id that silently changes English wording.
- `cronProse` on an unparseable expression returns that expression verbatim in
  both locales (the `catch` path must not become locale-dependent).

**Rollback:** two files; reverting restores the pinned `en-US` formatters and
cronstrue's default locale.

---

## WI-5 — i18n sweep A: shell, app, and shared components

**Depends on:** WI-3, WI-4. **Blocks:** WI-8.

**Files** — `apps/web/src/App.tsx`, `components/Shell.tsx`, `components/ui.tsx`,
`components/chain-list.tsx`, `components/goal-limit-inputs.tsx`,
`components/new-task-panel.tsx`, `components/secret-value-input.tsx`,
`components/tasks-tabs.tsx`. (`components/icons.tsx` has no user-visible text.)

**What changes**

- `Shell.tsx:21-30` — `NAV`'s eight `label` fields become keys
  (`sidebar.nav.inbox` …). The table keeps its shape; only the value moves.
- `Shell.tsx:38-51` — `No project`, `Select project`, `No projects yet`,
  `Manage projects…`.
- `Shell.tsx:88-93` — `Control plane`, `online`/`degraded`/`offline`, `Settings`,
  and the theme button's `aria-label` (`Theme: ${mode}. Switch to ${nextMode[mode]}.`
  becomes `sidebar.theme.aria` with two vars, and the mode words become
  `sidebar.theme.system|light|dark`). The runner row itself is rewritten by WI-13;
  this WI translates what is there so the sweep guard can go green before WI-13.
- `Shell.tsx:79-81` — the Inbox badge keeps its count source and cadence (spec
  §4.4.4); it gains an `aria-label` from `sidebar.inbox.unread` with `{n}`.
- `App.tsx:52-55, 62, 81` — the three Chinese banners. English becomes the `en`
  entry, the **existing Chinese wording becomes the `zh` entry verbatim** (spec
  §4.3.6). They contain `<code>` elements, so they are authored as keys whose value
  is plain text plus `{token}` placeholders, and the JSX interpolates the `<code>`
  around the substituted value — a translated string never contains markup.
- `components/ui.tsx` — `GapNotice` (`:322-329`, Chinese), `ErrorNotice`'s `Retry`
  button (`:346`), `InfoNotice`'s dismiss affordance, `EmptyState` callers stay
  where they are, and **the status pills at `:129-138`**: `status.toLowerCase()` /
  `.replace("_"," ")` becomes a dictionary lookup keyed by the enum value
  (`status.task.DOING`, `status.run.WAITING_INBOX`, `status.goal.ACTIVE` → the
  existing special case `running`, `status.inbox.OPEN` → `Awaiting reply`). One key
  per enum value, per spec §4.3.7. The tone maps (`:117-126`) are untouched.
- `components/ui.tsx:512` — `Label` renders `titleCase(value)` on raw enum-ish
  values; it stays as-is where the value is a technical identifier (spec §4.3.7's
  carve-out) and its call sites are audited one by one in WI-6/7.
- `new-task-panel.tsx`, `goal-limit-inputs.tsx`, `secret-value-input.tsx`,
  `tasks-tabs.tsx`, `chain-list.tsx` — every label, placeholder, `title`,
  `aria-label`, empty state and hint.

**Verification**

- `npm run build && npm test` — `tasks-tabs.test.tsx` and `chain-list.test.tsx`
  assert English labels; they now assert `translate("en", "…")` instead of a
  literal (spec §7.20). No test's *expected value* changes; only where it comes from.
- Manual: with `agentos.locale` unset, every string in the sidebar and the three
  banners is byte-identical to before this commit. This is the property that makes
  the sweep reviewable.

**Rollback:** revert restores literals; dictionary entries left behind are inert.

---

## WI-6 — i18n sweep B: Tasks, TaskDetail, Automations, Triggers, Archived, Sessions

**Depends on:** WI-5. **Blocks:** WI-8.

**Files** — `apps/web/src/pages/{Tasks,TaskDetail,Automations,Triggers,Archived,Sessions}.tsx`.
(`lib/schedule.ts` is **WI-4's**, not this WI's — must-fix 3.)

Three literal shapes in this file set that the revision-0 guard could not see, named
here so the sweep does not miss them and WI-8's fixtures have real precedents:

- `Tasks.tsx:33-41` — `COLUMNS: Array<{ status; label }>` with five object-literal
  labels (`Backlog`, `Todo`, `Doing`, `Review`, `Done`). The array keeps its shape;
  `label` becomes a key resolved at render.
- `Automations.tsx:23-28` (`:25-27`) — `stateLabel` **returns** `Paused` / `Quarantined` /
  `Active`, the note `Fix the cron expression`, and a template literal
  `` `Next run ${nextRunLabel(task.runAt)}` ``. The template becomes
  `automations.nextRun` with an `{at}` var; the function takes no new parameter
  because it can call `useT`'s output through its caller — or, if it stays pure,
  `formatT` (WI-4). Pick one and say which in the commit message.
- `TaskDetail.tsx` / `Triggers.tsx` — `window.confirm` text and `title` attributes.

**What changes** — the same six categories every time: JSX text, button/link labels,
table headers, tab/segmented labels, empty states and error notices, plus the
attribute set `placeholder`, `title`, `aria-label`, `alt`, and any `window.confirm`
text (spec §4.3.6).

`Sessions.tsx:172` carries the Chinese `what="会话列表"` prop into `GapNotice`; the
prop becomes a key and `GapNotice` (already translated in WI-5) interpolates it.

**Not extracted** (spec §4.3.7): API-sourced values (task/agent/session names,
branch names, shas, model ids, server error text), code blocks and JSON, the string
`AgentOS`, punctuation-only runs (`·`, `—`, `/`).

**Verification**

- `sessions.test.tsx`, `triggers.test.tsx`, `automations.test.tsx`,
  `tasks-board.test.tsx`, `task-detail.test.tsx` pass, with literal expectations
  rewritten as `translate("en", …)` where the label moved.
- Manual: `/tasks`, a task detail, `/automations`, `/triggers`, a trigger detail,
  `/archived`, `/sessions`, a session detail render identically in English.

**Rollback:** per-commit revert.

---

## WI-7 — i18n sweep C: Agents, Goals, Inbox, Projects, Connections, Secrets

**Depends on:** WI-6. **Blocks:** WI-8.

**Files** — `apps/web/src/pages/{Agents,Goals,Inbox,Projects,Connections,Secrets}.tsx`.

Same rules as WI-6, plus the three remaining Chinese sites: `Agents.tsx:77`,
`Agents.tsx:453` (**do not port `execution.ts` into the new string — C11**), and
`Connections.tsx:99-101`.

The dominant literal shape in this file set is **component props**, not JSX text:
`Secrets.tsx:48` (`<Field label="Name" hint="Referenced by repos, MCP connections
and agent grants.">`), `:56-58` (a ternary whose both arms are user copy), `:126-127`
(`RowMenu items={[{ label: "Edit" }, { label: "Delete", danger: true }]}`), and
`Modal title={secret ? `Edit {name}` : "New secret"}` at `:40`. All four
are inside WI-8's guard once it is an AST scan; all four are invisible to a
JSX-text regex. The `Edit ${secret.name}` case becomes a key with a `{name}` var —
the interpolated value is API data and stays untranslated.

`Agents.tsx` gets swept here and structurally changed in WI-15/16/17. That is two
commits on one file, deliberately: the sweep is mechanical and reviewable on its
own, and the feature commits then start from an already-translated file and add
keys rather than literals.

**Verification**

- `npm run build && npm test` green.
- Manual: `/agents`, an agent detail with all four tabs, `/goals`, a goal, `/inbox`,
  a thread, `/projects`, a project, `/connections`, `/secrets` in English —
  unchanged — then in Chinese: no English left except proper nouns, identifiers and
  API data.

**Rollback:** per-commit revert.

---

## WI-8 — The sweep guard test and its allowlist

**Depends on:** WI-5, WI-6, WI-7. **Blocks:** nothing, but every later web WI must
keep it green — which is the point of landing it here rather than last.

**Revision 1 rewrote this WI.** The revision-0 guard scanned JSX text, four
attributes and `window.confirm` with regexes. The review proved that insufficient
against literals that already exist in the very files it is meant to accept
(must-fix 2): `Secrets.tsx:48,56-58` (`label` / `hint` props), `Tasks.tsx:33-40`
(object-literal `label`s), `Automations.tsx:23-28` (returned literals and a template
literal). A JSX-text fixture would have gone green over hundreds of survivors. The
guard is now an **AST scan**.

**Files**

- `apps/web/src/tests/i18n-sweep.test.tsx` (new).
- `apps/web/src/tests/i18n-allowlist.ts` (new) — an exported array of
  `{ file, text, why }`, asserted to be **at most 25 entries**. A number, so growing
  it is a visible decision.
- `apps/web/src/tests/fixtures/i18n-regression-*.tsx` (new) — **six** fixtures, one
  per syntax category below, each asserted to be flagged. One fixture per category,
  not one overall, because a guard usually stops detecting one category at a time.
- `apps/web/package.json` — `typescript` added to `devDependencies` (it is already
  the root's only devDependency, `package.json:31`, and is what `tsc -b` in the
  `build`/`typecheck` scripts already runs). No third-party code enters the runtime
  bundle: the import is `test`-only.

**How the guard works** (spec §7.6). `ts.createSourceFile(…, ts.ScriptKind.TSX)` per
file over **`src/pages/**`, `src/components/**` and `src/lib/**`** — the last one
added because `schedule.ts` and `format.ts` hold user-visible copy and were outside
the revision-0 scan entirely. Walk the tree and flag a `StringLiteral`,
`NoSubstitutionTemplateLiteral` or `TemplateExpression` whose text (or any of whose
literal spans) contains **two or more consecutive letters**, when it appears in any
of these positions:

| # | Category | Example in the tree today |
|---|---|---|
| 1 | JSX text (`ts.isJsxText`, non-whitespace) | `Shell.tsx:88` `Control plane` |
| 2 | JSX attribute value on a **user-copy attribute**: `placeholder`, `title`, `aria-label`, `alt`, `label`, `hint`, `message`, `what`, `empty`, `description`, `confirmLabel` | `Secrets.tsx:48`, `Sessions.tsx:172` |
| 3 | Object-literal property whose key is in that same attribute set, plus `note` | `Tasks.tsx:36-40` (inside `COLUMNS`, `:33-41`), `Secrets.tsx:126-127` |
| 4 | `return` / arrow-body position inside a function whose name matches `/Label$\|^render\|Text$/`, and any literal in a `ConditionalExpression` arm in categories 1-3 | `Automations.tsx:25-27`, `Secrets.tsx:56-58` |
| 5 | Argument to `window.confirm` / `window.alert` / `window.prompt` | the confirm sites in `TaskDetail.tsx` / `Triggers.tsx` |
| 6 | Template literal in any of positions 1-4, judged on its literal spans only | `Automations.tsx:27`, `Secrets.tsx:40` |

Not flagged, by construction rather than by allowlist: any literal that is an
argument to `t(…)` / `translate(…)` / `formatT(…)`; `className`, `data-*`, `key`,
`href`, `to`, `type`, `role`, `id`, `value`, `name` attribute values; import
specifiers; literals inside a `TypeReference` or a union type; and template spans'
`${…}` expressions (those are data).

The attribute/property name list is a **named exported constant** in the test, so
adding a prop that carries copy is a one-line, reviewable change rather than a
silent gap.

**Known limitation, stated rather than papered over:** category 4 is a heuristic —
a helper that returns copy but is named `foo()` is not caught. The allowlist is not
the mitigation; the sweep commits WI-5/6/7 are, and any survivor found later is a
guard-rule bug to fix, not an allowlist entry to add.

Known-good exceptions that do go in the allowlist with a reason: `AgentOS` (spec
§4.3.7), any `<code>` child that is a technical identifier, and — only if WI-4's
check finds no `zh_CN` — `cronstrue`'s English prose.

**Verification**

- The guard passes on the tree after WI-7.
- The guard **fails on each of the six fixtures**, asserted per category, so a guard
  that stops detecting one syntax shape is itself a failing test.
- A positive control: a fixture whose every string is wrapped in `t(…)` passes.
- The allowlist length assertion is `<= 25`.

**Rollback:** deleting the test file. Note that reverting WI-5/6/7 without also
reverting WI-8 leaves a failing suite — revert them together or not at all.

---

## WI-9 — API: the daemon registry, `GET /runners`, and claim/heartbeat telemetry

**Depends on:** WI-1 (for the regenerated client only; independent otherwise).
**Blocks:** WI-10, WI-13, WI-14.

**Files**

- `packages/api/src/runners.ts` (new) — the in-process registry (spec §5.4):

```ts
export type DaemonTelemetry = {
  lastSeenAt: Date;
  daemonVersion: string | null;
  diskFreeBytes: number | null;
  pollIntervalMs: number | null;
  workspaceRoot: string | null;
};
export const RUNNER_FORGET_MS = 15 * 60_000;   // stale entries disappear from the snapshot
export const RUNNER_MAX_ENTRIES = 16;          // hard cap; oldest lastSeenAt evicted on insert
export const createRunnerRegistry = () => ({
  note(runnerId: string, telemetry: Partial<Omit<DaemonTelemetry,"lastSeenAt">>, now: Date): void,
  snapshot(now: Date): Array<{ runnerId: string } & DaemonTelemetry & { online: boolean }>,
});
```

  **`note` replaces, it does not merge** (review must-fix 5). Revision 0 merged, so
  that an older daemon omitting `diskFreeBytes` would not erase a newer one's
  reading for the same `runnerId`. That reasoning is wrong for the identity this
  code actually sees: `config.ts:29` defaults `runnerId` to
  `` `${hostname()}-${process.pid}` ``, so two daemons never share a key by
  accident, and when they do share one (a configured `RUNNER_ID`) the second is a
  *different incarnation* whose real state is "no disk reading" — the missing-value
  state spec §6.3 requires, not the dead process's number. Every `note` therefore
  writes all five fields from the observation, absent → `null`.

  **Entries are evicted** (same finding). Revision 0 assumed the map holds one or
  two keys; with a pid in the id, every daemon restart adds one permanently and
  `N of M` degrades forever. `snapshot` omits entries whose `lastSeenAt` is older
  than `RUNNER_FORGET_MS`, and `note` evicts the oldest `lastSeenAt` when inserting
  a key beyond `RUNNER_MAX_ENTRIES`. `total` counts what `snapshot` returns, so the
  ratio only ever describes daemons seen in the last 15 minutes.

  **Why the identity is not stabilised instead.** `runnerId` is a co-predicate of
  every fencing write (`app.ts:2484`, `:2726`:
  `where: { id, runnerId, fencingToken, leaseExpiresAt, status }`). Changing what a
  daemon calls itself across restarts changes which stale writes the control plane
  accepts, which is a runtime-semantics change this batch does not authorise.
  **Accepted consequence, and it must be written in the popover copy, not hidden:**
  for up to 15 minutes after a daemon restart the previous incarnation is still
  listed, `Offline`, and the row reads `1 of 2 runner online`. Setting `RUNNER_ID`
  in the daemon environment removes it; WI-14's Settings runner card says so in one
  line.

  `online` is `now - lastSeenAt <= max(3 × (pollIntervalMs ?? 5000), 30_000)`
  (spec §4.5.5). `snapshot` sorts by `runnerId` so the popover order is stable
  (spec §4.5.3).

- `packages/api/src/app.ts`:
  - `:539` — `const runners = createRunnerRegistry();` beside the existing
    per-app closure. **Not a module singleton** — `createApp` is a factory
    (`:537`) and `app.test.ts` builds several.
  - `:252-255` — `claimInput` gains the four optional fields with the spec's
    bounds, **each one individually recoverable** (review must-fix 4):

```ts
const telemetry = <T extends z.ZodTypeAny>(schema: T) =>
  schema.optional().catch(({ error, input }) => {           // zod 4.1 — packages/api/package.json:22
    console.warn("Discarded runner telemetry", { input, issues: error.issues });
    return undefined;
  });
const claimInput = z.object({
  runnerId: z.string().trim().min(1).max(120),
  leaseSeconds: z.number().int().min(15).max(3600).default(60),
  daemonVersion: telemetry(z.string().trim().max(40)),
  diskFreeBytes: telemetry(z.number().int().nonnegative()),
  pollIntervalMs: telemetry(z.number().int().positive().max(3_600_000)),
  workspaceRoot: telemetry(z.string().trim().max(500)),
});
```

    Revision 0 let a bad value 400 the whole claim and called it "loud". The review
    is right that it is loud in the wrong place: `readJson` (`app.ts:371-372`)
    parses before the handler body runs, so `diskFreeBytes: -1` would stop the
    daemon claiming *any* work — one observational field idling the runner. `.catch()`
    keeps this inside the **single existing parse**: the operational fields
    (`runnerId`, `leaseSeconds`) still fail hard, the telemetry field is dropped,
    the claim proceeds, and the discard is logged rather than silent. §17.2 records
    the withdrawal.
  - `:256-263` — `heartbeatInput` gains the same four through the same `telemetry`
    helper (spec §5.2), so a daemon mid-run keeps its last-seen fresh without
    waiting for a claim, and a bad value there cannot fail a heartbeat either.
  - `:2271` — the claim handler records `runners.note(body.runnerId, …, now)`
    **before** `reconcileDatabaseRuns` and **outside** the `$transaction`, so a poll
    that finds no work (the 204 at `:2410`) still refreshes last-seen. This is the
    whole point of item 7: today the API sees the signal and drops it.
  - `:2453` — the heartbeat handler does the same, before the `updateMany`, so a
    stale-fencing 409 still counts as "this daemon is alive".
  - New route `app.get("/runners", …)`, placed next to `/health` (`:556-564`) so the
    two control-plane reads sit together. It must **not** begin with `/runner/`
    (`auth.ts:48-53`) — the operator principal is forbidden there outright.
    Response shape exactly as spec §5.2, with:
    - `backends`: `RunnerBackendState.findMany()` mapped over **all three**
      `RunnerKind` values, so a backend that never preflighted appears with nulls
      rather than being absent.
    - `busy` / `activeRuns`: `db.run.groupBy({ by: ["runnerId"], where: { status:
      { in: activeRunStatuses }, runnerId: { in: knownIds } }, _count: true })` —
      `activeRunStatuses` (`app.ts:445`), **not** `ACTIVE_RUN_STATUSES` (C5/E2).
    - `checkedAt`, `online`, `total` at the top level.

**Verification** — `packages/api/src/control-plane.test.ts` (the existing home for
route-shape tests) or a new `runners.test.ts`, spec §7.11-§7.12:

1. Shape: `checkedAt`, `online`, `total`, `daemons[]`, `backends[]` with all three
   `RunnerKind` values present even on an empty table.
2. `online` boundary: a daemon reporting `pollIntervalMs: 5000` is online at 29 s
   and offline at 31 s (the `30_000` floor wins); one reporting `pollIntervalMs:
   20000` is online at 59 s and offline at 61 s.
3. `busy` from a `RUNNING` run owned by that `runnerId`; **a `QUEUED` run with the
   same `runnerId` does not make it busy** (the C5 regression test).
4. Auth: operator token → 200; runner token → 403 (`principalMayAccess`); no token
   → 401.
5. Claim with none of the four optional fields succeeds and still records last-seen.
6. **Invalid telemetry never fails the claim** (spec §7.12, must-fix 4), asserted
   twice because the two paths return from different places:
   - with **no claimable work**, a body carrying `diskFreeBytes: -1` returns the
     204, and the following `GET /runners` shows the daemon present with
     `diskFreeBytes: null` and a fresh `lastSeenAt`;
   - with **claimable work**, the same bad field returns the claimed run *and*
     the other three telemetry fields are stored.
   - `runnerId: ""` still 400s — the operational fields did not go soft.
7. A 204 claim (no work) still updates last-seen — assert via a following
   `GET /runners`.
8. **Incarnation churn** (must-fix 5): three claims from `host-1`, `host-2`,
   `host-3` in turn, 16 minutes apart on a frozen clock, leave exactly one daemon
   in the snapshot; three within one minute leave three, and `total` is 3.
9. **Replace, not merge**: `runner-a` claims with all four fields, then claims again
   with none of them; `GET /runners` shows `daemonVersion: null` and
   `diskFreeBytes: null`, not the previous values.
10. **The cap holds**: 20 distinct `runnerId`s inside one minute leave 16 entries,
    and the ones kept are the 16 most recently seen.

**Rollback:** the registry is in-process and disappears with the process (spec
§9.4). The four claim/heartbeat fields are optional, so a reverted API ignores a
newer daemon's telemetry and a reverted daemon simply sends none. Reverting this WI
alone breaks WI-13/WI-14, which fetch `/runners` — revert them together.

---

## WI-10 — Daemon: report version, disk free, poll interval, workspace root

**Depends on:** WI-9. **Blocks:** WI-13's real values (not its tests).

**Files**

- `packages/runner/src/config.ts` — add `daemonVersion: string` to `RunnerConfig`,
  read from `packages/runner/package.json` via `createRequire(import.meta.url)`
  (C4). Depth-symmetric between `src/` and `dist/`, same as `index.ts:3`'s `.env`
  resolution.
- `packages/runner/src/api.ts:90-95` (`claimTask`) and `:113-127` (`heartbeat`) —
  both bodies gain the same four fields. Disk free comes from
  `statfs(config.workspaceRoot)` (`node:fs/promises`, Node ≥ 18.15) computed as
  `bavail * bsize`; **a failure is not fatal** (spec §5.3): catch, omit the field,
  proceed with the poll. A daemon that cannot stat its workspace root must still
  claim work.
- No change to preflight, delivery, workspace provisioning or the failure
  classifier (spec §5.3).

**Verification** — `packages/runner/src/config.test.ts` and a new small test:

- `loadRunnerConfig().daemonVersion` **equals the `version` field of
  `packages/runner/package.json`**, read in the test through the same
  `createRequire(import.meta.url)("../package.json")` the code uses (review
  should-fix 4). A shape-only regex would pass on a plausible hardcoded string,
  which is precisely the failure mode C4 warns about. The test never writes the
  literal `0.0.0` — it compares two reads of one file, so it keeps passing when the
  workspaces are versioned for real (C4/E6).
- **Both bodies carry the same value**: build a claim body and a heartbeat body from
  the same config and assert `daemonVersion` is equal in both and equal to the
  package version.
- A `statfs` rejection leaves the claim body without `diskFreeBytes` and does not
  throw (inject a failing stat).
- The claim body still validates against the API's `claimInput` (round-trip the
  object through the same zod schema in the test, importing it — or duplicate the
  bounds and assert them, if the import crosses a workspace boundary the test
  harness will not resolve).

**Manual check** (spec §8.7): compare the reported `diskFreeBytes` against
`df -h ~/.agentos/runs` — they must agree to within a rounding step. This is the
check that catches a `bfree`-vs-`bavail` mix-up, which no unit test will.

**Rollback:** revert; the API's fields are optional and a reverted daemon simply
sends none.

---

## WI-11 — Runner: tool deny flags in `argsForRunner`, and the enforcement capture

**Depends on:** WI-1. **Blocks:** WI-16's honesty tags.

**Files**

- `packages/runner/src/adapters.ts:343-371` (`argsForRunner`) — insert the deny
  mapping. Shape (C9):

```ts
const CLAUDE_TOOL_NAMES: Partial<Record<ToolKey, string>> = {
  BASH: "Bash", READ: "Read", WRITE: "Write", EDIT: "Edit",
  GLOB: "Glob", GREP: "Grep", WEB_FETCH: "WebFetch", WEB_SEARCH: "WebSearch",
};
const PI_TOOL_NAMES: Partial<Record<ToolKey, string>> = {
  BASH: "bash", READ: "read", WRITE: "write", EDIT: "edit",
};  // C8: GREP/GLOB are off by default on pi; WEB_* do not exist there
```

  - CLAUDE: when the mapped list is non-empty, emit `["--disallowedTools", names.join(",")]`
    **immediately before `--mcp-config`** (`:353`), never adjacent to the trailing
    positional `input` (C9).
  - PI: when non-empty, emit `["--exclude-tools", names.join(",")]` immediately
    before `--extension` (`:368`).
  - CODEX: nothing. No flag exists (§2.5 of the spec, `codex-exec-help.stdout:52-62`).
  - Order is the fixed canonical order `BASH, READ, WRITE, EDIT, GLOB, GREP,
    WEB_FETCH, WEB_SEARCH` filtered by the deny set, so the emitted string is
    deterministic and snapshot-testable.
  - **When the deny set is empty, emit nothing** — the argv must be byte-identical
    to today's for all three runners (spec §4.7.3).
- `packages/runner/src/api.ts:28-34` — `agent.disabledTools: string[]` (C3). The
  value reaches `argsForRunner` through `spec.claim.agent.disabledTools`;
  `argsForRunner` already receives the whole `RunSpec` (`:343-345`), so no signature
  change is needed.

**The enforcement capture (spec §4.7.5) — this WI is not done without it.**

Run one real CLAUDE session with `BASH` denied, using the existing harness
(`spikes/cli-capabilities/run_capture.py`), and commit the artefacts to
`spikes/cli-capabilities/samples/` as `claude-disallowed-bash.{stdout,stderr,meta.json}`.
The session must ask the model to run a shell command, and the capture must show
the tool call being refused **by the CLI**, with `--dangerously-skip-permissions`
present in the recorded argv. If it is not refused:

- **Fallback (a):** `--allowedTools` with the complement set, captured the same way.
- **Fallback (b):** ship the toggles stored-but-unenforced, tag them `not enforced`
  on **every** runner in WI-16, and open a follow-up.

Under no circumstance does WI-16's UI claim enforcement that this capture did not
show. Whichever branch is taken is written into the PR description and into
`docs/runbooks/batch-1-rollback.md` (WI-18).

**Verification** — `packages/runner/src/adapters.test.ts` (exists), spec §7.14-§7.15:

1. **Byte-identical snapshot** for `disabledTools: []` on CLAUDE, CODEX and PI —
   capture today's arrays first and pin them as literals, so a future edit to the
   MCP or model flags is caught here too.
2. `["BASH","WEB_SEARCH"]` → CLAUDE argv contains exactly
   `"--disallowedTools", "Bash,WebSearch"`; PI argv contains exactly
   `"--exclude-tools", "bash"`; CODEX argv is unchanged from the empty case.
3. The flag never sits immediately before the positional `input` (assert the index
   of `--disallowedTools` is at least two less than `argv.length - 1`) — the C9
   regression test.
4. All eight denied → CLAUDE gets all eight names in canonical order; PI gets
   `bash,read,write,edit`.
5. A resume invocation carries the same flags (CLAUDE's resume branch shares the
   array; CODEX's `exec resume` branch legitimately does not, and the test says so).

**Rollback:** the flags disappear with the reverted `adapters.ts`; an in-flight run
is unaffected because argv is fixed at spawn (spec §9.5).

---

## WI-12 — Web: `lib/models.ts` and `lib/tools.ts`

**Depends on:** WI-1 (type only). **Blocks:** WI-15, WI-16.

**Files**

- `apps/web/src/lib/models.ts` (new) — configuration plus pure functions
  (decisions §6.4: model ids appear only in config):

```ts
export type CatalogModel = { id: string; label: string; runner: "CLAUDE"|"CODEX"|"PI"; efforts: string[]; defaultEffort: string };
export const MODELS: CatalogModel[]
export const splitModel = (raw: string): { model: string; effort: string | null }
export const joinModel = (model: string, effort: string | null): string
export const findModel = (id: string): CatalogModel | null
export const runnerForModel = (id: string): "CLAUDE"|"CODEX"|"PI"|null
// added in revision 1 — review must-fix 7 and 9:
export const resolveRunner = (preference: RunnerPreference, model: string): "CLAUDE"|"CODEX"|"PI"
export type ModelPairIssue = { kind: "mismatch"; model: string; expected: RunnerKind; actual: RunnerPreference } | { kind: "empty-model" } | null
export const validateModelPair = (model: string, preference: RunnerPreference): ModelPairIssue
```

- **`resolveRunner` — a byte-faithful mirror of `runnerFor` (`workflow.ts:22-30`)**,
  because the Tools card must name the runner the *runtime* will pick, and
  `runnerForModel` returns `null` for anything uncatalogued (must-fix 7):

```ts
export const resolveRunner = (preference: RunnerPreference, model: string) => {
  if (preference === "CLAUDE" || preference === "CODEX" || preference === "PI") return preference;
  const normalized = model.toLowerCase();                       // workflow.ts:26
  if (normalized.includes("codex")) return "CODEX";             // workflow.ts:27
  if (normalized.includes("deepseek") || normalized.split(/[\/:_-]+/u).includes("pi")) return "PI";
  return "CLAUDE";                                              // workflow.ts:29-30
};
```

  It always returns a concrete kind, so `ENFORCED_BY` — which is keyed by the three
  `RunnerKind` values only — can never be indexed with `INHERIT` or `AUTO`. The two
  functions coexist on purpose: `runnerForModel` answers "what does the catalog say"
  (and drives WI-15's read-only Runner control), `resolveRunner` answers "what will
  actually run" (and drives WI-16's honesty tags). The comment in each names the
  other and names `workflow.ts:22-30` as the thing they must not drift from.

- **`validateModelPair` — the one validator, consumed by three call sites**
  (must-fix 9). `mismatch` when `findModel(model)` exists and `preference` is a
  concrete kind that is not that entry's `runner`; `empty-model` when the id trims
  to empty. A `Custom…` model with any preference is valid — that is the escape
  hatch. The picker renders its notice from the returned issue; **both parents put
  `validateModelPair(...) !== null` into their `disabled` expressions** (WI-15).

  - `splitModel` **must reproduce `adapters.ts:329-331` exactly**: `lastIndexOf(":")`,
    and a split only when the index is `> 0`. A leading-colon input (`":high"`)
    therefore returns `{ model: ":high", effort: null }` — the same as the runner.
  - Catalog entries (spec §4.6.2), covering the whole roster so no existing agent
    renders as `Custom…`. **Supersession (2026-08-17):** Leo's final canonical
    model decision restores Fable as a supported CLAUDE catalog model. The
    current roster and defaults are authoritative in `agents/roles/*.md` and
    `packages/db/prisma/agent-contract.ts`; this table records the resulting
    catalog rather than the earlier implementation-time roster count.

| id | label | runner | efforts | default |
|---|---|---|---|---|
| `claude-fable-5` | Claude Fable 5 | CLAUDE | low, medium, high, xhigh, max | medium |
| `claude-opus-5` | Claude Opus 5 | CLAUDE | low, medium, high, xhigh, max | high |
| `claude-sonnet-5` | Claude Sonnet 5 | CLAUDE | low, medium, high, xhigh, max | high |
| `claude-haiku-4-5` | Claude Haiku 4.5 | CLAUDE | low, medium, high, xhigh, max | high |
| `gpt-5.6-sol` | GPT-5.6 Sol (codex) | CODEX | high, xhigh, max | high |
| `gpt-5.6-luna` | GPT-5.6 Luna (codex) | CODEX | high, xhigh, max | xhigh |
| `openai-codex/gpt-5.6-luna` | GPT-5.6 Luna (pi) | **PI** | off, minimal, low, medium, high, xhigh, max | xhigh |

  - CLAUDE efforts from `claude-help.stdout:72-73`; PI from `pi-help.stdout:40`.
    **CODEX is deliberately narrow** — only the three values in production use —
    until the implementation step checks the installed CLI (spec §4.6.3, §10.7).
    The check is `codex exec --help` plus `codex -c model_reasoning_effort=…` with
    a nonsense value to see whether it errors; whatever is learned is captured into
    `spikes/cli-capabilities/samples/` and the table widened in the same commit or
    left alone with a comment saying it was checked.
  - The earlier Fable exclusion is superseded. `claude-fable-5` is a formal
    catalog entry and the canonical default for Specification Writer and Planner
    at medium effort. Catalog coverage tests must require it rather than place it
    in an intentionally-absent list.
- `apps/web/src/lib/tools.ts` (new):

```ts
export const TOOL_KEYS = ["BASH","READ","WRITE","EDIT","GLOB","GREP","WEB_FETCH","WEB_SEARCH"] as const;
export type ToolKey = typeof TOOL_KEYS[number];
export const TOOL_LABEL_KEYS: Record<ToolKey, string>            // i18n keys, not English
export const ENFORCED_BY: Record<"CLAUDE"|"CODEX"|"PI", ToolKey[]>
export const isEnforced = (runner, key): boolean
```

  `ENFORCED_BY.CLAUDE` = all eight; `ENFORCED_BY.PI` = `BASH, READ, WRITE, EDIT`
  (C8); `ENFORCED_BY.CODEX` = `[]`. **This table must stay in lockstep with
  `adapters.ts`'s two maps** — the two files are in different workspaces and cannot
  import each other, so WI-16's test asserts the web table against a hand-copied
  literal and a comment in each file names the other.

**Verification** — new `apps/web/src/tests/models.test.tsx`, spec §7.7-§7.9:

1. Every model id in `agents/roles/*.md` (read from disk in the test — the files are
   in the repo) is present in `MODELS`; there is no intentionally-absent exception.
2. Every entry's `defaultEffort` ∈ its `efforts`; no entry has empty `efforts`;
   ids are unique.
3. `splitModel`/`joinModel` round-trip `claude-opus-5:high`, `gpt-5.6-luna:max`,
   `openai-codex/gpt-5.6-luna:xhigh`, bare `claude-opus-5`, and `":high"` — the
   last one asserting the `> 0` rule against `adapters.ts:330`.
4. `runnerForModel("openai-codex/gpt-5.6-luna") === "PI"` — the case
   `workflow.ts:22-30`'s substring heuristic gets wrong (spec §7.9).
5. `TOOL_KEYS` has exactly eight entries in the canonical order, and `ENFORCED_BY`
   covers all three runners.
6. **`resolveRunner` matches `workflow.ts:22-30` on a hand-copied table** (must-fix 7):
   `(CLAUDE, "gpt-5.6-luna") → CLAUDE`, `(INHERIT, "gpt-5.6-luna") → CLAUDE`,
   `(INHERIT, "openai-codex/gpt-5.6-luna") → CODEX` (**the heuristic's known wrong
   answer, faithfully reproduced** — the web must predict what runs, not what should
   run), `(AUTO, "some-pi-model") → PI` via the `split(/[\/:_-]+/u)` rule,
   `(AUTO, "deepseek-v3") → PI`, `(AUTO, "anything-else") → CLAUDE`, and
   `(PI, "openai-codex/gpt-5.6-luna") → PI` — the catalog path WI-15 writes.
   Its result is always one of the three keys of `ENFORCED_BY`.
7. **`validateModelPair`** (must-fix 9): `("gpt-5.6-luna", "CLAUDE")` is a
   `mismatch` naming both; `("gpt-5.6-luna", "CODEX")` is `null`;
   `("my-own-model", "INHERIT")` is `null`; `("", "CLAUDE")` is `empty-model`;
   `("claude-opus-5:high", "CLAUDE")` is `null` — the effort suffix must be split
   off before the catalog lookup, not treated as part of the id.

**Rollback:** two new files with no importers until WI-15/16.

---

## WI-13 — Web: `components/runner-status.tsx` and the sidebar row

**Depends on:** WI-2 (hover-card), WI-9. **Blocks:** WI-14 (shares the fetch).

**Files**

- `apps/web/src/lib/types.ts` — `RunnersResponse`, `DaemonStatus`, `BackendStatus`
  mirroring WI-9's payload.
- `apps/web/src/components/runner-status.tsx` (new) — exports `RunnerRow` (the
  sidebar row plus popover), the **`RunnersProvider` / `useRunners()` pair**, and
  the pure `runnerSummary(payload, now)` that both the row and the Settings page
  use. Making the summary pure is what lets §7.13 be a unit test.

  **The provider, and where it mounts** (review must-fix 8). Revision 0 defined
  `useRunners()` as its own `usePoll` and left the "lift it into a context" decision
  in WI-14's prose, with no API and no test. Settled here:

```ts
export const RunnersProvider = ({ children }: { children: ReactNode }): ReactNode;
export const useRunners = (): {
  runners: Poll<RunnersResponse>;   // one usePoll("/runners", 30_000)
  health: Poll<Health>;             // one usePoll("/health", 10_000) — see below
};
```

  - **Mounted once, in `App.tsx`**, immediately inside `ProjectProvider` and
    wrapping `<Shell>`. `Shell` renders both the sidebar and `{children}`
    (the `<aside>` at `Shell.tsx:72` and `<main className={CONTENT}>{children}</main>`
    at `:97`), so one mount at that level encloses the sidebar row and the routed
    `/settings` page. Mounting it *inside* `Shell` would work identically
    (children render in Shell's subtree); `App.tsx` is chosen so the provider stack
    reads in one place next to `ProjectProvider`.
  - **It also owns the `/health` poll.** Shell polls `/health` at 10 s today
    (`Shell.tsx:59`) and the Settings control-plane card needs the same data; two
    hooks would mean two intervals for the second time in one batch. `Shell` reads
    `health` from the context instead of its own `usePoll`. Spec §10.15 keeps the
    `/health` endpoint and its cadence — both unchanged, only the ownership moves.
  - **Provider-free default is an idle poll, not a throw** — same reasoning as C7:
    eight existing test files render pieces of the shell with no providers.
- `apps/web/src/lib/hooks.ts:9-16, 19-64` — `Poll<T>` gains
  `lastSuccessAt: string | null` (review should-fix 2), set from `new Date().toISOString()`
  on a successful load and **left untouched by a later failure**, which is exactly
  the "last successful poll" Settings must render. One shared change; every existing
  consumer ignores the new field.
- `apps/web/src/components/Shell.tsx:57-99` — the `Control plane` row is replaced
  by `<RunnerRow />`; `:59`'s `usePoll<Health>` becomes `useRunners().health`. The
  health data is passed into the popover, which shows a line at the top when it is
  failing (spec §4.4.3).
- `apps/web/src/components/ui.tsx` — no new constants; `RUNNER_ROW`, `RUNNER_STATE`,
  `DOT`, `DOT_TONE` (`:55-56, 99-100`) are reused unchanged so the row's geometry
  does not move.

**Behaviour** (spec §4.4, §4.5, §6.1-§6.6):

- States: `Running` (online, no active run), `Busy` (online, ≥1 active run),
  `Offline` (known but stale), `Never seen` (no daemon in the registry — distinct
  from `Offline`), `Unknown` (fetch failed **or payload older than 60 s** — C6).
- Dot tone: green online, amber online-with-any-`circuitOpen` backend, grey
  offline / never seen / unknown. All three tones already exist in `DOT_TONE`.
- Popover: opens on hover **and on keyboard focus**, closes on `Escape`
  (Radix HoverCard gives hover + focus; the trigger must be focusable — use a
  `<button type="button">` wrapper, not a `<div>`, or `tabIndex={0}` with an
  explicit `role`). Header `Local runner`, then `{n} of {m} runner online`, then one
  block per daemon sorted by `runnerId`, then three CLI lines, then the footer
  `Refreshes every 30s`.
- **It does not fetch on open** (spec §4.5.6) — it renders what the 30 s poll last
  returned.
- Empty states are `—`, never `0` / `unknown` / blank (spec §4.2.4).
- Disk below **2 GB** renders in the destructive tone (spec §6.5). A colour, no
  modal.
- `circuitReason` truncated to one line in the popover; full text on Settings.
- The row links nowhere (spec §4.4.5).

**Verification** — new `apps/web/src/tests/runner-status.test.tsx`, spec §7.13:

1. All seven fields render for a full payload.
2. `Busy` badge present only when `busy: true`; absent (not a grey `Idle`) otherwise.
3. `Never seen` (empty `daemons`) versus `Offline` (`online: false`) render
   different strings.
4. `daemonVersion: null` and `diskFreeBytes: null` render `—`.
5. `diskFreeBytes` below 2 GB carries the destructive class; above it does not.
6. A backend with `circuitOpen: true` shows its `circuitReason`.
7. **C6:** a payload whose `checkedAt` is 90 s old renders `Unknown` with the grey
   dot even though it says `online: true`. Frozen clock.
8. Two daemons → `2 of 2 runner online` and two blocks, sorted.
9. **One fetch per path, both consumers mounted** (must-fix 8): with fake timers and
   a counting `fetch` stub, render `<RunnersProvider><Shell><SettingsPage/></Shell></RunnersProvider>`,
   advance 90 s, and assert exactly **3** requests to `/runners` and **9** to
   `/health` — the counts a single interval each produces. Mounting the page twice
   must not change them. Without this the "re-uses the same fetch" requirement
   (spec §4.2.7) has no acceptance criterion at all.
10. **`lastSuccessAt` survives a failure** (should-fix 2): a successful poll, then a
    failing one; `lastSuccessAt` is unchanged while `error` becomes non-null.

**Rollback:** revert restores the `Control plane` row verbatim (it is a five-line
block, kept in the commit message for that reason).

---

## WI-14 — Web: the `/settings` route, the page, and the nav fix

**Depends on:** WI-3 (translated from birth), WI-13 (shares `useRunners`).
**Blocks:** nothing.

**Files**

- `apps/web/src/components/icons.tsx` — new `IconSettings`, a gear in the same
  16px / `strokeWidth 1.3` `Svg` shape as its 25 neighbours. `IconActivity`
  (`:47-49`) stays exported: it is the wrong icon for Settings, not a dead one.
- `apps/web/src/App.tsx:21-42` — add `{ pattern: "/settings", render: () => <SettingsPage /> }`
  after `/secrets` (`:41`). One segment, no params, no ordering hazard with
  `matchRoute`'s segment-count comparison.
- `apps/web/src/components/Shell.tsx:91` — `to="/settings"`, `<IconSettings />`,
  and the row must highlight active like every other nav row. Today the footer
  `Settings` link is a bare `NAV_ITEM` with no active handling (`active()` at
  `:67-68` is only applied to the `NAV` table). Give it the same
  `cn(NAV_ITEM, path === "/settings" && NAV_ITEM_ACTIVE)` treatment (spec §4.2.2).
  **`/secrets` and its `NAV` entry at `:29` are untouched.**
- `apps/web/src/pages/Settings.tsx` (new) — three `Card`s:
  - **Appearance** — `Language` as a `Segmented` (`English` / `中文`) bound to
    `useLocale`; `Theme` as a `Segmented` (`System` / `Light` / `Dark`) bound to
    `useTheme`. Both use the existing `Segmented` primitive (`ui.tsx:211`), so the
    control matches every other segmented control in the app. The sidebar cycle
    button stays (spec §10.14) and both write the same store, so they stay in sync
    live with no extra wiring.
  - **Runner** — the full version of the popover: one row per daemon with all seven
    fields, one row per CLI backend with `cliVersion`, `authMode`, last preflight
    time and result, circuit state and **full** reason. Missing data is `—`.
    Includes the one-line seed warning required by spec §4.6.10: *"`npm run db:seed`
    rewrites every agent's model and runner from `agents/roles/*.md`."*
    Includes a second one-liner, from WI-9's accepted consequence: *"A restarted
    daemon appears as a new entry for up to 15 minutes; set `RUNNER_ID` to keep one
    identity across restarts."*
  - **Control plane** — `/health` status (`ok` / `degraded` / unreachable), the API
    base URL (`apiBase` from `lib/api.ts:15`), and the time of the last successful
    poll — **`useRunners().health.lastSuccessAt`**, the field WI-13 adds to `Poll<T>`
    (review should-fix 2). Rendered through `timeAgo`, `—` before the first success.
    **No token, ever** — `apiBase` is `/api` in the proxied default and the
    operator token lives in the Vite proxy (`vite.config.ts:15, 25`); nothing on
    this page may read or render it.
  - Read-only apart from the two Appearance controls; no destructive action
    (spec §4.2.6).
  - Polling: **reads `useRunners()` from `RunnersProvider`** (WI-13), which owns the
    single 30 s `/runners` poll and the single 10 s `/health` poll. This page starts
    no interval of its own — that is the whole content of spec §4.2.7 ("re-uses the
    same fetch"), and WI-13's verification 9 is its acceptance criterion. Revision 0
    left this as a choice in prose with no API and no test; the review was right
    that placement is load-bearing (must-fix 8).

**Verification** — new `apps/web/src/tests/settings.test.tsx`:

1. `matchRoute("/settings", "/settings")` resolves to the page, and `/secrets` still
   resolves to `SecretsPage` (the mislink regression test).
2. The three cards render; the Runner card renders `—` for every missing field.
3. Setting the language through the Appearance control writes `agentos.locale` and
   changes a rendered string.
4. Theme and language controls read the same stores as the sidebar (assert the
   sidebar button's label changes after Settings sets the theme).
5. **No occurrence of the operator token** — assert the rendered markup does not
   contain `Bearer`, `OPERATOR_TOKEN`, or the value of `import.meta.env.VITE_API_TOKEN`.
6. **The control-plane card's timestamp is the last *successful* poll**
   (should-fix 2): with a provider whose health poll succeeds and then fails, the
   card shows `unreachable` **and** still shows the earlier timestamp — not `—`,
   not the failure's time.

**Manual** (spec §8.2, §8.4, §8.5): click `Settings` → `/settings`; `Secrets` still
opens `/secrets`; reload with 中文 selected stays Chinese; a second tab switching
language drags the first along.

**Rollback:** revert removes the route and the page; the sidebar link returns to
`/secrets`. No data, no schema.

---

## WI-15 — Agents: model dropdown, effort dropdown, and the runner they imply

**Depends on:** WI-7 (Agents already swept), WI-12. **Blocks:** nothing.

**Files** — `apps/web/src/pages/Agents.tsx`, plus a new shared control.

- New `apps/web/src/components/model-picker.tsx` — one component used by **both**
  the create form (`Agents.tsx:66-75`) and the detail edit form (`:451-458`), per
  spec §4.6.8. Props:
  `{ model: string; runnerPreference: RunnerPreference; onChange(next: { model, runnerPreference }): void }`.
  **Validation is not a prop and not internal state** (review must-fix 9): it is
  `validateModelPair(model, runnerPreference)` from `lib/models.ts` (WI-12), a pure
  function of the two values the parent already holds. The picker calls it to render
  its notice; each parent calls it for its button. No callback, no ref, no lifted
  state — the parents cannot get out of sync with the picker because they compute
  the same function over the same inputs.
  Renders three controls:
  - `Model` — a `Select` over `MODELS` plus a trailing `Custom…` option.
  - `Reasoning effort` — a `Select` over the selected entry's `efforts`.
  - `Runner` — a `Select` that is **read-only (disabled, showing the derived value)
    for a catalog model**, with the hint `Set by the model`, and fully editable
    (all five `RunnerPreference` values) under `Custom…` with a visible warning
    line (spec §4.6.7).
- Rules, all in the picker:
  - Selecting a catalog model sets `runnerPreference` to that entry's `runner` — a
    concrete kind, **never `INHERIT`** (spec §4.6.5), which is what bypasses
    `workflow.ts:22-30` for provider-prefixed catalog models such as the generic
    `openai-codex/…` PI regression fixture.
  - Switching models keeps the current effort when the new vocabulary contains it,
    otherwise falls back to the new entry's `defaultEffort`, **visibly, before
    saving** (spec §4.6.11 / scenario B).
  - A stored model absent from the catalog shows `Custom…` pre-filled and is **not
    rewritten on load** (spec §6.9).
  - A stored model with no effort suffix shows the entry's `defaultEffort` in the
    dropdown but **is not rewritten on load**; only an explicit save writes a
    suffix (spec §4.6.4).
  - A contradictory stored pair (e.g. `gpt-5.6-luna` + `CLAUDE`) renders an inline
    notice naming **both** values; the next save writes the corrected pair; loading
    such an agent **must not auto-save** (spec §6.10).
- **Both action buttons block on the same function** (spec §4.6.6, must-fix 9).
  Revision 0 said "save is disabled while any inline validation error is present"
  but put validation inside the picker, where neither button can see it. The two
  buttons live in the parents and today know only `pending` plus an emptiness check:
  - `Agents.tsx:52-53` (Create) — `disabled={pending || form.name.trim() === "" ||
    form.environmentId.trim() === ""}` gains
    `|| validateModelPair(form.model, form.runnerPreference) !== null`.
  - `Agents.tsx:413` (Save) — `disabled={pending}` gains
    `|| validateModelPair(draft.model, draft.runnerPreference) !== null`.
- `Agents.tsx:389-397` (`save`) — sends the recomposed `model` and the derived
  `runnerPreference`. (WI-17 removes `foundationalPrompt` from this same payload;
  the two WIs touch adjacent lines and must land in this order.)
- `Agents.tsx:156` (list `Model` column) — renders the catalog **label** plus the
  effort as a separate muted token (spec §4.6.9), falling back to the raw id for a
  non-catalog model.
- `Agents.tsx:70, 453` — the two `execution.ts` hints are replaced, not ported (C11).
- One line of hint text, on the Agents page or the Settings runner card, saying a
  UI model choice survives restarts but not `npm run db:seed` (spec §4.6.10). WI-14
  already places it on Settings; this WI decides whether to repeat it here. **Call:
  once, on Settings**, with the Agents hint linking to it — two copies of a caveat
  age at different rates.

**Verification** — new `apps/web/src/tests/model-picker.test.tsx`, spec §7.10:

1. Choosing `gpt-5.6-luna` sets `CODEX`; choosing `claude-opus-5` sets `CLAUDE`;
   choosing `openai-codex/gpt-5.6-luna` sets `PI`.
2. The runner control is disabled for a catalog model and enabled for `Custom…`.
3. A contradictory loaded pair renders the notice naming both values, and renders
   it **without** emitting an onChange (the no-auto-save assertion).
4. Switching from a model with `max` to one whose vocabulary lacks it selects that
   model's `defaultEffort`.
5. **The real buttons are asserted, not the picker's markup** (must-fix 9): render
   the whole `NewAgent` panel with a contradictory pair and assert the **Create**
   button carries `disabled`; render `AgentDetailPage` in edit mode with the same
   and assert the **Save** button does; fix the pair and assert both re-enable.
   A picker-only assertion would have passed against a form that saves anyway.
6. An agent stored as bare `claude-opus-5` renders effort `high` and, if the form is
   cancelled, the stored value is unchanged.

**Manual** (spec §8.8-§8.10): `senior-dev` shows `Claude Opus 5` / `high` /
`claude` read-only and the database already stores `claude-opus-5:high` /
`CLAUDE`. `librarian` shows `gpt-5.6-luna:high` / `codex`. In an unsaved form,
select the generic `openai-codex/gpt-5.6-luna` catalog entry and confirm its
derived runner is `pi`, then cancel; this preserves the substring-regression
coverage without treating that catalog entry as Librarian's current assignment.

**Rollback:** revert restores the two text inputs and the free runner select.
Nothing was written that the old UI cannot display.

---

## WI-16 — Agents: the Tools card, its honesty tags, and the 3.00 px drift

**Depends on:** WI-1, WI-11 (its capture decides what the card may claim), WI-12.

**Files** — `apps/web/src/pages/Agents.tsx` (`CapabilitiesTab`, `:295-372`).

- A `Tools` card, placed **first** in the Capabilities tab (above `Repositories`),
  because it is the only card on that tab that changes what the agent can do rather
  than what it can reach. Eight `Toggle`s in the canonical order, each ON when the
  key is **not** in `agent.disabledTools` (spec §4.7.2: the stored value is the
  denied set).
- Save path: `PATCH /agents/:id` with `disabledTools`, saving on change (no separate
  Save button on this tab — the tab has none today). **The write is serialised and
  the displayed state is optimistic** (review should-fix 3): the eight toggles all
  derive from one polled array, so two clicks inside one poll interval would each
  PATCH the pre-click array and the second would undo the first.
  - Local `denied: Set<ToolKey>` state, seeded from `agent.disabledTools` and
    re-seeded whenever a poll delivers a different array **while no write is in
    flight** (re-seeding mid-flight is what would flicker the toggle back).
  - A `useRef<Promise<unknown>>` chain: each toggle appends its PATCH to the ref's
    promise, so request *n+1* is sent from the state request *n* produced, and
    `reload()` runs once at the end of the chain. `useAction` (`hooks.ts:66-89`)
    gives a pending bit only, so this is eight lines in the card, not a hook change.
  - If that proves fiddly in review, the sanctioned fallback is to disable the whole
    card while `pending` — correct, and visibly worse. Ship the chain; the fallback
    exists so nobody invents a third option under time pressure.
- **Honesty line** (spec §4.7.4, decisions §13). The card names the runner the agent
  resolves to — **`resolveRunner(view.runnerPreference, view.model)`** from WI-12,
  never `runnerForModel(model) ?? runnerPreference` as revision 0 had it. That
  expression yields `INHERIT` or `AUTO` for an uncatalogued model (the `Custom…`
  escape hatch), and `ENFORCED_BY` has no such key — so the honesty tags were
  wrong or unrenderable on exactly the path where the user is most likely to be
  surprised (review must-fix 7). `resolveRunner` always returns a concrete kind and
  reproduces `workflow.ts:22-30`, so the card names the runner that will actually
  run, including when the heuristic's answer is the wrong one. When the runner comes
  from the heuristic rather than from a concrete preference, the line says so:
  `resolves to codex (from the model name)`.
  It then tags every toggle
  that runner does not enforce with `not enforced on <runner>`. On CODEX, one line
  above the toggles: `codex has no per-tool switch — these toggles are not enforced
  for this agent`, with the toggles still editable and still stored, so moving the
  agent to a CLAUDE model later makes them bind (spec §4.7 scenario B, §6.14).
  On PI, `GLOB`, `GREP`, `WEB_FETCH` and `WEB_SEARCH` carry the tag (C8), and the
  `GREP`/`GLOB` tooltip cites `pi-help.stdout:177-178` — they are off by default
  there already.
- **All eight off is allowed**, and the card says plainly that the agent will have
  no tools (spec §6.13).
- If WI-11's capture failed, every toggle on every runner carries the tag and the
  card claims storage only (spec §4.7.5 fallback b).

**The 3.00 px drift — one line, in this file, in this WI** (see §19 for the
derivation). `apps/web/src/pages/Agents.tsx:238`'s `BindingToggle` returns a bare
`<div>`; the `Toggle` inside it is `inline-flex`, so it is baseline-aligned in a
line box, and its baseline now comes from the thumb — which sits 3px above the
root's bottom edge because of `border-[3px] border-transparent`
(`components/ui.tsx:280`). At the screenshot baseline the thumb was `display:none`
(`[&>span]:hidden`, `82b1de5:components/ui.tsx:125`), so the switch had no in-flow
child and its baseline was its bottom margin edge.

Fix: make the wrapper a flex container — `<div className={ROW}>` — which blockifies
the switch and removes the baseline offset. Every other `Toggle` call site
(`Agents.tsx:88, 460`, `new-task-panel.tsx:115`, `TaskDetail.tsx:281`) already sits
directly in a flex row, which is why the drift appears only here. **Do not change
`border-[3px]`** — it is the correct reproduction of `.toggle::after { top: 3px }`
(`git show 3ed8436^:apps/web/src/styles.css:218-221`).

**Verification** — new `apps/web/src/tests/agent-tools.test.tsx`, spec §7.17:

1. Eight toggles render, in canonical order, all ON for `disabledTools: []`.
2. `disabledTools: ["BASH"]` renders Bash OFF and the rest ON.
3. On a CODEX-resolved agent the wide notice renders and all eight carry the tag.
4. On a PI-resolved agent exactly `GLOB, GREP, WEB_FETCH, WEB_SEARCH` carry the tag.
5. On a CLAUDE-resolved agent no toggle carries the tag (or all do, if WI-11 took a
   fallback — the test asserts whichever branch the capture produced, and its
   comment names the capture file).
6. `ENFORCED_BY` (web) matches the two maps in `adapters.ts` — a hand-copied literal
   in the test, with a comment in both files pointing at the other.
7. The `BindingToggle` wrapper renders with the flex class (a cheap structural
   assertion that keeps the fix from being undone).
8. **The `Custom…` escape hatch resolves** (must-fix 7), three agents, all with an
   uncatalogued model: `{ model: "my-model", runnerPreference: "PI" }` tags as PI;
   `{ model: "some-codex-build", runnerPreference: "INHERIT" }` tags as CODEX;
   `{ model: "my-model", runnerPreference: "AUTO" }` tags as CLAUDE. None renders
   `INHERIT`, `AUTO`, `undefined` or an empty tag — the revision-0 expression
   produced the first two.
9. **Rapid toggles keep both changes** (should-fix 3): with a fetch stub that
   resolves on command, click Bash off and then Web Search off before the first
   PATCH resolves; assert two PATCHes were sent, the second body is
   `["BASH","WEB_SEARCH"]` (canonical order), and both toggles read OFF throughout.
   A poll delivering the stale `[]` mid-flight must not flip either back.

**Manual** (spec §8.11): turn Bash off on a CLAUDE agent, dispatch a task that needs
a shell command, read the session events — the call is refused by the CLI. Re-shoot
`agents-toggle-{light,dark}` with `docs/plans/baseline-screenshots/harness/` and
confirm the 3px displacement is gone (procedure in §19).

**Rollback:** revert restores the Capabilities tab. `disabledTools` rows survive in
the database, unread — see §16.

---

## WI-17 — Agents: Foundation block becomes genuinely read-only

**Depends on:** WI-7, WI-15 (both edit the same `save` payload).

**Files** — `apps/web/src/pages/Agents.tsx` **and `packages/api/src/app.ts`**
(revision 1 — the create path can only lose the field if the server supplies it;
review must-fix 6, errata E8).

- `:473-478` — the `Textarea` in edit mode goes. The foundation renders as the
  existing `CODE_BLOCK` in both view and edit mode (spec §4.8.2, §4.8.4 — no
  collapsing is introduced).
- `:473` — the card's `extra` gains two `Pill`s: a revision tag `rev 3f9a2c1` and
  `Read-only`, replacing the `prepended` pill. The revision is the first 7 hex
  characters of a hash of `agent.foundationalPrompt`. **The web app has no crypto
  helper today**; use a small pure FNV-1a or djb2 in `lib/format.ts` rendered as
  7 hex chars rather than pulling in `crypto.subtle` (which is async and would make
  the render a promise). The tag carries a `title` explaining it is a content
  revision, not a version (spec §4.8.3).
- `:477` — the note becomes `Sits above your instructions`; today's longer sentence
  becomes the card's hint (spec §4.8.1).
- The card names the real edit path: `agents/foundational.md` + `npm run db:seed`.
- `:391-395` — `foundationalPrompt` is removed from the `PATCH /agents/:id` payload
  the web client sends. **The server keeps accepting it** (`agentFields:91`
  unchanged) so the CLI and any script are unaffected (spec §5.2).
- `NewAgent` (`:32-36`, `:98-100`) — the create form's foundation `Textarea` goes,
  **and so does the constant it posts**. Revision 0 kept posting
  `"You are an AgentOS worker. Work only on the assigned task in the provided
  working directory."` (`Agents.tsx:35`) because `agentInput` requires the field.
  The review is right that this is the bug the spec names: that constant is a
  one-sentence web default, **not** the authoritative foundation
  (`agents/foundational.md` → `seed.ts:56-57, 128, 138`), so every UI-created agent
  was born divergent and the new `rev` tag would advertise it. Spec §4.8.2 orders
  the field out of the create form; something had to give, and it is the API's
  requiredness, not the spec.

- **`packages/api/src/app.ts`, two edits** (E8):
  - `:86-95` — `agentFields.foundationalPrompt` stays as it is (so `agentPatch`,
    the CLI and any script keep working, spec §5.2). `agentInput` (`:96-100`) makes
    it **optional**: `foundationalPrompt: agentFields.foundationalPrompt.optional()`.
  - `:780-785` (handler at `:780`, `readJson` at `:782`, the create at `:785`) —
    the handler fills the field when the body omits it:

```ts
const foundationalPrompt = body.foundationalPrompt ?? (await db.agent.findFirst({
  where: { projectId },
  orderBy: { createdAt: "asc" },            // the seeded row, not a UI-created one
  select: { foundationalPrompt: true },
}))?.foundationalPrompt;
if (foundationalPrompt === undefined) {
  return context.json({ error: "This project has no foundation yet. Run npm run db:seed." }, 400);
}
return context.json(await db.agent.create({ data: { ...body, foundationalPrompt, projectId } }), 201);
```

  **Why the project's first agent and not the file.** The API reads no repo file
  today (`grep -rn "readFile" packages/api/src` finds nothing outside tests) and
  `seed.ts:8` resolves `agents/` relative to `packages/db`, so teaching the API to
  read `agents/foundational.md` adds a deployment coupling a containerised API would
  not satisfy. Every agent in the project already holds the seeded text; the
  first-created one is the seeded row by construction. Ordering by `createdAt: "asc"`
  makes the choice deterministic even when rows have diverged. The alternative —
  reading the file — is open question 5, for Leo, not for the implementation step.

**Verification** — extend `apps/web/src/tests/agent-tools.test.tsx` or a new file,
plus one API test:

1. Edit mode renders no `<textarea>` for the foundation (assert on the markup).
2. The revision tag is stable for a fixed string and differs for a changed one; it
   is exactly 7 hex characters.
3. The save payload contains `name, title, model, runnerPreference, inboxAccess,
   rolePrompt` and **not** `foundationalPrompt`.
4. **The create request body has no `foundationalPrompt` key at all** — asserted with
   `"foundationalPrompt" in body === false`, not `body.foundationalPrompt === ""`,
   and the create form renders no foundation textarea (must-fix 6).
5. **API dbtest** (`packages/api/src/*.dbtest.ts` harness): `POST
   /projects/:id/agents` **without** the field, in a project whose first agent has a
   known foundation, returns 201 and the created row's `foundationalPrompt` is
   **equal to** that agent's — not the old web constant, not empty.
6. **API dbtest**: the same POST in a project with no agents returns 400 naming
   `npm run db:seed`, and creates nothing.
7. **API dbtest**: `POST` **with** an explicit `foundationalPrompt` still stores it
   verbatim, and `PATCH /agents/:id` with the field still works — the CLI path is
   untouched.

**Manual** (spec §8.12): the Prompt tab shows the revision tag, `Read-only` and
`Sits above your instructions`; the text cannot be edited; the card names
`agents/foundational.md` + `npm run db:seed`. **Then create an agent through the UI
and confirm its `rev` tag equals a seeded sibling's** — the whole point of the
change, and the one thing no unit test proves end to end.

**Rollback:** revert restores the textarea and the `foundationalPrompt` field in the
payload. No data was changed. **Revert the web and API halves together**: a reverted
web client that still posts the constant works against either API, but a reverted API
(field required again) with the new web client would 400 every agent creation.

---

## WI-18 — `docs/runbooks/batch-1-rollback.md` and the PR description

**Depends on:** everything. **Blocks:** the PR.

**Files** — `docs/runbooks/batch-1-rollback.md` (new), matching
`docs/runbooks/batch-2.5-rollback.md`'s structure (Deploy order · Rollback ·
Schema rollback · What is lost · Deliberate behaviour changes).

Contents, from spec §9 and §16 below: deploy order; the one additive migration;
"leaving the column is the recommended action"; the capture query before any drop;
the fact that telemetry is in-process and needs no rollback; the fact that older and
newer daemon/API combinations interoperate because the four claim fields are
optional; and **which branch WI-11's enforcement capture took**, because that
decides whether the UI's claim is true.

Three entries added in revision 1, because each one is a thing an operator hits at
2 a.m. and cannot derive from the diff:

- **Agent creation spans both halves** (E8). `POST /projects/:id/agents` now fills
  `foundationalPrompt` server-side; reverting the API alone while the new web client
  is deployed 400s every agent creation. Revert order: web first, then API.
- **A restarted daemon shows up twice for up to 15 minutes** and the sidebar reads
  `1 of 2 runner online` (WI-9). Not a fault; `RUNNER_ID` in the daemon environment
  removes it. Say so before someone debugs a phantom daemon.
- **Whether `cronstrue` shipped `zh_CN`** (WI-4), because it decides whether the
  Chinese UI has one English string in it by design.

**Verification:** a human can follow it on a scratch database (spec §8.15) — build
the scratch database **from migrations with fixture rows**, never from a dump of
the live one, and never start a second control plane against the live database or a
copy of it.

---

## 14. Requirement → work-item traceability

| Spec § | Requirement | Work item(s) |
|---|---|---|
| §4.1.1-2 | 13 components to v4 generation, customisations survive | WI-2 |
| §4.1.3 | Animation decision: none, no `tw-animate-css` | WI-2 |
| §4.1.4-5 | Tokens unchanged; focus rings the only visual change | WI-2 |
| §4.2.1-2 | `/settings` route and page; sidebar link and icon | WI-14 |
| §4.2.3 | Appearance card (language + theme) | WI-14 |
| §4.2.4 | Runner card, per-daemon and per-backend | WI-14 |
| §4.2.5 | Control-plane card, no token | WI-14 |
| §4.2.6-7 | Read-only page; shared 30 s poll | WI-14 (the shared poll is `RunnersProvider`, defined and tested in WI-13) |
| §4.3.1 | `i18n.tsx` module and provider | WI-3 (mount per C10/E5) |
| §4.3.2 | Flat dotted dictionaries | WI-3 |
| §4.3.3 | `en` default, `agentos.locale`, cross-tab, no `navigator.language` | WI-3 |
| §4.3.4-5 | Fallback chain; `{placeholder}` interpolation | WI-3 |
| §4.3.6-7 | What is and is not extracted | WI-5, WI-6, WI-7 |
| §4.3.8 | Locale-aware `format.ts` (and `schedule.ts`: cron prose + future-time fragments) | WI-4 (seam in WI-3) |
| §4.3.9-10 | Size; completeness | WI-5/6/7 + WI-8 |
| §4.4.1-5 | Sidebar runner row; Inbox badge preserved | WI-13 (badge translated in WI-5) |
| §4.5.1-6 | Popover: seven fields, hover+focus, online rule, no fetch on open | WI-13 |
| §4.6.1-4 | Catalog module, effort vocabularies, split/join | WI-12 |
| §4.6.5-9 | Linkage, unsaveable mismatch, `Custom…`, both forms, list column | WI-15 |
| §4.6.10 | Seed-overwrite hint | WI-14 (placed once) |
| §4.7.1-2 | Eight keys; denied set | WI-1, WI-12 |
| §4.7.3 | CLI flag mapping | WI-11 (per C8/C9) |
| §4.7.4 | Per-agent honesty tags | WI-16 |
| §4.7.5 | Enforcement demonstrated before claimed | WI-11 |
| §4.7.6 | Read at claim time | WI-11 (no code — asserted, not built) |
| §4.8.1-4 | Foundation tags, read-only, revision, full text; out of the create form | WI-17 (incl. the API's optional-with-server-fill create path, E8) |
| §5.1 | Schema and migration | WI-1 |
| §5.2 | `GET /runners`, claim/heartbeat fields, `PATCH` field | WI-9, WI-1 (per C3/E1), WI-17 (create-path fill, per E8) |
| §5.3 | Daemon telemetry and tool flags | WI-10, WI-11 |
| §5.4 | In-process registry | WI-9 |
| §5.5 | Frontend module table | WI-2/3/12/13/14 |
| §5.6 | What must not change | asserted in WI-2 (`styles.test.tsx` unmodified), WI-11 (byte-identical argv), WI-5 (badge behaviour) |
| §6.1-§6.18 | Eighteen edge cases | WI-13 (1-6), WI-3 (7, 8, 17), WI-15 (9-12), WI-16 (13-15), WI-1 (16), WI-17 (18) |
| §7.1-§7.20 | Twenty test expectations | WI-3 (1-5), WI-8 (6), WI-12 (7-9), WI-15 (10), WI-9 (11-12), WI-13 (13), WI-11 (14-15), WI-1 (16), WI-16 (17), WI-2 (18-19), WI-5/6/7 (20) |
| §9 | Rollback notes | WI-18, §16 |

Every numbered spec requirement appears exactly once above. Nothing in §3.2's
non-goal list has a work item.

---

## 15. Sequencing, migration and restart steps, PR mechanics

**Branch:** one feature branch off `master`, eighteen commits, one PR.

**Order is a dependency order, not a preference:**

```
WI-1  schema ────────────┬──────────────┬────────────────┐
WI-2  components v4 ─────┼── WI-13 ◄────┤                │
WI-3  i18n runtime ──────┤              │                │
WI-4  format.ts ─────────┤              │                │
WI-5/6/7 sweep A/B/C ────┤              │                │
WI-8  sweep guard ───────┘              │                │
WI-9  API /runners ──────► WI-13 ──► WI-14                │
WI-10 daemon telemetry ──┘                                │
WI-11 runner tool flags + capture ───────────► WI-16      │
WI-12 models.ts + tools.ts ──► WI-15 ──► WI-16 ──► WI-17 ─┘
WI-18 runbook
```

**Acceptance command order — this order, every time** (spec §7; `styles.test.tsx`
reads `apps/web/dist/assets/*.css` and throws if the app was not built,
`styles.test.tsx:11-14`):

```
npm run build          # all six workspaces, including @agentos/web
npm test               # all workspaces
npm run typecheck
npm run db:migrate     # the one additive migration
```

`npm run db:generate` must run **before** the first `npm run build` after WI-1, or
the API and daemon will not typecheck against the new column. `postinstall` already
does it on a fresh install; on an existing tree it is explicit.

**Two commits carry an extra gate, both from the review** (§0.4):

- **WI-3** must pass `npm run build && npm test && npm run typecheck` *on its own
  commit*, before WI-4 exists. Revision 0's WI-3 called an export WI-4 had not
  created yet; the gate is what makes that class of error impossible rather than
  merely unlikely.
- **WI-4** must run the `cronstrue` locale check (the one-line `node -e` in WI-4)
  **before** the `locale` argument is written, and record the answer in the commit
  message.

Two commits also now span workspaces, so neither can be reviewed as web-only:
**WI-17** touches `packages/api/src/app.ts` as well as `apps/web` (E8), and
**WI-13** touches `apps/web/src/lib/hooks.ts`, which every page imports.

**Migration and restart steps (WI-1 only):**

1. `npm run db:generate`
2. `npm run db:migrate` — `prisma migrate dev`, against the live dev database.
   Never `--force-reset`. Never against a copy of the live database that a second
   API could then reconcile.
3. Restart the API and the daemon (both hold a stale Prisma client). **The agent
   steps of this chain do not touch launchd and do not restart the runner** — if the
   services are launchd-managed, the implementation step stops here and says so in
   its activity log.
4. `npm run db:drift-check`

**PR mechanics:** one PR, title naming the batch, body carrying (a) the enforcement
capture's outcome from WI-11, (b) the §19 finding, (c) the open questions from
§18 restated as review prompts, (d) the acceptance command output, (e) **the two
revision-1 answers that only the implementation can supply**: whether `cronstrue`
ships `zh_CN` (WI-4) and what the daemon-restart window actually looks like in the
sidebar (WI-9/WI-13). Do not merge — chain step ⑨ is Leo's review.

---

## 16. Rollback, per section

**Schema.** One additive column, `Agent.disabledTools TEXT[] NOT NULL DEFAULT '{}'`.
No table dropped, no column removed, no data rewritten — therefore no precheck
script and no row-count guard.

1. Revert the merge commit. The web app returns to its previous behaviour
   immediately; nothing in the reverted code reads `disabledTools`.
2. **Leaving the column in place is the recommended action.** The reverted code
   never selects it, and `seed.ts` never writes it, so it costs one empty array per
   agent row.
3. If it must go, capture first:
   `SELECT name, "disabledTools" FROM "Agent" WHERE array_length("disabledTools", 1) > 0;`
   then `ALTER TABLE "Agent" DROP COLUMN "disabledTools";`. This permanently
   discards every per-agent tool restriction.

**Telemetry (WI-9, WI-10).** In-process; it disappears with the API process. The
four claim/heartbeat fields are optional in both directions, so a reverted API
ignores a newer daemon's telemetry and a reverted daemon simply sends none. Nothing
to roll back.

**Runner tool flags (WI-11).** Disappear with the reverted `adapters.ts`. An
in-flight run is unaffected: argv is fixed at spawn (`adapters.ts:375`).

**i18n (WI-3 … WI-8).** Reverting restores the literals. **Revert WI-5/6/7 and WI-8
together** — the guard test fails against a partially reverted sweep. `agentos.locale`
may be left in `localStorage`; nothing reads it after the revert. WI-4 also reverts
`schedule.ts` to cronstrue's default locale, which is what it renders today.

**Agent creation (WI-17).** The only place in this batch where a partial revert is
worse than no revert: the API's `agentInput.foundationalPrompt` optionality and the
web client's omission of the field must revert **together**. Reverted API + new web
client 400s every agent creation. Reverted web client + new API is harmless (an
explicitly supplied foundation is still stored verbatim), so if only one half can
move, move the web half first.

**Components (WI-2).** Self-contained per file. `styles.test.tsx` is the canary: if
it goes red after a partial revert, the revert was partial in the wrong place.

**Settings, runner row, Agents controls (WI-13 … WI-17).** UI only. Reverting
restores the `/secrets` link, the `Control plane` row, the two text inputs and the
foundation textarea. No data written by these WIs except `disabledTools` and the
`model`/`runnerPreference` values Leo chooses — and those are ordinary column values
the old UI displays fine.

**Blast radius if the batch is bad but not reverted** (spec §9): (a) a wrong tool-flag
mapping making agents unable to work — mitigated by the empty default and the
byte-identical no-op assertion (WI-11 verification 1); (b) a bad effort value
reaching a CLI — mitigated by CLI-derived vocabularies and the deliberately narrow
CODEX list; (c) an i18n key mistake showing a raw key — cosmetic, caught by WI-8.

---

## 17. Where this plan is guessing, and known gaps it does not close

1. **`--disallowedTools` binding under `--dangerously-skip-permissions` is still
   unverified.** This is the spec's own highest-risk assumption (§10.11) and this
   plan does not resolve it — WI-11 mandates the capture and names the fallback
   order. Everything in WI-16's UI copy depends on which branch that capture takes.
2. ~~`claimInput` rejects an out-of-range telemetry value with a 400 on the whole
   claim.~~ **Withdrawn in revision 1** (review must-fix 4). The review's objection
   was right — `readJson` parses before the handler, so a bad observational field
   would have idled the daemon. Zod 4's `.catch()` per field gives partial
   acceptance inside the existing parse; WI-9 now does that and tests both the
   no-work and the claimed-work path. This entry is left in place, struck through,
   so a reader of the review can see where its finding landed.
3. **CODEX's `model_reasoning_effort` vocabulary is unknown.** WI-12 ships
   `high, xhigh, max` (production use only) and requires the implementation step to
   check the installed CLI and capture the result. If the CLI accepts more, widening
   the table is a one-line change; if it silently accepts anything, the narrow list
   is still the right default.
4. **`cronstrue`'s `zh_CN` locale is assumed to exist, and the assumption is
   checked by command, not by reading.** Revision 0 deferred cron prose to a
   follow-up; the review was right that it is live UI output the spec's §4.3 already
   covers (must-fix 3), so WI-4 translates it. What remains a guess is whether
   `cronstrue ^3.24.0` ships `zh_CN` under `cronstrue/i18n`. WI-4 names the one
   command that settles it and the fallback if it does not (English prose, one
   allowlist entry, a follow-up). A wrong locale id makes `cronstrue` throw and every
   schedule cell silently falls back to the raw expression — which is why this is
   verified before the code is written, not after.
5. **The API's create-path foundation comes from a sibling row, not from
   `agents/foundational.md`.** WI-17 fills an omitted `foundationalPrompt` from the
   project's first-created agent (must-fix 6, E8). That is right whenever the project
   was seeded — which is every project that exists today — and wrong in the corner
   where someone has edited a seeded row's foundation in the database by hand. The
   honest alternative is for the API to read the file; open question 5 puts that to
   Leo rather than deciding it in implementation.
6. **The sweep guard's category 4 is a heuristic.** Categories 1-3, 5 and 6 are
   structural (AST node kinds and a named attribute list) and are exact; category 4 —
   copy returned from a helper — keys on the function's name (`/Label$|^render|Text$/`)
   and will miss a helper named otherwise, and will occasionally flag a technical
   string. The allowlist is bounded at 25 entries rather than pretending the scan is
   complete. If the real count exceeds 25, that is a signal the rules need tightening,
   not that the cap should rise.
7. **The exact string count is unknown and is not an acceptance criterion.** The
   spec's 600–800 estimate is a planning figure. WI-8's guard is the criterion.
8. ~~`useRunners` as a context is a design call, not a verified need.~~ **Settled in
   revision 1** (review must-fix 8): `RunnersProvider` is defined in WI-13, mounted
   once in `App.tsx`, owns both the `/runners` and `/health` polls, and has a
   fetch-counting acceptance test. What is still a guess is the *cost* claim — that
   one provider is cheaper than two intervals is obvious; that no third consumer
   appears later and re-forks the poll is not, which is why the test counts requests
   rather than asserting structure.
9. **Two daemons has never been exercised.** Spec §6.4 requires the popover to handle
   it; WI-13's test constructs the payload by hand. Nobody has run two daemons
   against this control plane. Revision 1 adds a second, likelier version of the same
   gap: **the `1 of 2 runner online` window after a daemon restart** (WI-9) is
   reasoned from `config.ts:29`, not observed. Restarting the daemon once during the
   WI-13 manual check settles it in a minute.
10. **§19's mechanism is derived from the source, not from a re-shoot.** It explains
    the exact integer, the exact panel and the exact frame, and it is falsifiable in
    two commands — but the plan has not run them. WI-16 must.

---

## 18. Open questions carried forward (recorded, never blocking)

No step of this chain calls `inbox_ask`. These are for Leo at ⑨.

1. **Should the foundation get a real semantic version?** (spec §11.1) A `v6` needs a
   `version:` key in `agents/foundational.md` plus a runtime surface. WI-17 ships a
   content revision because that is what the data supports.
2. **Should `npm run db:seed` stop overwriting `model` / `runnerPreference`?**
   (spec §11.2) After this batch Leo picks models in the UI and the next re-seed
   reverts them (`seed.ts:121-144`). Worth deciding **before** the post-merge model
   review, or that review's output does not survive the next seed. Out of scope here;
   WI-14 only documents it.
3. **Should `PATCH /agents/:id` reject a mismatched model/runner pair server-side?**
   (spec §11.3) The UI makes it unreachable; the CLI and the seed path do not.
4. **Is `GREP`/`GLOB` "off by default" on pi still true for the installed version?**
   New, from C8. The captured help says so; the installed CLI may have changed. WI-16's
   tag is correct either way (a denied tool that is already off is still denied), but
   the tooltip's wording depends on it.
5. **Should the API read `agents/foundational.md` instead of copying a sibling
   agent's foundation on create?** New in revision 1, from review must-fix 6. WI-17
   ships the sibling copy because the API reads no repo file today and `seed.ts:8`
   resolves that path relative to `packages/db`. Reading the file would make the
   create path independent of seeding order and of hand-edited rows, at the cost of
   a filesystem dependency (and an `AGENTS_ROOT` env var for a containerised API).
   Worth a decision **before** any project is created without seeding, which is the
   only case where the two differ.
6. **Should `Agent.foundationalPrompt` stop being per-agent altogether?** Also new,
   and the question underneath both §11.1 and question 5: the spec calls per-agent
   divergence a bug, and WI-17's `rev` tag exists to make it visible. A single
   project-level (or global) foundation with agents referencing it would delete the
   whole class of problem — and is a schema change well beyond this batch. Recorded
   here so the `rev` tag is read as a diagnostic, not as a feature to build on.

---

## 19. The `Capabilities` panel's 3.00 CSS px drift — located

The out-of-chain note asked for the specific token or property, found while editing
that panel, with no separate work item. Here it is; the fix is one line inside WI-16.

**It is not a token conversion.** `html { font-size: 13px }` makes Tailwind's spacing
unit 3.25 px, so no `p-*`/`gap-*` value can produce exactly 3.00 px. Every geometric
class in the Capabilities panel is unchanged from the baseline — verified against
`git show 3ed8436^:apps/web/src/styles.css` and `git show 82b1de5:apps/web/src/pages/Agents.tsx`:

| Baseline rule | Today | Same? |
|---|---|---|
| `.card { padding: 18px 20px }` (`:251`) | `px-[20px] py-[18px]` (`ui.tsx:167`) | yes |
| `.cardTitle { margin-bottom: 14px }` (`:252`) | `mb-[14px]` (`ui.tsx:64`) | yes |
| `.stack { gap: 16px }` (`:172`) | `gap-[16px]` (`ui.tsx:33`) | yes |
| `.row { display:flex; align-items:center; gap:10px }` (`:173`) | `flex items-center gap-[10px]` (`ui.tsx:34`) | yes |
| `row … py-2.5` on the binding rows | identical class, `Agents.tsx:318, 335, 352` | yes — **it was already `py-2.5` at `82b1de5:315`** |

**The mechanism.** At the baseline, `Toggle` was already a Radix `Switch`, but with
its thumb hidden:

```tsx
// git show 82b1de5:apps/web/src/components/ui.tsx:122-128
<Switch className={`${on ? "toggle on" : "toggle"} [&>span]:hidden`} … />
```

and the legacy rule `.toggle { … border: 0; … }` with the knob drawn by
`.toggle::after { top: 3px; left: 3px; width: 15px; height: 15px }`
(`3ed8436^:styles.css:214-221`).

Today the thumb is a real element (`ui.tsx:282`, `[&>span]:size-[15px] …`) inside a
root carrying `border-[3px] border-transparent` (`ui.tsx:280`) — the class that
reproduces that 3px inset, exactly as its comment says (`ui.tsx:259-269`).

The Radix Switch root is `inline-flex` (`ui/switch.tsx:14`). The baseline of an
`inline-flex` box is the baseline of its **first in-flow flex item**; with the thumb
`display:none` there was none, so the browser synthesised the baseline from the
root's bottom margin edge. Now the thumb *is* the first in-flow item; it is a block
with no text, so its baseline is its own bottom margin edge — which sits **3.00 px
above the root's bottom border edge, because of the 3px bottom border**. Baseline
alignment therefore pushes the whole switch down by exactly 3.00 px.

**Why only the Capabilities panel.** Baseline alignment only happens in a line box.
Of the five `Toggle` call sites, exactly one puts the switch in a non-flex block
container:

```tsx
// apps/web/src/pages/Agents.tsx:238 — BindingToggle
return <div>{error === null ? null : <ErrorNotice … />}<Toggle … /></div>;
```

The other four (`Agents.tsx:88`, `Agents.tsx:460`, `new-task-panel.tsx:115`,
`TaskDetail.tsx:281`) put the `Toggle` directly inside a `ROW` flex container, where
it is blockified and the baseline never applies. `BindingToggle` is used by the
Skills card, the MCP Connections card (both in Capabilities) and the Collaborators
tab — and the only screenshot frame that covers any of them is
`agents-toggle-{light,dark}`.

**Why the whole-page frames measured 0.** The binding row's height is set by the
two-line text block on its left, not by the 21px switch, so a 3px shift of the switch
inside the row causes no reflow — which matches the reported "20 帧尺寸全等（无重排）".
And `shoot.mjs:122-133` anchors the close-up crop to the switches' own bounding boxes
(`y = min(top) + scrollY - 26`), so when the switch moves 3px and the rest of the
frame does not, cross-correlation reports a rigid 3px displacement of everything
else. That is precisely the reported signature: knob size, travel and colour
identical (G2 clean), integer displacement, panel-local.

**Is it a regression or a baseline artefact?** A regression, and a real one: the
baseline's rendering was the intended one (`.toggle::after` positioned the knob
absolutely, so the root's own box was flush) and the current rendering moves the
switch off the row's optical centre. But **the 3px token is correct** — it faithfully
reproduces `top: 3px` — so the fix is not to change it.

**Fix (inside WI-16, one line):** give `BindingToggle`'s wrapper the `ROW` class, so
the switch becomes a flex item and is blockified:

```tsx
return <div className={ROW}>{error === null ? null : <ErrorNotice … />}<Toggle … /></div>;
```

This also makes the wrapper consistent with the other four call sites. The
alternative — `align-bottom` on the `Toggle` — fixes the symptom in one place and
leaves the next block-wrapped toggle to re-introduce it.

**Falsification, two commands** (WI-16 must run these, not trust this section):

```sh
node docs/plans/baseline-screenshots/harness/server.mjs &
cd apps/web && VITE_API_URL=http://127.0.0.1:8787 VITE_API_TOKEN=fixture npx vite --port 5199 --strictPort &
node docs/plans/baseline-screenshots/harness/shoot.mjs /tmp/after
# compare /tmp/after/agents-toggle-light.png against docs/plans/baseline-screenshots/agents-toggle-light.png
```

Expected before the fix: best vertical displacement 9 px at 3× on
`agents-toggle-*`. Expected after: 0, with the residual falling to the same order as
the other 18 frames. If it does **not** fall to 0, this section is wrong and WI-16
must say so in the PR rather than force the pixels to match.
