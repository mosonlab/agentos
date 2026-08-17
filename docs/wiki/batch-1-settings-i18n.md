# Batch 1 — settings, i18n, runner status, and agent controls

Status: current.

This page describes the current operator-facing settings and agent-configuration
surface. The main implementation is in [`apps/web/src`](../../apps/web/src),
[`packages/api/src/app.ts`](../../packages/api/src/app.ts),
[`packages/api/src/runners.ts`](../../packages/api/src/runners.ts), and
[`packages/runner/src`](../../packages/runner/src). Deployment and schema
rollback procedures are in [`docs/runbooks/batch-1-rollback.md`](../runbooks/batch-1-rollback.md).

## What the operator can configure and observe

The sidebar Settings link opens `/settings` and uses `IconSettings`; `/secrets`
remains a separate route. The Settings page has three read-mostly cards:

- **Appearance** selects the UI language (`English` / `中文`) and the existing
  theme modes (`System`, `Light`, `Dark`).
- **Runner** lists the daemon incarnations known to the control plane and all
  three CLI backends, including their health, versions, telemetry, preflight and
  circuit state.
- **Control plane** shows `/health`, the API base used by the web client, and
  the last successful health poll.

The sidebar keeps its existing Inbox badge and theme-cycle button. The badge
still polls the global `/inbox/messages` endpoint every five seconds and counts
messages whose status is `OPEN`; Batch 1 only translates its label. The theme
cycle button and the Settings segmented control write the same `agentos.theme`
store.

The Agents page now has a catalog-backed model and effort picker, a runner
linkage control, eight per-agent tool switches, and a read-only Foundation card.
These controls remain project-scoped; no task, scheduler, chain, session, or
delivery semantics are changed by this surface.

## Language, formatting, and UI primitives

### Locale runtime

`LocaleProvider` mounts beside `ThemeProvider` in
[`apps/web/src/main.tsx`](../../apps/web/src/main.tsx), so App-level connection
banners are localized too. The React-free lookup lives in
[`apps/web/src/lib/i18n-core.ts`](../../apps/web/src/lib/i18n-core.ts); React
components use [`apps/web/src/lib/i18n.tsx`](../../apps/web/src/lib/i18n.tsx).
The dictionaries are flat `Record<string, string>` values in
[`apps/web/src/locales/en.ts`](../../apps/web/src/locales/en.ts) and
[`apps/web/src/locales/zh.ts`](../../apps/web/src/locales/zh.ts).

The runtime has these deliberately simple rules:

- English is the default. The selected locale is stored under
  `agentos.locale` and a `storage` listener mirrors changes between tabs.
- Keys are dotted strings and values interpolate `{placeholder}` names. There
  is no plural engine and no browser-language detection.
- Lookup falls back `zh → en → key`; a missing key is visible rather than
  silently becoming an empty string. Components rendered without a provider use
  English, which keeps provider-free SSR/test fixtures valid.
- The provider registers a locale-bound translator with
  [`lib/format.ts`](../../apps/web/src/lib/format.ts) during render. Existing
  formatter call signatures stay unchanged, while dates, relative times,
  durations, and schedule labels use the active locale on the same paint as a
  language switch.
- [`lib/schedule.ts`](../../apps/web/src/lib/schedule.ts) passes `en` or
  `zh_CN` to `cronstrue/i18n`. An expression that the formatter cannot parse is
  rendered verbatim; a quarantined automation also renders its raw expression
  rather than plausible but incorrect prose.

The source sweep in `apps/web/src/tests/i18n-sweep.test.tsx` uses the TypeScript
AST across pages and `src/lib/**` for JSX text, user-copy attributes,
object-property labels, returned/conditional copy, dialogs, and template
literals. Its bounded allowlist is for technical identifiers and proper nouns,
not a replacement for translating ordinary UI copy. Backend/API/Feishu text is
outside this UI locale boundary.

### Component generation and motion contract

The 13 shadcn primitives under
[`apps/web/src/components/ui`](../../apps/web/src/components/ui) use the v4
generation shape: no `forwardRef`, `data-slot` on every exported part,
`outline-hidden` plus the 3px focus-ring idiom, and `aria-invalid` styling on
form controls. The repository's `legacy*` button variants and other local class
contracts remain part of the public component surface. `hover-card.tsx` is the
one additional primitive used by the runner popover.

The app intentionally has no motion contract: `tw-animate-css` is not imported,
and generated `animate-in`/`animate-out` utilities are omitted. Reintroducing
animation requires an explicit visual decision and the corresponding import;
it is not an implicit property of the current shadcn generation.

The 3px switch inset is intentional. `BindingToggle` wraps the Radix switch in
the shared `ROW` flex class so the switch is blockified and does not acquire a
3px inline-flex baseline displacement in a block wrapper. Do not replace the
`border-[3px] border-transparent` inset with a spacing-token change; the inset
reproduces the established knob geometry, and the flex wrapper is the alignment
fix.

## Shared runner and control-plane status

`RunnersProvider` in
[`apps/web/src/components/runner-status.tsx`](../../apps/web/src/components/runner-status.tsx)
is mounted once in `App.tsx` inside `ProjectProvider`, enclosing both the
sidebar and routed Settings page. It owns exactly one `/runners` poll every 30
seconds and one `/health` poll every 10 seconds. `Shell` and `SettingsPage`
read the same context; opening the popover or visiting Settings does not start
another fetch.

`usePoll` skips network loads while `document.hidden` and records
`lastSuccessAt` only on successful responses. A later failure keeps that
timestamp while exposing the error. Runner freshness is separate from network
completion: the provider schedules a local expiry update at 60 seconds and
refreshes it on `visibilitychange`, so a previously green row becomes `Unknown`
even when a hidden tab has suspended polling or a request is unresolved.

### The `/runners` contract

`GET /runners` is an operator-readable endpoint outside the `/runner/` prefix.
It returns `checkedAt`, `online`/`total` counts, daemon rows, and one row for
each of `CLAUDE`, `CODEX`, and `PI`. Each daemon row includes:

- `runnerId`, `online`, `busy`, `activeRuns`, and `lastSeenAt`;
- `daemonVersion`, `diskFreeBytes`, `pollIntervalMs`, and `workspaceRoot`,
  each nullable when that observation was not supplied; and
- backend `cliVersion`, `authMode`, `lastPreflightAt`, `lastPreflightOk`,
  `circuitOpen`, and `circuitReason` for each CLI kind.

The daemon sends the four telemetry fields on both task claim and run
heartbeat. `daemonVersion` comes from `packages/runner/package.json`; disk
space is read with `statfs`. If that read fails, the daemon omits only
`diskFreeBytes` and continues claiming/heartbeating. The API parses telemetry
fields with per-field soft failure: a malformed observational value is logged
and discarded, but it cannot idle the runner. `runnerId` and lease fields remain
operational inputs and fail the request when invalid.

The registry in `packages/api/src/runners.ts` is intentionally in process
memory, not a database table. A claim or heartbeat replaces the entire
observation for that `runnerId`, so a new incarnation cannot inherit old disk,
version, or workspace values. A daemon is online when its last observation is
within `max(3 × pollIntervalMs, 30 seconds)`. Entries unseen for 15 minutes are
forgotten, and the registry is capped at 16 entries. An API restart therefore
temporarily produces `Never seen` until a daemon polls again.

The default daemon identity is `${hostname()}-${pid}`. A daemon restart normally
creates a second registry row; the old row remains bounded for up to 15 minutes
and may make the count read `1 of 2 runner online`. Set `RUNNER_ID` when one
logical daemon should retain one identity across restarts. This is an
incarnation/retirement behavior, not durable runner inventory.

### Rendering states and failure signals

The pure `runnerSummary` function and the Settings card distinguish:

- `Running`: at least one fresh online daemon and no active run;
- `Busy`: at least one fresh online daemon with an active run;
- `Offline`: known daemon rows exist but none is online;
- `Never seen`: the registry has no daemon rows; and
- `Unknown`: the `/runners` request failed or its payload is older than 60
  seconds.

Green/amber/grey dots represent healthy, circuit-degraded, and unavailable
states. `Busy` is a separate badge, not a replacement for online state. Disk
free below 2 GiB uses the destructive tone. Missing values render `—`, never a
fake zero or a blank. The popover opens on hover and keyboard focus, closes with
Escape, shows all daemon/backend details, and does not fetch on open; long
circuit reasons are truncated there while Settings keeps the full reason.

The busy calculation counts only
`CLAIMED`, `PROVISIONING`, `RUNNING`, and `WAITING_INBOX` runs. Queued work is
not evidence that a daemon is busy. Backend circuit state comes from the
durable `RunnerBackendState` rows populated by runner preflight; daemon
identity and liveness remain in the in-process registry.

## Agent model, effort, and runner selection

`Agent.model` remains one string with the shape `<model>[:<effort>]`. Both the
web picker and runner adapter split on the **last** colon, then rejoin the two
parts when saving. The catalog in
[`apps/web/src/lib/models.ts`](../../apps/web/src/lib/models.ts) contains every
roster model, including `openai-codex/gpt-5.6-luna` linked to PI rather than
selected by a substring heuristic.

Catalog entries provide a label, concrete runner, supported efforts, and a
default effort. The current effort sets are:

- Claude: `low`, `medium`, `high`, `xhigh`, `max`;
- Pi: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; and
- Codex: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, as
  verified against the installed CLI and captured under
  [`spikes/cli-capabilities/samples`](../../spikes/cli-capabilities/samples).

Choosing a catalog model writes its concrete runner preference and disables the
runner selector. `Custom…` keeps free model text and permits all five
preferences (`INHERIT`, `AUTO`, or a concrete runner), with a warning. The pure
`resolveRunner` function mirrors the runtime heuristic in
[`packages/db/src/workflow.ts`](../../packages/db/src/workflow.ts): explicit
runner preferences win; otherwise `codex` maps to CODEX, `deepseek` or a `pi`
token maps to PI, and the fallback is CLAUDE. The Tools card uses this concrete
resolution so its enforcement labels describe what will actually spawn,
including for Custom models.

`validateModelPair` is shared by the picker and both Create and Save buttons.
It blocks an empty model and a catalog model paired with a different concrete
runner. The API still accepts mismatched pairs from direct clients, CLI paths,
and seed data; the current server contract intentionally relies on the web
validation boundary.

## Per-agent denied tools

The only schema addition is `Agent.disabledTools String[] @default([])` in
[`packages/db/prisma/schema.prisma`](../../packages/db/prisma/schema.prisma),
applied by the additive
[`20260816190000_agent_disabled_tools`](../../packages/db/prisma/migrations/20260816190000_agent_disabled_tools/migration.sql)
migration. It stores the **denied** set, not the allowed set. An empty array is
the old behavior, so existing agents need no backfill and reverting the code
does not discard data. The API validates the eight canonical keys and the
claim response carries the agent row's denied set to the runner.

At process spawn, [`packages/runner/src/adapters.ts`](../../packages/runner/src/adapters.ts)
maps the denied set to native CLI arguments:

| Runner | Enforcement | Native mapping |
| --- | --- | --- |
| CLAUDE | all eight keys | `--disallowedTools` followed by one comma-joined tool value |
| PI | `BASH`, `READ`, `WRITE`, `EDIT` | `--exclude-tools` with Pi's lowercase names |
| CODEX | none | Codex exposes sandbox modes, not per-tool deny flags |

The prompt remains the final positional argument after the Claude/Pi deny flags;
the comma-joined form is required because the Claude option is variadic and a
space-separated list would consume the prompt. Pi's `GLOB` and `GREP` are not
mapped because the captured Pi help describes them as off by default; the UI
marks these and all Codex toggles as not enforced. The real Claude capture under
`--dangerously-skip-permissions` shows Bash absent from the initial tool set and
unavailable through ToolSearch; its evidence is listed in the rollback runbook.

The Tools card keeps a local optimistic denied set but serializes PATCHes. Each
request starts from the last confirmed server set, queued intents replay after
the preceding request, and a rejected request removes its intent and restores
the confirmed state while later queued changes still converge. The UI reports
which runner enforces each toggle and never labels Codex restrictions as active.
The restriction is fixed in the argv of a newly spawned run; changing the
agent later does not mutate an already-running CLI process.

## Foundation behavior

The web Foundation card is read-only and displays the full prompt with a stable
seven-hex content revision from
[`apps/web/src/lib/format.ts`](../../apps/web/src/lib/format.ts). The revision is
a content fingerprint, not a semantic version. The web create and save payloads
omit `foundationalPrompt`; the API still accepts explicit Foundation values for
direct clients and patches, and on create fills an omitted value from the
project's first-created agent. If the project has no agent yet, creation returns
a 400 instructing the operator to run `npm run db:seed`.

This keeps the web form from inventing a divergent one-line prompt, but the
source of truth is still per-agent in the current schema. `npm run db:seed`
continues to rewrite model, runner preference, and Foundation fields from
`agents/roles/*.md`; Settings exposes that warning rather than changing seed
behavior.

## Deliberate boundaries and deferred decisions

The following are current decisions, not accidental omissions:

- daemon observations are in process memory; only backend preflight state is
  persisted;
- effort remains a suffix of `Agent.model`, avoiding a second source of truth;
- tool settings are native CLI hints/enforcement, not an application-level
  permission or filesystem sandbox layer;
- Codex tool toggles remain visible for cross-runner consistency but are
  explicitly marked not enforced;
- no motion dependency or animation utilities are introduced; and
- the Foundation revision is content-based because the repository has no
  semantic Foundation version field.

The next maintainer should not silently decide these open questions while
changing this surface:

1. whether Foundation needs a real semantic version;
2. whether seeding should stop overwriting model and runner choices;
3. whether the API should reject mismatched catalog model/runner pairs;
4. whether Pi's current `GLOB`/`GREP` default-off behavior still holds after a
   CLI upgrade;
5. whether API creation should read `agents/foundational.md` instead of copying
   the first sibling agent; and
6. whether `foundationalPrompt` should become project-level rather than
   per-agent.

The rollback order, compatibility of old/new API and daemon telemetry, and the
warning about never starting a second control plane against a live database
copy are maintained in [`docs/runbooks/batch-1-rollback.md`](../runbooks/batch-1-rollback.md),
not duplicated here.

## Verification and where to start

The web sweep, runner state, Settings, model picker, tool serialization, API
runner registry, Foundation create path, and CLI argument mapping each have
focused tests under `apps/web/src/tests`, `packages/api/src`, and
`packages/runner/src`. Build before the full test suite because the existing
style test reads emitted web CSS:

```sh
npm run build
npm test
npm run typecheck
npm run db:migrate
```

For a UI change, start with `main.tsx`, `lib/i18n-core.ts`,
`lib/i18n.tsx`, `components/runner-status.tsx`, and `pages/Settings.tsx`. For
an agent execution change, read `lib/models.ts`, `lib/tools.ts`,
`pages/Agents.tsx`, `packages/api/src/app.ts`, and
`packages/runner/src/adapters.ts` together. Keep the duplicated tool-key maps
in API, web, and runner synchronized; they intentionally cannot import across
workspace boundaries.
