# PLAN — Platform Repairs Batch: workspace retention, retry re-derivation, agent archive

Spec: `docs/specs/batch-repairs.md` @ `b16d9bf` (approved; unchanged by this plan).
Backlog: `docs/BACKLOG-V2.md` §平台修缮 lines 61 / 62 / 64.

Revision 2 — this file answers the plan review's 2 must-fix and 4 should-fix
findings; see **Revision record** at the end for the item-by-item disposition.

Decisions incorporated: A1–A6 as ruled, plus two additions —

- **A2+**: collapse the duplicate `runnerFor` (`packages/api/src/execution.ts:20-28`) /
  `chooseRunner` (`packages/db/src/workflow.ts:22-30`) into one implementation.
- **A6+**: a QUEUED run that cannot proceed because `agent.archivedAt != null`
  must be visible as a task activity, with acceptance tests. Revision 2 changes
  **how** this is implemented (an independent audit sweep with a per-run atomic
  idempotency key) but not the requirement — see Step 6.

Every `file:line` reference below was re-read against the working tree at
`50348a3` while writing revision 2; the ones the review found drifting
(`schema.prisma` `updatedAt`, `Agents.tsx` name cell) are corrected, and several
more that the review did not name were corrected in the same pass (the task
PATCH assignee check, the `agentPatch` field set, the retry route's closing
line). Three spec citations drifted slightly and are corrected here: the retry
frozen-field copy is at `app.ts:1027-1031` (spec said 1023-1025), the GC delete
decision is at `reconcile.ts:147-150` (spec said 147-151), and the `onError` map
spans `app.ts:1732-1740` with the P2025/P2002 branches at `:1735-1736`.

## Approach summary

Eight steps. Steps 1–7 each land exactly one commit; **step 8 is verification
only and produces no commit.** Order: Item 1 first (standalone, no
dependencies), then the A2+ convergence refactor as its own no-behavior-change
commit, then retry re-derivation on top of it, then Item 3 in four commits
(migration → agent API core → dispatch/claim semantics → UI). The single
migration is `Agent.archivedAt DateTime?`. The shared derivation logic lands in
`packages/db` because the dependency arrow only points api→db: `@agentos/api`
imports `@agentos/db`, never the reverse, so a helper in `packages/api` would be
unreachable from `enqueueTaskRun`.

Nothing that references `archivedAt` in TypeScript is committed before step 4
adds the column, so every commit compiles in isolation. Concretely: step 3
adds only the null-agent 409 to the retry endpoint; the archived-assignee 409
for the same endpoint is part of step 6.

Test reality (constraint 4 of the plan brief): `packages/api` tests are
`node --test` with object-literal mocks cast to `PrismaClient`
(`packages/api/src/app.test.ts:126-147` is the pattern). They can verify handler
logic, error mapping, and query/data shapes, but **not** real-database behavior:
FK enforcement, the actual P2003 error, `ON CONFLICT DO NOTHING` under real
concurrency, migration SQL, or lock behavior. The plan therefore splits
verification into (a) mock-level tests per step and (b) a dev-stack pass in
step 8 that exercises the real Postgres via docker-compose — the only place
migration SQL, the true FK 409, and true insert-concurrency are proven.
`reconcileWorkspaces` and the new `noteArchivedQueuedRuns` are exceptions that
test well without a database: they take a workspace root path / a client, so
tests use a real `mkdtemp` directory plus a mock `db`.

---

## Step 1 — Item 1: workspace GC keeps suspended and resume-pending runs

**Files:** `packages/api/src/reconcile.ts`; new `packages/api/src/reconcile.test.ts`;
this plan's revision record.
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
   sort and `slice(0, failedRetentionCount)` (`reconcile.ts:141`). A
   WAITING_INBOX run (`endedAt = null`) no longer competes for — or is evicted
   by — the quota.
3. The 2026-08-16 05:38 incident exposed a third form of the same Item 1 bug:
   while the runner clones into `resolve(workspaceRoot, run.id)`, `workspacePath`
   is still null until `/start` writes it (`app.ts:1344` at the plan baseline).
   The old workspace query (`reconcile.ts:134`) therefore omitted the run, and
   the path-only orphan decision (`reconcile.ts:147-152`) deleted the live clone.
   Read directory names before querying and widen the query to include run ids
   matching those names as well as rows with a non-null `workspacePath`; keep a
   directory when either its resolved path or its name-as-run-id identifies a
   run in the five workspace keep statuses. This protects CLAIMED and
   PROVISIONING clone directories before their path is persisted, without a
   column or migration.

**Tests** (new `reconcile.test.ts`, `node:test`; real temp dir via
`fs.mkdtemp`, mock `db` with `run.findMany`/`run.update`/`session.updateMany`):

- WAITING_INBOX run + three `workspaceRetained` failed runs, quota 2 → the
  waiting run's directory survives, the oldest failed directory is removed
  (spec Item 1 AC 1; also proves the quota still evicts).
- QUEUED run with `workspacePath` set → survives a pass (AC 3).
- Run in SUCCEEDED/FAILED past quota → removed; `workspaceRetained` reset and
  session cleanup marked, as today (AC 4).
- Directory with no matching run row → still removed (edge case preserved).
- Directory named for a CLAIMED or PROVISIONING run whose `workspacePath` is
  null → survives (the 2026-08-16 clone-window regression).
- `reconcileDatabaseRuns` query shape: capture the `where.status.in` list from
  the mock and assert it is exactly `[CLAIMED, PROVISIONING, RUNNING]` (AC 5's
  no-regression guard); the existing heartbeat test at `app.test.ts:165-193`
  continues to pass.
- AC 2 (restart path) needs no separate test: `reconcileAtStartup`
  (`reconcile.ts:165-172`, called from `packages/api/src/index.ts:15-19`)
  invokes the same two functions with the same arguments; the two tests above
  cover it.

**Verify:** `npm run test -w @agentos/api && npm run typecheck`.

## Step 2 — A2+ convergence: one runner-choice + one run-config derivation

**Files:** `packages/db/src/workflow.ts`, `packages/api/src/execution.ts`,
`packages/api/src/workflow.test.ts`.
**Commit:** `refactor(db): single runnerFor and shared run-config derivation`
No behavior change; this commit exists so step 3's diff is purely the retry fix.

1. In `packages/db/src/workflow.ts`: rename the private `chooseRunner`
   (`workflow.ts:22-30`) to an **exported** `runnerFor` (same body — it is
   byte-identical to the api copy at `execution.ts:20-28`). This is the
   surviving implementation. It reaches consumers through the existing
   `export * from "./workflow.js"` in `packages/db/src/index.ts:14`.
2. Same file: extract `deriveRunConfig(agent, templateStep, task)` returning
   `{ runner, model, promptHash }`, implemented exactly as `enqueueTaskRun`
   derives them today (`workflow.ts:47` runner with template-step override,
   `:62` model, `:65-70` promptHash over
   `[foundationalPrompt, rolePrompt, task.name, task.description]`). Export it;
   rewrite `enqueueTaskRun` to call it.
3. In `packages/api/src/execution.ts`: delete the local `runnerFor`
   (`execution.ts:20-28`) and replace it with
   `export { runnerFor } from "@agentos/db";` so the existing import site
   (`app.ts:940` via `./execution.js`) compiles unchanged. `hashPrompt`
   (`execution.ts:35-36`) stays — the task-creation endpoint at `app.ts:940-952`
   is deliberately left as-is (touching it is outside this batch; noted in
   Ambiguity 3).

**Tests** — this commit claims "no behavior change", so it must carry tests that
make that claim executable rather than relying on the one existing chain-branch
test (`workflow.test.ts:6-23`), which only exercises an explicit CLAUDE
preference:

- **Table-driven `runnerFor` parity.** One table covering every input class:
  each explicit preference (`CLAUDE`, `CODEX`, `PI`) against a model that would
  heuristically imply a *different* runner, plus `INHERIT` against models
  hitting each heuristic branch (`…codex…` → CODEX, `…deepseek…` → PI,
  `…pi…` → PI, mixed case, and a fallthrough like `claude-opus-5` → CLAUDE).
  Assert the exported `runnerFor` returns the expected `RunnerKind` for every
  row. The table is written from the pre-refactor bodies, so it fails if the
  surviving implementation diverges from either original.
- **`deriveRunConfig` capture.** For a fixture agent + task + `templateStep`,
  assert the returned `{ runner, model, promptHash }` equals the values the
  pre-refactor `enqueueTaskRun` produced — specifically that `promptHash` is
  `sha256` over `[foundationalPrompt, rolePrompt, task.name, task.description]`
  joined by `\n` (identical to `hashPrompt` at `execution.ts:35-36`, which
  `app.ts:952` still uses), and that a non-null `templateStep.runner` overrides
  the agent-derived runner.
- **Task-create output capture.** A `POST /projects/:projectId/tasks` mock test
  that captures the created run's `runner`, `model`, and `promptHash` for an
  `INHERIT` agent, locking `app.ts:940-952` against accidental drift while the
  shared helper moves underneath it.
- Existing `workflow.test.ts:6-23` chain-branch test and the gate test must
  pass **unmodified**.

**Verify:** `npm run typecheck && npm run test` (all workspaces).

## Step 3 — Item 2: operator retry re-derives from the current agent row

**Files:** `packages/api/src/app.ts` (retry endpoint `1003-1044`),
`packages/api/src/app.test.ts`.
**Commit:** `fix(api): operator retry re-derives runner, model, promptHash from current agent config`

Scope note: this step handles the **deleted-agent** case only. The
archived-assignee 409 for the same endpoint belongs to step 6, because
`archivedAt` does not exist in the Prisma client until step 4. There is no
partial archived logic here.

1. Widen the task load at `app.ts:1007-1010` to
   `include: { assigneeAgent: true, templateStep: true, runs: {...} }`.
2. After the existing guards (`no run to retry` `:1013`, `active run`
   `:1014-1016`, budget guard `:1017` — all unchanged): if
   `task.assigneeAgent` is null → 409
   `{ error: "Task assignee no longer exists; assign an agent before retrying" }`.
3. Replace the frozen copies at `app.ts:1027-1031`:
   `const derived = deriveRunConfig(task.assigneeAgent, task.templateStep, task)`
   → `runner: derived.runner`, `model: derived.model`,
   `promptHash: derived.promptHash`, and `agentId: task.assigneeAgent.id`
   (current assignee, not `last.agentId` — Ambiguity 2).
   Unchanged: `branch: last.branch` (`:1030`), `targetBranch: last.targetBranch`
   (`:1029`), `goalId` (`:1022`), `repoId` (`:1024`), `maxDurationMin`
   (`:1032`), `stallTimeoutMin` (`:1033`), `maxRunsPerTask: last.maxRunsPerTask`
   (`:1034`, keeps the +1 external ceiling raise), and the budget guard.

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
  archived half is tested in step 6).
- AC 4 (budget guard, `maxRunsPerTask` carry-forward, `branch` continuation):
  assert those fields in the same captured create; existing external-failure
  test (`app.test.ts:122-163`) keeps passing.

**Verify:** `npm run test -w @agentos/api && npm run typecheck`.

## Step 4 — Item 3 migration: `Agent.archivedAt`

**Files:** `packages/db/prisma/schema.prisma` (Agent model, `:201-235`); new
`packages/db/prisma/migrations/<timestamp>_agent_archived_at/migration.sql`.
**Commit:** `feat(db): nullable Agent.archivedAt for soft-offline`

1. Add `archivedAt DateTime?` to the Agent model, after `updatedAt`
   (`schema.prisma:213`) and before the `project` relation (`:214`).
2. Generate the migration — exact command, run from the repo root, with the
   docker-compose Postgres up (`docker compose up -d postgres` if not):

   ```
   npm run db:migrate -w @agentos/db -- --name agent_archived_at
   ```

   which expands (per `packages/db/package.json:18`) to
   `dotenv -e ../../.env -- prisma migrate dev --name agent_archived_at`.
   No shadow-database flag is passed or needed: `prisma migrate dev`
   auto-creates and drops its own shadow database, and the compose credentials
   (`POSTGRES_USER=agentos`, `docker-compose.yml:5-8`; `DATABASE_URL` at
   `.env.example:5`) are the container's initialisation superuser, which holds
   CREATEDB. There is **no fallback command** — Prisma 6.19's `migrate dev` has
   no `--shadow-database-url` option, and a restricted-user setup would need
   `shadowDatabaseUrl` configured in `schema.prisma`'s datasource block, which
   this deployment does not require.
3. Expected generated SQL — verify the file contains exactly this (plus Prisma's
   comment header) and nothing else:
   `ALTER TABLE "Agent" ADD COLUMN "archivedAt" TIMESTAMP(3);`
   No backfill, no index (A4, current scale). Rollback per spec:
   `ALTER TABLE "Agent" DROP COLUMN "archivedAt";`
4. `npm run db:generate` to refresh the client.

**Verify:** `npm run db:validate`; migration applies cleanly on the dev stack;
`npx prisma migrate status` reports no drift and no pending migrations;
`SELECT "archivedAt" FROM "Agent" LIMIT 1` returns null for existing rows
(spec Item 3 AC 1). This is real-database verification — no mock claims it.
Full command sequence in step 8.

## Step 5 — Item 3 API core: archive/unarchive endpoints, FK-delete 409

**Files:** `packages/api/src/app.ts`, `packages/api/src/app.test.ts`.
**Commit:** `feat(api): agent archive/unarchive endpoints, FK delete maps to 409`

Endpoints, placed next to the existing agent routes (after
`DELETE /agents/:agentId` at `app.ts:482-485`):

- `POST /agents/:agentId/archive`: load the agent (404 if missing); if
  `archivedAt` is already set, return the row unchanged (idempotent — do **not**
  refresh the timestamp, Ambiguity 5); else `update({ archivedAt: now })`. 200
  with the plain agent row, per spec. (Step 6 later appends one line here — the
  `noteArchivedQueuedRuns(db, { agentId })` call — because the helper does not
  exist yet at this commit.)
- `POST /agents/:agentId/unarchive`: symmetric, sets `archivedAt: null`,
  idempotent 200.
- `archivedAt` stays out of the writable field set: `agentFields`
  (`app.ts:55-64`) and therefore `agentInput` (`:65-69`) and `agentPatch`
  (`:70`) are untouched — A5.
- `DELETE /agents/:agentId` (`app.ts:482-485`): wrap the delete in try/catch;
  on `Prisma.PrismaClientKnownRequestError` with `code === "P2003"` return 409
  `{ error: "Agent has task history; archive it instead" }`. The global
  `onError` map (`app.ts:1732-1740`) is left unchanged (Ambiguity 4). A
  history-free agent still deletes → 204.

Read surfaces stay unchanged: `GET /projects/:projectId/agents`
(`app.ts:446-449`) and `GET /agents/:agentId` (`app.ts:457-471`) now simply
carry the new column (spec Item 3 AC 3).

**Tests** (mock-Prisma, `app.test.ts`):

- Archive an active agent → 200, `update` called once with a `Date` in
  `archivedAt`. Archive again → 200, `update` **not** called a second time
  (capture the call count).
- Unarchive an archived agent → 200 with `archivedAt: null`; unarchive an
  active agent → 200 no-op.
- Archive/unarchive of a missing agent → 404.
- Delete where the mock's `agent.delete` throws a constructed
  `Prisma.PrismaClientKnownRequestError("...", { code: "P2003", clientVersion: "6.19.0" })`
  → 409 with the "archive it instead" body. *Proves the mapping only*; that
  Postgres actually raises P2003 on an agent with runs is proven in step 8 on
  the real stack (spec AC 5).
- Delete where `agent.delete` resolves → 204 (no regression).

**Verify:** `npm run test -w @agentos/api && npm run typecheck`.

## Step 6 — Item 3 dispatch: archived agents are rejected at entry, skipped at claim, and always visible

**Files:** `packages/db/src/workflow.ts`, `packages/api/src/reconcile.ts`,
`packages/api/src/app.ts`, `packages/api/src/index.ts`,
`packages/api/src/templates.ts`, `packages/inbox/src/index.ts`; tests in
`packages/api/src/app.test.ts`, `packages/api/src/reconcile.test.ts`,
`packages/api/src/templates.test.ts`, `packages/api/src/workflow.test.ts`.
**Commit:** `feat(api): archived agents blocked at dispatch, excluded from claim, and surfaced as task activity`

This is the step the plan review rewrote. It has four parts: (6a) a typed error
with per-caller semantics, (6b) the entry guards, (6c) the claim-query
exclusion, (6d) the archived-queued audit sweep that satisfies A6+.

### 6a — A recognisable archived-assignee error, and what each caller does with it

In `packages/db/src/workflow.ts`, beside `enqueueTaskRun`:

```ts
export class ArchivedAssigneeError extends Error {
  constructor(readonly taskId: string, readonly taskName: string, readonly agentName: string) {
    super(`Task ${taskName} assignee ${agentName} is archived; unarchive the agent to queue this step`);
    this.name = "ArchivedAssigneeError";
  }
}
export const isArchivedAssigneeError = (error: unknown): error is ArchivedAssigneeError =>
  error instanceof Error && error.name === "ArchivedAssigneeError";
```

The predicate matches on `name`, not `instanceof`, because `@agentos/db`
resolves to `./src/index.ts` for types and `./dist/index.js` for imports
(`packages/db/package.json:8-13`); a `dist`/`src` split would give two distinct
classes and silently break an `instanceof` check.

`enqueueTaskRun`'s existing guard (`workflow.ts:42-44`) gains a second clause
that throws `ArchivedAssigneeError` when
`task.assigneeAgent.archivedAt != null`. Its three call sites get **different**
semantics, because rolling back is right in two of them and catastrophic in the
third:

| Caller | Site | Semantics |
|---|---|---|
| Chain advancement after a **successful** run | `workflow.ts:147`, reached from the completion transaction at `app.ts:1646` | **Must not roll back.** Never let the error escape: see 6a-1. |
| Approval-gate **approve** (successor enqueue) | `workflow.ts:236` | Let it throw; the whole decision rolls back so the gate stays OPEN and re-decidable. Surface as 409: see 6a-2. |
| Approval-gate **reject** (redo enqueue) | `workflow.ts:249` | Same as approve. |

**6a-1 — chain advancement must commit the finished run.** Today
`advanceTemplateTask` calls `enqueueTaskRun(tx, next.id, now)` at
`workflow.ts:147` inside completeRun's `Serializable` transaction
(`app.ts:1712`). A throw there rolls back the run close (`app.ts:1561-1585`),
the session close (`:1587-1601`) and the freshly written `taskStepOutput`
(`:1638-1644`) — a succeeded run is resurrected as RUNNING, its lease
eventually expires, and `reconcileDatabaseRuns` re-queues work that already
succeeded. The runner also sees a 500 (the error does not match the inbox regex
and falls through to `app.ts:1738-1739`).

Fix: **pre-check instead of throwing.** Widen the load at `workflow.ts:129-132`
to `include: { followUpTask: { include: { assigneeAgent: true } } }`, and
before the enqueue at `:147`:

```ts
if (next.assigneeAgent?.archivedAt) {
  await tx.task.update({ where: { id: next.id }, data: {
    status: TaskStatus.REVIEW,
    failureReason: `Assignee ${next.assigneeAgent.name} is archived; unarchive the agent and retry to queue this step`,
  } });
  await tx.taskActivity.create({ data: { taskId: next.id, actorType: "control-plane",
    body: `Predecessor ${task.name} completed but assignee ${next.assigneeAgent.name} is archived; step not queued` } });
  return { gated: false, nextTaskId: next.id };
}
await enqueueTaskRun(tx, next.id, now);
```

No exception crosses the transaction boundary, so the completion commits: the
finished run stays SUCCEEDED, its output is persisted, and the blocked
successor is diagnosable from its own task page (REVIEW + `failureReason` +
activity). The pre-check and `enqueueTaskRun`'s own read observe the same agent
row because both run inside one `Serializable` transaction, so there is no
check-then-enqueue race here; `enqueueTaskRun`'s throw remains the invariant
backstop for callers that do not pre-check. The return shape
`{ gated, nextTaskId }` is unchanged — `app.ts:1646` discards it, and the tests
assert on the captured `tx` calls instead.

Known, declared consequence: the source task's own completion activity
(`app.ts:1658-1669`) still reads "template chain advanced". The successor's
activity carries the real story; changing the source-task wording would mean
threading a result flag out of `advanceTemplateTask` into `app.ts:1663`, which
is more churn than the ambiguity is worth.

**6a-2 — gate decisions return a 409 that names the agent.** Add, ahead of the
existing regex branch, in both web inbox routes:

- `POST /inbox/messages/:messageId/decision` (`app.ts:1102-1121`, regex at
  `:1113`) and `POST /inbox/messages/:messageId/reply` (`app.ts:1122-1142`,
  regex at `:1134`):
  `if (isArchivedAssigneeError(error)) return context.json({ error: error.message }, 409);`

Rolling back is the desired outcome here: the `inboxMessage.updateMany` that
claims the question (`workflow.ts:200-203`) is undone with everything else, so
the card stays OPEN and the operator can unarchive and press the same button
again.

- Feishu card path: `processFeishuEvent` (`packages/inbox/src/events.ts:83-90`)
  rethrows after re-persisting the raw event (`:96-107`) — leave that intact,
  but in `packages/inbox/src/index.ts:41-45` catch the archived error in the
  `card.action.trigger` handler and return
  `{ toast: { type: "error", content: error.message } }` instead of letting it
  escape the dispatcher. Same rollback, but the approver sees why on the card.
  Every other error keeps rethrowing.

### 6b — Entry guards (each names the agent or the step, spec Item 3 AC 2)

- `POST /projects/:projectId/tasks` — at the assignee check
  (`app.ts:923-926`): `if (agent?.archivedAt) return 400 { error: "Assignee <name> is archived" }`.
- `PATCH /tasks/:taskId` — at the assignee-change check (`app.ts:977-980`):
  same 400.
- Operator retry (`app.ts:1003-1044`, structure from step 3): after the
  null-agent 409, `if (task.assigneeAgent.archivedAt) return 409 { error: "Assignee <name> is archived; unarchive it to retry" }`.
- Template instantiation (`packages/api/src/templates.ts:37-45`): beside the
  existing `has no agent` guard at `:38`, add
  ``if (step.assigneeAgent?.archivedAt) throw new Error(`Template step ${step.name} agent ${step.assigneeAgent.name} is archived`)``.
  The route's error→400 regex (`app.ts:901`) matches on `has no|not found|…`
  and would *not* match "is archived", so extend that regex with `is archived`
  and assert the 400 in the test.

Declared race: `POST /projects/:projectId/tasks` reads the agent outside the
transaction (`app.ts:923-925`) and creates the run inside it (`:941-957`), so an
archive committing in between yields a QUEUED run for an archived agent. That is
exactly what 6c and 6d exist to absorb: the run is never claimed, the operator
sees the reason in the task activity, and unarchiving releases it. No new
locking is introduced for a window this narrow and this recoverable.

### 6c — The claim query excludes archived agents from the candidate set

The candidate query at `app.ts:1197-1220` sorts by `[readyAt asc, createdAt asc]`
and takes 20. Filtering inside the loop would let archived runs permanently
occupy that window: an archived agent's runs are never cancelled (A6), they keep
the oldest `readyAt`, and every poll from every runner would re-fetch the same
20 rows and skip them all — a run behind them would starve forever, not
transiently.

So the exclusion goes in the `where` clause (`app.ts:1198-1203`):

```ts
where: {
  status: RunStatus.QUEUED,
  readyAt: { lte: now },
  agent: { archivedAt: null },
  task: { status: { in: [TaskStatus.TODO, TaskStatus.DOING] }, assigneeType: AssigneeType.AGENT },
  OR: [{ blockedByRunId: null }, { blockedBy: { status: RunStatus.SUCCEEDED } }],
},
```

`Run.agent` is a required relation (`schema.prisma:592` `agentId String`,
relation at `:648`), so this is a plain relation filter, not a nullable one.
Archived runs then never consume a candidate slot. **No `continue` is added to
the loop at `app.ts:1221-1225`** — a loop-level check would be dead code and
would re-suggest the wrong mental model to the next reader.

### 6d — A6+ visibility: one audit sweep with a per-run atomic idempotency key

Because 6c removes archived runs from the claim path entirely, the activity that
A6+ requires cannot be written there. It also cannot be written only at archive
time: after an agent is archived, three paths still create fresh QUEUED runs for
it —

1. an Inbox answer flips WAITING_INBOX → QUEUED in place
   (`workflow.ts:253-256`);
2. completeRun's automatic transient-failure retry creates a new run
   (`app.ts:1603-1624`);
3. lease-loss reconciliation creates a new run (`reconcile.ts:76-98`);

plus the check-then-enqueue race declared in 6b. A single archive-time snapshot
would miss all four.

New exported helper in `packages/api/src/reconcile.ts`:

```ts
export const noteArchivedQueuedRuns = async (
  db: PrismaClient,
  options: { agentId?: string } = {},
): Promise<number> => {
  const stalled = await db.run.findMany({
    where: {
      status: RunStatus.QUEUED,
      taskId: { not: null },
      agent: { archivedAt: { not: null } },
      ...(options.agentId ? { agentId: options.agentId } : {}),
    },
    select: { id: true, taskId: true, runNumber: true, agent: { select: { name: true, archivedAt: true } } },
  });
  const rows = stalled.flatMap((run) => run.taskId && run.agent.archivedAt ? [{
    // Deterministic primary key = the idempotency key. Two concurrent polls
    // both INSERT; Postgres lets exactly one win and skipDuplicates swallows
    // the loser, so no read-then-write window exists.
    id: `archived-skip:${run.id}:${run.agent.archivedAt.toISOString()}`,
    taskId: run.taskId,
    actorType: "control-plane",
    body: `Assignee ${run.agent.name} is archived; run ${run.runNumber} stays queued and is not claimed until the agent is unarchived`,
  }] : []);
  if (rows.length === 0) return 0;
  return (await db.taskActivity.createMany({ data: rows, skipDuplicates: true })).count;
};
```

Design notes the implementer must preserve:

- **The idempotency key is the row's own primary key.** `TaskActivity.id` is
  `String @id @default(cuid())` (`schema.prisma:517`) with no format constraint,
  so supplying it explicitly needs **no migration**. `createMany({ skipDuplicates: true })`
  compiles to `INSERT … ON CONFLICT DO NOTHING` on PostgreSQL, so four runners
  polling concurrently produce exactly one row. The revision-1 approach —
  comparing the task's most recent activity body — is removed: four
  transactions can read the same stale "latest" and all insert, and any
  unrelated activity landing in between defeats the comparison entirely.
- **Archive cycle is part of the key.** Including `archivedAt` means a
  re-archived agent gets a fresh, accurate notice per archive cycle instead of
  reusing a stale one from a previous cycle.
- **No `take` cap.** Ordering-plus-cap would reproduce MF-1 in miniature: the
  first N rows are already noted and would be re-fetched forever while the tail
  never got a notice. The query is bounded in practice — it only matches QUEUED
  runs of archived agents — and it rides the existing
  `@@index([status, readyAt])` (`schema.prisma:659`) for the `status` predicate.
  If the archived backlog ever grows enough to matter, the fix is a cursor, not
  a silent cap.
- Only `QUEUED` runs are swept. A CLAIMED/RUNNING/WAITING_INBOX run of an
  archived agent finishes normally (A6) and needs no notice.

Three call sites:

1. **Claim poll** — in `POST /runner/tasks/claim`, beside the existing
   `reconcileDatabaseRuns(db, now)` at `app.ts:1195`:
   `await noteArchivedQueuedRuns(db).catch((error: unknown) => console.error("Archived-run notice failed", error));`
   The `.catch` mirrors the post-run `reconcileWorkspaces` call
   (`app.ts:1719-1723`): an audit-log failure must never break claiming.
2. **Startup** — `reconcileAtStartup` (`reconcile.ts:165-172`) also returns
   `archivedNotices: await noteArchivedQueuedRuns(db)`; extend the startup log
   line at `packages/api/src/index.ts:20` with the new count.
3. **Archive endpoint** — step 5's `POST /agents/:agentId/archive` calls
   `noteArchivedQueuedRuns(db, { agentId })` after the update, so the operator
   gets the notice immediately even when no runner is polling. Same helper, same
   key, so it cannot double-write against the claim-poll sweep.

Unarchive needs no counterpart: the runs simply become claimable again, and the
"claimed" activity (`app.ts:1273-1280`) is the natural sequel in the log.

**Tests** (mock-Prisma unless stated; each notes what it does *not* prove):

- **Claim-window starvation (the MF-1 regression test).** Seed 20 candidates
  belonging to an archived agent with older `readyAt`, then one active-agent
  candidate. The mock `run.findMany` **applies the `where.agent` predicate and
  the `take`** before returning, so it models the database rather than the
  handler. Assert the active run is the one passed to `run.updateMany`. Against
  the pre-fix loop-level `continue`, the mock returns 20 archived rows, nothing
  is claimed, and the test fails — which is the point.
- **Query-shape assertion.** Capture the `where` the claim handler passes and
  assert it contains `agent: { archivedAt: null }`, so a later refactor cannot
  quietly move the filter back into the loop.
- **Concurrent notice writes.** `Promise.all` of four `noteArchivedQueuedRuns`
  calls against a mock whose `taskActivity.createMany` keeps a `Set` of ids and
  honours `skipDuplicates` → exactly one row for the run, and the id equals
  `archived-skip:<runId>:<archivedAt ISO>`. *Proves the code uses a
  unique-key insert rather than a read-compare heuristic*; that Postgres
  enforces the uniqueness under real parallelism is proven in step 8.
- **Each post-archive enqueue path becomes visible.** Three cases, all through
  the sweep: (i) a run flipped WAITING_INBOX → QUEUED by
  `applyInboxDecisionTx` (`workflow.ts:253-256`), (ii) a run created by
  completeRun's auto-retry (`app.ts:1603-1624`), (iii) a run created by
  lease-loss reconciliation (`reconcile.ts:76-98`) — for each, run the path
  against a mock whose agent is archived, then call `noteArchivedQueuedRuns` and
  assert exactly one activity naming the agent and the run number.
- **Sweep scoping.** An archived agent with a RUNNING run and a QUEUED run →
  one notice, for the QUEUED run only. An active agent's QUEUED run → zero
  notices. `agentId`-scoped call touches only that agent's runs.
- **Chain advancement does not roll back (the MF-2 regression test).**
  HTTP-level `POST /runner/runs/:runId/complete` for a succeeded template-step
  run whose successor's agent is archived, in the `app.test.ts:126-147` mock
  style: assert 200 (not 500), the run-close `updateMany` was called, the
  `taskStepOutput` create was called, no `run.create` happened for the
  successor, the successor task was updated to REVIEW with a `failureReason`
  naming the agent, and an activity was written on the successor.
- **Gate decisions return 409, not 500.** HTTP-level
  `POST /inbox/messages/:messageId/decision` with `decision: "approve"` where
  the gate's successor agent is archived → 409 whose body names the agent;
  same for `"reject"` where the redo task's agent is archived. *Proves the
  status mapping*; that the surrounding transaction actually rolls back and
  leaves the card OPEN is a Postgres property, proven in step 8.
- **Entry guards.** Task create / task patch with an archived assignee → 400
  naming the agent. Retry with an archived assignee → 409 (completes step 3's
  AC 5). Template instantiation with an archived step agent → 400 naming the
  step (`templates.test.ts`), asserting the widened regex at `app.ts:901`
  matches.
- **`enqueueTaskRun` guard.** Archived agent → rejects with
  `ArchivedAssigneeError`, and `isArchivedAssigneeError` returns true for it
  (`workflow.test.ts` mock-tx style).

**Verify:** `npm run test -w @agentos/api && npm run test -w @agentos/inbox && npm run typecheck`.

## Step 7 — Item 3 UI: archive action, badge, picker filter

**Files:** `apps/web/src/lib/types.ts`, `apps/web/src/pages/Agents.tsx`,
`apps/web/src/pages/Tasks.tsx`.
**Commit:** `feat(web): agent archive action, Archived badge, picker excludes archived`

1. `types.ts`: add `archivedAt: string | null;` to the `Agent` type (declared at
   `types.ts:37`), after `updatedAt` at `types.ts:49`.
2. `Agents.tsx`: the `RowMenu` at `Agents.tsx:145` gains
   `{ label: agent.archivedAt ? "Unarchive" : "Archive", onSelect: … }` next to
   Delete, POSTing `/agents/:id/archive` or `/agents/:id/unarchive` and then
   `reload()` — same `useAction().run` pattern as `remove` at
   `Agents.tsx:109-112`. The name cell at `Agents.tsx:140` renders
   `<Pill tone="grey">Archived</Pill>` beside the title when
   `agent.archivedAt != null`. No new page, no filter UI (spec).
3. `Tasks.tsx`: in `NewTask`, filter the picker options at `Tasks.tsx:160` to
   `agents.filter((a) => !a.archivedAt)`, and use the same filtered list for the
   form default `assigneeAgentId` at `Tasks.tsx:97` so an archived agent cannot
   be the silent default. Task/history views are untouched (they read task
   includes).

**Verify:** `npm run typecheck && npm run build -w @agentos/web`; visual check in
step 8 (spec Item 3 AC 6).

## Step 8 — batch verification on the real stack (no commit)

This step produces no commit. Every command below is written to be run in order;
capture stdout for the PR as verification evidence.

**Setup.** Per `README.md:46-65`, in separate terminals:

```sh
docker compose up -d postgres            # docker-compose.yml:1-17
npm run db:migrate                       # applies the step-4 migration
npx prisma migrate status --schema packages/db/prisma/schema.prisma   # expect: no pending, no drift
npm run db:seed
npm run dev:api                          # terminal 2, API_PORT=3000 (.env.example:9)
npm run dev:web                          # terminal 3
```

The runner (`npm run dev:runner`, terminal 4) is started and stopped explicitly
per scenario below — **not** left running throughout, because two of the three
scenarios depend on a run staying unclaimed. Export
`OPERATOR=$(grep ^OPERATOR_TOKEN .env | cut -d= -f2)` and
`WS=$(grep ^RUNNER_WORKSPACE_ROOT .env | cut -d= -f2)` for the commands below;
`psql "$DATABASE_URL"` is the SQL entry point.

1. `npm run typecheck && npm run test` — all workspaces green.

2. **Scenario 1 (Item 1) — suspended workspace survives GC.** Runner up.
   - Create a task whose agent calls `inbox_ask`; poll
     `curl -s -H "Authorization: Bearer $OPERATOR" localhost:3000/tasks/$TASK | jq '.runs[0].status'`
     until it reads `WAITING_INBOX`. Record `RUN=$(… .runs[0].id)` and confirm
     `ls -d $WS/$RUN` exists.
   - Run a second, unrelated task to completion. Its completion calls
     `reconcileWorkspaces` (`app.ts:1719-1723`).
   - Assert `ls -d $WS/$RUN` still exists (pre-fix: gone). Repeat with two
     failed runs holding retained workspaces
     (`SELECT id,"workspaceRetained","endedAt" FROM "Run" WHERE "workspaceRetained"` )
     to prove the quota still evicts the oldest failed directory but not `$RUN`.
   - Restart the API (Ctrl-C in terminal 2, `npm run dev:api` again) and check
     the startup log line (`index.ts:20`) plus `ls -d $WS/$RUN` — AC 2.
   - Answer the question from the web Inbox; confirm the resumed run claims the
     surviving workspace (runner log shows reuse, not a fresh clone) and
     finishes. After it reaches a terminal state, complete one more unrelated
     run and confirm `$WS/$RUN` is now removed — AC 4.

3. **Scenario 2 (Item 2) — retry re-derives.** Runner up.
   - Fail a task (`SELECT id,runner,model,"promptHash" FROM "Run" WHERE "taskId"=$TASK`
     — record the row).
   - `curl -X PATCH -H "Authorization: Bearer $OPERATOR" -H 'Content-Type: application/json' \
      -d '{"model":"openai-codex/gpt-5.6-luna","runnerPreference":"PI"}' localhost:3000/agents/$AGENT`
   - `curl -X POST -H "Authorization: Bearer $OPERATOR" localhost:3000/tasks/$TASK/retry`
   - Assert the new run row's `runner` is `PI` and `model` is the new one.
     Because `promptHash` identifies only the effective prompt text
     (foundational prompt, role prompt, task name, and task description), assert
     that it stays equal when those four inputs are unchanged. Confirm the
     runner log shows the PI adapter selected, preflight passed, and a child
     process spawn attempted; this is not evidence that a protocol-capable PI
     run completed end to end.

4. **Scenario 3 (Item 3) — archive.** Runner **stopped** before the queued run
   is created, so nothing races to claim it.
   - Stop the runner (Ctrl-C in terminal 4).
   - Create a task for `$AGENT` (an agent that already has run history, so the
     FK check later is real): the POST creates a QUEUED run. Verify
     `SELECT id,status FROM "Run" WHERE "taskId"=$TASK` → `QUEUED`.
   - `curl -X POST -H "Authorization: Bearer $OPERATOR" localhost:3000/agents/$AGENT/archive`
     → 200 with `archivedAt` set.
   - Immediately assert the archive-time notice landed:
     `SELECT id,body FROM "TaskActivity" WHERE id LIKE 'archived-skip:%'` → one
     row naming the agent.
   - Start the runner again and let it poll for ≥30s (six polls at
     `RUNNER_POLL_INTERVAL_MS=5000`, `packages/runner/src/config.ts:29`). Assert
     the run is still `QUEUED` (skipped, not claimed, not cancelled — A6) and
     that `SELECT count(*) FROM "TaskActivity" WHERE id LIKE 'archived-skip:%'`
     is still **1** — the concurrency/idempotency proof the mocks cannot give.
   - Starvation check (the MF-1 fix on real data): with the archived agent's run
     still queued, create ≥1 task for an *active* agent and confirm it is
     claimed and runs while the archived run sits untouched. To exercise the
     window bound, insert 20 extra archived-agent QUEUED rows first via
     `INSERT INTO "Run" …` (or by creating 20 tasks before archiving) with older
     `readyAt`; the active run must still be claimed on the next poll.
   - Read surfaces: `GET /tasks/$TASK`, `GET /agents/$AGENT`, the web Tasks and
     Agents pages all still render the archived agent's history (AC 3); the
     new-task picker omits it and the Agents row shows the Archived badge
     (AC 6).
   - `curl -i -X DELETE -H "Authorization: Bearer $OPERATOR" localhost:3000/agents/$AGENT`
     → **409** with `Agent has task history; archive it instead` (real P2003,
     AC 5). Then create a throwaway agent with no history and delete it → 204.
   - Gate path: with an archived agent assigned to a chain successor, complete
     the predecessor run and assert (a) the predecessor stays `SUCCEEDED` with
     its `TaskStepOutput` row present, (b) the runner got 200, not 500, (c) the
     successor task is `REVIEW` with a `failureReason` naming the agent — the
     MF-2 proof that a success is never rolled back. Then approve a gate whose
     successor agent is archived from the web Inbox and assert a 409 toast/body
     plus `SELECT status FROM "InboxMessage" WHERE id=$MSG` → still `OPEN`
     (rollback proof).
   - `curl -X POST -H "Authorization: Bearer $OPERATOR" localhost:3000/agents/$AGENT/unarchive`
     → the queued run is claimed on the next poll (AC 4) and the picker shows
     the agent again.

5. Migration SQL reviewed in the PR diff equals the single `ALTER TABLE` from
   step 4, and `npx prisma migrate status` still reports no drift after all
   scenarios.

## Acceptance-criteria coverage map

| Spec AC | Covered by |
|---|---|
| Item 1 AC 1–5 | Step 1 (tests + untouched `activeStatuses`); AC 2 via shared `reconcileAtStartup` path; step 8 scenario 1 |
| Item 2 AC 1–4 | Step 2 parity tests + step 3 tests; step 8 scenario 2 |
| Item 2 AC 5 | Step 3 (deleted agent) + step 6b (archived agent) |
| Item 3 AC 1 | Step 4; real-DB check in step 8 |
| Item 3 AC 2 | Step 6b entry guards + 6c claim exclusion + 6a caller semantics + 6d visibility (A6+), each with tests |
| Item 3 AC 3 | Step 5 (read endpoints untouched) + step 8 scenario 3 |
| Item 3 AC 4 | Step 8 scenario 3 unarchive leg + step 6c claim-query test |
| Item 3 AC 5 | Step 5 P2003 mapping test + step 8 scenario 3 (real FK) |
| Item 3 AC 6 | Step 7 + step 8 scenario 3 |

## Ambiguities — defaults chosen, cost to overturn

The spec leaves these open; each has a default the implementation will follow.
None are decided silently — overturn any of them and only the named step changes.

1. **Archived-run visibility is an audit sweep, not a claim-loop side effect.**
   Default: `noteArchivedQueuedRuns` (step 6d) run from the claim poll, startup,
   and the archive endpoint, with `archived-skip:<runId>:<archivedAt>` as the
   `TaskActivity` primary key and `createMany({ skipDuplicates: true })` for
   atomicity. Cost: one extra indexed query per claim poll. Overturn to
   "write inside the claim loop": reintroduces the starvation bug the query-level
   exclusion exists to fix. Overturn to "write only at archive time": misses the
   four post-archive enqueue paths enumerated in 6d. Overturn to "no dedupe":
   hundreds of identical rows per hour, which defeats A6+'s purpose.
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
   from execution.ts" vs "rewrite the api import site" — re-export keeps the
   diff minimal. The task-creation endpoint (`app.ts:940-952`) is *not*
   migrated onto `deriveRunConfig` in this batch (it takes body-level fields,
   not task-row fields), but step 2 now pins its output with a capture test so
   the duplication cannot drift silently. Cost of also converging it: a larger
   step-2 diff now, one less near-duplicate later. Declared, not hidden.
4. **P2003 mapping location.** Default: local try/catch in the DELETE handler,
   because the contract message ("Agent has task history; archive it instead")
   is agent-specific and a global map can only say something generic. Overturn
   (global `onError` entry at `app.ts:1735-1736`): every future FK 500 becomes
   a 409 for free, but with a generic body — acceptable, loses the guidance
   text on this endpoint unless both are done.
5. **Double-archive keeps the original timestamp.** "Idempotent no-op 200"
   (spec) is read literally: re-archiving must not refresh `archivedAt`,
   otherwise the UI's "archived since" lies — and, since `archivedAt` is part of
   the step-6d idempotency key, a refreshed timestamp would also emit a
   duplicate notice for every already-noted run. Overturn (always `update`):
   one line simpler, timestamp drifts on repeat clicks, log gains duplicates.
6. **Item 1 keep-set is status-based: *any* run in the five keep statuses whose
   `workspacePath` is set survives**, not only post-inbox QUEUED runs. In
   practice these sets are identical today (a never-claimed QUEUED run has no
   `workspacePath`), and status-based is the smallest correct predicate.
   Overturn (track "resume-pending" explicitly): needs a new column → second
   migration, over the cap.
7. **A blocked chain successor lands in REVIEW, not a new status.** Step 6a-1
   parks the successor in `TaskStatus.REVIEW` with a `failureReason`, reusing
   the status the codebase already means "a human must look at this"
   (`app.ts:1651`, `reconcile.ts:102`). Overturn (new `BLOCKED` status): a
   second migration plus UI work, over the batch cap, for a state the operator
   resolves by unarchiving and retrying anyway.

---

## Revision record (revision 2)

Review verdict addressed: 2 must-fix, 4 should-fix. Nothing was recorded as a
known limitation.

### Must-fix

**MF-1 — archived runs starving the claim window; latest-body dedupe not
concurrency-safe.** Implemented in **Step 6c** and **Step 6d**.

- The exclusion moved from the candidate loop into the claim query's `where`
  (Step 6c), so archived runs never occupy the `take: 20` window; the loop-level
  `continue` is deleted rather than kept as dead code, with the reason written
  down.
- A6+ visibility is re-homed onto an independent audit sweep,
  `noteArchivedQueuedRuns` in `packages/api/src/reconcile.ts` (Step 6d), called
  from the claim poll, `reconcileAtStartup`, and the archive endpoint. It covers
  the archive moment *and* all four post-archive enqueue paths (Inbox
  WAITING_INBOX → QUEUED, auto-retry, lease-loss requeue, the check-then-enqueue
  race), which a snapshot-at-archive design would miss.
- Dedupe is now a per-run atomic idempotency key —
  `TaskActivity.id = archived-skip:<runId>:<archivedAt ISO>` with
  `createMany({ skipDuplicates: true })` (`INSERT … ON CONFLICT DO NOTHING`) —
  reusing the existing primary key, so **no migration is added**. The
  latest-activity-body heuristic is deleted, and Ambiguity 1 was rewritten to
  match.
- The `take` cap was deliberately omitted from the sweep with the reason stated,
  because a capped ordered scan would reproduce the same starvation shape.
- New tests in Step 6d: 20 archived candidates ahead of one active candidate,
  against a mock that applies the `where`/`take` (fails on the old code); a
  claim-query shape assertion; four concurrent sweeps producing exactly one row;
  one test per post-archive enqueue path; plus a real-stack concurrency check in
  Step 8 scenario 3 (`count(*) = 1` after six polls from a live runner) and a
  real-stack starvation check.

**MF-2 — `enqueueTaskRun`'s new throw rolling back completions and surfacing as
500.** Implemented in **Step 6a**.

- A recognisable `ArchivedAssigneeError` plus a `name`-based
  `isArchivedAssigneeError` predicate (chosen because `@agentos/db`'s dual
  src/dist export makes `instanceof` unreliable).
- Per-caller semantics are specified in a table. Chain advancement
  (`workflow.ts:147` from the Serializable completion transaction at
  `app.ts:1646`) **never throws**: `advanceTemplateTask` pre-checks the
  successor's agent, commits the finished run/session/output, and parks the
  successor in REVIEW with a `failureReason` and an activity. Gate
  approve/reject keep throwing, because rolling the decision back leaves the
  card OPEN and re-decidable — mapped to 409 in both web inbox routes
  (`app.ts:1113`, `:1134`) and to an error toast in the Feishu card handler
  (`packages/inbox/src/index.ts:41-45`).
- New HTTP-level tests: `complete-run` with an archived successor asserting 200,
  run closed, output written, successor REVIEW, no successor run created, no
  500; gate approve and gate reject each asserting a 409 that names the agent.
  Step 8 scenario 3 adds the real-stack proofs the mocks cannot give (the
  succeeded run is not resurrected; the inbox message is still OPEN after the
  409).

### Should-fix

| # | Disposition | What changed |
|---|---|---|
| SF-1 — migration fallback | **Adopted** | The `--shadow-database-url` fallback command is deleted outright from Step 4 (Prisma 6.19 rejects the flag; the compose init user is a superuser, so the fallback had no reason to exist). Ambiguity 7 in revision 1, which existed only to host that fallback, is gone; Step 4 now verifies with `prisma migrate status` for drift as well. |
| SF-2 — commit-order narrative and drifting line numbers | **Adopted** | The approach summary now says "eight steps; steps 1–7 one commit each, step 8 is verification only (no commit)". The retry endpoint's archived-assignee 409 is stated once, in step 6b, and step 3 explicitly scopes itself to the null-agent case — the revision-1 paragraph that decided the order three times is deleted, as is the ambiguity entry that re-litigated it. Every `file:line` in the document was re-read against the working tree: `updatedAt` corrected to `schema.prisma:213`, the Agents name cell to `Agents.tsx:140`, plus the task PATCH assignee check (`app.ts:977-980`, was 979-982), the writable agent field set (`app.ts:55-64` `agentFields`, was "65-70"), the retry route span (`app.ts:1003-1044`, was 1003-1042), the lease-loss requeue (`reconcile.ts:76-98`, was 77-94), and the Agent model span (`schema.prisma:201-235`). |
| SF-3 — dev-stack replay is racy and evidence-free | **Adopted** | Step 8 is rewritten as an ordered command sequence: explicit setup with `prisma migrate status`, the runner started and stopped per scenario (scenario 3 creates its QUEUED run with the runner **down**, so nothing races to claim it), concrete `curl`/`psql` commands with the assertions spelled out, a real-FK delete against an agent that genuinely has history, an explicit API restart for scenario 1's AC 2, and an instruction to keep command output as PR evidence. |
| SF-4 — Step 2's "no behavior change" rests on one existing test | **Adopted** | Step 2 gains a table-driven `runnerFor` parity test covering all three explicit preferences against contradicting models plus every `INHERIT` heuristic branch, a `deriveRunConfig` input/output capture (including the `templateStep.runner` override and the exact `promptHash` composition), and a task-create capture test pinning `app.ts:940-952`'s runner/model/promptHash output. Ambiguity 3 records that the task-create endpoint stays un-migrated but is now pinned by test. |

No changes beyond those the six findings forced, except two that the fixes made
necessary and that are named here for the record: Step 5 was split out of the
old Step 5 (agent API core) so that Step 6 could hold the reworked dispatch,
claim, and visibility design as one reviewable commit — this renumbered UI to
Step 7 and verification to Step 8 — and a new Ambiguity 7 was added to declare
that a chain successor blocked by an archived agent parks in `REVIEW` rather
than getting a new task status (a consequence of MF-2's no-rollback contract).

### Implementation-time addendum — clone window GC incident

At 2026-08-16 05:38, reconciliation triggered by one completed run removed a
different run's in-progress clone before `/start` had persisted its
`workspacePath`. Step 1 now also matches workspace directory names to run ids
and retains CLAIMED/PROVISIONING (as well as the other keep statuses) even when
`workspacePath` is null. The baseline sites were rechecked at
`app.ts:1344` and `reconcile.ts:134,147-152`; this is the same spec Item 1
defect and adds no migration.
