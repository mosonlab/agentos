# TC-UX v1.0 — dependency-safe start and truthful task detail

**Branch:** `agentos/chain/w2-2026-08-17-task-chain-9ca4e7ae`

**Planning authority:** `master` was explicitly fetched into `refs/remotes/origin/master` and captured at immutable SHA `70995b5ada80f968b0c929dc91717b2e102df717`. Local `master` is not used as authority in this run workspace.

**Route:** Planned Critical; implementation role `senior-dev` at the route's high-effort default.

The implementation will first make polled resources and every local/action state explicitly task-keyed, so a URL change removes the old task before the destination can render or act and missing output is represented honestly. It will then replace per-row chain startability with one dependency decision, enforced in both chain rendering and `POST /tasks/:taskId/start` while all relevant Task rows are locked in chain order; the same mutex is completed in automatic advancement and completion paths. Finally it will make task-prompt, chain-position, human ownership, recovery, and immutable gate/status controls truthful, add focused unit/real-Postgres/mounted-browser regressions, and record the old out-of-order behavior as superseded by TC-UX v1.0.

## Fixed design decisions

- **Chain order:** an indexed chain is scoped by `(projectId, chainId)` and ordered by `chainIndex`. A "surviving" predecessor is any still-existing indexed row, including an archived row; deletion removes a row from the dependency set, while archiving does not silently waive unfinished work. A null-`chainIndex` row remains the existing isolated 1/1 malformed-chain case.
- **Next executable step:** the first surviving row whose status is not `DONE` is the only candidate. It gets a manual action only when it is an `AGENT` row in `TODO` or `BACKLOG`, has a live agent/repo grant, is unarchived, has no active run, and has budget. `TODO` means **Start next step**; `BACKLOG` means **Recover parked step**. An unfinished `HUMAN`, `DOING`, or `REVIEW` row blocks every successor.
- **Current execution:** a row is labelled **Current execution** only when its run facts contain an active run (`QUEUED`, `CLAIMED`, `PROVISIONING`, `RUNNING`, or `WAITING_INBOX`). **Viewed here** is independently keyed to the URL task id. If both facts are true, both labels may appear on that one row; otherwise they never masquerade as the same marker.
- **Locking:** retain PostgreSQL Task rows as the chain mutex. For indexed-chain start or `PATCH ... status=DONE`, lock the prefix in ascending `(chainIndex, id)` order, then re-read typed rows. Manual start next locks the exact `AgentRepoAccess` row before final grant revalidation and Run creation; revocation locks only that grant row and checks active Runs, establishing the acyclic order Task-prefix → grant. Automatic activation selects the first surviving non-DONE successor, locks and re-reads it, and reselects after deletion or a legacy DONE gap. Successful chain completion locks its current Task before changing task/chain state.
- **PATCH authority:** ordinary PATCH may not change `approvalGate` on any dispatched Task row with non-null `chainId`; this deliberately uses a stable, auditable definition rather than trying to infer whether a paused chain is "active." A PATCH to `DONE` is rejected while that task has an active run or while an earlier surviving predecessor is unfinished. Inbox gate decisions and runner/automatic advancement continue through their dedicated transactional helpers, not ordinary PATCH.
- **Prompt truth:** the card is titled **Task prompt**. When a description contains `Product Contract:` and `Step responsibility:`, the responsibility is rendered first and the common Product Contract is in a closed disclosure; unstructured descriptions remain wholly visible as the task responsibility. A note states that the effective runner prompt *also* includes the foundational prompt, role prompt, tool manifest, and available prior outputs; it does not claim those unavailable bodies are displayed.
- **Compatibility:** keep the existing `startable` response boolean, but redefine it to the safe single candidate and add `startAction: "start" | "recover" | null` plus `currentExecution: boolean`. An older web bundle therefore becomes safer against a newer API, while the new bundle uses the richer fields.
- **Rejected alternative:** transaction isolation alone is not the mutex; Read Committed permits the observed check/create race, while Serializable would require retry semantics across every caller. Target-only locking is also rejected because completion can mark the predecessor done, block on the target, and then enqueue a second run after a manual start. Ordered prefix row locks fit the repository's existing exclusion protocol and need no schema migration.

## Implementation steps

1. **Record the TC-UX precedence and capture the implementation baseline.**

   **Change** — Add `docs/specs/tc-ux-v1-errata.md` with the Product Contract identity, the dependency-safe replacement for `docs/specs/batch-2.5-tasks-visibility.md` §§4.1/4.3 and scenarios C1/C4/S1, the PATCH/gate authority rules, resource-identity rule, and the explicit statement that TC-UX v1.0 wins over the earlier intentional out-of-order behavior. Add a short supersession banner and link at the top of `docs/specs/batch-2.5-tasks-visibility.md`; do not rewrite the historical body. Update `docs/runbooks/chain-operations.md` only where it describes ordinary manual recovery/control behavior: one safe next step, no force bypass, Inbox owns gates, and live-chain testing is prohibited. Before code changes, record `git rev-parse HEAD origin/master`, `git status --short --branch`, and the exact diff surface; stop if current master no longer reproduces the stale-output/startability/PATCH defects, if the shared branch/worktree has overlapping owners, or if CP-A ownership/startup symbols overlap.

   **Depends on** — none.

   **Verify** — `git rev-parse HEAD origin/master`; `git status --short --branch`; `rg -n "TC-UX v1.0|out-of-order|force bypass|next step" docs/specs/tc-ux-v1-errata.md docs/specs/batch-2.5-tasks-visibility.md docs/runbooks/chain-operations.md`; `git diff --check`. The implementation activity entry must name the authority SHA and confirm no live task, production command, restart, or migration was used.

2. **Make shared polling resource-identified before changing the task page.**

   **Change** — In `apps/web/src/lib/hooks.ts`, change `usePoll` so held data, errors, loading state, validators, and late responses are associated with the exact `path` generation. On the render in which `path` changes, expose `data=null`, `error=null`, and `loading=true` for the new path even before effects run; a response from an older generation must be ignored. Preserve same-resource behavior: a transient poll failure may retain the last successful payload from that same path, a 304 keeps its validator, hidden tabs remain idle, and `reload()` invalidates only the current generation. In `apps/web/src/App.tsx`, key `TaskDetailPage` by `taskId` as a second boundary so page-local action errors, pending state, run expansion, output expansion, and the nested Activity draft unmount on navigation. Extend `apps/web/src/lib/poll-state.ts` only with small pure state predicates needed to distinguish initial loading, authoritative 404, and same-resource transient failure; do not introduce another polling cadence.

   **Depends on** — step 1.

   **Verify** — Add path-switch and late-response cases to `apps/web/src/tests/conditional-poll.test.tsx` (or a focused new `poll-resource.test.tsx`) and update `apps/web/src/tests/poll-state.test.tsx`. Run `TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --import tsx --test apps/web/src/tests/conditional-poll.test.tsx apps/web/src/tests/poll-state.test.tsx`. Tests must prove the old payload is absent in the immediate destination render, an old request cannot win after the switch, same-path transient retention still works, and reload/304 behavior is unchanged.

3. **Render a truthful task prompt and explicit per-resource loading/output/activity states.**

   **Change** — Add `apps/web/src/lib/task-prompt.ts` with a pure `partitionTaskPrompt(description)` implementing the fixed marker rules above. Refactor `apps/web/src/pages/TaskDetail.tsx` into small exported cards for `TaskPrompt`, `TaskOutput`, and `Activity`: the prompt leads with the unique responsibility and puts the Product Contract in a closed `<details>` disclosure; output always has a card and renders **No output recorded** for the destination's 404, while loading and transient failures have distinct localized states; Activity does not render an empty history while its destination poll is still loading or failed, and it reports a same-resource transient error without discarding current data. Show a nonfatal main-task polling error above the still-current task, while a 404 remains authoritative and an initial/transient error with no destination data is an error page. Update `apps/web/src/locales/en.ts` and `apps/web/src/locales/zh.ts` for **Task prompt**, Product Contract disclosure, effective-runner-prompt explanation, loading, no-output, and retry/error copy.

   **Depends on** — step 2.

   **Verify** — Extend `apps/web/src/tests/task-detail.test.tsx` and add pure parser cases for all seven TC-UX step descriptions: each unique `Step responsibility:` is visible first, the common Product Contract disclosure has no `open` attribute, ordinary free-form prompts remain intact, and the runner-components explanation names only the four components actually confirmed by `packages/runner/src/adapters.ts::buildPrompt`. Run `TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --import tsx --test apps/web/src/tests/task-detail.test.tsx`. Include output cases for 200 body, whitespace body, 404, initial loading, transient-without-data, and transient-with-current-data.

4. **Replace per-row startability with one chain dependency decision in the API contract.**

   **Change** — In `packages/api/src/chain.ts`, retain `startable` as the row-local capability predicate but add pure ordered-chain helpers (for example `firstUnfinishedStep`, `blockingPredecessor`, and `chainStartDecision`) that combine dependency order with the existing run/assignee/repo/archive/budget facts. The decision must return exactly one action (`start`, `recover`, or null), the first unfinished blocking predecessor where applicable, and current-execution facts without treating the viewed task as active. In `packages/api/src/app.ts::GET /tasks/:taskId/chain`, compute decisions once over the complete project-scoped indexed row set and return each row's safe `startable`, `startAction`, and `currentExecution`; preserve the isolated null-index envelope and existing progress/position behavior. Update `apps/web/src/lib/types.ts` for those additive fields.

   **Depends on** — step 1.

   **Verify** — Extend `packages/api/src/chain.test.ts` with table-driven cases: 1–3 DONE/4 DOING means no action on 5+; 1–3 DONE/4 TODO yields one `start`; 4 BACKLOG yields one `recover`; 4 REVIEW or HUMAN blocks all successors; archived or deleted predecessor semantics match the fixed decision; active/budget/repo/agent failures suppress the only candidate. Extend `packages/api/src/chain.dbtest.ts` so the real route returns those exact fields for template and API-created chains. Run `npm test -w @agentos/api` and, against the dedicated non-public test schema only, `npm run test:db -w @agentos/api`.

5. **Add ordered chain locks and enforce dependency-safe manual start atomically.**

   **Change** — Add exported helpers for the ordered indexed-chain prefix and exact repo-grant row. `POST /tasks/:taskId/start` acquires Task-prefix then grant, revalidates immediately before Run creation, and shares the dependency helpers used by rendering. Grant revocation takes only the exact grant lock and refuses to remove a grant used by an active Run. A future step returns 409 with the first unfinished predecessor's name and creates no Run, status write, output, Inbox change, or activity. Preserve standalone start and BACKLOG recovery exactly once.

   **Depends on** — step 4.

   **Verify** — In `packages/api/src/tasks.dbtest.ts`, add real-Postgres cases for direct start of steps 5/6 while step 4 is DOING (specific 409 naming step 4; before/after snapshots of every task status, Run count, TaskStepOutput, TaskActivity, and InboxMessage unchanged), happy TODO and BACKLOG next-step starts, non-chain start, and simultaneous double start. Run `cd packages/api && node --import tsx --test --test-concurrency=1 src/tasks.dbtest.ts` with `TEST_DATABASE_URL` set only to a dedicated non-public schema (or use the harness's workspace-derived default); never point it at the live database.

6. **Complete the mutex in automatic advancement and prove completion/start idempotency.**

   **Change** — In `activateChainSuccessor`, resolve, lock, and re-read the first surviving non-DONE successor in a reselection loop so concurrent deletion and legacy DONE gaps cannot stall advancement. Successful completion locks its current chain Task before mutating task/output/chain state and retains predecessor-then-successor ordering. Inbox approval continues through the same successor helper; runner routing, lease/fencing, retry policy, and gate choices are unchanged.

   **Depends on** — step 5.

   **Verify** — Add a synchronized completion-versus-manual-start test to `packages/api/src/tasks.dbtest.ts` or `packages/api/src/chain.dbtest.ts` using two clients/barriers: predecessors end DONE, target ends TODO with exactly one active Run, one start path wins/one is idempotently refused, and no duplicate activity/output is created. Retain and run the existing automatic successor, parked BACKLOG, gate approval/rejection, and duplicate-decision tests in `packages/api/src/chain.dbtest.ts` and `packages/api/src/workflow.test.ts`. Focused command: `cd packages/api && node --import tsx --test --test-concurrency=1 src/tasks.dbtest.ts src/chain.dbtest.ts`; unit command: `npm test -w @agentos/api`.

7. **Guard ordinary Task PATCH without weakening legitimate gate and recovery channels.**

   **Change** — In `packages/api/src/app.ts::PATCH /tasks/:taskId`, reject an actual `approvalGate` value change when `chainId` is non-null. For `status: DONE`, join the ordered prefix lock, re-read the task, reject if `hasActiveRun` is true, and reject if the first earlier surviving row is not DONE, naming that predecessor; perform gate-card closure, status/activity write, and successor activation only after all guards pass in the same transaction. Leave Inbox decisions (`applyInboxDecisionTx`), automatic run completion/advancement, retry, BACKLOG parking, unarchive, and non-chain PATCH behavior on their existing dedicated paths. Keep the current no-op/replay semantics when an already-decided gate card proves another decision channel won.

   **Depends on** — steps 5 and 6.

   **Verify** — Extend `packages/api/src/tasks.dbtest.ts` with: approvalGate change on a dispatched chain → 409/no changes; future DONE with an unfinished predecessor → named 409/no changes; DONE with any active-run status including `WAITING_INBOX` → 409/no closed gate/no activity; safe current-step DONE → one advancement; standalone approvalGate/status PATCH remains supported. Run `npm run test:db -w @agentos/api`, and explicitly retain the existing Inbox approval, rejection, HUMAN gate closure, automatic successor, retry, parking, and unarchive cases. Add API unit response-shape/reason-ladder coverage to `packages/api/src/app.test.ts` and run `npm test -w @agentos/api`.

8. **Make chain rows and task controls state their real meaning.**

   **Change** — In `apps/web/src/components/chain-list.tsx`, render **Completed n/m**, **Viewed here**, and `currentExecution` as independent localized labels. Use `startAction` to show **Start next step** or **Recover parked step**, never a generic future-step control. Render HUMAN with `IconUser` in a dedicated neutral human chip rather than passing a human label to `AgentChip` (which always uses `IconRobot` for named values). In `apps/web/src/pages/TaskDetail.tsx`, replace the editable status select with read-only chain guidance for chain tasks, retain it for standalone tasks, and replace the approval toggle with a read-only value for chain tasks; keep Retry, archive/unarchive, refresh, and surfaced API errors. Update `apps/web/src/locales/en.ts` and `apps/web/src/locales/zh.ts` with all labels and action-effect copy.

   **Depends on** — steps 3, 4, and 7.

   **Verify** — Update `apps/web/src/tests/chain-list.test.tsx` to assert: one action at most; none on 5+ while 4 is DOING/REVIEW; parked next row says recovery; Completed copy; viewed/current labels land on the correct rows and coincide only when both facts point to that row; HUMAN markup contains the user glyph path and no robot glyph/start button. Update `apps/web/src/tests/task-detail.test.tsx` to assert chain controls are read-only while standalone controls remain. Run `TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --import tsx --test apps/web/src/tests/chain-list.test.tsx apps/web/src/tests/task-detail.test.tsx`, then `npm test -w @agentos/web` for the i18n sweep.

9. **Add the mounted path-switch/browser regression matrix.**

   **Change** — Add `task-detail-navigation.test.tsx` with JSDOM, `createRoot`, and deferred fetch. The immediate A→B assertion is a B-identity loading shell with no A content or controls; destination title/prompt/status and **No output recorded** are asserted only after B task 200 and output 404 settle. Late A responses cannot restore source state. Destination PATCH, archive, safe chain start, and activity send must all use B (or B's chain row), never A.

   **Depends on** — steps 2, 3, and 8.

   **Verify** — `TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --import tsx --test apps/web/src/tests/task-detail-navigation.test.tsx`; then `npm test -w @agentos/web`. The test must fail if `TaskDetailPage` loses its key, `usePoll` exposes mismatched-path data, output 404 hides the card, or an action closure uses the prior id.

10. **Run final-tree gates, browser verification, and prepare one-branch evidence/rollback.**

   **Change** — Fetch current `origin/master` again. If it advanced, rebase the shared branch once, re-run the authority/ownership checks, and stop on a semantic conflict or CP-A overlap rather than resolving ownership code opportunistically. On the final rebased tree run the focused suites first, then build before full tests (the web style suite reads built CSS), real DB tests once without retry, typecheck, and diff checks. For real-browser verification, start only disposable local API/web processes against the dedicated non-public test schema or a fixture-only HTTP server; never use the live control-plane database or press controls on the live CP-A/TC-UX chain. Drive A1/A3/A6 in English and Chinese at desktop width: output→no-output immediate navigation, seven responsibility prompts with closed common contract, step 4 DOING with no actions on 5+, parked recovery, Viewed here vs Current execution, and HUMAN user glyph. Record exact base/head SHAs, commands/counts, browser scenarios, changed symbols, no-migration result, and limitations in the implementation output and PR; keep Plan/review/implementation commits on this one branch and one PR.

   **Depends on** — steps 1–9.

   **Verify** — in this order:

   ```sh
   git fetch origin master:refs/remotes/origin/master
   FINAL_BASE_SHA=$(git rev-parse refs/remotes/origin/master)
   git rev-parse HEAD
   git merge-base --is-ancestor "$FINAL_BASE_SHA" HEAD
   npm run build
   npm test
   npm run test:db
   npm run typecheck
   git diff --check "$FINAL_BASE_SHA"...HEAD
   git status --short --branch
   git diff --name-only "$FINAL_BASE_SHA"...HEAD
   git diff --exit-code "$FINAL_BASE_SHA"...HEAD -- packages/db/prisma/schema.prisma packages/db/prisma/migrations
   git diff --exit-code -- packages/db/prisma/schema.prisma packages/db/prisma/migrations
   ```

   `npm run test:db` must use the existing dedicated non-public schema guard and pass in one final-tree invocation. Both committed-range and working-tree schema/migration diffs must be empty. Rollback is a whole-PR revert followed by build, unit, typecheck, and one no-retry dedicated-schema DB invocation; no data rollback exists because there is no migration. Production activation, restart, live mutation, and migration remain outside this chain.

## Requirement-to-step map

| Product requirement / acceptance | Implemented in | Verified in |
| --- | --- | --- |
| Behavior 1: sequential chain, one safe TODO/BACKLOG next AGENT, budget/assignee/repo/active checks, no force | 4, 5 | 4, 5, 8, 10 |
| Behavior 2: API dependency guard, explicit locking, named 409, zero side effects, standalone start | 5, 6 | 5, 6, 7, 10 |
| Behavior 3: task-id invalidation; explicit loading/404/transient states; keyed drafts/expansion/errors/actions; honest missing output | 2, 3, 9 | 2, 3, 9, 10 |
| Behavior 4: unique responsibility first, common Product Contract collapsed, truthful effective-prompt explanation | 3 | 3, 9, 10 |
| Behavior 5: Viewed here vs Current execution, Completed n/m, no-output, HUMAN user glyph | 3, 4, 8 | 3, 8, 9, 10 |
| Behavior 6: effect-labelled start/recovery, only next action, predecessor errors | 4, 5, 8 | 4, 5, 8, 10 |
| Behavior 7: chain gate immutability, no future/active-run DONE, constrained UI, Inbox/retry/parking/unarchive/auto-advance retained | 6, 7, 8 | 6, 7, 8, 10 |
| In-scope localized web/API/workflow/test/docs work; no router/model/CP-A redesign | 1–10 | 10 diff surfaces and no-migration check |
| A1 output→no-output settled and immediate navigation | 2, 3, 9 | 9, 10 browser |
| A2 no cross-id patch/archive/start/comment; drafts/local state isolated | 2, 9 | 2, 9 |
| A3 seven distinct responsibilities; common contract closed; runner components truthful | 3 | 3, 9, 10 browser |
| A4 step 4 DOING blocks 5/6 UI and POST, named 409, zero mutation | 4, 5 | 4, 5, 8 |
| A5 next TODO/BACKLOG starts once; double and completion races idempotent | 5, 6 | 5, 6 |
| A6 REVIEW blocks successors; HUMAN no robot/start; viewed/current markers truthful | 4, 8 | 4, 8, 10 browser |
| A7 PATCH gate/future-DONE/active-run guards; legitimate control paths pass | 6, 7, 8 | 6, 7, 8 |
| A8 focused web/API/DB tests, typecheck, build, affected/full tests, diff, browser on final rebased tree | 9, 10 | 10 |
| A9 one branch/PR with exact base/head, checks, symbols, limitations; no production/restart/migration/live mutation | 1, 10 | 1, 10 |

## Stop and rollback boundaries

- Stop immediately on an unexplained Run or activity creation in a rejected path, any contact with the live CP-A chain, need to weaken a gate/dependency, need for a database migration, failure to reproduce on refreshed master, same-branch/worktree ownership overlap, or a required production restart.
- Treat a final `origin/master` advance as stale authority: rebase/revalidate once and repeat all final-tree evidence; do not carry a pre-rebase green result forward.
- Use only scratch fixtures and the test harness's dedicated non-public schema. Do not copy the production database into a second control plane and do not use live future-step controls as acceptance probes.
- Code rollback is a whole-PR revert. Because wire additions are backward-compatible and there is no schema/data change, rollback needs no repair script; rerun build, unit tests, and typecheck before any later controlled deployment.
