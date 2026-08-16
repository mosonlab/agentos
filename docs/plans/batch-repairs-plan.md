# PLAN — Platform Repairs Batch: workspace retention, retry re-derivation, agent archive

Spec: `docs/specs/batch-repairs.md` @ `b16d9bf` (approved; unchanged by this plan).
Backlog: `docs/BACKLOG-V2.md` §平台修缮 lines 61 / 62 / 64.
Decisions incorporated: A1–A6 as ruled, plus two additions — **A2+**: collapse the
duplicate `runnerFor` (`packages/api/src/execution.ts:20-28`) / `chooseRunner`
(`packages/db/src/workflow.ts:22-30`) into one implementation; **A6+**: a claim-loop
skip caused by `agent.archivedAt != null` must write a task activity, with a test.

All line numbers below were re-verified against the working tree at `b16d9bf`.
Three spec citations drifted slightly and are corrected here: the retry frozen-field
copy is at `app.ts:1027-1031` (spec said 1023-1025), the GC delete decision is at
`reconcile.ts:147-150` (spec said 147-151), and the `onError` map spans
`app.ts:1732-1740` with the P2025/P2002 branches at `:1735-1736`.

## Approach summary

Seven steps, one commit each (six code commits; step 7 is verification only).
Order: Item 1 first (standalone, no dependencies), then the A2+ convergence
refactor as its own no-behavior-change commit, then retry re-derivation on top of
it, then Item 3 in three commits (migration → API+guards → UI). The single
migration is `Agent.archivedAt DateTime?`. The shared derivation logic lands in
`packages/db` because the dependency arrow only points api→db: `@agentos/api`
imports `@agentos/db`, never the reverse, so a helper in `packages/api` would be
unreachable from `enqueueTaskRun`.

Test reality (constraint 4 of the plan brief): `packages/api` tests are
`node --test` with object-literal mocks cast to `PrismaClient`
(`packages/api/src/app.test.ts:126-147` is the pattern). They can verify handler
logic, error mapping, and query/data shapes, but **not** real-database behavior:
FK enforcement, the actual P2003 error, migration SQL, or lock behavior. The plan
therefore splits verification into (a) mock-level tests per step and (b) a
dev-stack pass in step 7 that exercises the real Postgres via docker-compose —
the only place migration SQL and the true FK 409 are proven. `reconcileWorkspaces`
is an exception that tests well without a database: it takes a workspace root
path, so tests use a real `mkdtemp` directory plus a mock `db`.

---

## Step 1 — Item 1: workspace GC keeps suspended and resume-pending runs

**Files:** `packages/api/src/reconcile.ts`; new `packages/api/src/reconcile.test.ts`.
**Commit:** `fix(api): workspace GC keeps WAITING_INBOX and resume-pending QUEUED workspaces`

Changes in `reconcileWorkspaces` (`reconcile.ts:120-163`) only; `activeStatuses`
at `reconcile.ts:15` is **left untouched** so the orphan query at
`reconcile.ts:18-22` (`reconcileDatabaseRuns`) never starts matching
WAITING_INBOX runs — the two status lists stay separate, per the spec's second
scenario.

1. Add a local keep-list inside `reconcileWorkspaces`:
   `const workspaceKeepStatuses = [CLAIMED, PROVISIONING, RUNNING, WAITING_INBOX, QUEUED]`.
   Use it in the keep decision at `reconcile.ts:148` in place of `activeStatuses`.
   Note: the `byPath` map (`reconcile.ts:137`) only contains runs with a
   non-null `workspacePath`, so "QUEUED with a workspacePath" (the answered-but-
   not-reclaimed window, `workflow.ts:253-256`) is exactly what matching QUEUED
   here means — a freshly created QUEUED run has no `workspacePath` and no
   directory, so nothing widens.
2. Scope the failed-retention quota to terminal runs: in the `retained` pool at
   `reconcile.ts:138-141`, add `run.endedAt != null` to the filter before the
   sort and `slice(0, failedRetentionCount)`. A WAITING_INBOX run
   (`endedAt = null`) no longer competes for — or is evicted by — the quota.

**Tests** (new `reconcile.test.ts`, `node:test`; real temp dir via
`fs.mkdtemp`, mock `db` with `run.findMany`/`run.update`/`session.updateMany`):

- WAITING_INBOX run + three `workspaceRetained` failed runs, quota 2 → the
  waiting run's directory survives, the oldest failed directory is removed
  (spec Item 1 AC 1; also proves the quota still evicts).
- QUEUED run with `workspacePath` set → survives a pass (AC 3).
- Run in SUCCEEDED/FAILED past quota → removed; `workspaceRetained` reset and
  session cleanup marked, as today (AC 4).
- Directory with no matching run row → still removed (edge case preserved).
- `reconcileDatabaseRuns` query shape: capture the `where.status.in` list from
  the mock and assert it is exactly `[CLAIMED, PROVISIONING, RUNNING]` (AC 5's
  no-regression guard); the existing heartbeat test at `app.test.ts:165-193`
  continues to pass.
- AC 2 (restart path) needs no separate test: `reconcileAtStartup`
  (`reconcile.ts:165-172`, called from `packages/api/src/index.ts:15`) invokes
  the same two functions with the same arguments; the two tests above cover it.

**Verify:** `npm run test -w @agentos/api && npm run typecheck`.

## Step 2 — A2+ convergence: one runner-choice + one run-config derivation

**Files:** `packages/db/src/workflow.ts`, `packages/api/src/execution.ts`.
**Commit:** `refactor(db): single runnerFor and shared run-config derivation`
No behavior change; this commit exists so step 3's diff is purely the retry fix.

1. In `packages/db/src/workflow.ts`: rename the private `chooseRunner`
   (`workflow.ts:22-30`) to an **exported** `runnerFor` (same body — it is
   byte-identical to the api copy). This is the surviving implementation.
   It reaches consumers through the existing `export * from "./workflow.js"` in
   `packages/db/src/index.ts:14`.
2. Same file: extract `deriveRunConfig(agent, templateStep, task)` returning
   `{ runner, model, promptHash }`, implemented exactly as `enqueueTaskRun`
   derives them today (`workflow.ts:47` runner with template-step override,
   `:62` model, `:65-70` promptHash over
   `[foundationalPrompt, rolePrompt, task.name, task.description]`). Export it;
   rewrite `enqueueTaskRun` to call it.
3. In `packages/api/src/execution.ts`: delete the local `runnerFor`
   (`execution.ts:20-28`) and replace it with
   `export { runnerFor } from "@agentos/db";` so the existing import sites
   (`app.ts:940` via `./execution.js`) compile unchanged. `hashPrompt`
   (`execution.ts:35-36`) stays — the task-creation endpoint at `app.ts:940-952`
   is deliberately left as-is (touching it is outside this batch; noted in
   Ambiguity 3).

**Verify:** `npm run typecheck && npm run test` (all workspaces) — identical
behavior, existing `workflow.test.ts` chain-branch and gate tests must pass
unmodified.

## Step 3 — Item 2: operator retry re-derives from the current agent row

**Files:** `packages/api/src/app.ts` (retry endpoint `1003-1042`),
`packages/api/src/app.test.ts`.
**Commit:** `fix(api): operator retry re-derives runner, model, promptHash from current agent config`

1. Widen the task load at `app.ts:1006-1009` to
   `include: { assigneeAgent: true, templateStep: true, runs: {...} }`.
2. After the existing guards (`no run to retry`, `active run`, budget guard at
   `app.ts:1017` — all unchanged): if `task.assigneeAgent` is null → 409
   `{ error: "Task assignee no longer exists; assign an agent before retrying" }`;
   if `task.assigneeAgent.archivedAt != null` → 409 naming the agent (guard
   lands here, activates once step 4's column exists — until then the field is
   absent from the schema, so this step's code references it only after step 4;
   in practice steps 3–5 land on one branch and CI runs on the final state; the
   step-3 commit itself compiles because it is committed after the schema change
   if rebased, otherwise the archived check moves into step 5's commit — see
   Ambiguity 8 for the chosen order: **archived check is added in step 5**, this
   step only adds the null-agent 409).
3. Replace the frozen copies at `app.ts:1027-1031`:
   `const derived = deriveRunConfig(task.assigneeAgent, task.templateStep, task)`
   → `runner: derived.runner`, `model: derived.model`,
   `promptHash: derived.promptHash`, and `agentId: task.assigneeAgent.id`
   (current assignee, not `last.agentId` — Ambiguity 2).
   Unchanged: `branch: last.branch`, `targetBranch: last.targetBranch`,
   `goalId`, `repoId`, `maxDurationMin`, `stallTimeoutMin`,
   `maxRunsPerTask: last.maxRunsPerTask` (line 1034, keeps the +1 external
   ceiling raise), and the budget guard.

**Tests** (mock-Prisma style, in `app.test.ts`):

- Failed run with agent row now carrying a different `model`/`runnerPreference`
  → created run's `runner`/`model`/`promptHash` reflect the current agent
  (spec Item 2 AC 1; replays the line-64 incident with
  `runnerPreference: PI`).
- Agent unchanged → created run data deep-equals what the old code produced
  (AC 2).
- `task.templateStep.runner = CODEX` with agent preferring PI → `runner: CODEX`
  (AC 3).
- `task.assigneeAgent: null` → 409, no throw (AC 5, deleted-agent half; the
  archived half is tested in step 5).
- AC 4 (budget guard, `maxRunsPerTask` carry-forward, `branch` continuation):
  assert those fields in the same captured create; existing external-failure
  test (`app.test.ts:122-163`) keeps passing.

**Verify:** `npm run test -w @agentos/api && npm run typecheck`.

## Step 4 — Item 3 migration: `Agent.archivedAt`

**Files:** `packages/db/prisma/schema.prisma` (Agent model, lines 200-233); new
`packages/db/prisma/migrations/<timestamp>_agent_archived_at/migration.sql`.
**Commit:** `feat(db): nullable Agent.archivedAt for soft-offline`

1. Add `archivedAt DateTime?` to the Agent model (after `updatedAt`,
   `schema.prisma:211`).
2. Generate the migration — exact command, from the repo root, with the
   docker-compose Postgres running (`docker compose up -d postgres` if not):

   ```
   npm run db:migrate -w @agentos/db -- --name agent_archived_at
   ```

   which expands (per `packages/db/package.json:18`) to
   `dotenv -e ../../.env -- prisma migrate dev --name agent_archived_at`.
   No `--shadow-database-url` is needed: `prisma migrate dev` auto-creates its
   shadow database, and the compose credentials (`POSTGRES_USER=agentos`,
   `.env.example:2-5`) are the container's superuser, which holds CREATEDB.
   Fallback only if running against a non-superuser database:
   `createdb -h localhost -U agentos agentos_shadow` then
   `dotenv -e ../../.env -- prisma migrate dev --name agent_archived_at --shadow-database-url "postgresql://agentos:agentos@localhost:5432/agentos_shadow?schema=public"`.
3. Expected generated SQL — verify the file contains exactly this (plus Prisma's
   comment header) and nothing else:
   `ALTER TABLE "Agent" ADD COLUMN "archivedAt" TIMESTAMP(3);`
   No backfill, no index (A4, current scale). Rollback per spec:
   `ALTER TABLE "Agent" DROP COLUMN "archivedAt";`
4. `npm run db:generate` to refresh the client.

**Verify:** migration applies cleanly on the dev stack; `npm run db:validate`;
`SELECT "archivedAt" FROM "Agent" LIMIT 1` returns nulls for existing rows
(spec Item 3 AC 1). This is real-database verification — no mock claims it.

## Step 5 — Item 3 API: archive/unarchive endpoints, dispatch guards, FK-delete 409

**Files:** `packages/api/src/app.ts`, `packages/api/src/templates.ts`,
`packages/db/src/workflow.ts`, tests in `packages/api/src/app.test.ts`,
`packages/api/src/templates.test.ts`, `packages/api/src/workflow.test.ts`.
**Commit:** `feat(api): agent archive/unarchive, dispatch guards, FK delete maps to 409`

Endpoints (next to the existing agent routes, after `app.ts:481`):

- `POST /agents/:agentId/archive`: load the agent (404 if missing); if
  `archivedAt` already set, return the row unchanged (idempotent — do **not**
  refresh the timestamp, Ambiguity 5); else `update({ archivedAt: now })`. 200
  with the row.
- `POST /agents/:agentId/unarchive`: symmetric, sets `archivedAt: null`,
  idempotent 200.
- `archivedAt` stays out of `agentPatch` (`app.ts:65-70` field set untouched —
  A5).
- `DELETE /agents/:agentId` (`app.ts:482-485`): wrap the delete in try/catch;
  on `Prisma.PrismaClientKnownRequestError` with `code === "P2003"` return 409
  `{ error: "Agent has task history; archive it instead" }`. The global
  `onError` map (`app.ts:1732-1740`) is left unchanged (Ambiguity 4). No-history
  agent still deletes → 204.

Dispatch guards (each names the agent or step, per spec Item 3 AC 2):

- `POST /projects/:projectId/tasks` — at the assignee check (`app.ts:922-926`):
  `if (agent?.archivedAt) return 400 { error: "Assignee <name> is archived" }`.
- `PATCH /tasks/:taskId` — at the assignee-change check (`app.ts:979-982`): same
  400.
- Operator retry (`app.ts:1003`, structure from step 3): archived assignee →
  409 `{ error: "Assignee <name> is archived; unarchive it to retry" }`.
- Template instantiation (`packages/api/src/templates.ts:38`): beside the
  existing `has no agent` guard, `if (step.assigneeAgent?.archivedAt) throw new
  Error(\`Template step ${step.name} agent ${step.assigneeAgent.name} is archived\`)`
  — the route's existing error→400 mapping (`app.ts:900-905` regex) already
  matches "has no"; extend the thrown message or the regex so this surfaces as
  400, and assert that in the test.
- `enqueueTaskRun` (`packages/db/src/workflow.ts:42-44`): add
  `assigneeAgent.archivedAt` to the guard → throw
  `` `Task ${task.id} assignee ${task.assigneeAgent.name} is archived` `` —
  covers chain advancement and gate-reject requeue through existing callers.
- Runner claim loop (`app.ts:1221-1225`): after the repo-access `continue` at
  `:1223`, add:
  ```
  if (candidate.agent.archivedAt) { <task activity, deduped>; continue; }
  ```
  The A6+ hard requirement: write a `taskActivity`
  (`actorType: "control-plane"`, body
  `Assignee <name> archived; run skipped`) so the QUEUED-but-never-claimed run
  is visible from the task. Dedupe because the claim poll fires every ~5s
  (`RUNNER_POLL_INTERVAL_MS=5000`): before inserting, read the task's most
  recent activity (`orderBy createdAt desc, take 1`) and skip the insert if its
  body is identical (Ambiguity 1). `candidate.agent` is already included in the
  claim query (`app.ts:1211-1217`), so no query change is needed for the flag
  itself.

Read surfaces stay unchanged: `GET /projects/:projectId/agents` (`app.ts:446`)
and `GET /agents/:agentId` (`app.ts:459`) now simply carry the new column
(spec Item 3 AC 3).

**Tests** (mock-Prisma; what each proves and does not prove):

- Archive then archive again → both 200, second call performs no update
  (capture: `update` called once). Unarchive of active agent → 200 no-op.
- Delete where the mock's `agent.delete` throws a constructed
  `Prisma.PrismaClientKnownRequestError("...", { code: "P2003", clientVersion: "6.19.0" })`
  → 409 with the "archive it instead" body. *Proves the mapping only*; that
  Postgres actually raises P2003 on an agent with runs is proven in step 7 on
  the real stack (spec AC 5).
- Task create / task patch with archived assignee → 400 naming the agent.
- Retry with archived assignee → 409 (completes step 3's AC 5).
- Template instantiation with an archived step agent → 400 naming the step
  (`templates.test.ts`).
- `enqueueTaskRun` with archived agent → throws the descriptive error
  (`workflow.test.ts` style, mock tx).
- Claim loop: candidates `[archived-agent run, active-agent run]` → the active
  one is claimed, the archived one skipped, and exactly one taskActivity with
  the "archived; run skipped" body is created; a second claim pass with the
  activity already latest creates none (A6+ acceptance test).

**Verify:** `npm run test -w @agentos/api && npm run typecheck`.

## Step 6 — Item 3 UI: archive action, badge, picker filter

**Files:** `apps/web/src/lib/types.ts`, `apps/web/src/pages/Agents.tsx`,
`apps/web/src/pages/Tasks.tsx`.
**Commit:** `feat(web): agent archive action, Archived badge, picker excludes archived`

1. `types.ts:37` Agent type: add `archivedAt: string | null;`.
2. `Agents.tsx`: the RowMenu at line 145 gains
   `{ label: agent.archivedAt ? "Unarchive" : "Archive", onSelect: ... }` next
   to Delete, POSTing `/agents/:id/archive` / `/unarchive` then `reload()`
   (same `useAction().run` pattern as `remove`, lines 109-112). The name cell
   (line 141) renders `<Pill tone="grey">Archived</Pill>` when
   `agent.archivedAt != null`. No new page, no filter UI (spec).
3. `Tasks.tsx`: in `NewTask`, filter the picker options at line 160 to
   `agents.filter((a) => !a.archivedAt)`, and use the same filtered list for
   the form default at line 97 so an archived agent can't be the silent default.
   Task/history views untouched (they read task includes).

**Verify:** `npm run typecheck && npm run build -w @agentos/web`; visual check in
step 7 (spec Item 3 AC 6).

## Step 7 — batch verification (no commit)

1. `npm run typecheck && npm run test` — all workspaces green.
2. Dev-stack incident replay (spec §How a reviewer verifies), with the compose
   stack, API, one runner, and web up:
   - **Scenario 1 (Item 1):** create a task whose agent calls `inbox_ask`; once
     the run is WAITING_INBOX, run an unrelated task to completion (triggers
     `reconcileWorkspaces`, `app.ts:1719-1723`); confirm
     `$RUNNER_WORKSPACE_ROOT/<runId>` still exists; answer via web inbox;
     confirm the resume claims the surviving workspace and finishes. Restart
     the API mid-wait and re-check (AC 2).
   - **Scenario 2 (Item 2):** fail a task; PATCH the agent to a different
     `model`/`runnerPreference`; POST `/tasks/:taskId/retry`; confirm the new
     run row and the runner log show the new adapter.
   - **Scenario 3 (Item 3):** archive an agent with history → gone from the
     new-task picker, its QUEUED run is skipped **and the task activity shows
     "archived; run skipped"**, history pages still render, DELETE → 409 with
     guidance, unarchive → the queued run is claimed on the next poll and the
     picker shows the agent again.
3. Migration SQL reviewed in the PR diff equals the single ALTER TABLE above.

## Acceptance-criteria coverage map

| Spec AC | Covered by |
|---|---|
| Item 1 AC 1–5 | Step 1 (tests + untouched `activeStatuses`); AC 2 via shared `reconcileAtStartup` path; scenario 1 |
| Item 2 AC 1–4 | Step 3 tests; scenario 2 |
| Item 2 AC 5 | Step 3 (deleted agent) + step 5 (archived agent) |
| Item 3 AC 1 | Step 4; real-DB check |
| Item 3 AC 2 | Step 5 guards + tests (incl. A6+ activity test) |
| Item 3 AC 3 | Step 5 (read endpoints untouched) + scenario 3 |
| Item 3 AC 4 | Scenario 3 unarchive leg + claim-loop test |
| Item 3 AC 5 | Step 5 P2003 test (mapping) + scenario 3 (real FK) |
| Item 3 AC 6 | Step 6 + scenario 3 |

## Ambiguities — defaults chosen, cost to overturn

The spec leaves these open; each has a default the implementation will follow.
None are decided silently — overturn any of them at the plan gate and only the
named step changes.

1. **Claim-skip activity dedupe cadence.** The claim poll runs every ~5s; a
   naive insert writes an activity row per poll per skipped run. Default:
   insert only if the task's most recent activity body differs (one extra
   indexed read per skipped candidate per poll, `@@index([taskId, createdAt])`
   exists at `schema.prisma:526`). Overturn to "write every time": simpler code,
   but hundreds of identical rows per hour per skipped run — the activity log
   becomes unreadable, which defeats A6+'s purpose. Overturn to "write exactly
   once ever" needs persisted state (a column or dedupe key) → a second
   migration, over the batch cap.
2. **Retry uses the task's *current* assignee agent, including `agentId` on the
   new run** (not `last.agentId`). Rationale: the spec's mechanism is "load the
   agent" and its deleted-agent 409 only makes sense against the task's current
   assignee; deriving model from one agent while stamping another's id would be
   incoherent. Consequence: if the operator reassigned the task between failure
   and retry, the retry runs as the new assignee (repo-access is enforced at
   claim time, `app.ts:1223`, so a missing grant skips rather than crashes).
   Overturn (keep `last.agentId`): retry ignores reassignment — preserves a
   behavior nobody relies on and re-opens a cousin of the line-64 incident.
3. **Convergence home and shape (A2+).** Default: the surviving `runnerFor`
   lives in `packages/db/src/workflow.ts` (exported through `@agentos/db`), and
   `packages/api/src/execution.ts` re-exports it so call sites don't move;
   retry shares `deriveRunConfig` with `enqueueTaskRun`. The direction is
   forced by the dependency arrow (api→db); the only real choice is "re-export
   from execution.ts" vs "rewrite the two api import sites" — re-export keeps
   the diff minimal. The task-creation endpoint (`app.ts:940-952`) is *not*
   migrated onto `deriveRunConfig` in this batch (it takes body-level fields,
   not task-row fields); cost of also converging it: a slightly larger step-2
   diff now, one less near-duplicate later. Declared, not hidden.
4. **P2003 mapping location.** Default: local try/catch in the DELETE handler,
   because the contract message ("Agent has task history; archive it instead")
   is agent-specific and a global map can only say something generic. Overturn
   (global `onError` entry at `app.ts:1735-1736`): every future FK 500 becomes
   a 409 for free, but with a generic body — acceptable, loses the guidance
   text on this endpoint unless both are done.
5. **Double-archive keeps the original timestamp.** "Idempotent no-op 200"
   (spec) is read literally: re-archiving must not refresh `archivedAt`,
   otherwise the UI's "archived since" lies. Overturn (always `update`): one
   line simpler, timestamp drifts on repeat clicks.
6. **Item 1 keep-set is status-based: *any* run in the five keep statuses whose
   `workspacePath` is set survives**, not only post-inbox QUEUED runs. In
   practice these sets are identical today (a never-claimed QUEUED run has no
   `workspacePath`), and status-based is the smallest correct predicate.
   Overturn (track "resume-pending" explicitly): needs a new column → second
   migration, over the cap.
7. **No `--shadow-database-url`.** The compose Postgres user is the container
   superuser, so `prisma migrate dev` self-manages its shadow DB; the exact
   command in step 4 carries no extra flags. The fallback command for a
   restricted user is written out in step 4 — if review wants it as the
   default, only the step-4 command line changes.
8. **The archived-assignee 409 in the retry endpoint is committed in step 5,
   not step 3**, so every commit compiles in isolation (step 3 predates the
   `archivedAt` column). Overturn (reorder migration first): also fine; the
   chosen order keeps Item 2 revertable without touching Item 3's commits, per
   the spec's rollback note.
