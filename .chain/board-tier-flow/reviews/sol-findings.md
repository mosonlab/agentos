# Sol code review findings

## Authority

- implementation base: `45584af215b1e727316caf63e900d765d727aa91`
- delivered head: `e387cac448854d0b033fada65e38024ed5e46099`
- reviewed range: `45584af215b1e727316caf63e900d765d727aa91...e387cac448854d0b033fada65e38024ed5e46099`
- specification: `.chain/board-tier-flow/spec.md`
- revised plan: none; this is a direct chain
- range verification: both commits resolve, base is an ancestor of head, and checkout `HEAD` equalled delivered head before review

## Finding counts

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 5 |
| P2 | 2 |

## Findings

### SOL-SPEC-001 — P1 — Deferred template start loses the shared chain branch

- Location: `packages/api/src/templates.ts:164`, `packages/api/src/templates.ts:172-175`
- Governing specification: “When false, all step tasks are created in TODO as today but nothing is enqueued; the chain is started later by starting its first step via POST /tasks/:id/start (which already handles chain steps). When true, preserve current behavior.”
- Problem: the only write that gives the first Run `branchName` is inside the `autoStart` branch. With the new default `false`, the later `/start` path cannot recover that head branch.
- Evidence: the first Task stores `repo.defaultBranch` as `targetBranch`, while later Tasks store `branchName` (`templates.ts:164`). With no prior Run, `resolveRunBranches` treats the first template step's default target as `chainBranch = null` and returns `branch: null` (`packages/db/src/workflow.ts:338-345`). `provisionWorkspace` then substitutes `agentos/<taskId>/run-1` (`packages/runner/src/workspace.ts:159-160`). The successor still expects the original `branchName`, which the first Run never pushed. The new dbtest stops after asserting zero Runs at instantiation and does not exercise the specified later `/start` path.
- Required direction: centralize preservation/derivation of the template chain head so both immediate and deferred first-step enqueue use the same `branchName` while cloning the repository default as the base. Add a dbtest covering `autoStart:false` with a custom branch, `POST /tasks/:id/start`, the first Run's `branch`, publication/advance, and the successor's base continuity.

### SOL-SPEC-002 — P1 — A failed confirmed start is hidden behind the still-open modal

- Location: `apps/web/src/pages/Tasks.tsx:221-235`, `apps/web/src/pages/Tasks.tsx:309-322`
- Governing specification: “Surface API errors to the user verbatim (fail loudly).”
- Problem: a rejected `POST /tasks/:id/start` sets `startError` but leaves `startRequest` intact. The modal therefore remains open while the error notice renders in the underlying page.
- Evidence: the catch at lines 231-233 records the message without clearing the request; lines 309-316 continue rendering `StartTaskDialog`; line 322 renders the error outside it. The Radix dialog portal places both overlay and content at `z-50` (`apps/web/src/components/ui/dialog.tsx:31-53`), so the underlying notice is obscured and unavailable to the operator who must act on the error.
- Required direction: render the exact API message inside the active dialog, or close the dialog before rendering a visible page-level notice. Add an interaction test that rejects the POST with a named 409 and asserts the original server message is visible in the active error surface.

### SOL-SPEC-003 — P1 — Start confirmation also changes keyboard and touch menu behavior

- Location: `apps/web/src/pages/Tasks.tsx:204-219`, `apps/web/src/components/task-card.tsx:132-136`
- Governing specification: “Change ONLY the case ‘card dropped onto the DOING column AND the task is startable’.”
- Problem: startability lookup and confirmation live in the shared `move()` callback, not the desktop drop path. The card menu's `Move to Doing` action therefore also opens the start dialog and can POST `/start`, even though this behavior was limited to a card drop.
- Evidence: `TaskCard` maps keyboard/touch menu selections to `actions.onMove`; `TasksPage` maps that action to the same `move()` used by `DesktopBoard.onDrop`. `move()` has no source parameter, so it cannot distinguish a drop from a menu selection. The added unit test exercises only `dropAction(status, startable)` and cannot detect which UI entry point invoked it.
- Required direction: keep the existing menu callback on plain PATCH and give the desktop drop path a distinct confirmed-start entry point, or pass an explicit interaction origin. Add interaction tests proving a startable desktop drop opens confirmation while menu movement remains PATCH-only; also assert decline performs no write and confirm performs POST without PATCH.

### SOL-SPEC-004 — P1 — Last-good checklist data silently masks later polling failures

- Location: `apps/web/src/pages/TaskDetail.tsx:374-378`
- Governing specification: “No silent fallbacks; errors surface to the user (repo rule).”
- Problem: once startability has loaded successfully, a later network or server failure is hidden and the stale checklist remains the only visible state.
- Evidence: `usePoll` retains existing `data` while setting `error` on failure (`apps/web/src/lib/hooks.ts:94-103`). The render branch checks `startability.data` first and checks `startability.error` only when no data exists. A revoked grant or newly active Run can consequently remain displayed as satisfied with no error notice.
- Required direction: when last-good data is retained, render the checklist and the current error together, or clear the verdict on error. Add a regression test for a successful response followed by a failed poll and assert the failure is visible.

### SOL-STD-001 — P1 — The new tracked chain specification is unclassified for the public snapshot

- Location: `.chain/board-tier-flow/spec.md:1`
- Standard: `CONTRIBUTING.md:79-85` requires every tracked file to be explicitly included or excluded by `public-snapshot.json`.
- Problem: the integrated diff adds the chain specification but does not classify it.
- Evidence: `node scripts/public-snapshot-scan.mjs --list-included` reports `.chain/board-tier-flow/spec.md` as a new `snapshot-scope` blocker with reason “tracked path is not explicitly included or excluded”. The implementation did not modify `public-snapshot.json`; the other three reported scope blockers already exist outside this diff.
- Required direction: classify the chain record with the appropriate explicit exclusion or inclusion and rerun the snapshot scan, asserting this path no longer appears as a blocker.

### SOL-STD-002 — P2 — Obsolete `startable` wrapper remains after all production callers migrated

- Location: `packages/api/src/chain.ts:166-168`
- Standard: the task-level repository instruction requires obsolete paths replaced by a change to be removed in the same change.
- Problem: all production callers now use `taskStartability`, but the old `startable` export remains solely for tests.
- Evidence: repository search finds `startable(...)` only in `packages/api/src/chain.test.ts`; no production module calls it. The wrapper adds a second public name for the same predicate and lets tests maintain a path the product no longer exercises.
- Required direction: remove the wrapper and migrate its assertions to `taskStartability(...).startable`.

### SOL-SMELL-001 — P2 — Judgement call: the start-confirmation flow deepens the `TasksPage` long-method bloater

- Location: `apps/web/src/pages/Tasks.tsx:121-123`, `apps/web/src/pages/Tasks.tsx:204-243`
- Smell family: Fowler Bloater / Long Method. This is a labelled judgement call, not a documented-standard violation.
- Problem: startability fetch, three state variables, confirm/cancel transitions, POST failure handling, and modal lifetime are distributed across an already broad page that also owns polling, responsive tabs, focus, drag state, and CRUD. The misplaced error surface and shared menu/drop behavior above are concrete change-local symptoms of that spread.
- Evidence: the new board test could isolate only the pure `dropAction` helper; it does not exercise the state transitions or visible error behavior. Fixing SOL-SPEC-002 and SOL-SPEC-003 requires coordinated edits across multiple separated regions of the page.
- Direction: extract a `useTaskStartConfirmation` state machine or a focused flow component with explicit `request`, `confirm`, `cancel`, and `error` states, then test the flow through its public UI behavior.

## Harness and verification

Both required candidate-finding passes completed from delivered `HEAD` with exit status 0:

```text
codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "Review the changes from 45584af215b1e727316caf63e900d765d727aa91 to e387cac448854d0b033fada65e38024ed5e46099. Standards axis only. ..." </dev/null > <temp>/standards.log 2>&1 &
codex exec review -m gpt-5.6-sol -c model_reasoning_effort=high -c service_tier="standard" "Review the changes from 45584af215b1e727316caf63e900d765d727aa91 to e387cac448854d0b033fada65e38024ed5e46099. Specification axis only. ... [full approved specification text]" </dev/null > <temp>/specification.log 2>&1 &
```

Candidate findings were accepted only after direct code and test verification. Narrow regressions run by the coordinator:

```text
node --import tsx --test packages/api/src/chain.test.ts packages/api/src/templates.test.ts
# 30 passed, 0 failed

TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --import tsx --test apps/web/src/tests/tasks-board.test.tsx apps/web/src/tests/task-detail.test.tsx
# 45 passed, 0 failed

AGENTOS_ALLOW_SCRATCH_DATABASES=1 TEST_DATABASE_URL=<ephemeral-postgresql> TEST_DATABASE_MAINTENANCE_URL=<ephemeral-maintenance> RUNNER_WORKSPACE_ROOT=<temp> CONTROL_PLANE_STATE_DIR=<temp> FILES_ROOT=<temp> node --import tsx packages/api/scripts/dbtest.mjs packages/api/src/tasks.dbtest.ts
# 60 passed, 0 failed
```

The first narrow-test attempt stopped before test execution because the fresh checkout lacked `tsx`; after the required `npm install && npm run db:generate && npm run build -w @agentos/db` bootstrap, the same commands passed. `git diff --check` passed, and the forbidden files `packages/db/src/merge-integrator.ts` and `packages/db/src/agent-contract.ts` are unchanged in the implementation range.

No `MERGE GATE: PASS` is claimed. The implementation step recorded an exact-head gate failure in the existing database preflight authority before API dbtests; this review additionally confirms the new snapshot classification blocker above.
