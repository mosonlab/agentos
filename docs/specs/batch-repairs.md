# SPEC — Platform Repairs Batch: workspace retention, retry re-derivation, agent archive

Source: `docs/BACKLOG-V2.md` §平台修缮 (lines 61, 62, 64). Three defects found while
dogfooding, batched together because each is small and none blocks the others.
Batch constraints: at most one migration (the archive flag), no new UI surface
beyond exposing an archive action where the delete button already lives.

Explicitly **not** in this batch: the third 平台修缮 item (approvalGate 到闸不发飞书卡,
line 63) — it is a Feishu delivery problem, unrelated to these three.

---

## Item 1 — Runs suspended in WAITING_INBOX must keep their workspace

### Problem

When an agent calls `inbox_ask`, the run suspends at the gate
(`suspendForInbox`, `packages/api/src/inbox.ts:44-53` sets
`status: WAITING_INBOX`, and line 50 already sets `workspaceRetained: true`).
The runner side is also correct: `executeClaim` deliberately returns without
cleanup on the WAITING_INBOX 409 (`packages/runner/src/runner.ts:219-222` and
`:265-269`).

The deletion happens in the **API-side GC**, `reconcileWorkspaces`
(`packages/api/src/reconcile.ts:120-163`), which runs at API startup
(`packages/api/src/index.ts:15` via `reconcileAtStartup`,
`reconcile.ts:165-172`) and after **every** run completion
(`packages/api/src/app.ts:1719-1723`). Two compounding defects:

1. `reconcile.ts:15` defines `activeStatuses = [CLAIMED, PROVISIONING, RUNNING]`
   — it omits `WAITING_INBOX`, so a suspended run's directory is not treated as
   active. (Contrast `app.ts:313`, where the API's own `activeRunStatuses`
   *does* include `WAITING_INBOX`.)
2. The `workspaceRetained` flag does not save it either: `reconcile.ts:138-141`
   pools *all* retained runs, sorts by `endedAt` descending, and keeps only the
   top `failedRetentionCount` (default 2, `RUNNER_FAILED_WORKSPACE_RETENTION`).
   A WAITING_INBOX run has `endedAt = null`, so it sorts to the bottom and is
   evicted as soon as two failed workspaces are being retained.

So: agent asks a question → some other run completes → `reconcileWorkspaces`
fires → the waiting run's `/tmp/agentos-runs/<runId>` is `rm -rf`ed. When the
human answers, the run flips back to QUEUED (`packages/db/src/workflow.ts:254-256`),
a runner claims it with `resume` set, and `reuseWorkspace`
(`packages/runner/src/workspace.ts:77-85`) throws ENOENT at `stat()`. The
session context is unrecoverable.

### Intended behavior

**Retention rule: a workspace is GC-eligible only when its run is in a terminal
state.** Concretely, `reconcileWorkspaces` must treat these statuses as "keep":

- `CLAIMED`, `PROVISIONING`, `RUNNING` (as today), **plus `WAITING_INBOX`** and
  **`QUEUED` runs that carry a `workspacePath`** (the answered-but-not-yet-
  reclaimed window: `workflow.ts:254-256` flips WAITING_INBOX → QUEUED before a
  runner picks it up; deleting in that window loses the workspace just the
  same).
- Suspended/queued-for-resume workspaces must **not** consume the
  failed-retention quota: the `retained.slice(0, failedRetentionCount)` cap at
  `reconcile.ts:138-141` applies only to runs in terminal failed states
  (`endedAt != null`). Simplest shape: filter the keep-set by status first,
  then apply the quota to what is left.

Concrete scenarios:

- Run A suspends at `inbox_ask`. Runs B and C fail and retain their
  workspaces. Run D completes, triggering `reconcileWorkspaces`. Expected:
  A's workspace survives; B and C occupy the two failed-retention slots.
- API restarts while A is suspended. `reconcileAtStartup` runs. Expected: A's
  workspace survives; `reconcileDatabaseRuns` must continue to not mark A as
  LOST (already true today — its status is outside `activeStatuses` at
  `reconcile.ts:15`, and its lease is null by design; verify no regression when
  the status list changes: the run-orphaning query at `reconcile.ts:18-22` must
  **not** start matching WAITING_INBOX runs — keep the two status lists
  separate or scope the change to `reconcileWorkspaces` only).
- Human answers A's question. Run flips to QUEUED with `workspacePath` set,
  another run completes before a runner claims A. Expected: A's workspace
  survives the GC pass.
- A's resumed run finishes (success or failure). Expected: normal rules apply
  again — cleaned on success, retained-under-quota on failure.

### Data / interface changes

None. No migration, no API change, no runner change. The fix is contained in
`reconcileWorkspaces` (and its callers pass the same arguments as today).

### Edge cases and failure behavior

- A run abandoned in WAITING_INBOX forever (human never answers) retains its
  workspace indefinitely. **Assumption A1:** acceptable for the current
  single-operator deployment; no TTL in this batch (see Out of scope).
- Directories in the workspace root with no matching run row remain GC-able
  (today's behavior, `reconcile.ts:147-150` — `run` undefined → removed).
- If the workspace is *already* gone at resume time (pre-fix casualties, or
  operator deleted it), `reuseWorkspace` still throws and the run fails with
  the ENOENT surfaced as `failureReason`. Re-provisioning a fresh clone on
  missing workspace is **out of scope** (it would silently drop session
  context, which is exactly what this fix exists to prevent).

### Acceptance criteria

1. With a run in WAITING_INBOX and ≥2 failed runs holding retained workspaces,
   calling `reconcileWorkspaces` deletes nothing belonging to the waiting run;
   the failed-retention quota still evicts the oldest failed workspace.
2. Same guarantee across an API restart (`reconcileAtStartup`).
3. A run answered (QUEUED, `workspacePath` set, not yet claimed) survives a GC
   pass.
4. After the resumed run reaches a terminal state, its workspace is GC-ed by
   the next pass exactly as an ordinary run's would be.
5. Existing tests for orphan-run reconciliation still pass — WAITING_INBOX runs
   are still never marked LOST.

---

## Item 2 — Task retry must re-derive runner and model from the agent's current config

### Problem

The operator retry endpoint `POST /tasks/:taskId/retry`
(`packages/api/src/app.ts:1003-1042`) creates the new run by **copying the
failed run's frozen fields**: `runner: last.runner`, `model: last.model`,
`promptHash: last.promptHash` (`app.ts:1023-1025`). Editing the agent (model,
runner preference, prompts) between failure and retry has no effect — the
incident (BACKLOG-V2.md line 64): after switching the agent off the CLAUDE
runner, retry still ran the old CLAUDE runner twice, and the only escape was
deleting and recreating the task.

At task creation the runner is derived fresh: `runnerFor(agent.runnerPreference,
agent.model)` at `app.ts:940` (`runnerFor` defined in
`packages/api/src/execution.ts:20-28`). The workflow layer has the same logic as
a private duplicate `chooseRunner` (`packages/db/src/workflow.ts:22-30`), used by
`enqueueTaskRun` (`workflow.ts:32-76`) which already re-derives runner, model,
**and** promptHash from the current agent row and honours the
`templateStep.runner` override (`workflow.ts:47`).

### Intended behavior

On operator retry, derive the new run's execution config exactly as
`enqueueTaskRun` does at queue time:

- `runner` = `task.templateStep?.runner ?? runnerFor(agent.runnerPreference, agent.model)`
  — the template-step override (`workflow.ts:47`) still wins, because a chain
  step pinned to a runner must stay pinned.
- `model` = `agent.model` (current row, not `last.model`).
- `promptHash` = recomputed from the agent's current `foundationalPrompt`,
  `rolePrompt` and the task's `name`/`description` (as `workflow.ts:65-70`),
  so the hash matches what the claim will actually execute.

Everything else keeps today's retry semantics, which differ from
`enqueueTaskRun` and must not regress:

- `maxRunsPerTask` carries forward `last.maxRunsPerTask` (it may include the
  +1 external-failure ceiling raise, `execution.ts:46-65`), **not**
  `task.maxSessionsPerTask`.
- `branch: last.branch` is preserved (chain steps continue the shared feature
  branch), as are `targetBranch`, `goalId`, `repoId`, and the budget guard
  `last.runNumber >= last.maxRunsPerTask` → 409 (`app.ts:1016`).

**Assumption A2:** the mechanism is left to the plan — either extend
`enqueueTaskRun` to cover retry, or share a single derivation helper between
`workflow.ts` and the retry endpoint; the spec only requires that the three
derived fields come from the current agent row through the same
`runnerFor`/`chooseRunner` logic (and ideally the two duplicate functions
collapse into one).

**Assumption A3 (scope):** the *automatic* retry paths keep frozen config:
completeRun's auto-retry (`app.ts:1603-1623`) and the lease-loss requeue
(`reconcile.ts:77-94`). They fire seconds after the failure for transient
failure classes only (`execution.ts:38-44`) — replaying the identical config
is their contract, and no incident implicates them. Only the operator-initiated
retry re-derives.

Concrete scenario (the incident, replayed): task fails on runner CLAUDE; the
operator edits the agent to `model: "openai-codex/gpt-5.6-luna"` /
`runnerPreference: PI`; presses retry. Expected: the new run row has
`runner: PI` and the new model, and the claim manifest shows the PI adapter.

### Data / interface changes

None. Same endpoint, same request/response shape, no migration. The new run
row simply carries re-derived values.

### Edge cases and failure behavior

- Task's assignee agent was deleted → retry returns 409 with a clear error
  ("assignee no longer exists"), not a null-deref. (Today `last.agentId` is
  copied blindly; after this change the endpoint must load the agent and can
  hit this case.)
- Task's assignee agent is **archived** (Item 3) → 409, see Item 3 dispatch
  rules.
- Agent unchanged between failure and retry → the new run is byte-for-byte
  what today's code produces (runner, model and promptHash re-derive to the
  same values). No behavior change for the common case.
- Retry of a template-step task whose step pins `runner` → pinned runner wins
  over the agent's preference, matching first-queue behavior.

### Acceptance criteria

1. Fail a run, patch the agent's `model`/`runnerPreference`, POST
   `/tasks/:taskId/retry` → the created run's `runner`, `model`, `promptHash`
   reflect the patched agent.
2. Same flow without patching the agent → run identical to today's output.
3. Retry on a template-step task with a step-level runner override → override
   preserved.
4. Budget guard, `maxRunsPerTask` carry-forward, and `branch` continuation
   unchanged (existing retry tests still pass).
5. Retry against a task whose agent row is gone or archived → 409 with a
   descriptive error, no 500.

---

## Item 3 — Agent archive / soft-offline

### Problem

`DELETE /agents/:agentId` (`packages/api/src/app.ts:482-485`) is a bare
`db.agent.delete`. The `Agent` model is referenced without cascade by `Task`,
`Run`, `Session`, `InboxMessage`, `TaskTemplateStep` etc.
(`packages/db/prisma/schema.prisma:201-232`), so deleting any agent with task
history throws Prisma P2003 (FK violation) — which the global error handler
(`app.ts:1732-1740`) does not map (only P2025→404, P2002→409), so the operator
sees a raw 500. Incident: BACKLOG-V2.md line 62 — a decommissioned agent could
not be removed at all.

### Intended behavior

Add a soft-offline state. An **archived** agent:

- is hidden from every surface that *selects an agent for new work*;
- keeps all history (tasks, runs, sessions, inbox threads) readable;
- can be unarchived, restoring it fully;
- still cannot be hard-deleted while history exists — but that now fails with
  a clear 409, never a 500.

#### Data changes (the batch's one migration)

`Agent.archivedAt DateTime?` — nullable timestamp, null = active. Additive
column, no backfill needed, no index required at current scale
(**Assumption A4:** timestamp rather than boolean, so the UI can show when;
one migration, satisfying the batch cap).

#### API changes

- `POST /agents/:agentId/archive` → sets `archivedAt = now()`, 200 with the
  agent row. Idempotent (archiving an archived agent is a no-op 200).
- `POST /agents/:agentId/unarchive` → sets `archivedAt = null`, 200.
  Idempotent. (**Assumption A5:** dedicated endpoints rather than widening
  `agentPatch` at `app.ts:65-70`, keeping `archivedAt` out of the writable
  field set.)
- `DELETE /agents/:agentId` (`app.ts:482-485`): map the FK failure to
  **409** `{ error: "Agent has task history; archive it instead" }`. Either
  catch `P2003` in the handler or add `P2003` to the global `onError` map at
  `app.ts:1734-1737` — plan's choice; the contract is: agent with history →
  409 + guidance; agent with no history → 204 as today.
- Read endpoints unchanged: `GET /projects/:projectId/agents` (`app.ts:446`)
  continues to return archived agents (now with `archivedAt` populated) so
  history views and the agents list can render them; `GET /agents/:agentId`
  unchanged.

#### Dispatch/selection rules (archived agent must be rejected or skipped)

- `POST /projects/:projectId/tasks` (`app.ts:922-926`): assigning an archived
  agent → 400, same shape as the existing "Assignee does not belong to this
  project" guard.
- `PATCH /tasks/:taskId` assignee change (`app.ts:979-982`): same 400.
- Template instantiation (`packages/api/src/templates.ts:38-45`): a step whose
  agent is archived → 400 with the step name, alongside the existing
  "has no agent" guard.
- `POST /tasks/:taskId/retry` (`app.ts:1003`): archived assignee → 409 (see
  Item 2).
- Runner claim (`app.ts:~1200`, candidate loop): skip candidates whose
  `agent.archivedAt != null`, same pattern as the existing repo-access and
  circuit-breaker `continue`s (`app.ts:1222-1225`). This covers runs that were
  already QUEUED when the agent was archived.
  **Assumption A6:** queued runs are *skipped, not cancelled* — unarchiving
  lets them proceed; archiving is reversible and destroys nothing. A run
  mid-flight (CLAIMED/RUNNING/WAITING_INBOX) at archive time finishes
  normally. One deliberate consequence: a WAITING_INBOX run of an archived
  agent can still be answered, but its resume run is then QUEUED and gets
  skipped like any other queued run of that agent — one rule, not two; if
  that stalls a resume the operator wants, unarchive first.
- `enqueueTaskRun` (`packages/db/src/workflow.ts:32-76`, used by chain
  advancement and gate-reject requeue): archived agent → throw the same
  descriptive error shape as its existing guards (`workflow.ts:42-44`), which
  callers already surface.

#### UI (existing surfaces only)

- `apps/web/src/pages/Agents.tsx`: the list row's delete action (line 111)
  gains an Archive/Unarchive action next to it; archived agents render with an
  "Archived" badge (no new page, no filter UI required).
- `apps/web/src/pages/Tasks.tsx` new-task agent picker (line 160): exclude
  agents with `archivedAt != null`.
- Task/history views need no change — they read via task includes, which still
  return the agent row.

### Edge cases and failure behavior

- Archive an agent with a run currently RUNNING → run completes normally;
  completion processing (`app.ts:1540+`) does not consult archive state.
- Archive, then gate-reject a chain step assigned to that agent →
  `enqueueTaskRun` throws its descriptive error; the operator sees why and can
  unarchive.
- Delete an archived agent that has history → still 409 (archive does not
  unlock deletion).
- Delete an agent with no tasks/runs → 204, unchanged.
- Two archives in a row / unarchive of an active agent → idempotent 200s.

### Acceptance criteria

1. Migration adds nullable `Agent.archivedAt`; existing rows unaffected.
2. Archive endpoint hides the agent from: new-task creation (400), task
   assignee patch (400), template instantiation (400), operator retry (409),
   runner claim (skipped), chain requeue (error). Each rejection message names
   the archived agent or step.
3. Archived agent's tasks, runs, sessions and inbox history remain fully
   readable in the API and web UI.
4. Unarchive restores all of the above; a previously skipped QUEUED run gets
   claimed on the next poll.
5. `DELETE /agents/:agentId` on an agent with history returns 409 with the
   "archive it instead" message; on a history-free agent returns 204. No path
   returns 500.
6. Agents list UI shows the archive action and the Archived badge; the
   new-task picker omits archived agents.

---

## Out of scope (all three items)

- TTL/eviction for workspaces of runs stuck in WAITING_INBOX (A1) — revisit if
  disk pressure ever materializes.
- Re-provisioning a fresh workspace when resume finds it missing.
- Re-deriving config on *automatic* retries (A3).
- Cancelling queued/in-flight runs on archive (A6) — archive skips, never
  kills.
- Hard-delete of agents with history (e.g. cascade or anonymize) — deletion
  stays blocked.
- Any Feishu/notification work (that is the separate 平台修缮 item, backlog
  line 63).
- New UI pages, filters, or list toggles beyond the badge + action described
  in Item 3.

## Rollback

- Items 1–2 are code-only: revert the commit(s); no data to migrate back.
  Runs created by a re-deriving retry are ordinary runs — they stay valid
  after a revert.
- Item 3: revert code, then drop the column
  (`ALTER TABLE "Agent" DROP COLUMN "archivedAt"` via a down migration). The
  column is nullable and unread by any pre-batch code, so code-revert-first is
  safe; rows archived before rollback simply become active again. The 409 on
  delete degrades back to the old 500 — no data risk.

## How a reviewer verifies

Per-item acceptance criteria above, plus the batch-level pass: run the three
incident scenarios end-to-end on a dev stack —
(1) suspend a run via `inbox_ask`, complete an unrelated run, answer the
question, confirm the resume claims the surviving workspace and finishes;
(2) fail a task, switch the agent's model/runner, retry, confirm the new
adapter runs;
(3) archive an agent that has history, confirm it vanishes from pickers and
dispatch while its history stays readable, confirm delete → 409, unarchive →
fully restored.

## Open assumptions (need human eyes)

- **A1** — no TTL: suspended runs hold their workspace indefinitely until
  answered or cancelled.
- **A3** — automatic retries (transient-failure auto-retry, lease-loss
  requeue) intentionally keep frozen config; only operator retry re-derives.
- **A6** — archiving skips QUEUED runs (including an answered WAITING_INBOX
  resume) rather than cancelling them; unarchive un-skips.
- **A4/A5** — `archivedAt` timestamp + dedicated archive/unarchive endpoints
  (not a boolean via `agentPatch`).
- **A2** — plan may choose between extending `enqueueTaskRun` or extracting a
  shared derivation helper; duplicate `runnerFor`/`chooseRunner` should
  collapse to one.
