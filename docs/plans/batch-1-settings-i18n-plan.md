# PLAN — Batch 1: Settings, i18n, sidebar globals, agent model & tool controls

Status: **revision 0** · Author: plan agent (chain step ②) · Date: 2026-08-16
Spec: `docs/specs/batch-1-settings-i18n.md` (approved, commit `9c49e60`).
Brief: `docs/briefs/batch-1-settings-i18n.md`. Authority behind the spec:
`docs/BACKLOG-V2.md` 批次 1 · `docs/reference/danny-agentos-video/detail-gaps.md` §1/§11 ·
`decisions.md` §2/§3/§11/§12/§13.

Plan verified against the working tree at commit `9c49e60` (spec commit; code state
`f5c77ae`). **Every file, line anchor, class string, CLI flag and constant quoted
below was read in the source while writing this plan** — not carried over from the
spec. §0.2 lists the eleven places where the code contradicts or under-specifies
the spec (C1–C11); §0.3 is the binding errata against the approved spec; §17 lists
everything this plan is still guessing about; §19 answers the out-of-chain note
about the `Capabilities` 3.00 px drift.

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
  so they can be reviewed as pure string moves.
- **`format.ts` keeps its function signatures (C2).** Forty-one call sites across
  17 files, two of them in the non-component module `lib/schedule.ts`, make a hook
  refactor a ripple this batch has no reason to pay for. The locale and the
  translator are registered into the module by `LocaleProvider` during render.
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
export const setFormatLocale = (locale: "en" | "zh", translate: (key: string, vars?: Record<string, string|number>) => string): void
```

which `LocaleProvider` calls **in its render body** (an idempotent assignment, not
an effect) so the very paint that switches the language already formats in it —
spec §6.7's requirement. `Intl.DateTimeFormat` instances are memoised per locale in
a `Map`, so the switch does not rebuild them on every render. Default state at
module load is `en` with an identity translator that returns the current English
fragments, so a test importing `format.ts` alone behaves exactly as today.

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
   `data-slot="table-cell"`, and so on.
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
  - Every file exports at least one component whose static markup contains
    `data-slot=` (rendered with `renderToStaticMarkup` where possible; source-scanned
    for the Radix parts that need a portal).
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

## WI-3 — i18n runtime: `lib/i18n.tsx`, `locales/en.ts`, `locales/zh.ts`

**Depends on:** nothing. **Blocks:** WI-4 … WI-8, and every later web WI.

**Files**

- `apps/web/src/lib/i18n.tsx` (new):

```ts
export type Locale = "en" | "zh";
export const LOCALE_KEY = "agentos.locale";
export const LocaleProvider: ({ children, initialLocale }: {...}) => ReactNode
export const useLocale: () => { locale: Locale; setLocale: (next: Locale) => void }
export const useT: () => (key: string, vars?: Record<string, string | number>) => string
export const translate: (locale: Locale, key: string, vars?) => string  // provider-free, for tests and format.ts
```

  - Storage through `lib/storage.ts` (spec §6.17), key `agentos.locale`, values
    `"en" | "zh"`. Anything else, or absent, means `en`.
  - Cross-tab sync copies `theme.tsx:31-36` exactly: one `storage` listener,
    `event.key === LOCALE_KEY`, unrecognised `newValue` → `en`.
  - Fallback chain `zh → en → key` (spec §4.3.4). A miss never throws and never
    renders empty.
  - Interpolation is `{name}` replaced from `vars`; an unmatched placeholder is
    left in place rather than blanked, so a missing var is visible in review.
  - **No provider → `en`** (C7). This is the one intentional divergence from
    `useTheme`'s throwing shape and it carries a comment saying why.
  - Calls `setFormatLocale(locale, translate)` (WI-4) in the provider body.
- `apps/web/src/locales/en.ts`, `apps/web/src/locales/zh.ts` (new): flat
  `Record<string, string>`, dotted keys `<area>.<screen>.<thing>`, sorted by key so
  a diff is readable and a duplicate key is visible. Both files exist from this WI
  with the shell/common keys only; WI-5/6/7 grow them.
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

**Rollback:** self-contained. Reverting this commit and its dependants restores the
literals; nothing outside `apps/web/src` knows the module exists.

---

## WI-4 — `format.ts`: locale-aware dates, dictionary-driven relative time

**Depends on:** WI-3. **Blocks:** WI-5/6/7.

**Files** — `apps/web/src/lib/format.ts` only.

- Replace the two module-level `Intl.DateTimeFormat` constants (`:1-2`) with a
  `Map<Locale, Intl.DateTimeFormat>` per style, built lazily. Locales: `en-US`
  (unchanged from today) and `zh-CN`.
- Add `setFormatLocale(locale, translate)` (C2) and a module-private
  `activeLocale`/`activeTranslate`, defaulting to `en` and a translator that
  returns the current English fragments — so importing `format.ts` in isolation
  behaves exactly as today.
- `timeAgo` (`:10-20`) — the five English fragments become keys:
  `format.justNow` (`just now` / `刚刚`), `format.minutesAgo` (`{n}m ago` / `{n} 分钟前`),
  `format.hoursAgo`, `format.daysAgo`. The `≥30 days → formatDate` branch is unchanged.
- `duration` (`:22-29`) — `{n}s` and `{n}m {n}s` become `format.seconds` and
  `format.minutesSeconds` (two vars, `m` and `s`).
- **Unchanged, explicitly** (spec §4.3.8): the `—` placeholder everywhere, `money`'s
  `$` prefix and `toFixed(2)`, `compactTokens`'s `K`/`M` suffixes and its two
  threshold comments, `sha`, `titleCase`, `firstLine`, `restLines`, `initial`,
  `repoWebUrl`, `compact`.

**Verification** — extend `apps/web/src/tests/i18n.test.tsx` or a new
`format-locale.test.tsx`:

- `formatDate` / `formatDateTime` of a fixed ISO instant differ between `en` and
  `zh`, and the `en` output is **byte-identical to today's** (guard against an
  accidental option change — capture the current strings first and pin them).
- `timeAgo` with a frozen clock returns the `en` fragments today produces, and the
  zh fragments after `setFormatLocale("zh", …)`.
- `duration(null, x) === "—"` in both locales.
- `money`, `compactTokens`, `sha` outputs are locale-invariant.

**Rollback:** one file; reverting restores the pinned `en-US` formatters.

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

**Files** — `apps/web/src/pages/{Tasks,TaskDetail,Automations,Triggers,Archived,Sessions}.tsx`,
plus `apps/web/src/lib/schedule.ts` if it carries user-visible English (it formats
schedule descriptions through `cronstrue`, which has its own locale — see §17.4).

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

**Files**

- `apps/web/src/tests/i18n-sweep.test.tsx` (new).
- `apps/web/src/tests/i18n-allowlist.ts` (new) — an exported array of
  `{ file, text, why }`, asserted to be **at most 25 entries**. A number, so growing
  it is a visible decision.
- `apps/web/src/tests/fixtures/i18n-regression.tsx` (new) — a file containing one
  untranslated literal, used to prove the guard detects, exactly as
  `styles.test.tsx` proves its own layer detection on fixtures.

**How the guard works** (spec §7.6). Source scan over `src/pages/**` and
`src/components/**`, per file:

1. Strip `/* … */` and `// …` comments and all `import` lines.
2. Strip the contents of `t("…")` / `translate("…")` calls and every `className=`
   / `data-slot=` / `key=` attribute value.
3. Flag any JSX text node matching `>([^<>{}]*[A-Za-z]{2,}[^<>{}]*)<` whose trimmed
   text is not in the allowlist.
4. Flag any `(placeholder|title|aria-label|alt)="…"` whose value contains two or
   more consecutive letters and is not in the allowlist.
5. Flag any string literal argument to `window.confirm`.

Known-good exceptions that go in the allowlist with a reason: `AgentOS` (spec
§4.3.7), `·`/`—`/`/` (filtered by the two-letter rule anyway), and any `<code>`
child that is a technical identifier.

**Verification**

- The guard passes on the tree after WI-7.
- The guard **fails** on `fixtures/i18n-regression.tsx` — asserted, so a guard that
  silently stops detecting is itself a failing test.
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
export const createRunnerRegistry = () => ({
  note(runnerId: string, telemetry: Partial<Omit<DaemonTelemetry,"lastSeenAt">>, now: Date): void,
  snapshot(now: Date): Array<{ runnerId: string } & DaemonTelemetry & { online: boolean }>,
});
```

  `note` merges: a field the daemon omits keeps its previous value rather than
  becoming `null`, so an older daemon that never reports disk does not erase a
  newer one's reading for the same `runnerId`. `online` is
  `now - lastSeenAt <= max(3 × (pollIntervalMs ?? 5000), 30_000)` (spec §4.5.5).
  Entries are never evicted — on a single-user localhost the map holds one or two
  keys — but `snapshot` sorts by `runnerId` so the popover order is stable (spec
  §4.5.3).

- `packages/api/src/app.ts`:
  - `:539` — `const runners = createRunnerRegistry();` beside the existing
    per-app closure. **Not a module singleton** — `createApp` is a factory
    (`:537`) and `app.test.ts` builds several.
  - `:252-255` — `claimInput` gains the four optional fields with the spec's
    bounds: `daemonVersion` `z.string().trim().max(40).optional()`,
    `diskFreeBytes` `z.number().int().nonnegative().optional()`,
    `pollIntervalMs` `z.number().int().positive().max(3_600_000).optional()`,
    `workspaceRoot` `z.string().trim().max(500).optional()`.
  - `:256-263` — `heartbeatInput` gains the same four (spec §5.2), so a daemon
    mid-run keeps its last-seen fresh without waiting for a claim.
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
6. Claim with `diskFreeBytes: -1` is rejected **as a 400 on the whole request** —
   note this deviates from spec §7.12's "rejects out-of-range values without
   failing the claim itself": `readJson` validates the body before the handler
   runs (`app.ts:2271`), so partial acceptance would mean hand-rolling a second
   parse. The daemon only sends values it computed itself, so a 400 here is a
   daemon bug that should be loud. **Recorded as a deliberate deviation** (§17.2).
7. A 204 claim (no work) still updates last-seen — assert via a following
   `GET /runners`.

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

- `loadRunnerConfig().daemonVersion` is a non-empty string matching `/^\d+\.\d+\.\d+/`.
  It will be `0.0.0` — assert the shape, never the literal (C4/E6).
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
```

  - `splitModel` **must reproduce `adapters.ts:329-331` exactly**: `lastIndexOf(":")`,
    and a split only when the index is `> 0`. A leading-colon input (`":high"`)
    therefore returns `{ model: ":high", effort: null }` — the same as the runner.
  - Catalog entries (spec §4.6.2), covering the whole roster so no existing agent
    renders as `Custom…`. Roster verified from `agents/roles/*.md`: `claude-opus-5`
    (6 agents), `gpt-5.6-sol` (2), `gpt-5.6-luna` (2), `openai-codex/gpt-5.6-luna` (1).

| id | label | runner | efforts | default |
|---|---|---|---|---|
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
  - `claude-fable-5` is **deliberately absent** (decisions §12 retires Fable in
    favour of `claude-opus-5:xhigh`). A named constant `INTENTIONALLY_ABSENT =
    ["claude-fable-5"]` makes the §7.7 test assert this rather than tolerate it.
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
   in the repo) is either in `MODELS` or in `INTENTIONALLY_ABSENT`.
2. Every entry's `defaultEffort` ∈ its `efforts`; no entry has empty `efforts`;
   ids are unique.
3. `splitModel`/`joinModel` round-trip `claude-opus-5:high`, `gpt-5.6-luna:max`,
   `openai-codex/gpt-5.6-luna:xhigh`, bare `claude-opus-5`, and `":high"` — the
   last one asserting the `> 0` rule against `adapters.ts:330`.
4. `runnerForModel("openai-codex/gpt-5.6-luna") === "PI"` — the case
   `workflow.ts:22-30`'s substring heuristic gets wrong (spec §7.9).
5. `TOOL_KEYS` has exactly eight entries in the canonical order, and `ENFORCED_BY`
   covers all three runners.

**Rollback:** two new files with no importers until WI-15/16.

---

## WI-13 — Web: `components/runner-status.tsx` and the sidebar row

**Depends on:** WI-2 (hover-card), WI-9. **Blocks:** WI-14 (shares the fetch).

**Files**

- `apps/web/src/lib/types.ts` — `RunnersResponse`, `DaemonStatus`, `BackendStatus`
  mirroring WI-9's payload.
- `apps/web/src/components/runner-status.tsx` (new) — exports `RunnerRow` (the
  sidebar row plus popover) and `useRunners()` (one `usePoll<RunnersResponse>("/runners", 30_000)`),
  plus the pure `runnerSummary(payload, now)` that both the row and the Settings
  page use. Making the summary pure is what lets §7.13 be a unit test.
- `apps/web/src/components/Shell.tsx:85-90` — the `Control plane` row is replaced
  by `<RunnerRow />`. The `/health` poll at `:59` stays (spec §10.15) and is passed
  into the popover, which shows a line at the top when it is failing (spec §4.4.3).
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
  - **Control plane** — `/health` status (`ok` / `degraded` / unreachable), the API
    base URL (`apiBase` from `lib/api.ts:15`), and the time of the last successful
    poll. **No token, ever** — `apiBase` is `/api` in the proxied default and the
    operator token lives in the Vite proxy (`vite.config.ts:15, 25`); nothing on
    this page may read or render it.
  - Read-only apart from the two Appearance controls; no destructive action
    (spec §4.2.6).
  - Polling: reuses `useRunners()` at 30 s (spec §4.2.7) — opening Settings must not
    double the request rate. Because `usePoll` keys its interval per hook instance,
    Settings mounted while the sidebar is mounted **does** create a second interval
    on the same path. Accept it (two 30 s polls, not a doubling of a fast poll) and
    say so in a comment, or lift `useRunners` into a small context in this WI. The
    plan's call: **lift it into a context in `runner-status.tsx`**, because the spec
    is explicit ("re-uses the same fetch") and a context around one `usePoll` is
    ten lines.

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
  spec §4.6.8. Props: `{ model: string; runnerPreference: RunnerPreference; onChange(next: { model, runnerPreference }): void }`.
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
    `workflow.ts:22-30` and keeps the librarian on PI.
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
  - Save is disabled while any inline validation error is present (spec §4.6.6).
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
5. Save is blocked while a validation error is present.
6. An agent stored as bare `claude-opus-5` renders effort `high` and, if the form is
   cancelled, the stored value is unchanged.

**Manual** (spec §8.8-§8.10): `senior-dev` shows `GPT-5.6 Luna (codex)` / `xhigh` /
`codex` read-only; switching to `Claude Opus 5` flips the runner in the same
interaction; save, then confirm in the database that `Agent.model =
'claude-opus-5:xhigh'` and `runnerPreference = 'CLAUDE'`; switch it back.
**`librarian` must show `pi`, not `codex`** — the regression item 6 exists for.

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
- Save path: `PATCH /agents/:id` with `disabledTools`. The other Capabilities cards
  use per-binding endpoints and `BindingToggle`; Tools is a single agent field, so
  it uses the same `useAction` + `reload` shape and saves on change (no separate
  Save button on this tab — the tab has none today).
- **Honesty line** (spec §4.7.4, decisions §13). The card names the runner the agent
  resolves to (`runnerForModel(model) ?? runnerPreference`) and tags every toggle
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

**Manual** (spec §8.11): turn Bash off on a CLAUDE agent, dispatch a task that needs
a shell command, read the session events — the call is refused by the CLI. Re-shoot
`agents-toggle-{light,dark}` with `docs/plans/baseline-screenshots/harness/` and
confirm the 3px displacement is gone (procedure in §19).

**Rollback:** revert restores the Capabilities tab. `disabledTools` rows survive in
the database, unread — see §16.

---

## WI-17 — Agents: Foundation block becomes genuinely read-only

**Depends on:** WI-7, WI-15 (both edit the same `save` payload).

**Files** — `apps/web/src/pages/Agents.tsx`.

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
- `NewAgent` (`:35, :98-100`) — the create form's foundation `Textarea` goes too
  (spec §4.8.2 "and from the create form"). But `POST /projects/:id/agents`
  **requires** `foundationalPrompt` (`agentFields:91` is not optional and
  `agentInput` does not default it). The create form therefore keeps sending the
  same constant string it has today (`:35`), now as a non-editable constant with the
  same card copy. **This is the honest reading**: making the field optional
  server-side is a schema/API change the spec does not authorise. Recorded in §17.5.

**Verification** — extend `apps/web/src/tests/agent-tools.test.tsx` or a new file:

1. Edit mode renders no `<textarea>` for the foundation (assert on the markup).
2. The revision tag is stable for a fixed string and differs for a changed one; it
   is exactly 7 hex characters.
3. The save payload contains `name, title, model, runnerPreference, inboxAccess,
   rolePrompt` and **not** `foundationalPrompt`.
4. The create form still posts a non-empty `foundationalPrompt` (the 400 regression
   test).

**Manual** (spec §8.12): the Prompt tab shows the revision tag, `Read-only` and
`Sits above your instructions`; the text cannot be edited; the card names
`agents/foundational.md` + `npm run db:seed`.

**Rollback:** revert restores the textarea and the `foundationalPrompt` field in the
payload. No data was changed.

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
| §4.2.6-7 | Read-only page; shared 30 s poll | WI-14 |
| §4.3.1 | `i18n.tsx` module and provider | WI-3 (mount per C10/E5) |
| §4.3.2 | Flat dotted dictionaries | WI-3 |
| §4.3.3 | `en` default, `agentos.locale`, cross-tab, no `navigator.language` | WI-3 |
| §4.3.4-5 | Fallback chain; `{placeholder}` interpolation | WI-3 |
| §4.3.6-7 | What is and is not extracted | WI-5, WI-6, WI-7 |
| §4.3.8 | Locale-aware `format.ts` | WI-4 |
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
| §4.8.1-4 | Foundation tags, read-only, revision, full text | WI-17 |
| §5.1 | Schema and migration | WI-1 |
| §5.2 | `GET /runners`, claim/heartbeat fields, `PATCH` field | WI-9, WI-1 (per C3/E1) |
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
capture's outcome from WI-11, (b) the §19 finding, (c) the four open questions from
spec §11 restated as review prompts, (d) the acceptance command output. Do not merge
— chain step ⑨ is Leo's review.

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
may be left in `localStorage`; nothing reads it after the revert.

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
2. **`claimInput` rejects an out-of-range telemetry value with a 400 on the whole
   claim**, where spec §7.12 asks for "rejects out-of-range values without failing
   the claim itself". `readJson` parses before the handler body (`app.ts:2271`), so
   partial acceptance needs a second, hand-rolled parse. The plan takes the loud
   option and flags it. If review disagrees, the fix is a `.catch()` per field in
   the zod schema, not a handler change.
3. **CODEX's `model_reasoning_effort` vocabulary is unknown.** WI-12 ships
   `high, xhigh, max` (production use only) and requires the implementation step to
   check the installed CLI and capture the result. If the CLI accepts more, widening
   the table is a one-line change; if it silently accepts anything, the narrow list
   is still the right default.
4. **`cronstrue` has its own locale surface.** `apps/web/src/lib/schedule.ts` uses it
   to render cron descriptions. This plan does not switch `cronstrue` to `zh_CN` —
   it is a library locale, not a dictionary key, and the spec's §4.3 does not mention
   it. WI-6 should check whether the rendered description is user-visible English
   and, if so, record it as a follow-up rather than silently translating it.
5. **`POST /projects/:id/agents` still requires `foundationalPrompt`.** WI-17 removes
   the editor but keeps sending the constant, because making the field optional is an
   API change the spec does not authorise. If review wants the create form to stop
   sending it, that is a one-line zod change plus a default — call it in review, not
   in implementation.
6. **The sweep guard's regex will have false positives.** A JSX text node that is
   really a technical identifier, an `aria-label` built from data — these land in the
   allowlist. The plan bounds the allowlist at 25 entries rather than pretending the
   regex is exact. If the real count exceeds 25, that is a signal the guard's rules
   need tightening, not that the cap should rise.
7. **The exact string count is unknown and is not an acceptance criterion.** The
   spec's 600–800 estimate is a planning figure. WI-8's guard is the criterion.
8. **`useRunners` as a context (WI-14) is a design call, not a verified need.** If
   review prefers two independent 30 s polls, the comment-only option is in the WI.
9. **Two daemons has never been exercised.** Spec §6.4 requires the popover to handle
   it; WI-13's test constructs the payload by hand. Nobody has run two daemons
   against this control plane.
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
