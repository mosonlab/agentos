# Goal 5a0 implementation plan — idempotent execution kernel

Status: implementation-ready plan; implementation is not authorized by this document

Product Contract: Goal 5a0 v1.0

Routing Contract: v1.0, Planned Critical, future implementation role `senior-dev` at high effort

Plan source: approved `docs/specs/goal-5a0-single-flight-lineage-safety-kernel.md`

Revision sources, in order:

1. `docs/reviews/2026-08-17-goal-5a0-plan-review.md` §Must-fix/§Should-fix — round 1, 7 must-fix and 2 should-fix, all closed.
2. `docs/reviews/2026-08-17-goal-5a0-plan-review.md` §Current-master plan-revision disposition — round 2, current-master review of base `a4a4ba36c116c775d5d1c28ed55b17600869d904` against head `5d1a1fea89f3f0635b53bc298e5d2881bf363bf7`, 2 must-fix and 0 should-fix, all closed.
3. `docs/reviews/2026-08-17-goal-5a0-plan-review.md` §Round-3 disposition — round 3, final independent review of base `a4a4ba36c116c775d5d1c28ed55b17600869d904` against head `4d2a4be5f5a859dd7a92a41be13825c435bfc421` with peer `4a35da5c428241c43de5b91158cfb6b2d61bc8b7`, 4 must-fix and 0 should-fix, all closed. Round 3 **discards** round 2's recorded `… → Agent → AgentRepoAccess` lock order: current master takes the exact grant *before* the Agent row, and the corrected canonical order below is authoritative.

All three rounds stay in the append-only disposition ledger below. Where round 3 contradicts round 2, round 3 governs and the round-2 entry remains visible as history.

Audited planning base: `188d21e279b8feae816b4f9580a961f5c9ee0cbc` (2026-08-17)

Current-master convergence base: `a4a4ba36c116c775d5d1c28ed55b17600869d904` (merge of PR #105, Review/Approval Convergence). Every current-master fact cited in this plan was read at that commit and must be re-read in Step 1.

Dependency decision of record (Leo, 2026-08-17): Goal 5a0 implementation and merge (#97) goes first; Inbox 3a implementation (#98) is strictly dependency-held until #97 is merged and revalidated. See "Goal 5a0 and Inbox 3a dependency, ownership, and handoff" below.

## Outcome and approach

Implement one PostgreSQL-authoritative Goal execution kernel. Goal-linked Task and Run creation goes through one module; all mutating paths take locks in the global Goal → Task → Run order; unique/check/foreign-key constraints remain the final backstop. Existing NOW Task queueing, runner claiming, lease generation, fencing, delivery, Session accounting, CRON/AT scheduling, templates, chains, and manual Task behavior are reused rather than replaced.

The work is ordered so no route can expose a transition before its durable schema, lock, idempotency, and event semantics exist. The feature flag is default-off. Production migration, enablement, public release, and service restart are not authorized by Goal 5a0.

## Non-negotiable gates

1. **Dependency fuse.** Before any code, schema, or migration edit, Control-plane A must be merged. Rebase on then-current `master`; record its SHA and the Control-plane A merge SHA; rerun the baseline audit in Step 1. If it changes the objective, scope, acceptance, evidence, authority, risk boundary, or Planned Critical route, stop for a new Product Contract version and product-owner approval.
2. **Route.** The implementation task uses `senior-dev` at high effort. It must not be downshifted without Product Contract approval under `docs/governance/task-routing-v1.md`.
3. **Migration fuse.** Preflight must fail closed on ambiguous or active historical Goal lineage. Goal 5a0 may build and rehearse against disposable/private PostgreSQL schemas, but may not run a production migration or restart.
4. **Evidence fuse.** A rerun is not a green gate until the first failure is explained and dispositioned. Every reviewer finding remains in the final disposition ledger.
5. **Rollback default.** Disable `GOAL_SAFETY_KERNEL_ENABLED` first. Prefer roll-forward with the flag off whenever live lineage must be retained; destructive down-migration requires an approved export and explicit operator approvals described in Step 14.
6. **Exclusion-protocol fuse.** Goal 5a0 joins the merged Review/Approval Convergence exclusion protocols; it does not fork them. No Goal-linked Task or Run may be created without holding the exact-grant mutex (`packages/db/src/workflow.ts::lockAgentRepoGrant`) and then the Agent-row mutex (`::lockAgentRow`) — in that direction, which is the direction current master's `POST /tasks/:taskId/start` takes them — and re-reading both under those locks. Any implementation path that creates a Goal Run outside the canonical row order in Step 4.3, or that takes the Agent row before the exact grant, is a stop condition, not a follow-up.
7. **Inbox 3a fuse.** Goal 5a0 owns and may change the symbols listed in the ownership table below; it must not implement Inbox 3a. Inbox 3a (#98) does not begin until #97 is merged and Step 1's revalidation is rerun on the merged tail. Goal 5a0 leaves a written handoff, not a partial Inbox implementation.

## Audited current-tree conflicts that implementation must resolve

- `packages/api/src/app.ts` DoD approval/item routes directly set `Goal.status` to `COMPLETED` or reopen it as `ACTIVE`; governed Goals must instead reach terminal state only through the atomic Goal decision transaction.
- `packages/api/src/app.ts`, `packages/api/src/reconcile.ts`, and `packages/db/src/workflow.ts` create Runs through several paths. Goal-linked creation must be redirected to the kernel while manual/chain/template/CRON/AT behavior remains unchanged.
- Goal-linked completion/retry/reconciliation currently locks Task, not Goal first, and has neither retry-parent uniqueness nor generation/iteration fencing.
- The claim query does not join Goal status/Task dispatch state.
- `apps/web/src/pages/Goals.tsx` labels the nullable-cost subtotal as “Spend”; it must expose known provider cost and coverage instead of implying a total.
- No metrics library is present. Goal 5a0 will use one stable structured-JSON logging adapter whose fields can be aggregated into the required counters/gauges; alerts remain Goal 5a1.

Added by the current-master convergence review at `a4a4ba3`:

- The merged Agent-row exclusion protocol is now the only legal way to create a Run for an agent. `packages/db/src/workflow.ts::enqueueTaskRun` re-reads `Agent.archivedAt` under `lockAgentRow` (`workflow.ts:326-329`) and raises `ArchivedAssigneeError`; `packages/api/src/app.ts::assignmentBlocked` (`:641-649`) and `::reactivationBlocked` (`:666-685`) take the same Agent mutex on the assignment and reactivation halves; `POST /agents/:agentId/archive` takes it on the archive half and fails closed through `agentArchiveBlocker` (`app.ts:1052-1063`, `workflow.ts:455-478`). Goal 5a0's Step 4 kernel deliberately bypasses `enqueueTaskRun`, so it must re-implement the *protocol*, not inherit it by accident.
- The exact-grant protocol is `AgentRepoAccess`-row scoped, not agent scoped. `lockAgentRepoGrant` takes `FOR KEY SHARE` on the exact `(projectId, agentId, repoId)` row and confirms `count === 1` (`workflow.ts:160-173`); `POST /tasks/:taskId/start` calls it after the Task/chain-prefix locks and before `enqueueTaskRun` (`app.ts:2514-2521`). Revocation takes `FOR UPDATE` on the same exact row through `lockAgentRepoGrantForRevocation` (`workflow.ts:177-189`) and refuses while an `ACTIVE_RUN_STATUSES` Run exists on that repo (`app.ts:1349-1357`).
- **The grant row precedes the Agent row on current master, not the reverse.** `POST /tasks/:taskId/start` is the only current writer that takes both: `lockAgentRepoGrant` at `app.ts:2514-2521`, then `enqueueTaskRun` at `app.ts:2531`, whose `lockAgentRow` call is at `workflow.ts:326`. No current writer takes the Agent row and then the grant row. Round 2's `… → Agent → AgentRepoAccess` order is therefore wrong and is discarded; the derived table in Step 4.3 is authoritative.
- The merged acyclicity argument is that archive takes only the Agent row (`app.ts:1056`) and revocation takes only the grant row (`app.ts:1350`), while multi-row run writers take Task rows first (`workflow.ts:108-110`, `:157-159`). Goal 5a0 must extend that order rather than reorder it.
- Current master has no explicit `Run` row lock anywhere: `grep -n 'FOR UPDATE|FOR KEY SHARE' packages/api/src packages/db/src` returns only Task, Agent, and `AgentRepoAccess` statements. Run rows are serialized by `updateMany` CAS predicates and unique constraints. The `Run FOR UPDATE` in Step 4.3 is therefore new, and it is placed where the spec's I9 prefix (`docs/specs/goal-5a0-single-flight-lineage-safety-kernel.md:217-221`, Goal → Task → Run) puts it: above the grant and Agent rows, which no current writer takes before a Task row.
- `POST /runner/tasks/claim` runs at Serializable and takes no explicit lock; its implicit write order is Run CAS (`app.ts:2899`) → Session (`:2920`/`:2929`) → Task (`:2941`). That is why Step 8.2 must lock Goal → Task → Run *before* the CAS and why Step 8.3's bounded `40001`/`40P01` retry exists: the claim contends at Serializable, not through a lock the candidate query held.
- `POST /runner/runs/:runId/complete` takes the Task row only conditionally (`app.ts:3373`, `:3379`), then writes Run CAS (`:3386`) → Session (`:3415`) → optional retry Run insert (`:3451`) → Task (`:3500-3517`). Its automatic retry inserts a Run while holding neither the Agent row nor the grant row. Goal 5a0's Step 6.3 retry therefore *adds* rows 4 and 5 to a path that currently has neither; that is a strictly stronger protocol joined in the same descending order, not a reordering.
- `POST /tasks/:taskId/retry` takes Task (`app.ts:2382`) then Agent (`:2408`) and takes no grant lock; an archived assignee returns its own 409 sentence `Assignee <name> is archived; unarchive it to retry` (`:2410`), not `ArchivedAssigneeError`.
- `POST /projects/:projectId/tasks` and `PATCH /tasks/:taskId` validate the grant with an **unlocked** `agentRepoAccess.findFirst` and return `400 "Assignee has no grant for this Repo"` (`app.ts:2029-2031`, `:2185-2189`); they take only the Agent row under lock, through `assignmentBlocked` (`:641-649`), and return `400 "Assignee <name> is archived"` (`:2023`, `:2044`, `:2177`, `:2257`). Create-like Goal paths inherit these 400s, per spec §7.1 step 4 and §8's "Validation/project/assignee/repo-grant failures retain current 400/404 behavior" (`docs/specs/goal-5a0-single-flight-lineage-safety-kernel.md:440-441`, `:683`).
- `packages/db/src/workflow.ts::applyInboxDecisionTx` refuses a non-gate decision whose Run is no longer `WAITING_INBOX` by **throwing** `No matching waiting Inbox question` before any write (`workflow.ts:769-771`), and returns `{ duplicate: true, resumed: false }` when the `status = OPEN` compare-and-set loses (`:806-810`) — also before the reply message (`:821`) and the `InboxDecision` row (`:838`). Both refusals therefore write nothing. Any plan text promising a recorded reply after cancellation is not implementable on this function; Step 9.5 states the reachable contract instead.
- `packages/api/src/reconcile.ts:242-247` closes a stranded waiting card with an idempotent `inboxMessage.updateMany({ where: { id, status: OPEN }, data: { status: CLOSED } })`. Step 8.4's cancel card close reuses that exact shape and creates no Inbox row.
- `ls packages/db/prisma/migrations | sort | tail -1` returns `migration_lock.toml`, not a migration: `m` sorts after `2`, and that file is Prisma's provider lock, not a migration. Every migration-tail proof in this plan therefore enumerates directories only (Step 1.6).
- `packages/db/src/workflow.ts::applyInboxDecisionTx` resumes a `WAITING_INBOX` Run straight to `QUEUED` under no Goal lock (`workflow.ts:876-887`). On current master a Goal-linked Run therefore regains claimable authority from an Inbox answer that arrives after the Goal was cancelled. Goal 5a0 must fence this; it must not implement Inbox 3a.
- `packages/api/src/reconcile.ts` expires `WAITING_INBOX` Runs to `TIMED_OUT` and closes the open card (`reconcile.ts:112-122`, `:218-257`) without Goal awareness, and creates lease-loss Inbox rows at `:208-215`.
- `packages/inbox/src/connection.ts` opens in state `STARTING` (`:1`, `:16`); decisions delivered while the connector is `STARTING`/`RECONNECTING` replay into `applyInboxDecisionTx` and therefore into the same resume path.

## Exact implementation surface

The persisted schema surface is fixed: `Goal.goalGeneration`, `Goal.nextGoalIteration`; Task fields `goalId`, `goalGeneration`, `goalIteration`, `goalDispatchKey`, `goalDispatchRequestHash`, `goalDispatchState`, `goalDecisionKey`, `goalDecisionRequestHash`, `goalDecisionRunId`, `goalDecisionAt`, and `goalPredecessorTaskId`; Run fields `goalGeneration`, `goalIteration`, and `retryOfRunId`; enum `GoalDispatchState`; and model `GoalExecutionEvent`. The migration must install the exact partial index `Task_one_open_goal_dispatch_key`, composite Task/Run lineage FK, retry self-FK/uniqueness, decision/predecessor FKs, all checks in spec §6.3–§6.4, and the event indexes. P2002 classification explicitly recognizes `Task_one_open_goal_dispatch_key`, `Task_goalId_goalDispatchKey_key`, `Task_goalId_goalDecisionKey_key`, `Task_goalId_goalGeneration_goalIteration_key`, and `Run_retryOfRunId_key`.

The exact operator API surface is:

| Method and path | Success contract |
| --- | --- |
| `POST /goals/:goalId/dispatches` | 201 create; 200 exact replay |
| `POST /goals/:goalId/iterations/:goalIteration/decision` | 201 successor; 200 complete/fail/replay |
| `POST /goals/:goalId/pause` | 200 transition or same-state replay; preserve existing project-scoped alias |
| `POST /goals/:goalId/resume` | 200 transition or same-state replay |
| `POST /goals/:goalId/cancel` | 200 terminal state or replay |
| `POST /goals/:goalId/restart` | 201 new generation; 200 exact replay |
| `POST /tasks/:taskId/runs/:sourceRunId/retry` | 201 child; 200 exact replay |
| `POST /tasks/:taskId/retry` | unchanged for manual Tasks; delegates for Goal Tasks |
| `GET /goals/:goalId/lineage` | persisted generations/iterations/Tasks/Runs |
| `GET /goals/:goalId/execution-events?after=<eventId>&limit=<1..500>` | `(createdAt,id)` ordered event page |

Expected logical conflicts are 409 with `GOAL_NOT_ACTIVE`, `GOAL_ALREADY_COMPLETED`, `GOAL_DISPATCH_IN_FLIGHT`, `STALE_GOAL_GENERATION`, `STALE_GOAL_ITERATION`, `STALE_GOAL_DECISION`, `RUN_NOT_RETRYABLE`, `RUN_RETRY_IN_FLIGHT`, or `IDEMPOTENCY_KEY_REUSED`. Required durable event types are `DISPATCH_CREATED`, `RUN_RETRY_CREATED`, `RUN_AWAITING_DECISION`, `ITERATION_ADVANCED`, `GOAL_COMPLETED`, `GOAL_FAILED`, `GOAL_PAUSED`, `GOAL_RESUMED`, `GOAL_CANCELLED`, and `GOAL_RESTARTED`.

## Numbered implementation plan

### 1. Revalidate authority and the then-current integration surface

**Files:**

- `docs/reviews/goal-5a0-current-master-revalidation.md` (new)
- `docs/specs/goal-5a0-single-flight-lineage-safety-kernel.md` (read-only unless a new Product Contract is approved)
- `docs/governance/task-routing-v1.md` (read-only)
- `packages/db/prisma/schema.prisma`
- `packages/db/src/workflow.ts`
- `packages/api/src/app.ts`
- `packages/api/src/reconcile.ts`
- `packages/api/src/scheduler.ts`
- `packages/api/src/index.ts`
- `packages/api/src/testdb.ts`
- `packages/api/src/inbox.ts`
- `packages/inbox/src/connection.ts`
- `packages/db/prisma/acceptance-fixture.ts`

**Work:**

1. On then-current `master`, record `git rev-parse HEAD`, the Control-plane A merge commit, and proof that the latter is an ancestor of the former. Record the same proof for the Review/Approval Convergence merge `a4a4ba36c116c775d5d1c28ed55b17600869d904`; if it is not an ancestor, stop.
2. Refresh every audited fact in specification §3: exact models/columns/relations; all Task/Run creation sites; Goal/Task/runner routes; completion, claim, lease-loss, startup, CRON/AT, chain, template, and delete/status writers; PostgreSQL/Prisma versions; feature-flag and logging mechanisms.
3. Record schema/API/migration name conflicts, especially any migration newer than this plan's reserved folder. The implementation migration is `packages/db/prisma/migrations/20260818000000_goal_execution_safety_kernel/migration.sql`; if that name no longer sorts after every Control-plane A migration or already exists, stop and revise the plan artifact before editing schema. Enumerate migrations with the directory-only procedure in item 6 — never with a bare `ls`.
4. Carry forward the approved spec's assumptions A1–A8 unchanged and revalidate only the tree-dependent facts behind them. If current-master evidence would force a different assumption, stop for Product Contract revision rather than silently reinterpret it.
5. Re-read the exclusion protocols by symbol and record their then-current line numbers and behaviour: `lockTaskRow`, `lockAgentRow`, `lockAgentRows`, `lockChainPrefixRows`, `lockAgentRepoGrant`, `lockAgentRepoGrantForRevocation`, `agentArchiveBlocker`, `ACTIVE_RUN_STATUSES`, `LIVE_TASK_STATUSES`, `enqueueTaskRun`'s locked assignee re-read, `assignmentBlocked`, `reactivationBlocked`, the archive route, and the grant-revocation route. Record every current caller.

   Then **rebuild Step 4.3's writer table from the tree rather than checking it**: for every current writer that locks more than one row — `POST /tasks/:taskId/start`, `POST /tasks/:taskId/retry`, `POST /projects/:projectId/tasks`, `PATCH /tasks/:taskId`, `activateChainSuccessor`, template instantiation, `fireCronTask`/AT fire, `POST /runner/tasks/claim`, `POST /runner/runs/:runId/complete`, `reconcileDatabaseRuns`, `applyInboxDecisionTx`, `POST /agents/:agentId/archive`, `DELETE /agents/:agentId/repos/:repoId/access` — record the rows it takes, the order it takes them in, the lock mode, and the file:line of each acquisition, counting an `updateMany` CAS as an implicit lock on the row it updates. Enumerate every writer that takes both the exact `AgentRepoAccess` row and the `Agent` row and record the direction each takes them. If any writer is found taking `Agent` before the exact grant, or the set of both-row writers is no longer `{POST /tasks/:taskId/start}`, stop and revise Step 4.3 before writing code: the canonical order is derived from this reading, not asserted by this plan. Also re-record whether current master still takes no explicit `Run` row lock; if a `Run FOR UPDATE` has appeared, record its position relative to the grant and `Agent` rows.
6. Re-run the Inbox 3a overlap inventory in the ownership table below against the then-current tree. Confirm each listed symbol still exists at the named file, and add any new overlapping symbol.

   **Enumerate migrations as directories only.** `ls packages/db/prisma/migrations | sort | tail -1` returns `migration_lock.toml` on the current tree, because `m` sorts after `2` and that file is Prisma's provider lock, not a migration. Every migration-tail proof in this plan, in the Step 13/14 rehearsal, and in the #98 handoff uses this procedure instead:

   ```sh
   find packages/db/prisma/migrations -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
   ```

   Validate every returned name against `^[0-9]{14}_[a-z0-9_]+$` and stop on any name that fails, rather than silently sorting it. Then assert three things and record each: the reserved folder `20260818000000_goal_execution_safety_kernel` is **absent** from that list; the reserved name sorts strictly after **every** name in the list, not merely after the last one; and no Inbox 3a migration (any `*_inbox_question*` folder) has landed. Comparing against every directory rather than a computed tail is what makes the proof independent of how the shell happens to order the set. If any assertion fails, stop and revise this plan rather than renumbering under time pressure. `migration_lock.toml` is never treated as a migration, never included in the comparison, and never reported as the tail.

**Verification:** The revalidation document contains the three SHAs (current `master`, Control-plane A merge, Review/Approval Convergence merge `a4a4ba3`), `merge-base --is-ancestor` results for both merges, refreshed file/function map, the symbol-by-symbol exclusion-protocol map, the rebuilt multi-row writer table with per-acquisition file:line and the both-row-writer enumeration, the refreshed Inbox 3a overlap inventory, the directory-only migration list with all three ordering assertions, explicit A1–A8 dispositions, and a “no contract boundary changed” conclusion. Any contrary result stops implementation. Evidence commands:

```sh
rg -n 'lockAgentRow|lockAgentRepoGrant|lockAgentRepoGrantForRevocation|agentArchiveBlocker|assignmentBlocked|reactivationBlocked' packages/api/src packages/db/src
rg -n 'FOR UPDATE|FOR KEY SHARE|FOR NO KEY UPDATE' packages/api/src packages/db/src
find packages/db/prisma/migrations -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
```

### 2. Add the exact schema and one additive forward migration

**Files:**

- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/20260818000000_goal_execution_safety_kernel/migration.sql` (new, subject to Step 1's ordering fuse)
- `packages/api/src/migration.dbtest.ts`

**Work:**

1. Add `FAILED`/`CANCELLED` to `GoalStatus` and add `GoalDispatchState` with the exact mapped values in spec §6.1.
2. Add `Goal.goalGeneration @default(1)`, `Goal.nextGoalIteration @default(1)`, Task/event relations, all exact Task lineage/idempotency/decision/predecessor fields and declared unique/indexes, all exact Run generation/iteration/retry-parent fields and indexes, and `GoalExecutionEvent` exactly as §6.2–§6.5 requires. Preserve existing project-scoped relations; use composite Prisma relations where needed to enforce same-project ownership without renaming persisted columns.
3. Add named SQL checks for: Task all-null/all-non-null lineage and dispatch state; dispatch key/hash presence; decision quartet by state; generation/iteration ranges and generation-0 restriction; predecessor shape; Run all-null/all-non-null lineage and Goal-linked `taskId`; and runtime Goal Task shape. The runtime-shape check applies to generation ≥1 and requires NOW/AGENT, no schedule, recurrence, chain, template, follow-up, approval gate, or archive identity; `MIGRATED_CLOSED` generation-0 history is exempt.
4. Add the exact partial unique index `Task_one_open_goal_dispatch_key`, Task composite identity FK target, Run composite lineage FK, `retryOfRunId` unique self-FK, decision Run FK, predecessor FK, and `RESTRICT` lineage/event FKs in dependency-safe order. Preserve unique `(taskId, runNumber)`, `dedupeKey`, lease/fencing fields, and manual all-null lineage.
5. In the same forward migration, backfill only unambiguous closed history: order each Goal's inferred Tasks by `(createdAt,id)`, assign generation 0 and 1-based iterations, deterministic `migration:<taskId>` key and `pgcrypto`-backed PostgreSQL SHA-256 hash, mark `MIGRATED_CLOSED`, and copy the tuple to Runs. Existing Goals remain generation 1 / next iteration 1. Do not create events or open dispatches for history.
6. Use PostgreSQL 16 `pgcrypto` explicitly for the backfill hash: the migration installs `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public` and computes `encode(public.digest(('migration:' || "Task"."id")::text, 'sha256'), 'hex')`. The preflight first verifies either that `pgcrypto` already exists in schema `public`, or that it is absent and the migration role has database `CREATE` plus `CREATE` on `public`; an extension installed in another schema or insufficient privilege aborts before schema or data mutation. Record whether Goal 5a0 installed the extension. Rollback leaves a pre-existing/shared extension in place and may drop a Goal-5a0-installed extension only after an explicit `pg_depend` query proves no non-extension dependents.
7. Strengthen audit identity without adding new domain fields: add a composite unique target on Task `(id, goalId, goalGeneration)` and a composite predecessor FK `(goalPredecessorTaskId, goalId, goalGeneration)` so a predecessor cannot cross Goal or generation. Add/retain composite unique targets on Task and Run `(id, goalId, goalGeneration, goalIteration)`, then add composite event FKs for present identities—`(taskId, goalId, goalGeneration, goalIteration)` to Task and `(runId, goalId, goalGeneration, goalIteration)` to Run—plus checks that optional identity components are absent/present together for event types that carry them. Keep the spec's ID FKs as the delete-restriction relations. Exact predecessor iteration continuity and per-event-type identity shapes remain verifier assertions because a static FK cannot express `predecessor.goalIteration = successor.goalIteration - 1`.
8. Add catalog assertions in `migration.dbtest.ts` for enum labels, nullability/defaults, all named checks/FKs/unique indexes, exact partial-index predicate, event table/indexes, `pgcrypto` function resolution, and delete actions.

**Verification:** `npm run db:generate`, `npm run db:validate`, the focused `migration.dbtest.ts`, and raw negative inserts prove: a second open Task is rejected; partially-null Task/Run lineage is rejected; a Run tuple mismatching its Task is rejected; a second retry child is rejected; cross-Goal/cross-generation predecessor and event identities are rejected; and manual all-null Task/Run fixtures still insert. The fixture with `Task.id = 'task-1'` must persist the exact 64-hex hash `ae09d8434c29001c3151708be633fe60ca2a9837de8f169d003e6539be35bb94`, and the insufficient-extension-privilege fixture must fail before any schema/data checksum changes.

### 3. Build fail-closed migration, invariant, and archival tooling

**Files:**

- `packages/db/prisma/preflight-goal-execution.ts` (new)
- `packages/db/prisma/verify-goal-execution.ts` (new)
- `packages/db/prisma/export-goal-lineage.ts` (new)
- `packages/db/package.json`
- `package.json`
- `packages/api/src/migration.dbtest.ts`

**Work:**

1. Implement `db:preflight-goal-execution` to print IDs/counts only and exit non-zero for every §12.1 condition plus the review-identified ambiguity cases. In particular, fail when one Task has both null and non-null `Run.goalId`; when its Runs do not all carry the same non-null Goal ID; or when any Session's `goalId`, `taskId`, or `projectId` is distinct from its owning Run. A passing backfill may copy identity only when every Run is non-null with the same Goal and every Session agrees; it must never fill a formerly null Run from a sibling. Require the recorded current-master and Control-plane A SHAs as arguments/environment and fail if evidence is absent or ancestry/current-HEAD checks fail.
2. Implement idempotent `db:verify-goal-execution` queries for zero partial/mismatched tuples, Session-versus-Run identity mismatches, duplicate iteration tuples, duplicate retry parents, open dispatches without Task/Run, more than one open dispatch, predecessor Goal/generation/previous-iteration discontinuity, and GoalExecutionEvent-to-Task/Run Goal/generation/iteration mismatches or illegal per-type identity shapes. Include the exact health query from §14.
3. Implement `db:export-goal-lineage` as a read-only, deterministic JSONL export of Goal, Task, Run, Session summary, and GoalExecutionEvent rows. Include original enum/status values and checksums; exclude prompts, outputs, fencing/session tokens, credentials, and secrets. Require an explicit output path and never mutate the database.
4. Add root passthrough scripts for all three commands. Make all scripts accept an injected database URL and operate on the URL's schema, never an implicit `public` schema.
5. Add fixtures for no history, multiple closed iterations, all-null manual lineage, mixed null/non-null Runs on one Task, inconsistent non-null Goal IDs, Session-versus-Run Goal/task/project disagreement, active linked Runs, project disagreement, and orphaned lineage. Prove every ambiguous/corrupt/active case aborts before migration with unchanged schema/data checksums and only the unambiguous fixtures pass.

**Verification:** Run the three focused commands against disposable fixtures. Assert non-zero exits and unchanged schema/data checksums on blocked cases, zero invariant violations—including predecessor/event/Session identity queries—on valid migrated fixtures, deterministic repeat exports, and absence of forbidden payload/token fields. Direct-corruption tests must show the composite predecessor/event FKs reject cross-Goal or cross-generation links and the verifier catches same-generation wrong-iteration predecessor/event-type mismatches that cannot be expressed by those FKs.

### 4. Add the shared Goal safety-kernel module and typed outcomes

**Files:**

- `packages/db/src/goal-execution.ts` (new)
- `packages/db/src/index.ts`
- `packages/db/src/workflow.ts`
- `packages/api/src/goal-execution.test.ts` (new)

**Work:**

1. Define exported typed inputs/results/conflicts for initial dispatch, decision, retry, pause/resume, cancel, and restart. Preserve the required 409 codes and distinguish created/replayed/conflict/error outcomes.
2. Implement canonical JSON serialization after validation/defaulting, sorted object keys, and SHA-256 request hashes. Equivalent absent/defaulted inputs hash identically; reused keys with different bodies produce `IDEMPOTENCY_KEY_REUSED` without echoing bodies.
3. Implement `lockGoalRow` with raw `SELECT "id","status","goalGeneration","nextGoalIteration" FROM "Goal" WHERE "id" = $1 FOR UPDATE`, and a Run lock helper with raw `FOR UPDATE`. Reuse the merged `lockTaskRow`, `lockAgentRow`, and `lockAgentRepoGrant` helpers from `packages/db/src/workflow.ts` rather than adding parallel ones.

   **Derive the order from current master, do not assert it.** Step 1.5 rebuilds this table on the then-current tree before any code is written; the rows below are the reading at `a4a4ba3`. "Order observed" is the sequence in which the writer actually takes row locks, counting an `updateMany` CAS as an implicit lock on the row it updates.

   | Current-master writer | Evidence | Order observed | Takes both grant and Agent? |
   | --- | --- | --- | --- |
   | `POST /tasks/:taskId/start` | `app.ts:2446-2557`, `workflow.ts:326` | Task or chain prefix (`FOR UPDATE`, ascending `chainIndex, id`) → **`AgentRepoAccess` exact (`FOR KEY SHARE`)** → **`Agent` (`FOR UPDATE`)** → Run insert | **yes — grant, then Agent** |
   | `POST /tasks/:taskId/retry` | `app.ts:2378-2445` | Task → `Agent` → Run insert | no grant lock |
   | `POST /projects/:projectId/tasks` | `app.ts:2016-2090` | `Agent` (`assignmentBlocked`) → Task insert → Run insert | no grant lock; unlocked grant read at `:2030` |
   | `PATCH /tasks/:taskId` (status/assignee) | `app.ts:2163-2372` | Task or chain prefix → `Agent` (`assignmentBlocked`/`reactivationBlocked`) → optional `enqueueTaskRun` (same `Agent` row) | no grant lock; unlocked grant read at `:2186` |
   | `activateChainSuccessor` | `workflow.ts:523-660` | Task rows (`lockTaskRow`) → `Agent` (via `enqueueTaskRun`) → Run insert | no grant lock |
   | template instantiation | `templates.ts:97-141` | `Agent` rows (`ORDER BY "id" FOR UPDATE`) → Task inserts → `Agent` again (`enqueueTaskRun`) → Run insert | no grant lock |
   | `fireCronTask` / AT fire | `scheduler.ts:148`, `:167-180` | Task CAS → Task insert → `Agent` (`enqueueTaskRun`) → Run insert | no grant lock |
   | `POST /runner/tasks/claim` | `app.ts:2856-3009` | no explicit lock; Serializable; Run CAS → Session → Task | neither |
   | `POST /runner/runs/:runId/complete` | `app.ts:3348-3520` | Task (conditional) → Run CAS → Session → optional Run insert → Task | neither |
   | `reconcileDatabaseRuns` | `reconcile.ts:135-257` | Task (`lockTaskRow`, `:135`) → Run CAS (`:138`) → Session (`:152`) → optional Run insert (`:179`) → Task (`:199`) | neither |
   | `applyInboxDecisionTx` | `workflow.ts:744-888` | predecessor Task → gate Task → `InboxMessage` OPEN CAS → Run CAS → Session | neither (gate reject reaches `enqueueTaskRun`, so `Agent` after Task) |
   | `POST /agents/:agentId/archive` | `app.ts:1052-1069` | `Agent` only | Agent only |
   | `DELETE /agents/:agentId/repos/:repoId/access` | `app.ts:1342-1359` | `AgentRepoAccess` exact (`FOR UPDATE`) only | grant only |

   Exactly one writer takes both rows, and it takes the grant first. The canonical order is therefore:

   | # | Row | Statement | Helper | Taken when |
   | --- | --- | --- | --- | --- |
   | 1 | `Goal` | `FOR UPDATE` | `lockGoalRow` (new) | every Goal-linked mutator |
   | 2 | `Task` — **existing rows only**, ascending `id` | `FOR UPDATE` | `lockTaskRow` (Goal Tasks carry no chain identity, so `lockChainPrefixRows` never applies) | the operation reads or mutates an existing Task |
   | 3 | `Run` — **existing rows only**, ascending `id` | `FOR UPDATE` | `lockGoalRunRows` (new) | the operation reads or mutates an existing Run |
   | 4 | `AgentRepoAccess` (exact `projectId`/`agentId`/`repoId`) | `FOR KEY SHARE` | `lockAgentRepoGrant` | the operation will create a Run |
   | 5 | `Agent` | `FOR UPDATE` | `lockAgentRow` | the operation will create a Run |
   | 6 | Task/Run/event inserts | — | kernel constructors | after 1–5 are held |

   This is an extension, not a fork:

   - Rows 2, 4, 5 in that sequence are exactly `POST /tasks/:taskId/start`'s observed order. Row 1 is a new strict prefix, so a writer that never touches a Goal is unchanged. Row 3 is new, and sits where spec I9 puts it (`docs/specs/goal-5a0-single-flight-lineage-safety-kernel.md:217-221`); no current writer takes the grant or Agent row before a Task or Run row, so inserting Run above rows 4–5 inverts nothing.
   - **Why direct create, archive, and revocation cannot cycle.** `POST /agents/:agentId/archive` takes row 5 and nothing else; `DELETE /agents/:agentId/repos/:repoId/access` takes row 4 and nothing else. A transaction holding one row and requesting no other cannot participate in a wait cycle: a cycle needs every member to hold one row while waiting for another. `POST /projects/:projectId/tasks` and `PATCH /tasks/:taskId` hold at most Task then row 5 and never request row 4 under lock, so their only shared edge with a Goal mutator is Task → Agent, which both take in that direction. Two Goal mutators, or a Goal mutator and manual start, both descend 4 → 5, so they queue instead of crossing.
   - A Goal mutator must never take row 4 or 5 and then reach back for row 1, 2, or 3, and must never take row 5 before row 4.

4. Apply the canonical order on every Goal-linked path, with mandatory locked re-reads immediately before any Task or Run insert:

   - **New-Task paths** (initial dispatch; successor dispatch, i.e. decision `action=dispatch`; restart). There is no Task or Run row for the target iteration, so there is nothing to lock at rows 2–3 for it: lock Goal (1); lock the predecessor Task and its Runs at rows 2–3 **only if** the operation reads or mutates them (successor dispatch does; initial dispatch and restart-into-a-new-generation do not); lock the exact grant (4); lock the assignee Agent (5); then insert Task, Run, and events. Rows created inside the transaction need no lock — they are invisible until commit, and `Task_one_open_goal_dispatch_key` remains the backstop.
   - **Existing-Task paths** (completion, automatic retry, source-based retry, reconciliation retry, decision, pause, resume, cancel). Lock Goal (1), Task (2), Run (3); then, **only if the operation will create a Run**, grant (4) and Agent (5). Pause, resume, cancel, and terminal decisions create no Run and stop at row 3.
   - **Locked re-reads.** The pre-lock discovery read never authorizes a write. After row 4 is held, require `lockAgentRepoGrant` to return true for the exact triple; after row 5, re-read `Agent.archivedAt` and `Agent.projectId` from the locked row. Re-read `Goal.status`, `Goal.goalGeneration`, `Goal.nextGoalIteration`, the Task lineage tuple, dispatch state, and Run status/lease/fence under their own locks before evaluating eligibility.
   - **Every operation is assigned explicitly**, so no path is left to inference:

     | Operation | Rows taken | Step |
     | --- | --- | --- |
     | initial dispatch | 1, 4, 5, insert | 4.7, 5.2 |
     | successor dispatch (decision `action=dispatch`) | 1, 2, 3, 4, 5, insert | 4.7, 6 |
     | terminal decision (`complete`, `fail`) | 1, 2, 3 | 4.7, 6 |
     | restart | 1, 4, 5, insert (old generation rows are read, never mutated) | 8.5 |
     | source-based retry (`POST /tasks/:taskId/runs/:sourceRunId/retry`) | 1, 2, 3, 4, 5, insert | 6.4 |
     | Goal-linked completion, no retry | 1, 2, 3 | 6.1-6.2 |
     | Goal-linked completion, automatic retry | 1, 2, 3, 4, 5, insert | 6.3 |
     | reconciliation retry | 1, 2, 3, 4, 5, insert | 7.1 |
     | reconciliation, no child | 1, 2, 3 | 7.2, 7.5 |
     | pause / resume / cancel | 1, 2, 3 | 8.1, 8.4 |
     | Goal-linked claim | 1, 2, 3 | 8.2 |
     | Inbox resume authority | 1, 2, 3 | 9.5 |

5. Preserve **route-specific** typed behavior exactly. An archived assignee or a missing exact grant discovered under locks is a validation failure with the semantics the corresponding current route already has, never a new code and never a uniform status. Spec §7.1 step 4 requires create-like validation "exactly as current Task creation does" and §8 requires that "validation/project/assignee/repo-grant failures retain current 400/404 behavior", so the classification is derived from the route each Goal operation follows:

   | Goal operation | Follows | Archived assignee | Missing exact grant |
   | --- | --- | --- | --- |
   | initial dispatch (`POST /goals/:goalId/dispatches`) | current Task creation (`app.ts:2016-2044`) | **400** `Assignee <name> is archived` | **400** `Assignee has no grant for this Repo` |
   | successor dispatch (`POST /goals/:goalId/iterations/:goalIteration/decision`, `action=dispatch`) | current Task creation | **400**, same sentence | **400**, same sentence |
   | restart (`POST /goals/:goalId/restart`) | current Task creation | **400**, same sentence | **400**, same sentence |
   | source-based retry (`POST /tasks/:taskId/runs/:sourceRunId/retry`) | current `POST /tasks/:taskId/retry` (`app.ts:2408-2411`) | **409** `Assignee <name> is archived; unarchive it to retry` | **400** `Assignee has no grant for this Repo` (the retry route takes no grant lock today; the kernel adds row 4, and a missing grant is a configuration failure, so it keeps the 400 every other grant refusal returns) |
   | manual `POST /tasks/:taskId/retry` delegating for a Goal Task | itself, unchanged | **409**, current sentence | **400**, as above |
   | Goal-linked completion with automatic retry (`POST /runner/runs/:runId/complete`) | itself; the runner's completion must not start failing | no new status: the child is not created and the completion takes the awaiting-decision branch of Step 6.2, recording the terminal Run/Session and `AWAITING_DECISION` | same |

   `ArchivedAssigneeError` is raised only where a path actually reaches `enqueueTaskRun` today; the kernel bypasses `enqueueTaskRun`, so create-like Goal paths raise the create-shaped 400 instead of borrowing that 409. No iteration number, generation, dispatch key, decision key, or event is consumed on any of these refusals, and the predecessor remains `AWAITING_DECISION` (spec §11, `:804-806`). The named 409 set in "Exact implementation surface" is unchanged: Goal 5a0 adds no conflict code, and it does not introduce a uniform 409 — the Product Contract does not authorize one.
6. Centralize Goal-linked Task/Run data construction, the locked assignee/exact-grant validation above, `deriveRunConfig`, `resolveRunBranches`, limits, ordinary NOW Task fields, copied lineage tuple, Run number/dedupe fields, retry ancestry, and deterministic event creation. `enqueueTaskRun` rejects Goal-linked Tasks so no caller can bypass the kernel; because that rejection also removes `enqueueTaskRun`'s own locked-assignee re-read from the Goal path, the kernel's row-4/row-5 sequence is the sole replacement and every Goal Run constructor must route through it.
7. Implement `createInitialGoalDispatch`, `applyGoalDecision`, `retryGoalTaskRun`, pause/resume, cancel, and restart exactly as spec §7. Each public operation runs in one Serializable transaction with bounded retry only for PostgreSQL serialization/deadlock failures; logical 409s are not retried.
8. Replay lookup occurs before current-state validation while holding the Goal lock. Same-key replay returns stored IDs/result; different-key stale work conflicts. Event cardinality is explicit: every successful non-no-op transition writes exactly one durable event except restart, which is one compound operation that atomically writes exactly two events—`GOAL_RESTARTED` and `DISPATCH_CREATED`—for the same new Goal/Task/Run tuple. This restart-specific rule in spec §7.7 governs the generic singular wording in I10/§14; it does not add an event type or broaden scope. Replay/no-op writes zero events. The one post-commit operation log records `eventCount` (`2` for restart, `1` for other transitions, `0` for replay/no-op).
9. **Record the canonical order as the handoff artifact.** Write the row table from 4.3, its per-operation assignment from 4.4, and the acyclicity argument into `docs/reviews/goal-5a0-current-master-revalidation.md` and the Step 14 runbook under the exact heading "Canonical Goal execution row order", as one sentence any later work stream can quote verbatim:

   > Goal (`FOR UPDATE`) → existing Task rows (`FOR UPDATE`, ascending `id`) → existing Run rows (`FOR UPDATE`, ascending `id`) → exact `AgentRepoAccess` row (`FOR KEY SHARE`, `(projectId, agentId, repoId)`) → `Agent` (`FOR UPDATE`) → inserts.

   This is the order the Inbox 3a docs PR **#95** must adopt when it inherits the handoff. #95 currently records `Goal → Task → Agent → exact AgentRepoAccess → Run/lineage` (its plan's step 1.5, step 2 claim, and `claimInboxResumeRequest` in step 8) and, separately, `Goal → Task prefix → exact AgentRepoAccess → Run → Session → Question` in its fixed decision 13. Neither matches current master: the first inverts grant and Agent, and both are inconsistent with each other. Goal 5a0 does not edit #95 — the ownership table below assigns that correction to #98's post-merge write-surface review, which must replace both wordings with the sentence above and re-derive it from the merged tree rather than from either document.

**Verification:** Unit tests cover canonical hashing/default equivalence, every conflict mapping, event dedupe keys, canonical row order, manual-vs-Goal construction, replay-before-state behavior, no prompt/token leakage, exact per-operation event cardinality (including two for restart), and transaction rollback on an injected failure between each logical write/event. A lock-order test records the emitted statement sequence for every public operation listed in 4.4's assignment table and asserts the observed rows are a strictly ascending subsequence of Goal → Task → Run → `AgentRepoAccess` → `Agent` with no reach-back and no row 5 before row 4; the same test asserts each operation takes exactly the rows its table entry names and no others. A construction test asserts that no Goal Run is created on any path that did not first hold rows 4 and 5. A route-classification test asserts the exact status and body of each cell in 4.5's table against the current-master sentences read in Step 1.

### 5. Register the Goal execution HTTP contract and read models

**Files:**

- `packages/api/src/goal-execution.ts` (new)
- `packages/api/src/app.ts`
- `packages/api/src/goals.test.ts`
- `packages/api/src/goal-execution.test.ts`
- `.env.example`

**Work:**

1. Put Zod schemas, defaulting, route registration, feature-flag evaluation, response serialization, and typed error mapping in `goal-execution.ts`; keep the database transitions in `@agentos/db`.
2. Register the exact routes/payloads/statuses from spec §8: initial dispatch; iteration decision; resume/cancel/restart; source-based retry; lineage; and cursor/limit execution events. Keep operator authentication and reject Goal control fencing tokens.
3. Make `GOAL_SAFETY_KERNEL_ENABLED` default false. Disabled state rejects creation of initial/successor dispatch, retry, and restart without mutation; completion of already-running Goal work may record terminal evidence but may not create a retry/successor. Pause/cancel remain safety controls.
4. Add generation, next iteration, open dispatch summary, and computed `spendEvidence` to Goal list/detail. Build lineage from persisted tuple fields—not event timestamps—and order generations/iterations/runs deterministically. Page events by the located `after` event's `(createdAt,id)` tuple with a limit of 1–500.
5. Classify named P2002 constraints into replay or the required 409 response; unexpected database errors remain errors. Conflict payloads include only current identity/state, never stored request bodies. Map the kernel's locked exclusion-protocol outcomes to the **existing** route-specific responses from Step 4.5 and add no new code: a create-like refusal (initial dispatch, successor dispatch, restart) returns the current Task-creation `400` — `Assignee <name> is archived` for an archived assignee, `Assignee has no grant for this Repo` for a missing exact grant; the source-based retry route returns the current retry-route `409 "Assignee <name> is archived; unarchive it to retry"` for an archived assignee and the same `400` for a missing grant. There is **no** uniform 409 for this class, and no create-like path borrows `ArchivedAssigneeError`.
6. Change Goal DoD routes so approval/item edits only maintain DoD facts. They no longer directly complete or reopen a governed Goal; `applyGoalDecision(action=complete)` is the sole completion writer and revalidates approved/non-empty/all-satisfied DoD under lock. Preserve explicitly revalidated legacy empty-Goal behavior only if Step 1 proves it is still required and record that branch.
7. Guard Goal deletion: empty Goals retain current behavior; any Task/Run/event lineage returns 409.

**Verification:** HTTP tests assert request validation, authentication, 201/200 replay contracts, every named 409 code/current shape, disabled-flag behavior, DoD completion ownership, delete restriction, stable lineage ordering, event cursor behavior, and no body/fencing-token leakage. Add route-classification tests for the already-archived and missing-grant cases on **initial dispatch, successor dispatch, restart, and source-based retry** — an assignee archived (or a grant revoked) before the request arrives, so the pre-lock read already sees it — each asserting the exact status and body from Step 4.5's table and asserting zero mutation: no Task, no Run, no `GoalExecutionEvent`, `Goal.nextGoalIteration` and `Goal.goalGeneration` unchanged, no `goalDispatchKey`/`goalDecisionKey` row written, and the predecessor Task still `AWAITING_DECISION` where one exists. The archive-wins interleavings of the same cases are the real-database races in Step 12 tests 21-23.

### 6. Integrate Goal-aware completion and all retry sources atomically

**Files:**

- `packages/api/src/app.ts`
- `packages/db/src/goal-execution.ts`
- `packages/api/src/goal-execution.dbtest.ts` (new)
- `packages/api/src/app.test.ts`
- `packages/api/src/tasks.dbtest.ts`

**Work:**

1. Preserve the existing lease/fencing predicate. For a Goal-linked completion, discover identity, then lock/re-read Goal → Task → Run (canonical rows 1-3) before terminal mutation. The current route takes the Task row only conditionally (`app.ts:3373`, `:3379`); the Goal branch takes rows 1-3 unconditionally.
2. On success or non-retried failure, atomically terminalize Run/Session, set Task `REVIEW` plus `AWAITING_DECISION`, and append `RUN_AWAITING_DECISION`. Do not invoke template/chain/follow-up advancement for a Goal Task.
3. On retryable failure below the ceiling, re-read active Goal under lock, then take rows 4 and 5 — exact grant, then `Agent` — and create exactly one child via the shared source-based retry primitive, keeping the Goal tuple/Task and setting `retryOfRunId`. The current completion path inserts its automatic retry Run (`app.ts:3451`) while holding neither row, so this is a new, strictly stronger protocol joined in the canonical direction. A paused or disabled kernel follows the awaiting-decision branch. **An archived assignee or a missing exact grant found under those locks also follows the awaiting-decision branch**: the runner's completion route must not begin returning a new 4xx, so the child is simply not created, the terminal Run/Session evidence and `AWAITING_DECISION` are still written, and the operator decides from there (Step 4.5, last row). A uniqueness collision reads the child as replay rather than returning 500.
4. Add `POST /tasks/:taskId/runs/:sourceRunId/retry`, taking canonical rows 1-5. Preserve manual `POST /tasks/:taskId/retry`; for Goal Tasks it resolves the latest terminal source and delegates, returning an existing active child as replay. Both routes keep the current retry route's archived-assignee semantics — `409 "Assignee <name> is archived; unarchive it to retry"` (`app.ts:2410`) — and return `400 "Assignee has no grant for this Repo"` when row 4 fails.
5. Ensure a stale/terminal/cancelled/fenced completion returns the established 409 and changes no Goal/Task/Run/Session/event state.
6. Split inherited Inbox side effects before entering the Goal branch. Manual Tasks retain the existing run-budget-exhausted and per-completion authentication messages. Goal-linked completion/retry/exhaustion/authentication paths create no Inbox row: budget/lifecycle messages are deferred to Goal 5a1, and a Goal failure must not acquire Inbox integration indirectly. The existing runner-backend preflight/circuit-open operational alert remains unchanged and system-wide; it is the only applicable alert because it is emitted from backend health state, not Goal lifecycle. Existing human-authored Inbox questions already attached to a `WAITING_INBOX` Run remain readable; Goal 5a0 only fences them on cancel and emits no replacement message.

**Verification:** Real-DB tests cover success, terminal failure, automatic retry, attempt exhaustion, paused/disabled no-retry, archived-assignee and revoked-grant no-retry with the completion route still returning its normal success response, exact manual replay, simultaneous automatic/operator retries, stale fencing, rollback, and zero new Inbox rows for Goal-linked budget exhaustion, authentication-circuit failure, terminal failure, retry, pause, cancel, decision, and reconciliation. Regression tests prove manual Task budget/authentication messages and the system-wide runner-backend preflight/circuit alert still behave as before. Existing manual Task completion/retry, chain successor, output, delivery, lease, and fencing tests pass unchanged except for additive assertions.

### 7. Make reconciliation restart-safe and lineage-aware

**Files:**

- `packages/api/src/reconcile.ts`
- `packages/api/src/index.ts`
- `packages/db/src/goal-execution.ts`
- `packages/api/src/reconcile.test.ts`
- `packages/api/src/goal-execution.dbtest.ts`

**Work:**

1. For a Goal-linked orphan, lock Goal → Task → Run (rows 1-3), CAS the source to LOST, terminalize Session, then take rows 4 and 5 — exact grant, then `Agent` — and use the same retry-parent primitive. Reconciliation never increments iteration or guesses a successor. An archived assignee or missing grant under those locks follows item 2: the LOST evidence stands, the Task moves to `AWAITING_DECISION`, and no child is created.
2. If Goal is paused/cancelled/stale or the kernel is disabled, preserve the terminal LOST evidence, move the open Task to `AWAITING_DECISION` where applicable, and create no child.
3. Two startup/reconciliation callers read the one existing child on retry-parent conflict; a replayed pass creates neither a second LOST transition nor event.
4. Add startup invariant reporting after database reconciliation. Impossible lineage, missing Task/Run for an open dispatch, or multiple open dispatches prevents kernel enablement and emits queryable structured evidence; startup does not auto-repair it.
5. Make the `WAITING_INBOX` expiry sweep Goal-aware without giving it Goal authority. `reconcile.ts` selects expired waiting Runs and moves them to `TIMED_OUT` (`reconcile.ts:218-229`) while closing the open card (`:242-247`) with no Goal lock. For a Goal-linked expired Run, take canonical rows 1-3 (Goal → Task → Run) first, keep the same terminal Run/Session/card writes, move the open Task to `AWAITING_DECISION` instead of the generic `REVIEW` + `failureReason` write, and create no successor and no Inbox row. The sweep creates no Run, so it never takes rows 4-5. A Run whose Goal is already terminal is left as cancel left it; the sweep never revives it. Manual (`goalId` null) expiry behaviour is unchanged.

**Verification:** Two independent clients and a pre-lock rendezvous prove one LOST transition/event and at most one child. Repeat after constructing new clients to prove restart safety. Unit tests prove impossible-state reporting and no guessed successor. Real-DB tests prove the Goal-linked expiry sweep produces `AWAITING_DECISION` with no successor and no Inbox row, that it is a no-op on an already-cancelled Goal, and that `packages/api/src/reconcile.test.ts`'s existing manual `WAITING_INBOX` retention and eviction assertions pass unchanged.

### 8. Enforce pause, claim, decision, cancel, and restart race semantics

**Files:**

- `packages/db/src/goal-execution.ts`
- `packages/api/src/goal-execution.ts`
- `packages/api/src/app.ts`
- `packages/api/src/goal-execution.dbtest.ts`
- `packages/api/src/goals.test.ts`

**Work:**

1. Pause/resume are Goal-row-locked, idempotent state transitions with one event on a real transition and no event on a same-state replay. Pause leaves a claimed Run's fence valid but blocks claims, retries, and decisions.
2. Extend claim eligibility without reversing the canonical row order. Candidate discovery remains non-locking. A manual candidate retains the current claim transaction, whose observed write order is Run CAS (`app.ts:2899`) → Session → Task and which takes no explicit lock. For a Goal-linked candidate, begin a fresh Serializable attempt, set the bounded lock timeout, lock/re-read Goal `FOR UPDATE`, then Task `FOR UPDATE`, then Run `FOR UPDATE`; only then re-evaluate Goal `ACTIVE`, Task `EXECUTING`, exact Goal/Task/Run tuple, current generation, queued status, lease generation, readiness, agent/repo eligibility, and dependency state. Update the locked Run lease/fence, Session, then Task without acquiring any later Goal/Task lock. The Run CAS remains defense in depth/winner selection, but a pre-lock candidate row never authorizes the write. Claiming creates no Run, so it takes rows 1–3 of the canonical order only and takes neither the grant nor the Agent row; agent and repo eligibility stay the merged claim path's own unlocked checks — the candidate query's `agent: { archivedAt: null }` predicate (`app.ts:2861`) and the per-candidate `agent.repoAccess.some(grant => grant.repoId === candidate.repoId && grant.projectId === candidate.projectId)` filter (`:2892`) — unchanged. If a claim is ever made to create or requeue a Run, it must extend to rows 4 and then 5 first.
3. Retry the entire Goal-linked claim transaction at most three times for PostgreSQL `40P01` deadlock or `40001` serialization failures, with the same candidate identity and bounded per-attempt timeout; after exhaustion return the existing retryable service failure and no claim mutation. Logical ineligibility/CAS loss is not retried. Add structured attempt/outcome evidence so the concurrency suite distinguishes a valid losing claim from an unclassified database error.
4. Cancel serializes against claim/completion/decision through the same canonical row order, fills deterministic decision fields on the open Task, terminalizes Goal/open Task/active Run/Session, clears lease authority/revokes tokens, and writes one `GOAL_CANCELLED` event. Repeated cancel returns state without a second event. Cancel also terminalizes a `WAITING_INBOX` Run of the Goal Task (spec §7.6 already lists `WAITING_INBOX` among the Run statuses cancel closes, `:546-547`) and closes its `OPEN` waiting card with the idempotent write `inboxMessage.updateMany({ where: { id: session.waitingOnMessageId, status: OPEN }, data: { status: CLOSED } })` — byte-identical in shape to the existing expiry sweep at `reconcile.ts:242-247`, creating no Inbox row and sending no notification, so it stays inside spec §11's "adds no Inbox behavior". Pause leaves such a Run suspended and its card `OPEN` (spec §11, `:814-816`).

   That card close is the **compare-and-set that decides the cancel-versus-answer race**, and it is what makes Step 9.5's contract reachable: on current master the only answer mutex is `InboxMessage.status = OPEN` (`workflow.ts:806-810`), so a cancel that closes the card has already consumed it, and a later delivery loses the same CAS. Cancel does not delete, rewrite, or reopen any reply message or `InboxDecision` row an answer that won first had already committed.
5. Restart is one transaction and allowed only from the specified terminal non-completed statuses. Same key replays; a new key/generation conflict returns 409. It increments generation once, preserves old rows, creates iteration-1 Task/Run, sets next iteration 2, and writes exactly two events—`GOAL_RESTARTED` plus `DISPATCH_CREATED`—atomically.
6. Old-generation completion and decisions fail both Run and Goal fences without changing new-generation counts/state.

**Verification:** Controlled real-DB races prove both valid pause/claim and cancel/claim orders, pause/automatic-retry outcome, both cancel/completion and cancel/decision orders, same/different-key restart races, and stale old-generation rejection. In cancel-versus-claim, cancel-first leaves the Run unclaimed; claim-first may return credentials but cancel revokes them before any accepted runner write. Both orders finish without deadlock, contain one original Run and no successor, and end with the Goal/Task/Run cancelled. Assert exact states, event cardinality (restart two; cancel one), retry-attempt classifications, and row counts—not “success or arbitrary error.”

### 9. Fence generic Task, scheduler, template, chain, and delete writers

**Files:**

- `packages/api/src/app.ts`
- `packages/api/src/scheduler.ts`
- `packages/api/src/templates.ts`
- `packages/db/src/workflow.ts`
- `packages/api/src/tasks.dbtest.ts`
- `packages/api/src/scheduler.dbtest.ts`
- `packages/api/src/chain.dbtest.ts`
- `packages/api/src/triggers.dbtest.ts`
- `packages/api/src/workflow.test.ts`
- `packages/api/src/inbox.test.ts`
- `packages/api/src/goal-execution.dbtest.ts`

**Work:**

1. Reject generic schedule, status, archive, hard-delete, start, chain/follow-up activation, template, recurring-copy, CRON/AT, approval-gate, or direct Run enqueue operations when Task lineage is non-null. Only the Goal kernel changes governed Task status/dispatch state or creates its Runs.
2. Public Task creation and patch schemas never accept Goal lineage fields. Internal scheduler/template/chain constructors explicitly set none and are defended by database checks.
3. Preserve every manual/chain/template/CRON/AT code path and current lock/CAS behavior. Do not merge Goal succession with chain successor authority.
4. Preserve workspace retention, branch routing, delivery, Task output, Session usage, and existing human Inbox waiting records except cancellation may terminalize an existing `WAITING_INBOX` Goal Run. Enforce Step 6's side-effect split: generic/manual Task messages and the system-wide runner-backend preflight/circuit alert remain; Goal-linked completion/retry/control/reconciliation creates no Inbox record in Goal 5a0.
5. **Cancellation fence on the Inbox resume path.** `packages/db/src/workflow.ts::applyInboxDecisionTx` today moves a `WAITING_INBOX` Run to `QUEUED` with a status CAS and no Goal lock (`workflow.ts:876-880`), so a Goal-linked Run can regain claimable authority from an answer that arrives after cancellation. Fence it without implementing Inbox 3a, and state only outcomes that function can actually produce.

   The two facts that bound what is implementable here, both read at `a4a4ba3`:

   - A non-gate decision whose Run is no longer `WAITING_INBOX` **throws** `No matching waiting Inbox question` at `workflow.ts:769-771`, before any write.
   - A decision whose card is no longer `OPEN` loses the `updateMany` CAS at `workflow.ts:806-810` and returns `{ duplicate: true, resumed: false }`, before the reply message (`:821`) and the `InboxDecision` row (`:838`).

   Both refusals therefore write nothing. There is no reachable path on which a post-cancellation delivery records a reply or an `InboxDecision`: cancel has already closed the card and terminalized the Run, so the delivery has lost the only mutex the current schema has. Round 2's "the answer is still recorded and the card is still closed" promise was not implementable and is removed.

   The minimal in-scope contract, which matches the peer Inbox 3a spec's own linearization ("an answer and expiry/cancel race use the same Question-row CAS; exactly one wins", and S11 "cancellation/expiry wins the state CAS before an answer … a later answer is harmless"):

   1. After loading the question, resolve `question.session.run.goalId` **before** taking any Task lock. When it is null, the function keeps its current guard order, lock sequence, throws, and writes byte for byte. When it is non-null, take `lockGoalRow` first so the transaction still descends the canonical order Goal → Task → Run.
   2. Under that Goal lock, re-read Goal status and generation, and re-read the Run row at row 3, and compare with the Run's persisted `goalGeneration`/`goalIteration`. Resume is authorized only when the Goal is `ACTIVE` and the tuple is current.
   3. **Cancel-first.** Cancel closed the `OPEN` card and terminalized/fenced the Run (Step 8.4). The later delivery is a duplicate: it returns `{ duplicate: true, resumed: false }` having written **nothing** — no new reply message, no `InboxDecision`, no Run or Session write, no lease, no fencing token, no Goal event. On the Goal path this replaces the `workflow.ts:769-771` throw with that duplicate return, because the delivery is a genuine late duplicate of a decision the cancel already resolved and an exception would misreport it to the connector as retryable. Repeated deliveries of the same `externalEventId` remain duplicates for the same reason.
   4. **Answer-first.** The answer won the `OPEN` CAS while the Goal was still `ACTIVE`, so it commits exactly as today: card `ANSWERED`, one reply message, one `InboxDecision`, Run `QUEUED`, Session `REQUESTED`, `{ duplicate: false, resumed: true }`. A cancellation arriving afterwards terminalizes and fences that queued Run through Step 8.4 and **erases no evidence**: the reply message and the `InboxDecision` row are immutable and stay, and the card stays `ANSWERED`. The Run never reaches a runner because cancel revokes lease and session authority before any accepted runner write (Step 8.4, spec §7.6).
   5. **Paused or stale generation, card still `OPEN` and Run still `WAITING_INBOX`.** Resume is not authorized, but nothing has been consumed. Write nothing, leave the card `OPEN` and the Run `WAITING_INBOX`, and return `{ duplicate: false, resumed: false }`. Pause is not terminal, so the card must survive for a post-resume answer; the `OPEN` CAS keeps the delivery idempotent without recording anything. This is the one non-terminal branch, and Goal 5a0 defines only this much of it: the resume-window and re-ask policy that decides what *should* happen to a paused Goal's waiting card belongs to Inbox 3a (#98) and is named in the non-scope list below.
   6. Goal 5a0 adds no Inbox message here. It does not notify, retarget, or re-ask.

   Final states, both orders, as the tests must assert them:

   | Interleaving | Card | Reply messages | `InboxDecision` rows | Run | Goal events | Return |
   | --- | --- | --- | --- | --- | --- | --- |
   | cancel, then delivery | `CLOSED` (by cancel) | 0 | 0 | `CANCELLED`, no lease, token revoked | exactly one `GOAL_CANCELLED` | `{ duplicate: true, resumed: false }` |
   | delivery, then cancel | `ANSWERED` (by the answer) | 1 | 1 | `CANCELLED`, no lease, token revoked | exactly one `GOAL_CANCELLED` | answer `{ duplicate: false, resumed: true }`; cancel returns terminal state |
   | delivery, then delivery, then cancel | `ANSWERED` | 1 | 1 | `CANCELLED` | one `GOAL_CANCELLED` | first `resumed: true`, second `{ duplicate: true, resumed: false }` |
   | cancel, then delivery, then delivery | `CLOSED` | 0 | 0 | `CANCELLED` | one `GOAL_CANCELLED` | both `{ duplicate: true, resumed: false }` |

   Neither order leaves an `OPEN` card on a terminal Goal, a live lease, a valid fencing token, a claimable Run, or a second `GOAL_CANCELLED` event; and no order produces two reply messages or two `InboxDecision` rows.

6. **Handoff seam for Inbox 3a.** Express the fence as one exported predicate in `packages/db/src/goal-execution.ts` — `goalRunResumeAuthority(tx, runId): "resume" | "no-resume"` — called from `applyInboxDecisionTx` under the Goal lock. The name `record-only` is retired: it described a write this path cannot perform. `no-resume` carries no promise about recording; what the caller does next is decided by the observed card/Run state in 9.5.3 and 9.5.5. Inbox 3a (#98) later replaces the `no-resume` branch with its own Question/Answer/ResumeRequest orchestration; it must not delete the predicate or the Goal lock that precedes it, and it owns the paused-Goal resume-window policy. Record this seam in the runbook and in the ownership table below so #98 inherits a named contract rather than a merge conflict. Goal 5a0 designs nothing else about Inbox 3a's internals.

**Verification:** Negative tests cover every forbidden generic operation on a Goal Task. Existing manual start/retry, API chain successor, template, webhook, CRON, AT, claim, fencing, completion, and archive suites remain green. Direct manual all-null Task/Run creation still works. `packages/api/src/inbox.test.ts` gains: a manual (`goalId` null) answer whose guard order, lock sequence, thrown error text, and result are byte-for-byte unchanged, including the unchanged `No matching waiting Inbox question` throw when a manual Run has left `WAITING_INBOX`; a Goal-linked answer on an `ACTIVE` Goal that resumes exactly as today; a Goal-linked delivery after cancellation that writes nothing and returns `{ duplicate: true, resumed: false }`; and a Goal-linked delivery on a `PAUSED` Goal that writes nothing, leaves the card `OPEN` and the Run `WAITING_INBOX`, and returns `{ duplicate: false, resumed: false }`. Each asserts the full row counts from 9.5's table.

### 10. Add evidence-scoped spend reads and structured observability

**Files:**

- `packages/api/src/goal-observability.ts` (new)
- `packages/api/src/goal-execution.ts`
- `packages/api/src/app.ts`
- `packages/api/src/index.ts`
- `packages/db/src/usage.ts`
- `packages/api/src/goal-execution.test.ts`
- `packages/api/src/goal-execution.dbtest.ts`
- `packages/api/src/usage.test.ts`
- `packages/api/src/usage.dbtest.ts`

**Work:**

1. Add one read helper that computes `spendEvidence` from terminal Sessions joined through persisted Run/Task Goal lineage in one Repeatable Read snapshot: PostgreSQL `numeric` sum of non-null `Session.costUsd`, priced/unpriced counts, and `complete|partial` coverage. Zero terminal sessions produces numeric zero, counts zero, and complete coverage; any null-cost terminal Session makes coverage partial. Never infer dollars from tokens.
2. Make terminal Session rows the only spend source of truth. Do not increment `Goal.spendUsd` during ingestion. Goal list/detail serializers override the legacy `spendUsd` response field with the same computed numeric value returned as `spendEvidence.knownProviderCostUsd`; both serialize to exactly four fractional digits, use PostgreSQL numeric/Prisma Decimal only (never binary float), and therefore compare numerically equal. The derived response is not constrained by the legacy column's `Decimal(12,2)` storage width; if PostgreSQL cannot represent/serialize the arbitrary-precision sum, fail the read with a typed evidence error rather than clamp, wrap, or claim a smaller total. The stored legacy column is non-authoritative and is not used for spend-cap enforcement, which remains out of scope.
3. Keep `recomputeSessionUsage`'s per-Session advisory lock/absolute FINAL_OUTPUT recompute in `packages/db/src/usage.ts`; after late or concurrent recomputes commit, the next Goal read takes a new database snapshot and derives from the repaired Session columns. Do not add a cross-Session accumulator that can lose updates. Tests coordinate two FINAL_OUTPUT recomputes with the existing usage lock barriers, then read through a separately constructed client and prove `spendUsd == knownProviderCostUsd`, exact four-decimal rounding, and correct priced/unpriced coverage.
4. Add a single stdout JSON adapter in `goal-observability.ts`; do not introduce a metrics dependency. Every record has `recordType: "agentos.goal.operation" | "agentos.goal.metric"`, `schemaVersion: 1`, ISO `emittedAt`, and non-secret Goal context. Operation records additionally have `operation`, `outcome`, integer `latencyMs`, `eventCount`, and nullable `goalId`, `goalGeneration`, `goalIteration`, `taskId`, `runId`; emit one after commit, and one with `eventCount: 0` for replay/rejected/stale attempts. Durable events remain transaction-authoritative.
5. Metric records have `metric`, `metricType: "counter_delta" | "gauge_snapshot"`, numeric `value`, and a stable `labels` object. Emit value `1` counter deltas for `goal_dispatch_total{outcome}`, `goal_decision_total{action,outcome}`, `goal_retry_total{source,outcome}`, and `goal_stale_operation_total{operation}`. Emit `goal_spend_sessions{coverage=priced|unpriced}` as per-Goal gauge snapshots whose two values are the current terminal Session counts. Emit global `goal_open_dispatches` and `goal_lineage_invariant_violations` gauge snapshots at startup and after each Goal transition, using the database queries from Steps 3/14. Gauges are queried as the latest record by `(metric, labels, goalId)`; counters are summed over the evidence window.
6. The operational sink contract is newline-delimited JSON on the existing service stdout/stderr collector. Goal 5a0 assumes only that the implementation evidence window can export those lines; it makes no retention/SLA promise and adds no Goal 5a1 alert. Put these exact queries in the runbook/evidence document (with `goal-metrics.jsonl` as the captured evidence file), and capture both raw JSONL and query output:

   ```sh
   jq -s '[.[] | select(.recordType == "agentos.goal.metric" and .schemaVersion == 1 and .metricType == "counter_delta")] | group_by([.metric, (.labels | tojson)]) | map({metric: .[0].metric, labels: .[0].labels, value: (map(.value) | add)})' goal-metrics.jsonl
   jq -s '[.[] | select(.recordType == "agentos.goal.metric" and .schemaVersion == 1 and .metricType == "gauge_snapshot")] | sort_by(.metric, (.labels | tojson), (.goalId // ""), .emittedAt) | group_by([.metric, (.labels | tojson), (.goalId // "")]) | map(last | {metric, labels, goalId, value, emittedAt})' goal-metrics.jsonl
   ```

**Verification:** Capture JSONL in tests and run the documented `jq` queries; assert one operation record per committed operation (restart `eventCount: 2`), stale/replay records with no new durable event, exact schema/version/metric dimensions, integer latency/value fields, no secrets, counter sums, and latest-snapshot gauge values. Real-DB spend tests cover late and concurrent FINAL_OUTPUT recomputes plus complete, partial with a null-cost Session, no-priced-session, zero-terminal-session, four-decimal values, and a synthetic sum wider than the legacy column; each asserts computed `spendUsd == knownProviderCostUsd` and no “total spend” wording.

### 11. Make the existing Goal UI truthful about new statuses and spend evidence

**Files:**

- `apps/web/src/lib/types.ts`
- `apps/web/src/components/ui.tsx`
- `apps/web/src/pages/Goals.tsx`
- `apps/web/src/locales/en.ts`
- `apps/web/src/locales/zh.ts`
- `apps/web/src/tests/goals.test.tsx` (new)

**Work:**

1. Add `FAILED`/`CANCELLED`, generation/iteration/open-dispatch, lineage/event, and `spendEvidence` response types. Add exhaustive pill tones and translations for new statuses.
2. Replace the list/detail “Spend” presentation with known provider cost/subtotal plus priced/unpriced coverage. When coverage is partial, visibly qualify it; do not calculate dollars from tokens.
3. Display persisted lineage identity in Goal detail only to the extent supported by the new read response. Do not add Inbox integration, waiver UX, lifecycle notifications, or a public release surface.

**Verification:** Static-render tests cover both new statuses and complete/partial/no-priced/zero-session wording in English and Chinese. Existing i18n allowlist, UI unit tests, build, and typecheck pass.

### 12. Build the executable real-PostgreSQL concurrency proof suite

**Files:**

- `packages/api/src/goal-execution.dbtest.ts` (new)
- `packages/api/src/testdb.ts`
- `packages/api/src/migration.dbtest.ts`
- `packages/api/src/inbox.test.ts`
- `packages/db/prisma/acceptance-fixture.ts` (read-only fixture; seeded, not edited)
- `packages/api/package.json` (only if a focused script is needed; aggregate `test:db` remains authoritative)

**Work and required named tests:**

Use the real PostgreSQL harness, two separately constructed `PrismaClient` instances, and reusable pre-lock/CAS rendezvous instrumentation based on the proven `scheduler.dbtest.ts` pattern. No mock, sequential call, sleep-only race, or arbitrary-success/error assertion qualifies.

1. `dispatch different keys: 201/409 and one lineage` — one Task, Run, open dispatch, and event.
2. `dispatch same key: create plus exact replay` — identical IDs and one row set.
3. `dispatch replay after client restart` — reconstruct app/client and return identical IDs.
4. `two dispatch decisions: one successor` — one iteration N+1 Task/Run/event.
5. `decision replay after client restart` — return original successor.
6. `two retries: one source child` — exact next run number and same tuple.
7. `automatic/operator/reconcile retry races` — each pair/interleaving has at most one child.
8. `two reconciliation passes: one LOST and child`.
9. `restart same and different keys` — generation increments once; replay or 409 as specified; the winning operation writes exactly one `GOAL_RESTARTED` and one `DISPATCH_CREATED` event for the same tuple, while replay writes neither.
10. `old generation completion and decision are stale` — new generation unchanged.
11. `pause versus claim` — assert both serialized outcomes and no duplicate Run.
12. `cancel versus claim follows Goal-Task-Run locks` — exercise cancel-first and claim-first barriers; no deadlock/unclassified error, one original Run, no successor, final cancelled/fenced state.
13. `pause versus automatic retry` — paused, awaiting decision, no child.
14. `cancel versus completion/decision` — one terminalized outcome, final cancelled, no successor.
15. `direct open-dispatch inserts hit partial unique index`.
16. `composite lineage and all-null checks reject corruption`.
17. `predecessor and event identity reject/catch corruption` — composite FKs reject cross-Goal/cross-generation identities; verifier catches wrong previous iteration and illegal event shapes.
18. `Goal paths emit no Inbox lifecycle rows` — budget, auth failure, terminal failure, retry/control/reconcile remain zero while manual/system-wide alert regressions stay green.
19. `manual/scheduler/chain/claim/fencing/completion regressions remain green`.
20. `spend evidence stays evidence scoped and current` — complete, partial, none priced, zero terminal, late/concurrent FINAL_OUTPUT recomputes, equality of computed `spendUsd`/known subtotal, and wide sums.
21. `initial dispatch versus agent archive` — client A runs `POST /goals/:goalId/dispatches`, client B runs `POST /agents/:agentId/archive`, with a rendezvous released at the `Agent` row (row 5) lock in both orders. Exactly one of two outcomes holds and the oracle asserts which: **dispatch wins** → 201, one Task, one Run, one `DISPATCH_CREATED`, `nextGoalIteration = 2`, and the archive returns the existing 409 from `agentArchiveBlocker` with `Agent.archivedAt` still null (dispatch kept its authority); or **archive wins** → `Agent.archivedAt` set, dispatch returns the create-shaped **`400 "Assignee <name> is archived"`** from Step 4.5, and **zero mutation** — no Task, no Run, no event, `nextGoalIteration` still 1, no dispatch key or generation consumed. Neither order deadlocks or produces an unclassified error.
22. `successor dispatch versus agent archive` — the same two barriers around `POST /goals/:goalId/iterations/:goalIteration/decision` with **`action=dispatch`** (the spec's action name, `docs/specs/goal-5a0-single-flight-lineage-safety-kernel.md:488`; there is no `continue` action). Dispatch-wins asserts iteration N+1 Task/Run/`ITERATION_ADVANCED`; archive-wins asserts the `400 "Assignee <name> is archived"`, the predecessor still `AWAITING_DECISION`, no iteration number consumed, no decision key or decision fields written, and no event.
23. `initial, successor, and restart dispatch versus exact grant revocation` — client B runs `DELETE /agents/:agentId/repos/:repoId/access` against the **exact** `(projectId, agentId, repoId)` triple the dispatch needs, with the rendezvous at the grant row (row 4). Dispatch-wins asserts the Run exists and the revocation returns the existing 409 (`ACTIVE_RUN_STATUSES` Run on that repo) with the grant row still present; revocation-wins asserts the grant row is gone, dispatch returns the existing `400 "Assignee has no grant for this Repo"`, and zero mutation as in test 21. A companion case revokes a *different* `(agentId, repoId)` grant and asserts it neither blocks nor is blocked by the dispatch — the protocol is row-exact, not agent-wide. A third case runs the same barriers against `POST /goals/:goalId/restart` and asserts generation is not incremented when revocation wins.
24. `cancel versus Inbox answer` — a Goal Task Run suspended by `suspendForInbox`, then `POST /goals/:goalId/cancel` against `applyInboxDecisionTx` in both orders, asserting Step 9.5's final-state table cell by cell. **Cancel-first:** card `CLOSED` by the cancel; the later delivery returns `{ duplicate: true, resumed: false }` and writes nothing — **zero** new reply messages, **zero** new `InboxDecision` rows, no Run or Session write; the Run is `CANCELLED` with no lease and a revoked session token; exactly one `GOAL_CANCELLED` event and no other Goal event. **Answer-first:** the answer returns `{ duplicate: false, resumed: true }` with exactly one reply message and one `InboxDecision`, the Run reaches `QUEUED`, then cancel terminalizes and fences it; the reply and `InboxDecision` still exist afterwards (cancel erases no evidence), the card remains `ANSWERED`, the final Goal/Task/Run state is cancelled with no successor, and there is exactly one `GOAL_CANCELLED` event. Neither order leaves an `OPEN` card, a live lease, a valid fencing token, or a claimable Run, and neither produces two replies or two decision rows.
25. `cancel versus Inbox connector STARTING replay` — drive `applyInboxDecisionTx` twice with the same `externalEventId` the way `packages/inbox/src/connection.ts` replays while its state is `STARTING`/`RECONNECTING`, straddling the cancel, in both orders. Delivery-delivery-cancel asserts exactly one `InboxDecision` row, one reply message, `resumed: true` then `{ duplicate: true, resumed: false }`, and both rows still present after the cancel. Cancel-delivery-delivery asserts zero `InboxDecision` rows, zero reply messages, `{ duplicate: true, resumed: false }` on both deliveries, and no Run or Goal event created by either. In every order there is exactly one `GOAL_CANCELLED` event.
26. `cancel versus reconcile Inbox expiry` — a Goal-linked `WAITING_INBOX` Run past `resumableUntil` racing cancel. Cancel-first leaves the sweep a no-op; sweep-first leaves `TIMED_OUT` plus `AWAITING_DECISION` and cancel then terminalizes the Goal. Both orders end with one Run, no successor, and no Inbox row.
27. `acceptance fixture survives the kernel` — seed `packages/db/prisma/acceptance-fixture.ts` unchanged, which carries a manual `WAITING_INBOX` Run and Session, then run the full Goal cancel/answer/claim suite alongside it. Assert every manual fixture row keeps its pre-kernel status, that the fixture's waiting Run still answers and resumes on the unfenced path, and that the acceptance seed still applies cleanly after the migration.
28. `manual start versus Goal initial dispatch on one agent` — the cross-protocol proof that the canonical order composes with the *unmodified* manual writer. Client A runs `POST /tasks/:taskId/start` on a manual Task and client B runs `POST /goals/:goalId/dispatches`, both for the same assignee `Agent` and the same exact `(projectId, agentId, repoId)` grant, with the rendezvous released at the shared grant row (row 4) in **both** barrier orders. Both operations must complete: they contend on rows 4 and 5 in the same direction, so one queues behind the other rather than crossing. Assert for each order — the manual start returns 201 with exactly one new manual Run whose lineage columns are all null; the dispatch returns 201 with exactly one Goal Task, one Run carrying the full lineage tuple, one `DISPATCH_CREATED`, and `nextGoalIteration = 2`; neither transaction reports `40P01`; the bounded `40001` retry counter recorded by Step 8.3's structured attempt evidence is not exhausted; and `Agent.archivedAt` is still null with the grant row still present. Record which side arrived first and the observed row-acquisition sequence of each transaction.
29. `manual start versus Goal successor dispatch on one agent` — the same two barriers with client B running `POST /goals/:goalId/iterations/:goalIteration/decision` with `action=dispatch`, so client B holds rows 1-3 (Goal, predecessor Task, its Runs) before it requests row 4. Assert the same two-winner outcome, the successor's iteration N+1 identity and single `ITERATION_ADVANCED`, the manual Run's null lineage, no `40P01`, no exhausted `40001`, and that the manual Task's own row lock was never requested by the Goal transaction — the two Task sets are disjoint, which is what keeps the manual writer unmodified.
30. `manual start versus Goal existing-Task retry on one agent` — client B runs `POST /tasks/:taskId/runs/:sourceRunId/retry` against a Goal Task, taking rows 1-3 then 4 and 5, while client A starts an unrelated manual Task on the same agent and grant, in both barrier orders. Assert both succeed, exactly one Goal retry child exists with `retryOfRunId = source.id` and the source tuple preserved, exactly one manual Run exists, one `RUN_RETRY_CREATED` event, no `40P01`, and no exhausted `40001`. Then repeat the same barrier with client A running `POST /agents/:agentId/archive` instead, and assert the route-specific loser outcome from Step 4.5: archive-wins gives the retry route's **409** `Assignee <name> is archived; unarchive it to retry` with zero mutation (no child Run, no event, source Run untouched), while retry-wins gives the archive the existing `agentArchiveBlocker` 409.

Each race records barrier arrival/release, exact HTTP/service result, row/event counts, tuples, and the final invariant query. Include a mutation note explaining which lock/unique/fence removal makes each proof fail. For tests 21-23 and 28-30 the mutation note must name the row-4/row-5 lock whose removal reintroduces the stranded-run class the merged exclusion protocol closed, and — for 28-30 — must state that swapping rows 4 and 5 into round 2's discarded `Agent`-before-grant order is exactly what makes the manual-start interleaving deadlock, since manual start takes grant then `Agent`. For tests 24-26 it must name the `lockGoalRow` call in `applyInboxDecisionTx`, the resume-authority predicate, and the cancel card-close CAS in Step 8.4.

**Verification:** Focused file passes twice without changing the rendezvous, then aggregate `npm run test:db` passes. Every independent client disconnects in `finally`; timeouts are bounded and report the contended Goal/Task/Run/grant/`Agent` lock or CAS rather than masking hangs. The test artifact records restart's two-event oracle and shows that no race produced a `40P01`, an exhausted `40001`, or a forbidden Inbox row. It also records, for each of tests 21-23, which side won and the full zero-mutation row/event counts for the losing dispatch; for tests 24-26, the `InboxDecision`/reply/card/Run/event counts in both orders; and for tests 28-30, both transactions' observed row-acquisition sequences, the retry-attempt classification counts, and the assertion that the manual writer's own behaviour and row set were unchanged.

### 13. Rehearse the migration and rollback paths on disposable schemas

**Files:**

- `packages/api/src/migration.dbtest.ts`
- `docs/runbooks/goal-5a0-safety-kernel-rollout-and-rollback.md` (new)
- `packages/db/prisma/preflight-goal-execution.ts`
- `packages/db/prisma/verify-goal-execution.ts`
- `packages/db/prisma/export-goal-lineage.ts`

**Work:**

1. Rehearse no history, multiple closed iterations, all-null manual lineage, mixed null/non-null Runs, inconsistent non-null Goal IDs, Session-versus-Run Goal/task/project mismatch, active Goal-linked Run, project mismatch, and orphaned lineage. Every ambiguous/corrupt/active fixture must stop in preflight with schema/data checksums unchanged.
2. Rehearse both `pgcrypto` states: already installed in `public`, and absent with sufficient creation privilege. Also prove an extension in the wrong schema and a role without required privileges fail before mutation. For valid fixtures, deploy the full migration chain into a private non-`public` application schema, verify deterministic generation-0 backfill including the exact `task-1` hash `ae09d8434c29001c3151708be633fe60ca2a9837de8f169d003e6539be35bb94` and all invariants, run `prisma migrate deploy` again and prove no-op, then run drift check. Record the applied migration set using Step 1.6's directory-only enumeration and cross-check it against `_prisma_migrations`; `migration_lock.toml` appears in neither list.
3. Exercise rollback first by disabling the flag and retaining schema/lineage. Separately rehearse the destructive archival path from Step 14 on disposable data only: export; verify checksum/readability; drain/fence; require explicit approval tokens for `FAILED → STOPPED_STUCK` and `CANCELLED → PAUSED`; remove lineage objects and rebuild the PostgreSQL 16 `GoalStatus` type in the exact documented transaction; conditionally retain/drop `pgcrypto`; verify old-client compatibility and Prisma drift.
4. Never silently relabel Goal lineage as manual. Record whether roll-forward-off or destructive archival rollback was selected and whether export is the only remaining lineage copy.

**Verification:** Save commands, schema names, first/second deploy output, `pgcrypto` owner/schema/privilege/dependency evidence, exact hash, row counts, all identity/invariant output, export checksum, enum translation approvals, object-removal/type-rebuild order, old-client query results, and final drift result in the implementation evidence packet. Production URLs are forbidden in the rehearsal.

### 14. Write the operational rollout/rollback runbook without executing production changes

**Files:**

- `docs/runbooks/goal-5a0-safety-kernel-rollout-and-rollback.md` (new)
- `.env.example`
- `docs/reviews/goal-5a0-implementation-evidence.md` (new)

**Work:**

1. Document the default-off flag and the exact staged sequence: Control-plane A evidence; final-master revalidation; ordered gates; private rehearsal; additive schema/client deploy disabled; read-only production preflight; approved migration window with no active Goal-linked Run; seeded non-production/canary Goal; review; then ordinary enablement.
2. Canary checks cover dispatch, same-key replay after process reconstruction, retry replay, pause/resume, terminal decision, lineage JSON, event ledger, and partial spend evidence. This task records steps only; it does not execute production migration, restart, enablement, or public release.
3. Document defect response and both rollback branches exactly as specification §13.2. Roll-forward-off is mandatory when live lineage must remain queryable. The destructive branch is disposable rehearsal unless separately authorized and must use these named PostgreSQL 16 phases:
   1. **Pre-transaction abort gate:** flag disabled; no active Goal-linked Run; deterministic export checksum/read test complete; explicit approver identities/tokens recorded for status translation and lineage removal; query `pg_depend`, defaults, checks, indexes, views, functions, and casts that depend on `GoalStatus`, `GoalDispatchState`, or new lineage objects. Any unexpected dependency aborts.
   2. **Single destructive transaction:** `LOCK TABLE "Goal", "Task", "Run", "Session", "GoalExecutionEvent" IN ACCESS EXCLUSIVE MODE`; translate `failed → stopped-stuck` and `cancelled → paused`; assert zero rows retain either new label; drop the `Goal.status` default and every known dependent check/view/function identified by the runbook; drop event/lineage FKs, partial/composite/unique indexes, `GoalExecutionEvent`, and added Task/Run/Goal columns in dependency order; then drop `GoalDispatchState` after its last column/dependency is gone.
   3. **Exact GoalStatus rebuild:** execute `CREATE TYPE "GoalStatus_goal5a0_rollback" AS ENUM ('active','paused','completed','stopped-spend','stopped-time','stopped-stuck')`; cast with `ALTER TABLE "Goal" ALTER COLUMN "status" TYPE "GoalStatus_goal5a0_rollback" USING ("status"::text::"GoalStatus_goal5a0_rollback")`; execute `DROP TYPE "GoalStatus"`; rename with `ALTER TYPE "GoalStatus_goal5a0_rollback" RENAME TO "GoalStatus"`; restore the exact old default with `ALTER TABLE "Goal" ALTER COLUMN "status" SET DEFAULT 'paused'::"GoalStatus"`; recreate only old-schema indexes/checks/views/functions recorded from the baseline; validate label order, default expression, row counts/status counts, and zero unexpected dependencies before commit. Any failed assertion rolls back the whole phase.
   4. **Post-commit gate:** retain `pgcrypto` unless the evidence says Goal 5a0 installed it and `pg_depend` proves no non-extension user; only then may the operator drop it. Start an old-client build against the disposable rolled-back schema, run Goal CRUD/list plus manual Task/Run scheduler smoke tests, run old-schema Prisma drift validation, and compare the archive checksum/readability again before old code is considered deployable.
4. Include operator stop points and explicit evidence fields for who approved destructive translation/removal. Alerts and lifecycle notifications are named as Goal 5a1, not added here.
5. Add an "Inbox 3a handoff" section reproducing the dependency decision, the ownership inventory, the directory-only migration-tail rule from Step 1.6, the "Canonical Goal execution row order" sentence from Step 4.9 with the note that #95's two conflicting orders must be replaced by it, and the `goalRunResumeAuthority` seam, so #98 reads one operational document rather than reconstructing the boundary from this plan's steps. State plainly what an operator sees: cancelling a Goal with a waiting Inbox card **closes the card, terminalizes and fences the Run, and does not resume**; an answer that arrives afterwards is a harmless duplicate that records nothing — no reply, no decision row — while an answer that arrived *before* the cancel keeps its recorded reply and decision row, which the cancel does not erase.

**Verification:** Execute the runbook only against the disposable rehearsal from Step 13. A reviewer can trace every command to an artifact, target schema, expected result, transaction boundary, abort/rollback condition, dependency query, approval identity, and recovery action. Evidence includes the temporary/final enum names, cast/default SQL, pre/post enum labels and counts, old-client smoke output, Prisma drift result, and `pgcrypto` retention decision.

### 15. Run the ordered gates and assemble review evidence

**Files:**

- `docs/reviews/goal-5a0-implementation-evidence.md` (new)
- `docs/reviews/goal-5a0-review-disposition.md` (new)
- all files changed by Steps 1–14

**Work:**

1. On the final implementation tree, run in order:

   ```text
   npm run db:generate
   npm run db:validate
   npm run db:drift-check
   npm run build
   npm run typecheck
   npm test
   npm run test:db
   ```

2. Also run the preflight, disposable migration rehearsal, invariant verifier, rollback rehearsal, and focused concurrency suite. Record the first result of each command; explain and disposition every failure before a rerun.
3. Assemble the ten-part reviewer packet required by spec §15.3: current-master/Control-plane A evidence; schema/raw SQL including `pgcrypto` and composite audit FKs; preflight/backfill/rehearsal counts; all command/test output; controlled interleavings including cancel/claim, dispatch-versus-archive, dispatch-versus-grant-revocation, cancel-versus-Inbox-answer in both orders, and manual-start-versus-Goal-dispatch/successor/retry in both orders; zero invariant results including predecessor/event/Session identity; canary Goal→generation→Task→Run/retry JSON with restart's exact two events; partial/late/concurrent Session cost evidence; feature-flag/rollout/exact enum-rebuild rollback state; and complete finding disposition table. Attach raw observability JSONL plus executable aggregation output and the Goal-path Inbox negative-test evidence. Include the Step 1 exclusion-protocol symbol map, the rebuilt multi-row writer table with the both-row-writer enumeration, the "Canonical Goal execution row order" record from Step 4.9, the route-classification test output proving the create-like 400s and retry-style 409s, the refreshed Inbox 3a ownership inventory, and the directory-only merged migration-tail ordering proof with all three assertions.
4. The disposition ledger has one row per finding with source/ID, severity, accepted/rejected/deferred, rationale, exact contract/code/doc change, and verification. Findings are append-only across revisions; a rejected or deferred finding remains visible. Any must-fix stays open until verified; every should-fix is adopted or explicitly declined with one-line reasoning.
5. Obtain an independent review against the reviewer checklist in spec §16. With an approval gate, move the implementation task to review rather than done; the human decides.

**Verification:** Every reviewer checklist answer is backed by a file/command/test/result in the evidence document. The final invariant query returns zero rows. `git diff --check` is clean, the reviewed SHA matches the evidence SHA, and the disposition ledger contains every finding from every review round.

## Goal 5a0 and Inbox 3a dependency, ownership, and handoff

### Decision of record

Leo's explicit dependency decision, 2026-08-17: **Goal 5a0 implementation and merge (#97) is first. Inbox 3a implementation (#98) is strictly dependency-held until #97 is merged and revalidated.** Concretely:

1. #98 does not start implementation while #97 is open. Its task stays dependency-held, not merely deprioritized.
2. When #97 merges, #98's first action is to rerun this plan's Step 1 revalidation against the merged tail and record the merged Goal migration folder name and the merged state of every symbol in the ownership table.
3. If that revalidation shows a symbol moved, was renamed, or changed shape, #98 revises its own plan before writing code. It does not reinterpret this table from memory.
4. Goal 5a0 does not implement, partially implement, or design Inbox 3a. Where the two meet, Goal 5a0 leaves the named fence and seam in Step 9 and nothing more.

### Overlapping symbol inventory and ownership

Read at `a4a4ba3`; Step 1 re-reads it. "Goal 5a0" means this plan may change the symbol; "Inbox 3a" means #98 owns it and Goal 5a0 must leave it byte-for-byte alone; "merged/shared" means neither may fork it.

| Surface | Symbol | Owner in Goal 5a0 | Goal 5a0 obligation | Handoff to Inbox 3a (#98) |
| --- | --- | --- | --- | --- |
| schema | `GoalStatus` (`FAILED`/`CANCELLED`), `GoalDispatchState`, `GoalExecutionEvent`, Task/Run lineage columns | Goal 5a0 | Step 2 adds them in the reserved migration | #98 treats them as existing baseline |
| schema | `RunStatus.WAITING_INBOX`, `SessionExecutionStatus.WAITING_INBOX` | merged/shared | no change | no change |
| schema | `InboxMessage`, `InboxThread`, `InboxDecision`, their `goalId`/`taskId` columns | Inbox 3a | read-only; cancel may close an `OPEN` card, nothing else | #98 owns all shape changes |
| workflow | `applyInboxDecisionTx` / `applyInboxDecision` | merged/shared | Step 9.5 adds the leading `lockGoalRow`, the resume-authority branch, and — on the Goal path only — the duplicate return that replaces the `workflow.ts:769-771` throw | #98 replaces the `no-resume` branch; it must not remove the Goal lock or the predicate, and it owns the paused-Goal resume-window policy |
| workflow | `goalRunResumeAuthority` (new, `packages/db/src/goal-execution.ts`), returning `"resume" \| "no-resume"` | Goal 5a0 | Step 9.6 creates it as the single seam | #98's integration point |
| docs | the canonical row order recorded in Step 4.9 | Goal 5a0 records it; #98 adopts it | Step 4.9 writes it into the revalidation document and the runbook | #98's post-merge write-surface review replaces #95's `Goal → Task → Agent → exact AgentRepoAccess → Run/lineage` and `Goal → Task prefix → grant → Run → Session → Question` wordings with it, re-derived from the merged tree |
| workflow | `gateQuestion`, approval-gate cards | Inbox 3a | no change; Goal Tasks may not carry an approval gate (Step 2 runtime shape check, Step 9.1) | #98 owns gate behaviour |
| workflow | `ACTIVE_RUN_STATUSES`, `LIVE_TASK_STATUSES` | merged/shared | consume, never redefine | consume, never redefine |
| workflow | `enqueueTaskRun`, `lockAgentRow`, `lockAgentRows`, `lockTaskRow`, `lockAgentRepoGrant`, `lockAgentRepoGrantForRevocation`, `agentArchiveBlocker` | merged/shared | Step 4 extends the lock order above them; `enqueueTaskRun` gains only the Goal-linked rejection | unchanged |
| app | `WAITING_INBOX` 409 guards on the runner routes, `activeRunStatuses` | merged/shared | no change | no change |
| app | run-budget-exhausted and authentication-circuit `inboxMessage.create` on completion | merged/shared | Step 6.6 fences them off Goal paths; manual behaviour unchanged | #98 (with Goal 5a1) owns any Goal-facing replacement message |
| app | Goal execution routes, Goal DoD routes, Goal delete guard | Goal 5a0 | Steps 5–9 | #98 does not change them |
| reconcile | expired-`WAITING_INBOX` sweep and its card close | merged/shared | Step 7.5 adds Goal awareness and `AWAITING_DECISION`; manual path unchanged | #98 owns the resume-window policy itself |
| reconcile | lease-loss `inboxMessage.create` | merged/shared | Step 6.6 restricts to manual Tasks | #98/Goal 5a1 own a Goal-facing replacement |
| runner | `packages/api/src/inbox.ts::suspendForInbox` | Inbox 3a | read-only; it already persists `run.goalId` and needs no Goal 5a0 edit | #98 owns it |
| runner | `packages/api/src/auth.ts` `WAITING_INBOX` session-token validity | merged/shared | no change; cancel revokes through `sessionTokenRevokedAt` | no change |
| runner | `packages/inbox/src/connection.ts` `STARTING`/`RECONNECTING` replay | Inbox 3a | no change; Goal 5a0 only adds the Step 12 test 25 oracle against it | #98 owns connector behaviour |

### Migration ordering

Goal 5a0 reserves `packages/db/prisma/migrations/20260818000000_goal_execution_safety_kernel/`. Step 1's ordering fuse still applies: if that name no longer sorts after every migration on the then-current tail, or already exists, stop and revise this plan rather than renumber during implementation.

Inbox 3a's migration timestamp must sort strictly after **the actual merged Goal tail** — the folder name as it exists on `master` after #97 merges — not merely after the literal string `20260818000000`. If the ordering fuse forced Goal 5a0 to a different folder name, that new name is the tail #98 must clear.

#98 uses **the same evidence procedure as Step 1.6**, not a `ls … | tail`:

```sh
find packages/db/prisma/migrations -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
```

`ls packages/db/prisma/migrations | sort | tail -1` returns `migration_lock.toml`, so it is not a valid tail proof for either work stream: `m` sorts after `2`, and that file is Prisma's provider lock rather than a migration. #98 validates each returned name against `^[0-9]{14}_[a-z0-9_]+$`, asserts its own chosen folder is **absent** from the list, and asserts its chosen name sorts strictly after **every** directory in the list — not merely after the last one — recording the full list and all assertions in its write-surface review before authoring its migration. `migration_lock.toml` is never treated as a migration by either work stream.

### Cancellation fence and non-scope

The fence is Step 9.5: a cancelled, completed, failed, paused, or stale-generation Goal can never regain Inbox resume authority, because `applyInboxDecisionTx` takes the Goal lock first and consults `goalRunResumeAuthority` before the resume writes. Cancel-first closes the `OPEN` card and terminalizes/fences the waiting Run (Step 8.4), so a later delivery is a duplicate that writes no reply and no `InboxDecision`; answer-first keeps its immutable reply and `InboxDecision` and a later cancel fences the queued Run without erasing that evidence. Goal 5a0 promises nothing about recording an answer after cancellation — the current function cannot do it, and Step 9.5 says so explicitly. The handoff is Step 9.6's exported `"resume" | "no-resume"` predicate. The oracles are Step 12 tests 24–27.

Explicitly out of scope for Goal 5a0, and named here so #98 inherits them rather than discovers them: Goal-facing Inbox messages of any kind, Goal lifecycle or budget notifications, resume-window policy changes, the policy for a paused Goal's still-`OPEN` waiting card beyond Step 9.5.5's write-nothing behaviour, any richer Question/Answer/ResumeRequest lifecycle, waiver UX, approval-gate integration for Goal Tasks, and any change to `suspendForInbox` or the Feishu connector.

## Requirement-to-step coverage

| Contract requirement | Plan steps |
| --- | --- |
| One open dispatch; atomic dispatch/decision | 2, 4, 5, 12 |
| Retry/restart and process-restart idempotency | 2, 4, 6, 7, 8, 12 |
| Durable Goal → Task → Run lineage; generation/iteration/retry parent | 2, 3, 4, 5 |
| Stale completion/decision fencing and lock order | 4, 6, 7, 8, 12 |
| Pause/resume/cancel/failure semantics | 4, 6, 8 |
| Current scheduler/manual/chain/CRON/AT compatibility | 6, 7, 8, 9, 12 |
| Migration/backfill/preflight/invariant checks, executable SHA-256, ambiguous-history rejection | 1, 2, 3, 13 |
| Default-off rollout, canary, rollback/export | 5, 13, 14 |
| Restart event cardinality and atomic event evidence | 4, 8, 12, 15 |
| Durable events and versioned, queryable signals; no Goal 5a1 alerts | 4, 7, 10, 15 |
| Evidence-scoped provider dollar claims | 5, 10, 11, 12 |
| Goal response spend subtotal stays synchronized with Session evidence | 5, 10, 12 |
| Predecessor/event/Session audit identity continuity | 2, 3, 12, 13 |
| Executable two-client PostgreSQL concurrency proofs | 12 |
| Goal claim/cancel global lock order and bounded retries | 8, 12 |
| Merged Agent-archive and exact-`AgentRepoAccess` exclusion protocols joined by initial and successor dispatch | 1, 4, 5, 12 |
| Canonical row order Goal → Task → Run → exact `AgentRepoAccess` → `Agent` → inserts, derived from every current multi-row writer, applied to initial dispatch, successor dispatch, restart, retry, completion, and reconciliation, with locked re-reads before creation | 1, 4, 6, 7, 8, 12 |
| Cross-protocol composition with the unmodified manual start/retry writers | 4, 12 |
| Route-specific typed archived-assignee and missing-grant behavior preserved (create-like 400, retry-style 409), no uniform 409 | 4, 5, 6, 12 |
| Cancellation fence and handoff seam on the Inbox resume path, with both-order final states | 7, 8, 9, 12 |
| Goal 5a0 before Inbox 3a: ownership inventory, directory-only migration tail ordering, canonical-order handoff, and written handoff | 1, 9, 13, 14, 15 |
| PostgreSQL 16 enum-removal rollback rehearsal | 13, 14, 15 |
| Ordered static/DB gates and reviewer packet | 15 |
| Every review finding disposition | 15 |
| No implementation before Control-plane A/current-master revalidation | 1 and all gates |
| No Inbox/waiver/notification/public-release/production execution scope creep | 6, 9, 11, 12, 14 |

## Consolidated review finding disposition

The ledger is append-only across rounds. A finding closed in an earlier round stays visible with its original decision.

### Round 1 — plan review

Source: `docs/reviews/2026-08-17-goal-5a0-plan-review.md` §Must-fix and §Should-fix. All findings are retained below; no should-fix was declined.

| Finding | Severity | Decision | One-line rationale | Exact plan change | Required verification |
| --- | --- | --- | --- | --- | --- |
| MF-1 | Must-fix | Accepted | Claim mutates Goal lineage authority and must share the global lock order with pause/cancel. | Step 8 requires non-locking discovery followed by Serializable Goal → Task → Run locks, full predicate re-read, three bounded `40P01`/`40001` retries, and an exact cancel/claim oracle. | Step 8 controlled race and Step 12 test 12 prove both orders, no deadlock/unclassified error, one Run, no successor, final cancellation/fence. |
| MF-2 | Must-fix | Accepted | PostgreSQL 16 has no built-in `sha256()` on this baseline. | Steps 2/3/13 use `pgcrypto` `public.digest`, preflight schema/privileges, conditional rollback ownership, and a hard-coded expected digest. | Migration tests persist `ae09d8434c29001c3151708be633fe60ca2a9837de8f169d003e6539be35bb94`; wrong-schema/no-privilege fixtures fail unchanged. |
| MF-3 | Must-fix | Accepted | Filling null Run identity from a sibling would invent historical lineage. | Steps 3/13 reject mixed null/non-null Runs and any Session-versus-Run Goal/task/project mismatch before mutation; backfill accepts only all-non-null, one-Goal history. | Preflight fixtures exit non-zero with identical schema/data checksums; migrated valid fixtures have zero mismatch rows. |
| MF-4 | Must-fix | Accepted | Restart needs one deterministic event-count oracle. | Steps 4/8 define restart as one compound transaction with exactly two events, while every other transition has one and replay/no-op has zero; logs carry `eventCount`. | Unit/DB tests inject failures between both events, assert rollback, then assert exactly one `GOAL_RESTARTED` plus one `DISPATCH_CREATED` and zero on replay. |
| MF-5 | Must-fix | Accepted | A stored zero that no usage path updates cannot be presented as the known subtotal. | Step 10 makes terminal Sessions authoritative and derives both response `spendUsd` and `knownProviderCostUsd` in one snapshot at four decimals; it names usage files, late/concurrent strategy, and overflow behavior. | Real-DB usage/Goal tests race late/concurrent FINAL_OUTPUT recomputes and prove numeric equality, coverage, rounding, and wide-sum behavior. |
| MF-6 | Must-fix | Accepted | Goal 5a0 must not inherit lifecycle Inbox writes assigned to Goal 5a1. | Steps 6/9 split manual/system-wide alerts from Goal paths: Goal budget/auth/failure/retry/control/reconcile creates no Inbox row; the backend-health alert and existing human questions remain. | Step 6 negatives and Step 12 test 18 assert zero Goal-path rows and unchanged manual/backend alert behavior. |
| MF-7 | Must-fix | Accepted | PostgreSQL 16 removes enum labels only by rebuilding the type, not `DROP VALUE`. | Steps 13/14 name the abort gate, locks, translations, dependency removal, temporary type, cast, old-type drop/rename, default restore, validations, and old-client rehearsal. | Disposable rollback records SQL/approvals/counts/dependencies, old-client CRUD/scheduler smoke results, archive checksum, and clean old-schema drift. |
| SF-1 | Should-fix | Accepted | Cheap database backstops plus verifier queries materially improve audit-chain integrity. | Steps 2/3 add composite predecessor/event FKs where expressible and verifier queries for previous-iteration and per-event identity continuity. | Direct corruption tests reject cross-Goal/generation writes and detect wrong-iteration/event-shape corruption. |
| SF-2 | Should-fix | Accepted | Queryability requires a versioned record and reproducible aggregation, not metric names alone. | Step 10 defines the stdout JSONL schema, discriminator/version/value/type/labels, counter/gauge semantics, sink assumption, and exact `jq` queries without alerts. | Captured JSONL passes schema/non-secret assertions and the documented queries return expected counter sums/latest gauges. |

### Round 2 — current-master plan review

Source: `docs/reviews/2026-08-17-goal-5a0-plan-review.md` §Current-master plan-revision disposition. Review base `a4a4ba36c116c775d5d1c28ed55b17600869d904`, head `5d1a1fea89f3f0635b53bc298e5d2881bf363bf7`. Verdict FAIL, 2 must-fix and 0 should-fix. Both are closed here; there was no should-fix to adopt or decline.

| Finding | Severity | Decision | One-line rationale | Exact plan change | Required verification |
| --- | --- | --- | --- | --- | --- |
| CM-MF-1 | Must-fix | Accepted | The kernel bypasses `enqueueTaskRun`, so it must join the merged Agent-archive and exact-grant exclusion protocols explicitly instead of inheriting them. | Audited-conflicts section records the merged protocol by symbol and line; Step 1.5 revalidates it; Step 4.3 defines the extended global order Goal → Task → Run → Agent → `AgentRepoAccess` with its acyclicity argument; Step 4.4 applies it to the new-Task and existing-Task paths with mandatory locked re-reads before any Task/Run insert; Step 4.5 preserves the typed conflict contract by reusing the existing `ArchivedAssigneeError` 409 and `400 "Assignee has no grant for this Repo"` and adding no new code; Step 5.5 maps them at the HTTP layer. | Step 4 lock-order and construction unit tests; Step 12 tests 21–23 prove, for initial and successor dispatch against Agent archive and exact grant revocation, either dispatch-plus-retained-authority or competing-change-plus-zero-mutation, in both barrier orders, with no deadlock and no unclassified error. |
| CM-MF-2 | Must-fix | Accepted | The Goal/Inbox overlap needs a recorded dependency order, symbol ownership, migration tail rule, and a cancellation fence — not a second implementation. | New section "Goal 5a0 and Inbox 3a dependency, ownership, and handoff" records Leo's decision (#97 first, #98 dependency-held until #97 merges and Step 1 reruns), the overlapping schema/workflow/app/reconcile/runner/`WAITING_INBOX` inventory with per-symbol ownership, the reserved `20260818000000_goal_execution_safety_kernel` folder, and the rule that Inbox 3a's migration must sort after the actual merged Goal tail; gate 7 makes it a stop condition; Step 7.5 makes the `WAITING_INBOX` expiry sweep Goal-aware; Step 9.5 adds the `lockGoalRow`-first cancellation fence in `applyInboxDecisionTx`; Step 9.6 exports `goalRunResumeAuthority` as the single handoff seam. | Step 9 unit tests for unchanged manual answers, resumed active-Goal answers, and record-only cancelled-Goal answers; Step 12 tests 24–27 give the real-DB cancel-versus-answer, cancel-versus-connector-`STARTING`-replay, cancel-versus-reconcile-expiry, and acceptance-fixture oracles; cancel-versus-claim remains test 12. |

Round-3 supersessions of round 2, recorded here so the earlier rows stay readable without being mistaken for current: CM-MF-1's `… → Agent → AgentRepoAccess` order is **wrong and discarded** (see R3-MF-1); CM-MF-2's "record-only cancelled-Goal answer" and the `record-only` seam name are **not implementable and removed** (see R3-MF-2); CM-MF-2's `ls … | sort | tail -1` tail proof is **invalid** (see R3-MF-3).

### Round 3 — final independent plan review

Source: `docs/reviews/2026-08-17-goal-5a0-plan-review.md` §Round-3 disposition. Review base `a4a4ba36c116c775d5d1c28ed55b17600869d904`, head `4d2a4be5f5a859dd7a92a41be13825c435bfc421`, peer `4a35da5c428241c43de5b91158cfb6b2d61bc8b7` (Inbox 3a docs, PR #95). Verdict FAIL, 4 must-fix and 0 should-fix. All four are closed here; there was no should-fix to adopt or decline.

| Finding | Severity | Decision | One-line rationale | Exact plan change | Required verification |
| --- | --- | --- | --- | --- | --- |
| R3-MF-1 | Must-fix | Accepted | Current master takes the exact grant *before* the `Agent` row, so round 2's order would deadlock against the unmodified manual start writer. | Audited-conflicts section records the grant-before-`Agent` fact, the absence of any explicit `Run` lock, and the claim/completion/retry/create/PATCH orders by file:line. Step 1.5 rebuilds the multi-row writer table from the tree and stops if the both-row-writer set is no longer `{POST /tasks/:taskId/start}`. Step 4.3 replaces the order with a derived writer table plus the canonical rows Goal → existing Task → existing Run → exact `AgentRepoAccess` (`FOR KEY SHARE`) → `Agent` (`FOR UPDATE`) → inserts, and states why single-row create/archive/revocation cannot cycle. Step 4.4 assigns rows per operation for initial dispatch, successor dispatch, terminal decision, restart, retry, completion, reconciliation, pause/resume/cancel, claim, and the Inbox seam. Step 4.9 records the canonical sentence as the #95 handoff artifact. Gate 6, Steps 6.1/6.3/6.4, 7.1/7.5, 8.2/8.4, and the coverage table follow it. Step 12 test 22 uses the spec's `action=dispatch`. | Step 4 lock-order test asserts a strictly ascending subsequence with no row 5 before row 4 and exactly the rows each operation's table entry names; Step 12 tests 21-23 keep the archive/revocation oracles at the corrected row numbers; new tests 28-30 add two-client real-PostgreSQL manual-start-versus-Goal-initial, successor, and existing-Task-retry races in both barrier orders, asserting both winners, exact loser row/event/authority outcomes, no `40P01`, and no exhausted `40001`. |
| R3-MF-2 | Must-fix | Accepted | `applyInboxDecisionTx` cannot record a reply after cancellation — it throws at `:769-771` or loses the `OPEN` CAS at `:806-810`, both before any write. | Step 9.5 records those two facts, removes the round-2 record-only promise, and states the minimal linearizable contract: cancel-first closes the card and terminalizes/fences the Run, so the later delivery is a duplicate that writes nothing; answer-first keeps an immutable reply/`InboxDecision` and a later cancel fences the queued Run without erasing it; paused/stale with nothing consumed writes nothing and leaves the card `OPEN`. A both-order final-state table replaces the prose. Step 8.4 names the card-close CAS (mirroring `reconcile.ts:242-247`) as the race decider. Step 9.6 renames the seam to `"resume" \| "no-resume"`. The ownership table, the fence/non-scope section, and Step 14.5 match. No Product Contract change: spec §7.6 already lists `WAITING_INBOX` among the Runs cancel closes and §11 already permits terminalizing one. | Step 9 unit tests for the byte-for-byte unchanged manual path (including its unchanged throw), the resumed active-Goal answer, the write-nothing post-cancel duplicate, and the write-nothing paused delivery; Step 12 tests 24-25 assert every cell of the both-order table, including zero versus one reply/`InboxDecision` rows and exactly one `GOAL_CANCELLED`. |
| R3-MF-3 | Must-fix | Accepted | `ls packages/db/prisma/migrations \| sort \| tail -1` returns `migration_lock.toml`, so the tail proof was invalid. | Step 1.6 replaces it with `find … -mindepth 1 -maxdepth 1 -type d -exec basename {} \; \| sort`, name validation against `^[0-9]{14}_[a-z0-9_]+$`, and three assertions: the reserved folder is absent, the reserved name sorts strictly after **every** directory, and no Inbox 3a migration has landed. Step 1.3 and the Step 1 verification commands follow. The "Migration ordering" handoff section gives #98 the identical procedure. Step 13.2 cross-checks the directory list against `_prisma_migrations`. `migration_lock.toml` is never treated as a migration anywhere. | Step 1's revalidation document carries the full directory list and all three assertions; Step 13's rehearsal records the applied set from the same enumeration; Step 15.3 attaches the proof. |
| R3-MF-4 | Must-fix | Accepted | Spec §7.1 step 4 and §8 require current route-specific 400/404 behavior, so a create-like Goal dispatch must not borrow the start route's `ArchivedAssigneeError` 409. | Step 4.5 replaces the single-mapping paragraph with a per-operation classification table derived from source: create-like initial/successor/restart return `400 "Assignee <name> is archived"` and `400 "Assignee has no grant for this Repo"` exactly as `POST /projects/:projectId/tasks` does; the source-based retry keeps the retry route's `409 "Assignee <name> is archived; unarchive it to retry"`; the runner completion route gains no new status and falls to the awaiting-decision branch. Step 5.5 maps it at the HTTP layer and states there is no uniform 409. Steps 6.3/6.4 and 7.1 carry the internal-path behaviour. | Step 5 HTTP route-classification tests assert exact status and body for already-archived and missing-grant cases on initial dispatch, successor dispatch, restart, and source-based retry, each with zero mutation (no Task, Run, event, consumed iteration/generation/key, predecessor still `AWAITING_DECISION`); Step 12 tests 21-23 and 30 assert the archive-wins interleavings at the same statuses; Step 4's route-classification unit test pins the sentences read in Step 1. |

## Completion boundary

This plan is complete when persisted for review. It does not authorize implementation. The future implementation task must stop at Step 1 unless Control-plane A and Review/Approval Convergence (`a4a4ba3`) are both merged and the then-current `master` revalidation passes; production migration, restart, flag enablement, public release, Inbox 3a integration, waiver UX, and Goal 5a1 notification behavior remain outside this contract.

Inbox 3a (#98) stays dependency-held until Goal 5a0 (#97) is merged and revalidated. Goal 5a0 discharges that boundary with the Step 9 fence and seam and the written handoff; it does not implement Inbox 3a.
