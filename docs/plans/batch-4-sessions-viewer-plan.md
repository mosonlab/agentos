# PLAN — Batch 4: the sessions viewer

Status: **revision 1** · Author: plan agent (chain step ④) · Date: 2026-08-16
Spec: `docs/specs/batch-4-sessions-viewer.md` (commit `e22c655`, approved).
Review answered: `docs/reviews/2026-08-16-batch-4-sessions-viewer-plan-review.md`
(verdict FAIL — 11 must-fix, 3 should-fix). **All 14 findings are accepted and
applied; none is rejected.** §0.3 is the disposition table: finding → what
changed → where.
Authority behind it: `docs/BACKLOG-V2.md` 批次 4, `docs/reference/danny-agentos-video/decisions.md` §10/§13.
Plan verified against the working tree at commit `e22c655` (post
frontend-convergence merge); every anchor cited by the review was re-read in the
source before its fix was applied.

Planning only. Eight work items in dependency order, one commit each, all on one
feature branch so the batch lands as one PR with one migration. Every spec
requirement maps to a numbered work item in §9. §0.2 lists the places where the
code contradicts or under-specifies the spec — each one is corrected here rather
than silently re-specified. §0.3 records the review disposition. §11 lists
everything this plan is still guessing about.

---

## 0. Approach summary

- **Migration first (WI-1).** Four nullable `Int` columns on `Session` plus two
  supporting indexes. Everything downstream needs the regenerated Prisma client
  to compile, so this is the only thing that can go first. Additive only — no
  drop, no NOT NULL — so BACKLOG-V2's destructive-migration precheck does not
  apply (spec §4.6.2, §10.4).
- **Usage extraction as one shared pure module (WI-2), placed in
  `packages/db/src/` rather than `packages/api/src/`.** The spec puts it at
  `packages/api/src/usage.ts` (§5.2) *and* asks the backfill script under
  `packages/db/prisma/` to call the same function (§4.6.3). Those two cannot both
  be true: `@agentos/api` depends on `@agentos/db`, never the reverse. See
  §0.2-C1 for the resolution and the precedent (`packages/db/src/workflow.ts`).
- **API next (WI-3):** two additive routes plus the one breaking shape change on
  `GET /runs/:runId/events`. Landing it before any web work means the new client
  is developed against the real envelope.
- **Web pure leaves before web pages (WI-4, WI-5, WI-6):** `format.ts` helpers +
  `Markdown`, then the stream normalizer, then the polling hook. Each is
  independently testable with no network and no DOM, which is what makes the
  page work in WI-7 mechanical.
- **`TaskDetail.tsx` last (WI-8).** It deletes `RunEvents`, the only in-repo
  consumer of the old bare-array event shape, and links to `/sessions/:id`. Both
  targets must already exist.
- **Evidence, not inference, wherever the repo has it.** `spikes/cli-capabilities/samples/`
  contains real captured stdout for all three runners. §0.1 records what it
  proves; four of the spec's inferred shapes are now verified facts and three are
  now known-wrong. The implementer should treat those samples as the fixture
  source for WI-2 and WI-5 rather than hand-writing payloads.

Verification commands used throughout: `npm run build` (root), `npm test` (root,
runs every workspace's `test` script), `npm run typecheck`, `npm run db:validate`,
`npm run db:drift-check`, and per-workspace `npm test -w @agentos/api` /
`-w @agentos/web`. **`npm run build` must precede `npm test`** — `apps/web/src/tests/styles.test.tsx:11-14`
reads `apps/web/dist/assets/*.css` and throws if the build is missing.

---

## 0.1 Evidence base — what the captured CLI samples prove

`spikes/cli-capabilities/samples/*.stdout` are real runs of the three CLIs,
captured 2026-08-15. They are the single best fixture source for this batch.
Findings, all read directly from the files:

**CLAUDE** — `claude-tool-event.stdout` (a complete Bash tool round trip):

| spec claim | verdict |
|---|---|
| `assistant` event → `message.content[]` with `{type:"text",text}` | ✅ verified |
| tool call → `message.content[]` with `{type:"tool_use", id, name, input}` | ✅ verified (`input:{command,description}` for Bash) |
| `user` event → `{tool_use_id, type:"tool_result", content, is_error}` | ✅ verified; `content` is a plain string here |
| `result` → `total_cost_usd` + `usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` | ✅ verified (`total_cost_usd: 0.049117`) |
| a tool-only assistant message yields no `text` | ✅ verified — the first `assistant` event has only a `tool_use` part, so §4.3's "empty text produces no item" is load-bearing, not defensive |

**CODEX** — `codex-tool-event.stdout`, `codex-resume.stdout`:

| spec claim | verdict |
|---|---|
| `item.completed` → `item:{id,type:"agent_message",text}` | ✅ verified |
| `turn.completed` → `usage.{input_tokens,cached_input_tokens,output_tokens}` | ✅ verified; the real payload also carries `cache_write_input_tokens` and `reasoning_output_tokens` |
| CODEX reports no cost | ✅ verified — no cost field anywhere in `turn.completed` |
| `command_execution` item shape | ❌ **not captured** — the sample's shell call died in the sandbox before producing one. Still inferred (§11-G1) |
| `file_change` item shape | ❌ **not captured**. Still inferred (§11-G1) |
| `item.started` fires for `agent_message` | not observed in either sample — only `item.completed`. Duplication risk is theoretical for this CLI version but the adapter code allows it (§0.2-C3) |

**PI** — `pi-tool-event.stdout`, `pi-resume.stdout`:

| spec claim | verdict |
|---|---|
| `tool_execution_start` payload carries `args` | ✅ verified: `{type, toolCallId, toolName, args:{command}}` |
| `tool_execution_end` signals errors via an `error` field (§4.3.1) | ❌ **wrong** — the real field is `isError: boolean`, and the return is under `result.content[]` (§0.2-C4) |
| `turn_end` → `message.content[].text` for `role:"assistant"` | ✅ verified |
| PI's `FINAL_OUTPUT` (`agent_settled`) may carry usage | ❌ **settled** — `agent_settled` is literally `{"type":"agent_settled"}`, an empty event. No usage, no cost, **no text**, in all five samples that contain it |
| PI emits one `MODEL_COMPLETED` per assistant message | ❌ **wrong** — `pi-tool-event.stdout` has 2 assistant `message_end` **and** 2 `turn_end` for 2 assistant messages, and the adapter maps both to `MODEL_COMPLETED` (`adapters.ts:287-297`). Every PI message is double-emitted (§0.2-C5) |

One further PI finding the spec does not mention: PI *does* report usage and cost,
on `message_end`/`turn_end` as `message.usage.{input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost:{total}}`
— a different shape on a different event, per-message rather than cumulative. It
is **not** harvested this batch; see §0.2-C6 for why and what gets written down
instead.

---

## 0.2 Corrections — where the code contradicts or under-specifies the spec

These are stated, not silently applied. Each names the file that proves it.

**C1 — the shared usage module cannot live in `packages/api/src/`.**
Spec §5.2 puts `extractUsage`/`applyUsage` in `packages/api/src/usage.ts`; spec
§4.6.3 puts the backfill script at `packages/db/prisma/backfill-session-usage.ts`
and requires "one implementation, two callers". `packages/db` has no dependency
on `packages/api` and must not gain one. **Resolution:** the module goes to
`packages/db/src/usage.ts` and is re-exported from `packages/db/src/index.ts`,
exactly as `packages/db/src/workflow.ts` already hosts `applyInboxDecision` /
`deriveRunConfig` / `activateChainSuccessor` for `app.ts` to import
(`packages/api/src/app.ts:1-27`). The API imports it from `@agentos/db`; the
backfill script imports it relatively. **The unit test still lives at
`packages/api/src/usage.test.ts` as the spec asks** — `packages/db` has no `test`
script at all (`packages/db/package.json`), so a test placed there would never
run under `npm test`, while `packages/api`'s `pretest` already builds
`@agentos/db` first.
Note on naming: the spec's `applyUsage` no longer exists under that name. C2 (as
revised) replaces it with `recomputeSessionUsage`, which takes a session id
rather than a usage delta. The spec's "one implementation, two callers"
requirement is unchanged and is what forces the placement decided here.

**C2 — accumulation cannot be done by adding to the current column value.**
Two independent reasons, the second found by the review (must-fix 2):

1. Prisma's `increment` is a silent no-op on a NULL column. `data: { inputTokens: { increment: n } }`
   compiles to `SET "inputTokens" = "inputTokens" + n`, and in SQL `NULL + n` is
   `NULL`. Every one of the four columns starts NULL, so the first write — the
   common case — would store nothing.
2. Read-modify-write with `+=` is not idempotent, and the ingest route it hangs
   off *is*: `createMany(..., skipDuplicates: true)` (`app.ts:1770-1783`) is
   deliberately replay-safe, so any usage write that adds a delta drifts every
   time the same `FINAL_OUTPUT` reaches it twice. It also cannot recover from a
   crash between `createMany` and the usage write — the event is stored, the
   tokens are not, and nothing ever revisits it.

**Resolution (replaces the first pass's read-modify-write): recompute absolute
totals from the stored events.** `recomputeSessionUsage(db, sessionId)` folds
`extractUsage` over *all* persisted `FINAL_OUTPUT` rows for the session and
writes absolute values. This is idempotent by construction, accumulates across
resume attempts for free (each attempt's `FINAL_OUTPUT` is its own row at a
higher `seq`), self-heals after a partial write, and never touches a NULL column
arithmetically. `SessionEvent` is the source of truth; the columns are a
derived cache. Full design in WI-2.

*Accuracy note on the review's framing:* the runner has **no** automatic retry of
`appendEvents` (`packages/runner/src/api.ts:74-88, 131-146` — `request` throws and
no caller re-posts the same batch), so routine same-batch replay is not the live
hazard the finding implies. The backfill's repeated-write case and the
crash-between-writes case are unconditional, and `skipDuplicates: true` exists
precisely because the write is *designed* to be replay-safe. The fix is accepted
in full on those grounds.

**C3 — CODEX can emit two `MODEL_DELTA` events for one item.**
`adapters.ts:239-255`: `item.started` for any non-`command_execution` item emits
`MODEL_DELTA(event)`, and `item.completed` for the same item emits another. A
literal reading of spec §4.3 would render one agent message twice. Not observed
in the captures (§0.1) but structurally possible. **Resolution:** in
`session-stream.ts`, CODEX text items are keyed on `payload.item.id`; a later
event for an id replaces the earlier item in place rather than appending.

**C4 — PI's tool error flag is `isError`, not `error`, and the result is nested.**
Spec §4.3.1 says "`error` present for PI"; the real `tool_execution_end` is
`{toolCallId, toolName, result:{content:[{type:"text",text}]}, isError:false}`.
**Resolution:** PI error detection reads `payload.isError === true`; the Result
block renders `payload.result.content[]`'s `text` parts joined by `\n`, falling
back to `JSON.stringify(payload.result)`.

**C5 — PI echoes each assistant message as a second `MODEL_COMPLETED`.**
`adapters.ts:287-297` maps both `turn_end` and `message_end` to
`MODEL_COMPLETED`. The first pass answered this with a global
"drop text byte-identical to the previous text" rule; review must-fix 8 is right
that this deletes legitimate messages (any agent that answers `ok` twice in a
row loses one) and it is not scoped to the runner that needs it.

**Re-derived from the captures, precisely** (`pi-tool-event.stdout`,
`pi-resume.stdout`, `pi-start-openai-codex.stdout`, `pi-sigterm.stdout`, all
decoded field by field):

| event | role | `message.timestamp` | content parts |
|---|---|---|---|
| `message_end` | user | 1786788182351 | `[text]` |
| `message_end` | assistant | 1786788182370 | `[thinking, toolCall]` |
| `message_end` | toolResult | 1786788186732 | `[text]` |
| **`turn_end`** | assistant | **1786788182370** | `[thinking, toolCall]` |
| `message_end` | assistant | 1786788186733 | `[text]` |
| **`turn_end`** | assistant | **1786788186733** | `[text]` |

Every `turn_end` is an exact echo of an earlier assistant `message_end` and
**shares its `message.timestamp`**; where the message has text, both also carry
the same `textSignature.id` (`msg_0dd9…`). `pi-sigterm.stdout` has a
`message_end` with **no** `turn_end` (the run was interrupted), so "just ignore
`turn_end`" would be the wrong shape of rule to rely on.

**Resolution:** dedup is **PI-only** and keyed on **message identity, never on
text bytes**. Within a PI stream, a `MODEL_COMPLETED` is skipped when a
previously seen one had the same identity, where identity is
`payload.message.timestamp` when present, else the first
`textSignature.id` found in `payload.message.content[]`, else no identity — and
**no identity means no dedup**, because rendering a duplicate is a smaller harm
than deleting a real message. CLAUDE gets no dedup at all. CODEX keeps its own,
separate `payload.item.id` replacement rule (C3) — that one is a replacement, not
a suppression, and is unaffected.
Consequence worth knowing: PI turn 1 in the capture has content
`[thinking, toolCall]` and therefore yields **zero** text items — correct, and
consistent with A2's exclusion of reasoning.

**C6 — PI usage exists, just not where the spec looks.** See §0.1. Harvesting it
would mean summing per-message usage across `MODEL_COMPLETED` events, which
double-counts precisely because of C5, and no cheap correct alternative exists
(`totalTokens` on each message is that message's total, not the session's).
**Resolution: follow the spec.** PI sessions show `—`, the BACKLOG-V2 ledger note
required by §4.6.5 is filed, and the note records the discovered shape and the
double-counting hazard so a follow-up batch starts from evidence. This is a
deliberate scope decision, not an oversight.

**C7 — the web test glob only matches `.tsx`.**
`apps/web/package.json`: `"test": "TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx --test src/**/*.test.tsx"`.
Spec §8 names `apps/web/src/tests/session-stream.test.ts` — a `.ts` file that
would never execute and would look green. **Resolution: every new web test file
ends in `.test.tsx`**, including the ones with no JSX in them.

**C8 — the metadata poll has no off switch, and does not need one.**
`hooks.ts:32-37` clears `data`, `error` and `loading` when `path === null`, so
passing `null` to stop the session-detail metadata poll on a terminal session
would blank the page rather than freeze it; §5.5 also forbids changing
`usePoll`'s signature. The first pass answered this by inventing
`TERMINAL_POLL_MS = 300_000`. Review should-fix 1 is right that this is
unrequested: spec §5.3 fixes session-detail metadata at `POLL_MS` with no
terminal exception, and only the **events** endpoint is ordered to stop. A
five-minute interval also leaves late-arriving metadata (`endedAt`,
`terminationReason`, the backfilled token columns) stale on screen.

**Resolution:** `TERMINAL_POLL_MS` is deleted. Session-detail metadata polls at
`POLL_MS` for the whole life of the page, terminal or not — one small request
every 2.5 s on a page the operator is actively looking at. The hard stop
condition (spec §5.3, §9 step 5) belongs entirely to `useEventStream`, which is
the new hook's own concern and does stop dead. The record of *why* `null` is not
the mechanism stays here so nobody re-derives it.

**C9 — `Session` has no `workspacePath` and no `model` column.**
Spec §5.1 says `GET /sessions/:sessionId` returns "workspacePath"; §4.2's meta
line wants `Model` and `Workspace`. Both live on `Run`
(`apps/web/src/lib/types.ts:152-186`, schema `model Run`). **Resolution:** they
arrive through the `run` include the spec already specifies; no new column, no
new query.

**C10 — `SessionEventSource` has no "provider" value.**
The enum is `RUNNER | CLAUDE | CODEX | PI` (`schema.prisma:145-150`). Spec §4.5's
`All | Provider | Runner` filter therefore means: Runner = `source === "RUNNER"`,
Provider = everything else.

**C11 — the `/sessions` vs `/session/` prefix is one character from a 403.**
`auth.ts:49` denies the operator any path starting with `/session/`. `/sessions`
and `/sessions/:id` do **not** match that prefix (index 8 is `s`, not `/`), so
they are operator-reachable with no auth change — verified by reading the
predicate. An implementer who writes the route singular (`/session/:sessionId`)
gets a 403 with no useful message. **The plural is mandatory**; WI-3's test pins
it.

Two smaller notes, recorded so nobody re-derives them:

- `GET /tasks/:taskId` already does `include: { session: true }` (`app.ts:1276`),
  so the four new columns reach the runs table with **no API change** once WI-1
  lands. WI-8 is pure UI.
- `GapNotice` (`ui.tsx:323-329`) renders Chinese copy while the new pages are
  English. Accepted as-is — i18n is batch 1's scope, and inventing an English
  variant here would fork the component.

---

## 0.3 Review disposition — revision 1

Review: `docs/reviews/2026-08-16-batch-4-sessions-viewer-plan-review.md`, verdict
FAIL. **Every finding was re-verified against the source before being applied**;
all 14 are accepted, **none is rejected**. Nothing else in the plan changed
except where a fix forced it (the forced edits are named in the right-hand
column).

| # | finding, in one line | disposition | where |
|---|---|---|---|
| MF-1 | `StreamItem["state"]` union lacks `"incomplete"`, which the same WI returns | accepted | WI-5 type + test matrix |
| MF-2 | usage writes and backfill are not idempotent at the `skipDuplicates` boundary | accepted — redesigned to absolute recomputation from stored events | §0.2-C2 rewritten; **WI-2 rewritten** |
| MF-3 | bare-array tolerance re-appends the whole history every poll | accepted | WI-6 (`toEnvelope` filters by `afterSeq`; all appends dedupe by `seq`) |
| MF-4 | session-detail response carries no repo URL, so the Branch link cannot be built | accepted | WI-3 (`run.repo.select.remoteUrl`), WI-7 types, WI-3 test |
| MF-5 | nested `Link` inside a clickable row navigates to the session instead | accepted | WI-7 (`defaultPrevented` guard + JSDOM test) |
| MF-6 | no `ADAPTER_ERROR` rule, and no per-runner tool-return extraction | accepted | WI-5 mapping table + test matrix |
| MF-7 | orphan tool call both counts and does not count | accepted — count redefined from rendered items; spec self-contradiction logged | WI-5 counts; §12 open question 5 |
| MF-8 | global consecutive-text suppression deletes legitimate messages | accepted — re-derived from captures, now PI-only and identity-keyed | §0.2-C5 rewritten; WI-5 rule + regression |
| MF-9 | whitespace-only step output has no `EmptyState` branch | accepted | WI-8 (mirrors the Prompt card at `TaskDetail.tsx:202-206`) |
| MF-10 | WI-6's acceptance check never exercises the hook | accepted — JSDOM hook test promoted from "if time allows" to required | WI-6 tests; §11-G8 retired |
| MF-11 | terminal `Done`/`Failed` stat-bar pill dropped | accepted | WI-7 stat bar + mapping test |
| SF-1 | `TERMINAL_POLL_MS = 300_000` is unrequested and staleness-prone | accepted | §0.2-C8 rewritten; constant deleted from WI-7 |
| SF-2 | session-list pagination has no state model or acceptance check | accepted | WI-7 (live head + accumulated older pages, deduped) |
| SF-3 | static-render tests cannot prove the interactions they are assigned | accepted | WI-7 tests split: static for initial markup, JSDOM for interaction |

**One correction to the review's reasoning, recorded because the executor will
read both documents.** MF-2 argues partly from replay of an already-stored batch.
The runner has no automatic retry of `appendEvents` (`packages/runner/src/api.ts:74-88, 131-146`),
so routine replay is not the live hazard. The finding is nevertheless accepted in
full: its other two halves — the backfill re-writing a cost-only session on every
run, and usage lost forever if the process dies between `createMany` and the
usage write — hold unconditionally, and the fix that addresses them is simpler
than the accumulation it replaces.

**Two findings changed the plan's shape rather than patching it:** MF-2 rewrote
WI-2 around `SessionEvent` as the source of truth, and MF-8 forced C5 to be
re-derived from the captures, which turned up the exact identity field
(`message.timestamp`, shared by every `turn_end`/`message_end` pair) that makes a
safe rule possible.

---

## WI-1 — Migration: token columns on `Session` (+ two supporting indexes)

Covers spec §4.6.2. Nothing else can start until the Prisma client regenerates.

**Files**

- `packages/db/prisma/schema.prisma` — in `model Session` (starts line 661; add
  immediately after `costUsd` at line 688 so the money-ish columns sit together):

  ```prisma
  inputTokens       Int?
  outputTokens      Int?
  cachedInputTokens Int?
  totalTokens       Int?   // input + output; cached excluded to avoid double counting
  ```

  Plus, in the same model's index block (currently
  `@@index([executionStatus, requestedAt])`, `@@index([cleanupStatus, requestedAt])`,
  `@@index([agentId])`, `@@index([taskId])`, `@@index([goalId])`):

  ```prisma
  @@index([projectId, requestedAt])
  ```

  and in `model SessionEvent` (starts line 708, alongside `@@index([runId, at])`):

  ```prisma
  @@index([runId, seq])
  ```

  **The two indexes are plan additions, not spec text.** Justification: WI-3's
  `GET /sessions` filters on `projectId` and orders by `requestedAt`, and
  `Session` has no `projectId` index today (`@@unique([runId, projectId])` leads
  with `runId` and cannot serve it); WI-3's paged events query filters `runId`
  and orders/ranges on `seq`, and only `[runId, at]` exists. Both are additive
  and non-destructive, so they sit inside the spec's "additive only"
  constraint. If the reviewer prefers the spec's literal column-only migration,
  delete the two `@@index` lines — nothing else changes.

- `packages/db/prisma/migrations/<timestamp>_batch4_session_usage/migration.sql`
  — generated, not hand-written, by `npm run db:migrate -w @agentos/db`
  (`prisma migrate dev`, which prompts for the name: use `batch4_session_usage`).
  Expected content, and nothing else:

  ```sql
  ALTER TABLE "Session" ADD COLUMN     "inputTokens" INTEGER;
  ALTER TABLE "Session" ADD COLUMN     "outputTokens" INTEGER;
  ALTER TABLE "Session" ADD COLUMN     "cachedInputTokens" INTEGER;
  ALTER TABLE "Session" ADD COLUMN     "totalTokens" INTEGER;
  CREATE INDEX "Session_projectId_requestedAt_idx" ON "Session"("projectId", "requestedAt");
  CREATE INDEX "SessionEvent_runId_seq_idx" ON "SessionEvent"("runId", "seq");
  ```

  Style reference: `packages/db/prisma/migrations/20260816055603_agent_archived_at/migration.sql`.
  **If the generated SQL contains any `DROP` or `ALTER COLUMN ... SET NOT NULL`,
  stop** — that means the schema was edited beyond this list.

- `apps/web/src/lib/types.ts:135-150` — extend `Session` with
  `inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; totalTokens: number | null;`.
  Done here rather than in WI-7 so the type and the column land together.

**Migration and restart steps (WI-1 is the only place in the batch that needs them)**

1. Local, from repo root, with Postgres up (`docker compose up -d postgres`):
   `npm run db:migrate -w @agentos/db` → writes the migration and applies it.
2. `npm run db:generate` (root) — regenerates `@prisma/client` with the new
   fields. Without this, WI-2 and WI-3 will not typecheck.
3. `npm run build -w @agentos/db` — `packages/api` resolves `@agentos/db` to
   `dist/index.js` at runtime (`packages/db/package.json` exports map), and its
   `pretest` does this too, but doing it explicitly avoids a confusing first
   failure.
4. Deploy (human action, not the implementer's): `prisma migrate deploy` against
   the control-plane database, then **restart the API process**. The runner is
   untouched by this batch (spec §5.5) and does **not** need restarting. This
   plan does not touch launchd units; the operator performs the restart.

**Tests / verification**

- `npm run db:validate` — schema parses.
- `DATABASE_URL=<migrated db> npm run db:drift-check` — exit 0, i.e. the
  migration and the datamodel agree (`packages/db/scripts/check-drift.mjs`
  requires `DATABASE_URL` and exits 2 without it).
- `npm run typecheck` — the web `Session` type change compiles.
- Inspect the generated SQL against the expected block above.

**Rollback.** `ALTER TABLE "Session" DROP COLUMN` on the four columns plus
`DROP INDEX` on the two indexes. Only derived data is lost, and WI-2's backfill
recomputes all of it from `SessionEvent` at any time. Rolling the *code* back
does not require rolling the migration back: unread nullable columns are inert
(spec §10.4).

**Commit**: `feat(db): batch 4 migration — nullable token columns on Session, project/seq indexes`

---

## WI-2 — Usage extraction, ingest wiring, backfill script

Covers spec §4.6.1, §4.6.3, §5.2. Depends on WI-1.

**Files**

- **New `packages/db/src/usage.ts`** (placement per §0.2-C1):

  ```ts
  export type SessionUsage = {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
  /** One event payload → whatever usage it carries. Total over `unknown`. */
  export const extractUsage = (payload: unknown): SessionUsage => { … };
  /** Fold many payloads into one absolute total. Pure; no database. */
  export const sumUsage = (usages: SessionUsage[]): SessionUsage => { … };
  /**
   * Recompute this session's derived usage columns from its stored
   * FINAL_OUTPUT events and write absolute values. Idempotent: same events in,
   * same columns out. Returns true when it actually wrote.
   */
  export const recomputeSessionUsage = (db: PrismaClient, sessionId: string): Promise<boolean> => { … };
  ```

  **`applyUsage` from the first pass is gone** (§0.2-C2, review MF-2). It took a
  delta and added it to the current column values, which drifts on replay,
  silently no-ops on NULL, and cannot recover a write lost to a crash. Nothing
  outside this module referenced it.

  - `extractUsage` is **total over `unknown`** and shape-driven, not
    runner-driven (spec §4.6.1): if `payload` is a non-null object and
    `payload.usage` is a non-null object, take whichever of
    `input_tokens` / `output_tokens` / `cached_input_tokens` are finite numbers;
    `cachedInputTokens` additionally accepts CLAUDE's pair as
    `cache_read_input_tokens + cache_creation_input_tokens` when either is
    present. Cost comes from a top-level numeric `total_cost_usd`. Anything else
    → `{}`. Never throws.
  - `reasoning_output_tokens` (present in the real CODEX payload, §0.1) is
    **not** added into `outputTokens`. That is a judgement call the spec does not
    make; it is called out in §11-G4 and is a one-line change if Leo disagrees.
  - `sumUsage` adds field by field and **omits a field entirely when no input
    carried it** — it never turns an absent field into `0`. So a run of
    cost-only payloads yields `{costUsd}` with all three token fields absent.
  - `recomputeSessionUsage`:
    1. `sessionEvent.findMany({ where: { sessionId, type: "FINAL_OUTPUT" }, orderBy: { seq: "asc" }, select: { payload: true } })`;
    2. `sumUsage(rows.map((row) => extractUsage(row.payload)))`;
    3. derive the five column values: the three token fields as summed
       (`undefined` → `null`), `costUsd` as `new Prisma.Decimal(sum)` or `null`,
       and `totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0)` **only when at
       least one of the two is present**, else `null`;
    4. read the session's five current values and **return `false` without
       writing when they already equal the derived ones** (`Decimal.equals` for
       cost) — this is what makes a second backfill pass honestly report
       `updated 0`;
    5. otherwise one `update` with all five absolute values, and return `true`.
  - **Why absolute, not additive** (§0.2-C2, review MF-2): `SessionEvent` is the
    source of truth and the columns are a derived cache, so replaying the same
    batch converges instead of drifting, a resumed session accumulates for free
    (each attempt's `FINAL_OUTPUT` is its own row at a higher `seq`, and step 2
    sums all of them), a write lost to a crash is repaired by the next ingest or
    by the backfill, and no NULL column is ever used in arithmetic.
  - Concurrency: last writer wins and both writers compute from the same table,
    so they converge. A session has exactly one runner process posting events
    sequentially (`packages/runner/src/api.ts:131-146`); that assumption is
    written into the module's comment, and it is now a performance note rather
    than a correctness requirement.
  - `totalTokens` stays `null` when both input and output are absent, so §4.6.5's
    "never `0`, never an estimate" holds. A session with cost but no tokens
    stores `costUsd` and leaves all four token columns `null` — spec §363-367's
    independent-nullable-fields rule.

- `packages/db/src/index.ts` — re-export `extractUsage`, `sumUsage`,
  `recomputeSessionUsage`, `SessionUsage` (the file already re-exports
  `workflow.ts`'s helpers; follow that shape).

- `packages/api/src/app.ts:1770-1787` — inside `POST /runner/runs/:runId/events`,
  after the existing `createMany` (line 1770-1783) and before the
  `providerConversationId` update (1784-1786):

  ```ts
  if (body.events.some((event) => event.type === "FINAL_OUTPUT")) {
    await recomputeSessionUsage(db, run.session.id);
  }
  ```

  The guard reads the request body already in memory, so the common case (no
  `FINAL_OUTPUT` in the batch) still costs **zero extra queries** — the spec's
  §5.2 performance requirement. When a `FINAL_OUTPUT` *is* present, which happens
  about once per run, the recompute costs one indexed `findMany` plus one
  `findUnique` plus at most one `update`. Deliberately, the trigger is "a
  `FINAL_OUTPUT` arrived", not "this payload had usage": a batch whose event was
  already stored still recomputes, and recomputation is a no-op write, which is
  exactly the self-healing property MF-2 asked for. Import
  `recomputeSessionUsage` from `@agentos/db` alongside the existing imports at
  `app.ts:1-27`.

- **New `packages/db/prisma/backfill-session-usage.ts`** — one-shot, idempotent,
  and now sharing the ingest path's single implementation rather than
  paraphrasing it. Select the candidate sessions as **those that have at least
  one `FINAL_OUTPUT` event** —
  `session.findMany({ where: { events: { some: { type: "FINAL_OUTPUT" } } }, select: { id: true } })`
  — not `where: { totalTokens: null }`. Call `recomputeSessionUsage` on each, in
  batches, and count the `true` returns. Print `scanned N, updated M`.

  **Why the selector changed** (review MF-2): `totalTokens: null` both re-scanned
  a cost-only session forever *and* permanently excluded a session whose
  `totalTokens` was written by attempt 1 but whose attempt 2 usage was lost to a
  crash — the one case a backfill exists to repair. Scanning every session with a
  terminal event and letting the no-write comparison decide is slower and
  correct. Running it twice reports `updated 0` on the second pass because
  `recomputeSessionUsage` compares before writing (step 4 above) — including for
  cost-only sessions, which the first pass could not honestly claim.

- `packages/db/package.json` — add
  `"db:backfill-session-usage": "dotenv -e ../../.env -- tsx prisma/backfill-session-usage.ts"`,
  matching the existing `db:files-precheck` entry exactly.
- `package.json` (root) — add
  `"db:backfill-session-usage": "npm run db:backfill-session-usage -w @agentos/db"`.

**Interfaces changed**

- `@agentos/db` gains three functions and one type (`extractUsage`, `sumUsage`,
  `recomputeSessionUsage`, `SessionUsage`). No existing export changes.
- `POST /runner/runs/:runId/events` response is unchanged (`{accepted: N}`).

**Tests / verification**

- **New `packages/api/src/usage.test.ts`** (spec §8; in `packages/api` because
  that is the workspace with a `test` script — §0.2-C1), importing from
  `@agentos/db`. Table-driven, with fixtures **copied verbatim from the real
  captures**:
  - CLAUDE `result` from `spikes/cli-capabilities/samples/claude-tool-event.stdout`
    → `{inputTokens:4, outputTokens:77, cachedInputTokens:8768, costUsd:0.049117}`
    (`4332 + 4436`).
  - CODEX `turn.completed` from `codex-tool-event.stdout` →
    `{inputTokens:40764, outputTokens:253, cachedInputTokens:35072}` and **no**
    `costUsd`.
  - PI `agent_settled` (`{"type":"agent_settled"}`) → `{}`.
  - `null`, `42`, `"x"`, `{}`, `{usage:null}`, `{usage:{input_tokens:"nope"}}`
    → `{}`, no throw.
  - Partial usage: `{usage:{output_tokens:5}}` → `{outputTokens:5}` only.
  - `sumUsage`: `[{inputTokens:1},{outputTokens:2}]` → `{inputTokens:1,outputTokens:2}`;
    `[{costUsd:1},{costUsd:2}]` → `{costUsd:3}` with **no** token fields present
    (not `0`); `[]` → `{}`.
  - **Idempotence (review MF-2, the regression that motivated the redesign).**
    `recomputeSessionUsage` against a stubbed `db` whose `sessionEvent.findMany`
    returns the same CLAUDE `result` row on both calls: the first call writes
    real numbers over all-null current values and returns `true`; the **second
    call, with the stub's session now holding those values, performs no `update`
    and returns `false`**. This single test covers the NULL-column regression
    (§0.2-C2 reason 1) and the replay-drift regression (reason 2) at once.
  - **Cost-only second run.** Events carrying `total_cost_usd` and no `usage`:
    first call writes `costUsd` and leaves all four token columns `null`; second
    call returns `false` and writes nothing. Pins spec §385-389 (no-op second
    run) and §363-367 (independent nullable fields) together.
  - **Resume accumulation.** Two `FINAL_OUTPUT` rows in one session, from two
    attempts, with different usage: one `update` carrying the **sums**, and
    `totalTokens = (i1+i2) + (o1+o2)`. Assert it equals what a single event
    carrying the summed usage would produce — accumulation is now a property of
    the stored rows, not of write ordering.
  - **Partial-resume recovery.** The same two rows, but the session's current
    columns hold only attempt 1's numbers (simulating a crash between
    `createMany` and the usage write): the recompute writes the full sum. Under
    the first pass's additive design this session was unreachable.
- The backfill script's own loop is thin (select ids → call the function →
  count `true`s); its correctness is the function's, covered above. End-to-end
  idempotence is still confirmed by hand at deploy time (spec §9 step 9): a
  DB-backed test would need Postgres and `npm test` does not run `*.dbtest.ts`.
- `npm test -w @agentos/api`, `npm run typecheck`.

**Rollback.** Delete the guard in `app.ts` and the module; the columns go inert
(they stay whatever the last write left). No data corruption, no schema change.
Because the columns are derived from `SessionEvent` and the recompute is
absolute, re-running the backfill after a re-deploy restores every number exactly
— including for sessions whose columns were already partly written.

**Commit**: `feat(api): extract runner usage at event ingest + idempotent session-usage backfill`

---

## WI-3 — API: `/sessions`, `/sessions/:sessionId`, and the events envelope

Covers spec §5.1, §4.1.2. Depends on WI-1.

**Files** — all in `packages/api/src/app.ts`.

- **New `GET /sessions`**, placed next to the other operator read routes (put it
  immediately before `app.get("/runs/:runId/events")` at line 2199 so the two
  session-facing reads sit together):

  ```ts
  app.get("/sessions", async (context) => {
    const projectId = context.req.query("projectId");
    const limit = Math.min(Math.max(Number.parseInt(context.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const before = context.req.query("before");
    return context.json(await db.session.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        ...(before ? { requestedAt: { lt: new Date(before) } } : {}),
      },
      include: {
        agent: { select: { id: true, title: true } },
        task:  { select: { id: true, name: true } },
        goal:  { select: { id: true, title: true } },
        run:   { select: {
          id: true, runNumber: true, model: true, branch: true,
          pullRequestUrl: true, workspacePath: true,
          repo: { select: { id: true, name: true, remoteUrl: true } },
        } },
      },
      orderBy: { requestedAt: "desc" },
      take: limit,
    }));
  });
  ```

  **The nested `repo` select is required, not decorative** (review MF-4): spec
  §4.2's meta line and §4.7.2 both want `Branch` rendered as a GitHub link, and
  `repoWebUrl` (WI-4) needs `Repo.remoteUrl` to build one. `Run.repo` is a
  nullable relation (`schema.prisma:643`) and `Repo.remoteUrl` is a non-null
  `String` (`schema.prisma:298`), so the frontend sees
  `run.repo?.remoteUrl ?? null` and falls back to plain text — spec §6's
  "not GitHub (or null) → plain text, no broken link". Without this the Branch
  field could only ever be plain text and the requirement would fail silently at
  review time.

  Notes the implementer must not re-derive: `projectId` is optional and matches
  the `GET /tasks` convention (`app.ts:1209-1220`); relation `select`s keep the
  agent's `foundationalPrompt`/`rolePrompt` out of a 50-row list; `Goal`'s label
  column is **`title`**, not `name` (`apps/web/src/lib/types.ts:306-326`) — the
  spec's §5.1 table says `goal {id,name}` and is wrong on that one word. An
  invalid `before` produces an Invalid Date and a Prisma error caught by
  `app.onError` as a 500; guard it with a validity check and ignore the filter if
  unparseable.

- **New `GET /sessions/:sessionId`** — same includes **including the nested
  `repo` select**, `findUnique`, `404 {error:"Session not found"}` when absent. `Session` already carries
  `terminationReason`, `exitCode`, `resumeAttempt`, `waitingOnMessageId`,
  `failureReason` and (after WI-1) the token columns, so no extra selection is
  needed; `workspacePath` and `model` come from the `run` include (§0.2-C9).
  **Route must be plural** (§0.2-C11).

- **Changed `GET /runs/:runId/events`** (`app.ts:2199-2202` today — a bare
  `findMany` with `orderBy: { seq: "asc" }` and no limit):

  ```ts
  app.get("/runs/:runId/events", async (context) => {
    const runId = id.parse(context.req.param("runId"));
    const afterSeq = Number.parseInt(context.req.query("afterSeq") ?? "", 10);
    const limit = Math.min(Math.max(Number.parseInt(context.req.query("limit") ?? "500", 10) || 500, 1), 2_000);
    const where = { runId, ...(Number.isFinite(afterSeq) ? { seq: { gt: afterSeq } } : {}) };
    const [events, total] = await Promise.all([
      db.sessionEvent.findMany({ where, orderBy: { seq: "asc" }, take: limit + 1 }),
      db.sessionEvent.count({ where: { runId } }),
    ]);
    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;
    return context.json({
      events: page,
      nextAfterSeq: page.at(-1)?.seq ?? null,
      hasMore,
      total,
    });
  });
  ```

  `take: limit + 1` is how `hasMore` is decided without a second count on the
  filtered set. `total` is the run's whole event count (what the ceiling notice
  in §5.3 needs to say "of N"), not the filtered count.

**Interfaces changed**

- `GET /runs/:runId/events` returns an object where it returned an array. **This
  is the batch's only backwards-incompatible change.** Verified consumers: one,
  `RunEvents` in `apps/web/src/pages/TaskDetail.tsx:26`, which WI-8 deletes.
  `grep -rn "/events" apps packages agents deploy` finds only that call site, the
  two API route definitions, the runner's *write* path
  (`packages/runner/src/api.ts:138`, a POST to `/runner/runs/:runId/events` —
  unaffected), and unrelated Feishu event files in `packages/inbox`. The CLI
  package has no call. Re-run that grep before landing.

**Tests / verification**

- Added to `packages/api/src/app.test.ts`, in its established stub style — that
  file casts object literals to `PrismaClient` (see `app.test.ts:42-49, 94-100`)
  and asserts on the arguments the route passes, so these are query-shape tests,
  not database tests:
  - `GET /sessions?projectId=p&limit=5&before=<ISO>` → the stub's `findMany`
    receives `where.projectId === "p"`, `where.requestedAt.lt` a Date,
    `take === 5`, `orderBy.requestedAt === "desc"`, and an `include` naming
    `agent`, `task`, `goal`, `run`.
  - `limit=9999` clamps to 200; `limit=abc` falls back to 50.
  - `GET /sessions/unknown` with a `findUnique` stub returning `null` → 404 with
    `{error:"Session not found"}`.
  - **Both routes' `include.run.select` contains `repo`, and that nested select
    names `remoteUrl`** (review MF-4) — asserted on the stub's arguments, so a
    later tidy-up of the select cannot silently break the Branch link.
  - **`GET /sessions` with an operator token returns 200, not 403** — the
    §0.2-C11 near-collision, pinned so a later rename cannot break it silently.
  - `GET /runs/r1/events?afterSeq=7&limit=2` against a stub returning 3 rows →
    body has 2 events, `hasMore === true`, `nextAfterSeq === <2nd row's seq>`,
    and `where.seq.gt === 7`; with 2 rows returned → `hasMore === false`.
  - `limit=99999` → the stub sees `take === 2001` (2 000 clamp + 1).
- `npm test -w @agentos/api`, `npm run typecheck`.

**Rollback.** The two new routes are additive — deleting them breaks only the new
pages. The envelope change reverts by restoring the four-line `findMany`.
**Deploy-order rule (spec §10.3), restated because it is the one trap here:**
revert the API and the web app together, or revert the API alone (the new client
tolerates the old array shape, WI-6), but **never revert the web app alone while
keeping the new API** — the old `RunEvents` would receive an object where it
expects an array and render nothing.

**Commit**: `feat(api): GET /sessions + /sessions/:sessionId, paged envelope on /runs/:runId/events`

---

## WI-4 — `format.ts` helpers and two new Markdown constructs

Covers spec §4.6.4, §4.7.2, §4.8. Independent of WI-1..3.

**Files**

- `apps/web/src/lib/format.ts` — append two exports (the file is 57 lines and has
  no token or URL helper today):
  - `compactTokens(value: number | null | undefined): string` — `null`/`undefined`
    → `"—"`; `< 1000` → the integer; `>= 1_000_000` → `"1.2M"`; else `"8.9K"`;
    one decimal with a trailing `.0` stripped (`1000 → "1K"`, `8_900 → "8.9K"`).
  - `repoWebUrl(remoteUrl: string | null | undefined): string | null` —
    `https://github.com/o/r` and `https://github.com/o/r.git` →
    `https://github.com/o/r`; `git@github.com:o/r.git` →
    `https://github.com/o/r`; **everything else → `null`**. No other forge.

- `apps/web/src/components/ui.tsx:425-456` — `Markdown` gains exactly two
  constructs and nothing else:
  1. **Fenced code blocks.** The current implementation is a single
     `for (const line of text.split("\n"))` loop with a list accumulator
     (`ui.tsx:436-453`). Add a fence state alongside `list`: on a line matching
     `/^\s*```(\w*)\s*$/`, flush the list, then either open a fence (recording
     the language) or close it and push a block. Inside a fence, lines are
     collected verbatim — no bullet/heading/inline processing. **An unterminated
     fence at end of input emits its collected lines as a code block** (spec
     §4.8, §6) — handle it in the existing post-loop `flush()` region. Render as
     `<div className={CODE_BLOCK}>` (`ui.tsx:70`, which already carries
     `whitespace-pre-wrap` and `[overflow-wrap:anywhere]`), preceded by a small
     muted caption showing the language when non-empty.
  2. **Links.** Extend the `inline()` splitter at `ui.tsx:415-421` — its regex is
     `/(\*\*[^*]+\*\*|`[^`]+`)/g` — with a `\[[^\]]*\]\([^)\s]*\)` alternative.
     Render `<a href={url} target="_blank" rel="noreferrer">` **only** when the
     URL matches `/^https?:\/\//i`; anything else (notably `javascript:`) renders
     as the literal source text. `target="_blank" rel="noreferrer"` matches the
     existing external-link shape at `TaskDetail.tsx:70`.

  Headings stay bold paragraphs; inline `` `code` `` is unchanged; tables stay
  unsupported (batch 3).

**Constraint that bites here.** `apps/web/src/tests/styles.test.tsx:111-125`
imports `Markdown` and asserts the rendered markup still contains
`<ul … list-disc>` and `<ol … list-decimal>`. The fence rewrite must not disturb
the list accumulator. Run that test specifically after touching `ui.tsx`.

**Tests / verification**

- **New `apps/web/src/tests/markdown.test.tsx`** (`.tsx` per §0.2-C7), using
  `renderToStaticMarkup` like `primitives.test.tsx`:
  - a fenced block renders its content verbatim inside the `CODE_BLOCK` shape,
    and markdown inside the fence (`**bold**`, `- item`) is **not** processed;
  - a fence with a language shows the language caption;
  - an unterminated fence renders its remaining lines and drops nothing;
  - `[a](https://x)` → an anchor with `target="_blank"` and `rel="noreferrer"`;
  - `[a](javascript:alert(1))` → literal text, **no `<a`** in the markup;
  - lists, bold and inline code still render as before (regression guard).
- **New format tests** — append to `apps/web/src/tests/primitives.test.tsx` or a
  new `apps/web/src/tests/format.test.tsx`: `compactTokens` at
  `null, 0, 999, 1000, 8900, 999_999, 1_200_000`; `repoWebUrl` for https,
  https-with-`.git`, ssh, a GitLab URL (→ `null`) and `null` (→ `null`).
- `npm run build && npm test -w @agentos/web` (build first — styles.test.tsx).

**Rollback.** Pure revert of two files. No stored state.

**Commit**: `feat(web): markdown fenced code + safe links; compactTokens and repoWebUrl formatters`

---

## WI-5 — `lib/session-stream.ts`, the one normalizer

Covers spec §4.3, §4.4, §4.2's counting rules, §6's robustness rows. Independent
of WI-1..4; it is the largest single piece of the batch.

**Files**

- **New `apps/web/src/lib/session-stream.ts`** — pure, no React, no imports from
  `components/`:

  ```ts
  export type StreamItem =
    | { kind: "text";  id: string; at: string; text: string }
    | { kind: "tool";  id: string; at: string; name: string; primaryArg: string | null;
        filePath: string | null; args: unknown; result: string | null;
        state: "running" | "incomplete" | "ok" | "error"; }
    | { kind: "error"; id: string; at: string; message: string }
    | { kind: "final"; id: string; at: string; text: string };

  export type FileTouch = { path: string; count: number };
  export type StreamCounts = { messages: number; toolCalls: number; files: number };

  export const normalize = (
    events: SessionEvent[],
    runner: RunnerKind,
    terminal: boolean,
  ): { items: StreamItem[]; files: FileTouch[]; counts: StreamCounts };
  ```

  `runner` is passed explicitly rather than read per-event so the mapping tables
  are chosen once; `terminal` decides whether an unfinished tool reads `running`
  or `incomplete` (spec §6) — **both values are in the `state` union**, which the
  first pass omitted and which would not have typechecked (review MF-1).
  `result` is the **already-extracted display string** (rules below), not the raw
  payload, so WI-7 renders it without re-deriving anything per runner; `null`
  means the tool has not returned. The `StreamItem` types live here, **not** in
  `lib/types.ts`, which mirrors API rows (spec §5.4).

  **Mapping rules**, per runner, all verified in §0.1 except where marked:

  | | CLAUDE | CODEX | PI |
  |---|---|---|---|
  | text | `MODEL_DELTA` → `payload.message.content[]` where `type==="text"`, joined `\n` | `MODEL_DELTA` → `payload.item.text` when `payload.item.type==="agent_message"`, **keyed on `payload.item.id`** (§0.2-C3) | `MODEL_COMPLETED` → `payload.message.content[].text` when `payload.message.role==="assistant"`, joined `\n` |
  | tool start | `TOOL_STARTED` payload = the `tool_use` part: `{id,name,input}` | `TOOL_STARTED` payload = the `command_execution` item *(inferred, §11-G1)* | `TOOL_STARTED` payload = `{toolCallId,toolName,args}` |
  | tool end | `TOOL_COMPLETED` payload = the `tool_result` part: `{tool_use_id,content,is_error}` | completed `command_execution` item *(inferred)* | `{toolCallId,toolName,result:{content[]},isError}` (§0.2-C4) |
  | tool **result** text | `payload.content` when a string; else the `text` parts of `payload.content[]` joined `\n` *(the capture has the string form)* | `payload.aggregated_output` when a string *(inferred, §11-G1)* | `payload.result.content[]`'s `text` parts joined `\n` (§0.2-C4) |
  | error flag | `payload.is_error === true` | non-zero `exit_code` *(inferred)* | `payload.isError === true` |
  | `error` item | `ADAPTER_ERROR` → message | `ADAPTER_ERROR` → message | `ADAPTER_ERROR` → message |
  | file paths | `payload.input.file_path` ‖ `payload.input.notebook_path`; `Glob`/`Grep` `path` **excluded** | `MODEL_DELTA` items with `payload.item.type==="file_change"` → `payload.item.changes[].path` *(inferred)* | `payload.args.file_path` ‖ `payload.args.path` ‖ `payload.args.filePath` *(container verified, keys inferred)* |
  | final | `FINAL_OUTPUT` → `payload.result` | `FINAL_OUTPUT` → the last CODEX agent message | `FINAL_OUTPUT` is `{type:"agent_settled"}` — **no text, so the Result card is always omitted for PI** (§0.1) |

  Cross-cutting rules:
  - Every other type — `PROVIDER_RAW`, `PROVIDER_STATUS`, `STDERR`,
    `MODEL_STARTED`, `TOOL_PROGRESS`, `PROCESS_STARTED` — yields **no item**.
    CODEX `reasoning` items are excluded (A2); PI `thinking` content parts have
    no `text` key and are dropped by the same rule that builds text.
  - **`ADAPTER_ERROR` → an `error` item, for every runner** (review MF-6; the
    first pass declared the item type and rendered it but never said what
    produced it). The adapter emits it from CODEX `error` events
    (`adapters.ts:259-262`) and from an unparseable stdout line for *any* runner
    (`adapters.ts:311-320`, payload `{error:"invalid-json", line}`). `message` is
    the first of `payload.message`, `payload.error` (when a string),
    `payload.error.message`, else `JSON.stringify(payload)` truncated to 500
    characters. That order mirrors the adapter's own `eventErrorMessage`
    (`adapters.ts:184-187`), so the stream shows the same text the run's
    `providerError` recorded.
  - **PI message-identity dedup** (§0.2-C5, review MF-8). **PI only**, and keyed
    on identity rather than text: a `MODEL_COMPLETED` is skipped when an earlier
    one in the stream had the same identity, where identity is
    `payload.message.timestamp` if present, else the first `textSignature.id`
    parsable out of `payload.message.content[]`, else **none — and no identity
    means no dedup**. CLAUDE is not deduped. CODEX's `payload.item.id`
    replacement (C3) is a separate, unchanged rule. The first pass's global
    "drop text identical to the previous text" is **deleted**: it silently
    removed a genuine second message whenever an agent answered `ok` twice.
  - Tools are joined `TOOL_STARTED` ↔ `TOOL_COMPLETED` by `toolCallId`. An
    orphan `TOOL_COMPLETED` becomes an item with `args: null`. A duplicate
    `toolCallId` resolves last-completed-wins, one item. When an event carries no
    `toolCallId` at all, the item is keyed on the **event id** so it cannot
    collide with another keyless tool event.
  - `primaryArg` = the extracted file path when there is one, else the command
    string (`input.command` for CLAUDE Bash — verified; `args.command` for PI —
    verified), else the first scalar value in the argument object, truncated to
    120 characters.
  - **Counts are derived from the normalized items, never from the raw events**
    (review MF-7): `messages` = number of `text` items; `toolCalls` = number of
    `tool` items (already deduplicated by `toolCallId`, or by event id when
    absent); `files` = `files.length`. This is the plan's central invariant —
    a stat-bar number can never disagree with what the stream renders.

    **This resolves a contradiction inside the spec, not just inside the plan.**
    Spec §4.2 defines tool calls as "distinct `toolCallId` values that have a
    `TOOL_STARTED`", while spec §6's edge-case table says an orphan
    `TOOL_COMPLETED` "counts as a tool call". Both cannot hold. The definition
    above follows §6 — it is the more specific statement, it is the one written
    about the exact case in dispute, and §4.2's phrasing is the only one of the
    two that breaks the invariant. Logged as §12 open question 5; the spec is not
    being rewritten here, and one line from Leo settles it either way (reverting
    would mean subtracting orphans from the count, a two-line change plus its
    test).
  - `normalize` is **total over `unknown`**: a payload that is `null`, a number,
    a string or an array contributes nothing and never throws. Every field access
    goes through a local `asRecord` / `asString` guard, mirroring
    `adapters.ts:178-182`.
  - Files are sorted alphabetically; non-absolute paths are listed verbatim and
    are not resolved (spec §4.4).

  **Verification duty carried from spec §4.4, unchanged and now sharper:** the
  CODEX `command_execution` and `file_change` shapes are the *only* mappings with
  no captured evidence (§0.1). Before writing them, run one real CODEX session
  and read its `/runs/:runId/events`. **If a shape does not match: extract
  nothing for that runner, render `Files touched` with count 0 and the hint
  `File tracking is not available for CODEX sessions.`, and file the BACKLOG-V2
  ledger note.** Do not guess further and do not let an unexpected shape throw.

**Tests / verification**

- **New `apps/web/src/tests/session-stream.test.tsx`** (`.tsx` per §0.2-C7) —
  the largest test in the batch, table-driven. Build fixtures by **pasting real
  lines from `spikes/cli-capabilities/samples/`** wrapped in the `SessionEvent`
  envelope, so the test proves the mapping against payloads the CLI actually
  emitted:
  - CLAUDE: the `assistant` event with a `tool_use` part yields **zero** text
    items; the following `assistant` with a `text` part yields one; the
    `tool_use` + `tool_result` pair yields one `tool` item with
    `primaryArg === "printf 3"`, `state === "ok"`, and — asserted explicitly —
    **`result === "3"`**, the extracted string, not the raw payload (MF-6); a
    synthetic `Read` call with `input.file_path` lands in `files`; a `Glob` call
    with `input.path` does not.
  - CODEX: `item.completed` `agent_message` yields one `text`; the same item id
    arriving twice (`item.started` then `item.completed`) yields **one** item
    with the later text (§0.2-C3); a `TOOL_COMPLETED` carrying
    `aggregated_output: "3\n"` yields `result === "3\n"`.
  - PI: the two assistant `message_end` + two `turn_end` events from
    `pi-tool-event.stdout`, pasted verbatim, yield **one** text item — the
    `[thinking, toolCall]` message contributes none and the `[text]` message
    contributes one, with its `turn_end` echo (same `message.timestamp`
    `1786788186733`) suppressed (§0.2-C5); the `tool_execution_start`/`_end` pair
    yields one tool item with `primaryArg === "printf 3"`, `state === "ok"` and
    `result === "3"` extracted from `result.content[]` (§0.2-C4); the same pair
    with `isError: true` yields `state === "error"`; a `message_end` with
    `role:"user"` yields nothing.
  - **PI dedup does not eat real messages** (review MF-8's required regression):
    two assistant `message_end` events with **identical text** and **different
    `message.timestamp`** yield **two** text items. Paired with a CLAUDE fixture
    of two identical consecutive `text` messages that also yields two items,
    since CLAUDE is not deduped at all.
  - **`ADAPTER_ERROR`** (review MF-6): a CODEX `error` event yields one `error`
    item whose `message` is the event's `message` field; an invalid-JSON payload
    `{error:"invalid-json", line:"…"}` yields one `error` item reading
    `invalid-json`; a payload with neither yields the truncated JSON and does not
    throw. Assert the item appears **in stream order**, between its neighbours.
  - Counting: a mixed fixture's `messages` / `toolCalls` / `files` equal the
    number of rendered items of each kind. Pinned cases, each with an exact
    expected number (review MF-7): an orphan `TOOL_COMPLETED` **counts as 1**; a
    duplicate `toolCallId` counts as **1**, not 2; two tool events with **no**
    `toolCallId` count as **2**, not 1.
  - Robustness: `payload: null`, `payload: 42`, `payload: []`, `payload: {}`,
    missing `toolCallId`, orphan `TOOL_COMPLETED`, duplicate `toolCallId` —
    all produce sane output and no throw.
  - Noise: `PROVIDER_RAW`, `STDERR`, `MODEL_STARTED`, `PROVIDER_STATUS`,
    `TOOL_PROGRESS`, `PROCESS_STARTED` produce zero items.
  - **Both tool states** (review MF-1): an unfinished `TOOL_STARTED` is
    `running` under `terminal: false` and `incomplete` under `terminal: true`.
- `npm run build && npm test -w @agentos/web`.

**Rollback.** Delete the module and its test; nothing else imports it until WI-7.

**Commit**: `feat(web): pure session-event normalizer for the message stream`

---

## WI-6 — `lib/use-event-stream.ts`, the polling contract

Covers spec §5.3 and the deploy-ordering mitigation in §6. Depends on WI-3's
envelope (and tolerates its absence).

**Files**

- **New `apps/web/src/lib/use-event-stream.ts`** — sits beside `usePoll`;
  `hooks.ts` is untouched (spec §5.5 freezes its signature and `POLL_MS`).

  ```ts
  export const EVENT_PAGE = 500;
  export const EVENT_PAGE_CEILING = 40;          // 40 × 500 = 20 000 events (A9)
  export const BACKOFF_AFTER_EMPTY = 4;
  export const BACKOFF_CEILING_MS = 15_000;      // A9
  export const nextIntervalMs = (emptyPolls: number): number => …;

  export const useEventStream = (runId: string | null, terminal: boolean): {
    events: SessionEvent[];
    total: number;
    capped: boolean;
    error: ApiError | null;
    loading: boolean;
    reload: () => void;
  };
  ```

  - Events accumulate in a ref-backed array; state carries a version counter so
    appends re-render without copying on every tick.
  - **Initial load**: fetch `?limit=500` with no `afterSeq`, then keep draining
    while `hasMore` and pages < `EVENT_PAGE_CEILING`. On hitting the ceiling, set
    `capped` and stop fetching.
  - **Live**: `?afterSeq=<highest seq held>&limit=500`, appending.
  - **Backoff**: `nextIntervalMs` is a pure exported function —
    `emptyPolls < 4 → 2_500`; thereafter `min(2_500 * 2 ** (emptyPolls - 3), 15_000)`.
    The counter resets to 0 the moment any events arrive. Implemented by feeding
    the value into a `useEffect`-owned `window.setTimeout` chain rather than
    `setInterval`, so the interval can change between ticks.
  - **Stop**: when `terminal` **and** a poll returns `hasMore === false` with
    zero new events, stop scheduling. `reload()` restarts one cycle.
  - `if (document.hidden) return;` before every fetch, matching `hooks.ts:41`.
  - **Shape tolerance (spec §6), corrected — the adapter must filter, not just
    wrap** (review MF-3). The old endpoint ignores `afterSeq` entirely and
    returns the run's whole history every time (`app.ts:2199-2202`, verified), so
    the first pass's five-line wrapper would have re-appended every event on
    every 2.5 s poll during a staggered deploy — growing to the render cap in
    under a minute, which is worse than the hazard it was meant to remove. The
    adapter takes the requested `afterSeq` and filters:

    ```ts
    export const toEnvelope = (body: unknown, afterSeq: number | null): EventPage => {
      if (!Array.isArray(body)) return body as EventPage;
      const events = afterSeq === null ? body : body.filter((event) => event.seq > afterSeq);
      return { events, nextAfterSeq: events.at(-1)?.seq ?? null, hasMore: false, total: body.length };
    };
    ```

    `total` stays the full array length, which is what the old shape can honestly
    report.
  - **Appends are deduplicated by `seq` regardless of shape** — the hook drops
    any incoming event whose `seq` is `<=` the highest it already holds. `seq` is
    unique per session and ascending (it backs `@@unique` on the table and the
    `[runId, seq]` index from WI-1), so this is a single comparison, not a `Set`
    scan. Belt and braces on top of `toEnvelope`: it also covers a new-API
    response that overlaps after a `reload()`.
  - A poll failure sets `error` and **keeps the accumulated events and keeps
    polling** (spec §5.3).

**Tests / verification**

- **New `apps/web/src/tests/event-stream.test.tsx`**, in two halves. Both are
  **required** — the first pass made only the pure half required, which left the
  whole polling contract unproved (review MF-10).

  *Pure functions:*
  - `nextIntervalMs(0..3) === 2_500`; `nextIntervalMs(4) === 5_000`;
    `nextIntervalMs(5) === 10_000`; `nextIntervalMs(6) === 15_000`;
    `nextIntervalMs(20) === 15_000` (ceiling holds, never exceeds).
  - `toEnvelope` passes an envelope through unchanged; turns a bare array into
    `{events, hasMore:false, total:<length>}`; and **with `afterSeq: 7` on a bare
    array of seq 1..10 returns exactly seq 8, 9, 10** (review MF-3).

  *The hook itself*, using the JSDOM + `createRoot` + `act` pattern already in
  `apps/web/src/tests/row-menu.test.tsx:1-49` (`jsdom` is a devDependency,
  `apps/web/package.json:28-34`), with `fetch` replaced by a queue-backed stub and
  timers driven by `node:test`'s `t.mock.timers` (`setTimeout` + `Date`). No new
  dependency. One assertion per contract clause:
  - **initial drain** — three pages with `hasMore: true, true, false` produce one
    accumulated array in `seq` order, with the second and third requests carrying
    the previous page's `nextAfterSeq`;
  - **live append** — a later non-empty poll appends only the new events and
    requests `afterSeq = <highest held>`;
  - **duplicate suppression** — the same old-shape full array returned twice in a
    row leaves the event count unchanged (review MF-3's named regression);
  - **backoff and reset** — four empty polls stretch the delay to 5 s / 10 s /
    15 s and hold at 15 s; one non-empty poll returns the next delay to 2.5 s;
  - **ceiling** — a stub that never sets `hasMore: false` stops after 40 requests
    with `capped === true`;
  - **hidden tab** — with `document.hidden` forced true no fetch is issued, and
    flipping it back resumes polling without losing the accumulated array;
  - **error retention** — a rejected poll sets `error`, keeps every event already
    held, and schedules the next poll anyway;
  - **terminal stop** — with `terminal: true`, a poll returning `hasMore: false`
    and zero events schedules nothing further (assert the fetch count is frozen
    after advancing the clock a full minute), and `reload()` issues exactly one
    more cycle.
- `npm run build && npm test -w @agentos/web`.

**Rollback.** Delete the module; nothing imports it until WI-7.

**Commit**: `feat(web): incremental event-stream hook with backoff, ceiling and stop condition`

---

## WI-7 — `pages/Sessions.tsx`: the list and the detail page

Covers spec §4.1, §4.2, §4.3, §4.4, §4.5, §6's UI rows, §7. Depends on WI-1
(types), WI-3 (routes), WI-4 (`compactTokens`), WI-5, WI-6.

**Files**

- **New `apps/web/src/pages/Sessions.tsx`** exporting `SessionsPage` and
  `SessionDetailPage`, mirroring how `Tasks.tsx` / `TaskDetail.tsx` export.

  - **`SessionsPage`** — copy the project-scoped polling shape from
    `Tasks.tsx:266-269` (`projectId === "" ? null : \`/sessions?projectId=${encodeURIComponent(projectId)}&limit=50\``)
    and the clickable-table shape from `Agents.tsx:148-164`
    (`<TableRow className="cursor-pointer" onClick={…}>`).
    Columns exactly as spec §4.1: Started, Agent (`AgentChip`), Task (`Link` to
    `/tasks/:id`, or the goal, else `—`), Runner (`Pill`), Duration, Status,
    Result. Header carries a `Refresh` button in the `TaskDetail.tsx:166` shape.
    `EmptyState` on empty; `GapNotice` when `poll.missing`.

    **The row handler must not swallow the nested Task/Goal link** (review MF-5).
    `Link` calls `event.preventDefault()` and navigates, but does **not** stop
    propagation (`router.tsx:42-55`, verified), so a row-level `onClick` fires
    afterwards and the session wins over the task the operator actually clicked.
    The row handler therefore opens with
    `if (event.defaultPrevented) return;` — one line, no change to `Link`, and it
    covers every nested anchor the row may grow later. A JSDOM click test pins it.

    **`Load more` needs a state model, because `usePoll` replaces `data`**
    (review SF-2; `hooks.ts:38-60`). Two pieces of state, deliberately separate:
    - the **live head** — `usePoll<Session[]>` on
      `/sessions?projectId=…&limit=50`, still polling at `POLL_MS` so new
      sessions keep appearing at the top;
    - **older pages** — `useState<Session[]>([])`, appended imperatively by
      `Load more`, which `api.get`s
      `/sessions?projectId=…&limit=50&before=<oldest requestedAt currently held>`
      once per click. These pages are **not** polled; they are history and do not
      change.

    The rendered list is `[...head, ...older]` deduplicated by `session.id`
    (head wins, so a session that moves between the two never renders twice) and
    sorted by `requestedAt` descending. Older pages **reset to `[]` whenever
    `projectId` changes** — otherwise another project's sessions linger below the
    fold. `Load more` hides when the last fetched page returned fewer than 50
    rows. A `Load more` test is added to the checks below, which the first pass
    omitted entirely.
  - **`SessionDetailPage({ sessionId })`** — `usePoll<Session>(\`/sessions/${sessionId}\`, POLL_MS)`
    — **plain `POLL_MS`, terminal or not** (§0.2-C8 as revised, review SF-1;
    `TERMINAL_POLL_MS` no longer exists) — plus
    `useEventStream(session?.runId ?? null, terminal)`, which is the thing that
    actually stops.
    - Header: `BACK_LINK` to `/sessions`, agent title as `h1`, status pill,
      runner `Pill`, `Refresh`. Reuse `DETAIL_HEAD` / `DETAIL_HEAD_H1`
      (`ui.tsx:42-44`).
    - Meta line: `KeyValue columns={3}` with Task, Run (`#<run.runNumber>`),
      Model (`run.model`), Started, Duration, Branch (link per WI-8's helper),
      Workspace (`run.workspacePath`), Termination, and
      `Resume attempts` when `resumeAttempt > 0`.
    - Stat bar: `STAT_PILLS` / `STAT_PILL` (`ui.tsx:68-69`) leading with a
      **lifecycle pill that is always present** — `● Live` (green `DOT` +
      `DOT_TONE.green`, `ui.tsx:55-62`) while `executionStatus ∈ {REQUESTED,
      PROVISIONING, RUNNING, WAITING_INBOX}`, and **on a terminal session the
      same slot reads `Done` (green) for `SUCCEEDED` or `Failed` (red) for
      `FAILED | TIMED_OUT | LOST | CANCELLED`** — spec §4.2's "in place of
      `● Live`", which the first pass dropped (review MF-11). This is the stat
      bar's own state; the header's status pill is a different element and does
      not satisfy it. Then `N messages`, `N tool calls`, `N files`,
      `compactTokens(totalTokens)` tokens (omitted when null), `money(costUsd)`
      (omitted when null). When `capped`, counts get a `+` suffix and a notice
      sits above the stream.
    - Stream: a plain list, oldest first. `text` and `final` items render in
      `MSG_CARD` with `Markdown` and an `MSG_TIME` timestamp
      (`ui.tsx:355-357`); `error` items render `ErrorNotice`; `tool` items render
      the collapsed one-liner and expand to `CODE_BLOCK` Arguments/Result blocks
      truncated at 8 000 characters with a `… truncated, N more characters` line.
      A tool item with a file path shows the **absolute path on its own line
      above Arguments**, selectable and wrapped, not truncated.
    - Auto-scroll only when already within 100 px of the bottom (A3); otherwise a
      `N new ↓` affordance.
    - `Files touched` — collapsible `Card` with a `COUNT` badge, collapsed by
      default, alphabetical, per-path touch counts.
    - `Debug events` — collapsible `Card` with a `COUNT` badge, collapsed by
      default, at the bottom, over **all** events including `PROVIDER_RAW`, with
      a `Segmented` filter `All | Provider | Runner` mapping to
      `source === "RUNNER"` vs not (§0.2-C10). It reuses the already-fetched
      array and issues **no requests of its own** (spec §5.3).
    - `WAITING_INBOX` → a notice above the stream linking
      `/inbox/:waitingOnMessageId` when set; `failureReason` → `ErrorNotice`
      under the header; zero events → `EmptyState` reading `No events yet.`
    - `normalize` runs inside a `useMemo` keyed on the **event count** plus the
      runner, not on array identity (spec §7), so an empty poll does not
      re-normalize.
    - The `EVENT_LOG` / `EVENT_ROW` class constants move here verbatim from
      `TaskDetail.tsx:22-23`. Keep them module-private in `Sessions.tsx` — this
      page becomes their only consumer, and `ui.tsx` is for shapes shared across
      pages. (If a second consumer ever appears, promote them to `ui.tsx` then.)

- `apps/web/src/components/icons.tsx` — add `IconSessions` in the file's existing
  16px thin-line `Svg` style (`icons.tsx:6-11`). The spec allows a `lucide-react`
  glyph, but every sidebar icon in `NAV` is from this local set — only the theme
  toggle uses lucide (`Shell.tsx:2, 64`), so a lucide nav glyph would be the odd
  one out. No new dependency either way.
- `apps/web/src/components/Shell.tsx:21-29` — insert
  `{ to: "/sessions", label: "Sessions", icon: <IconSessions />, match: ["/sessions"] }`
  **between `Tasks` (line 23) and `Goals` (line 24)** (A7).
- `apps/web/src/App.tsx:8-15, 17-30` — import both pages and add
  `{ pattern: "/sessions", render: () => <SessionsPage /> }` and
  `{ pattern: "/sessions/:sessionId", render: (params) => <SessionDetailPage sessionId={params.sessionId ?? ""} /> }`.
  `matchRoute` (`router.tsx:28-40`) compares segment counts first, so the two
  patterns cannot shadow each other and order does not matter. Routing is
  **hash-based** (`router.tsx:6-15`) — internal navigation uses `Link`/`navigate`;
  external links (GitHub) must be plain `<a target="_blank" rel="noreferrer">`.
- `apps/web/src/lib/types.ts:135-150` — extend `Session` with the relation
  includes WI-3 returns: `projectId`, `taskId`, `goalId`, `requestedAt`,
  `terminationReason`, `waitingOnMessageId` (already present), plus optional
  `agent?: {id,title}`, `task?: {id,name} | null`, `goal?: {id,title} | null`,
  `run?: {id,runNumber,model,branch,pullRequestUrl,workspacePath, repo?: {id,name,remoteUrl} | null} | null`
  — the nested `repo` carries the `remoteUrl` the Branch link needs (review
  MF-4), and it is optional-and-nullable because `Run.repo` is a nullable
  relation (`schema.prisma:643`).

**Tests / verification**

- **New `apps/web/src/tests/sessions.test.tsx`**, in two halves — the first pass
  assigned interaction assertions to `renderToStaticMarkup`, which can only ever
  observe the initial markup (review SF-3).

  *Static (`renderToStaticMarkup`, like `primitives.test.tsx`)* — initial markup
  and pure mappings only:
  - export and table-test the status-pill mapping (spec §4.1.1):
    `REQUESTED`/`PROVISIONING` → grey, `RUNNING` → green, `WAITING_INBOX` →
    amber, `SUCCEEDED` → green, `FAILED`/`TIMED_OUT`/`LOST` → red, `CANCELLED`
    → grey — asserting it only uses tones that exist in `PillTone`
    (`ui.tsx:109`);
  - **the stat bar's lifecycle slot** (review MF-11): non-terminal → `● Live`;
    `SUCCEEDED` → `Done`; each of `FAILED`/`TIMED_OUT`/`LOST`/`CANCELLED` →
    `Failed`. Table-driven over the same status list as the pill mapping, so the
    two cannot drift apart;
  - a collapsed tool row is one line carrying the path or command, and its
    Arguments/Result bodies are **absent** from the markup;
  - a 9 000-character result renders truncated with the
    `… truncated, N more characters` line; an absolute path renders verbatim and
    unwrapped-by-ellipsis;
  - the `Files touched` and `Debug events` sections render **collapsed** by
    default (assert the body markup is absent).

  *Interactive (JSDOM + `createRoot` + `act`, the `row-menu.test.tsx:1-49`
  pattern)* — everything that needs an event:
  - **clicking the Task link in a session row navigates to `/tasks/:id`, not to
    the session** (review MF-5): render a row inside a container whose `onClick`
    increments a counter, dispatch a bubbling click on the nested anchor, and
    assert `location.hash` is the task route and the row handler took no effect;
  - clicking a collapsed tool row **reveals** Arguments and Result;
  - the `Debug events` `Segmented` filter switches the visible rows between all
    events, `source === "RUNNER"` only, and the rest (§0.2-C10);
  - with the scroll position away from the bottom, new items **do not**
    auto-scroll and the `N new ↓` affordance appears with the right count;
    clicking it scrolls and clears the count.
- **`Load more` retains page one** (review SF-2): with the head poll stubbed to
  50 rows and `api.get` stubbed to return 50 older rows, clicking `Load more`
  renders 100 rows; a head poll that then returns an overlapping row leaves the
  count at 100, not 101 (the id dedup); changing `projectId` drops back to the
  head page alone.
- Theme check (spec §9 step 10):
  `grep -nE "#[0-9a-fA-F]{3,8}" apps/web/src/pages/Sessions.tsx` returns nothing.
- `npm run build && npm test -w @agentos/web`; `npm run typecheck`.
- Manual: spec §9 steps 1–6 and 11.

**Rollback.** Delete `Sessions.tsx`, the icon, the nav entry and the two route
rows — the app returns to pre-batch behaviour. No localStorage key, no cache, no
stored state (spec §10.1).

**Commit**: `feat(web): /sessions list and session detail — stat bar, message stream, files touched, debug events`

---

## WI-8 — Task detail: readable outputs, live links, Tokens, one raw event table

Covers spec §4.5's move, §4.6.4, §4.7. Depends on WI-4 (`Markdown`, `repoWebUrl`,
`compactTokens`), WI-7 (the link target must exist), WI-1 (the columns).

**Files** — `apps/web/src/pages/TaskDetail.tsx` throughout.

- **Delete `RunEvents` (lines 25-41) and the `EVENT_LOG` / `EVENT_ROW` constants
  (22-23)**, and remove `<RunEvents runId={run.id} />` from the expanded row
  (line 76). This is the batch's only breaking API consumer and it must leave in
  the same commit that stops needing the old shape. Drop the now-unused
  `SessionEvent` type import (line 7) and, if nothing else uses them, `compact`
  (line 4). **Result: exactly one raw event table in the product** (A1).
- In its place, in the expanded row's `KeyValue` (lines 64-74), add
  `{ k: "Session", v: run.session ? <Link to={\`/sessions/${run.session.id}\`}>Open session ↗</Link> : "—" }`.
  A run whose session row is absent shows `—` (spec §6).
- **Tokens column** (spec §4.6.4): add `<TableHead>Tokens</TableHead>` between
  `Cost` and `Failure class` (line 221) and the matching cell after line 57:
  `<TableCell>{compactTokens(run.session?.totalTokens ?? null)}</TableCell>`.
  **Bump `colSpan={9}` to `colSpan={10}` at line 62** — easy to miss, and it
  silently misaligns the expanded row if forgotten.
- **Task-level tokens pill** (spec §4.6.4): after the spend pill at line 175, add
  `<span className={STAT_PILL}>{compactTokens(totalTokens)} tokens</span>` where
  `totalTokens` sums `run.session?.totalTokens` across runs, computed next to the
  existing `totalCost` at line 146 and rendered as `—` (not `0`) when every run
  is null.
- **Step output as markdown** (spec §4.7.1): replace `<ShowMore text={output.data.body} lines={10} />`
  at line 210 with the rendered `Markdown` inside a clamped container —
  `max-h-[420px] overflow-hidden` plus a `Show more` / `Show less` toggle in the
  same control shape as `ShowMore` (`ui.tsx:374-382`: chevron + muted text
  button). The kind pill (line 209) and the `Updated {timeAgo(...)}` line (211)
  are unchanged.
  **An empty or whitespace-only body renders `EmptyState`, not an empty clamp**
  (spec §6, review MF-9): branch on `output.data.body.trim().length === 0`,
  exactly as the Prompt card immediately above already does
  (`TaskDetail.tsx:202-206`) — copy that shape rather than inventing one, and
  keep the card, the kind pill and the `Updated` line visible so the operator can
  still see that a step reported. Copy text: `No output recorded.`
- **Branch and PR as links** (spec §4.7.2): in the task `Details` `KeyValue`
  (lines 182-199) add
  - `Branch` — the newest run's `branch` (`task.runs[0]`, already ordered
    `runNumber desc` by `app.ts:1276`), anchored to
    `${repoWebUrl(task.repo?.remoteUrl)}/tree/${branch}` when `repoWebUrl` is
    non-null, else plain text;
  - `Pull request` — the newest run's `pullRequestUrl`, anchored, labelled
    `#<number>` parsed from the URL tail with the full URL as fallback.

  The run row's `Branch` cell (line 51) becomes the same link. The expanded row's
  `Push` entry (line 70) keeps its status word and **drops the duplicated
  anchor**. All external anchors use `target="_blank" rel="noreferrer"`.

**Tests / verification**

- Extend `apps/web/src/tests/sessions.test.tsx` (or add
  `apps/web/src/tests/task-detail.test.tsx`) with `renderToStaticMarkup` checks
  on the extracted pure pieces: the branch-link builder produces
  `https://github.com/o/r/tree/feat/x` for an https remote, an ssh remote and
  plain text for a GitLab remote; the PR label parses `#39` from
  `https://github.com/o/r/pull/39`.
- **Step output states** (review MF-9): a body of `"   \n\t\n"` renders the
  `EmptyState` copy and **no** `Markdown` body; a non-empty body renders the
  markdown and no empty state. Both asserted on static markup.
- Static guards, run as part of the WI:
  - `grep -rn "RunEvents\|EVENT_ROW\|EVENT_LOG" apps/web/src/pages/TaskDetail.tsx`
    → empty.
  - `grep -rn "runs/.*events" apps packages` → only the API route definitions and
    the runner's POST (`packages/runner/src/api.ts:138`).
  - The runs table's `<TableHead>` count equals every `RunRow`'s `<TableCell>`
    count, and equals the expanded row's `colSpan`.
- `npm run build && npm test` (full workspace suite), `npm run typecheck`.
- Manual: spec §9 steps 6, 7, 8.

**Rollback.** Pure revert of one file. Note the deploy-order rule from WI-3: this
file is the reason the web app must not be reverted alone while the new API
stays.

**Commit**: `feat(web): task detail — markdown outputs, branch/PR links, Tokens column, raw events move to the session page`

---

## 9. Requirement → work-item traceability

| spec § | requirement | WI |
|---|---|---|
| §4.1 | `/sessions` list, columns, ordering, Refresh, empty, GapNotice | WI-7 |
| §4.1.1 | status pill mapping, no new tone vocabulary | WI-7 |
| §4.1.2 | `?limit=50`, `&before=`, `Load more` | WI-3 (API), WI-7 (UI) |
| §4.2 | detail header, meta line, stat bar, finished-session shape | WI-7 |
| §4.2 | counting rules (messages / tool calls / files) | WI-5 (definitions + tests), WI-7 (display) |
| §4.3 | stream item mapping for all three runners; noise exclusion | WI-5 |
| §4.3.1 | tool rendering, running/error markers, 8 000-char truncation | WI-5 (state + data), WI-7 (rendering) |
| §4.3.2 | absolute path as its own line in the expanded view | WI-7 |
| §4.3.3 | conditional auto-scroll + `N new ↓` | WI-7 |
| §4.4 | `Files touched`, extraction rules, verification duty, fallback | WI-5 (extraction), WI-7 (section) |
| §4.5 | `Debug events` collapsed, source filter, table moves off the task page | WI-7 (new home), WI-8 (deletion + `Open session ↗`) |
| §4.6.1 | shape-driven usage extraction at ingest, accumulation | WI-2 |
| §4.6.2 | four nullable `Int` columns | WI-1 |
| §4.6.3 | idempotent backfill script + npm scripts | WI-2 |
| §4.6.4 | `compactTokens`, Tokens column, task-level tokens pill | WI-4 (formatter), WI-8 (UI) |
| §4.6.5 | honest fallback: `—`, never `0`, never an estimate | WI-2 (null semantics), WI-7/WI-8 (display) |
| §4.7.1 | step output as markdown with a clamp | WI-8 |
| §4.7.2 | branch and PR as links, `repoWebUrl` helper | WI-4 (helper), WI-8 (UI) |
| §4.8 | markdown fenced code + safe links | WI-4 |
| §5.1 | two new routes + the events envelope | WI-3 |
| §5.2 | pure usage module, no cost in the common ingest path | WI-2 |
| §5.3 | polling contract: 2.5 s, backoff to 15 s, ceilings, stop, hidden-tab | WI-6 |
| §5.4 | `session-stream.ts`, `use-event-stream.ts`, `Sessions.tsx`, types | WI-5, WI-6, WI-7, WI-1 |
| §5.5 | no new dependency; `usePoll`/`POLL_MS` untouched; no runner change | WI-6 (hook sits beside), all (dependency check in §10) |
| §6 | every edge-case row | WI-5 (payload robustness), WI-6 (shape tolerance, poll failure), WI-7 (UI states) |
| §7 | `useMemo` on count, no virtualization, no layout shift, themes | WI-7 |
| §8 | every named test | WI-2, WI-4, WI-5, WI-6, WI-7, WI-8 |
| §9 | reviewer walkthrough | §10 below |
| §10 | rollback | per-WI **Rollback** paragraphs |

---

## 10. Sequencing, gates and PR mechanics

**Dependency order.** WI-1 → WI-2 → WI-3 → {WI-4, WI-5} → WI-6 → WI-7 → WI-8.
WI-4 and WI-5 have no dependency on WI-1..3 and may be done at any point; they
are placed after the backend so the branch history reads backend → frontend.
WI-6 needs WI-3's envelope to develop against. WI-8 must be last: it deletes the
only consumer of the old event shape and links to a page that must already exist.

**One branch, one PR, one migration.** Eight commits with the messages above.

**Gate before the PR** (this is the acceptance bar, spec §8):

```bash
npm run build          # must precede npm test — styles.test.tsx reads dist/assets/*.css
npm test               # full workspace suite
npm run typecheck
npm run db:validate
DATABASE_URL=<migrated> npm run db:drift-check
```

Plus the dependency guard the spec makes absolute (§5.5, decisions §3): **no new
npm dependency this batch.** Verify with `git diff --stat package-lock.json
apps/web/package.json packages/*/package.json` — only the two `db:backfill-session-usage`
script lines may appear.

**Then the human walkthrough**, spec §9 steps 1–11, against a live control plane
with one finished and one running agent task. Step 9 (`npm run db:backfill-session-usage`
twice; second run reports zero updates) is the only step that writes.

**Deploy order.** API first (migration applied, API restarted), then the web
bundle. Web-first is also safe because the new client tolerates the old array
shape — the forbidden direction is old-web + new-API. The runner is not touched
and is not restarted by this batch.

---

## 11. Where this plan is guessing

Ranked by what a wrong guess costs.

- **G1 — CODEX `command_execution` and `file_change` payload shapes.** The only
  mappings in WI-5 with no captured evidence; the sandbox killed the shell call
  in `codex-tool-event.stdout` before either appeared. Mitigated by spec §4.4's
  verification duty and honest fallback, restated in WI-5. If both fall through,
  `Files touched` and CODEX tool rendering degrade to the hint + ledger note, and
  that is a conscious outcome, not a PR-gate surprise.
- **G2 — PI file-path argument keys.** The `args` container is verified
  (`pi-tool-event.stdout`), the keys (`file_path` / `path` / `filePath`) are not —
  the captured call is `bash` with `args.command`. Same fallback as G1.
- **G3 — CLAUDE `input.file_path` for Read/Edit.** The capture only exercises
  Bash (`input.command`, verified). `file_path` is the documented Claude Code
  tool-input key and is very likely right, but it is not proven by anything in
  this repo. First real CLAUDE session confirms or refutes it in seconds.
- **G4 — `reasoning_output_tokens` is excluded from `outputTokens`.** The real
  CODEX payload carries it; the spec does not mention it. Excluding it
  under-reports CODEX output tokens against the provider's own billing. One-line
  change in `extractUsage` if Leo wants it included.
- **G5 — `totalTokens = input + output` reads small for CLAUDE.** Against the
  real capture that is `4 + 77 = 81` for a run that actually processed ~8.8K
  tokens, because CLAUDE reports almost everything as cache read/creation. The
  spec pins this definition (§4.6.2) and this plan follows it; `cachedInputTokens`
  is stored separately, so switching the display to include cache is a UI change
  with no migration. Flagged because the original's reference frame shows
  "8.9K tokens" and the spec's arithmetic will not reproduce numbers of that
  magnitude for CLAUDE.
- **G6 — 20 000-event and 15 s ceilings** (A9). No reference behaviour to copy.
  Both are single exported constants in WI-6, trivially retuned.
- **G7 — `total` costs one `count()` per poll.** Cheap with WI-1's
  `[runId, seq]` index and a single operator, unmeasured at 179k rows. If it ever
  matters, return `total` only on the initial page.
- ~~**G8 — `useEventStream`'s full behaviour is verified by hand, not by
  test.**~~ **Retired in revision 1** (review MF-10). The jsdom + fake-timer hook
  test is now required and enumerates every state transition; see WI-6. Spec §9
  step 5's DevTools observation remains as a second, human check rather than as
  the only one.

---

## 12. Open questions carried forward (recorded, not blocking)

1. **A1 — does the run row keep its own copy of the raw event table?** This plan
   implements the spec's reading: the table *moves*, and the run row gains
   `Open session ↗`. Cheapest to settle before WI-8; reversing it is a small
   addition to WI-7/WI-8, not a redesign.
2. **PI usage is real and this batch does not take it** (§0.2-C6). Recorded so
   the ledger note has evidence attached rather than "not verified".
3. **Does any out-of-repo consumer call `GET /runs/:runId/events`?** In-repo grep
   says no (WI-3). If Leo has a personal script, the envelope breaks it; the fix
   would be a `?v=1` bare-array flag, not worth building speculatively.
4. **G5's token arithmetic** — worth one line from Leo before the PR, since it
   decides whether the Tokens column reads `81` or `8.9K` for CLAUDE runs.
5. **The spec contradicts itself on whether an orphan tool call counts**
   (new in revision 1, from review MF-7). Spec §4.2 defines tool calls as
   "distinct `toolCallId` values that have a `TOOL_STARTED`"; spec §6's
   edge-case table says a `TOOL_COMPLETED` with no matching `TOOL_STARTED`
   "counts as a tool call". Both cannot hold. **This plan is not re-specifying
   it** — it implements §6 (the more specific statement, and the only reading
   under which the stat bar cannot disagree with the stream) and records the
   conflict here. If Leo prefers §4.2's letter, WI-5 subtracts orphans from the
   count and flips one test expectation. The spec text should be repaired either
   way, in the spec, not here.

None of these blocks implementation. Per the chain's standing rules they are
recorded here and in the task activity log rather than sent to the Inbox.
