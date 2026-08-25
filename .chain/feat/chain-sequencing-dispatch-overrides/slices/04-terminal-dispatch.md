---
id: 04-terminal-dispatch
title: Server-owned dispatch on terminal chain completion
blocked_by:
  - 01-dispatch-binding-schema
files_hint:
  - packages/db/src/workflow.ts
  - packages/api/src/dispatch-activation.dbtest.ts
risk: false
---

## Delivers

Spec section 7 in full, scenarios S2, S3, S19 (progression half), and edge
cases 8.1-8.8, 8.14. This slice depends only on the column from 01; its
fixtures seed `dispatchAfterTaskId` directly on Task rows with prisma, so it
does not wait for the instantiate-route slice 03.

- Extend the terminal-completion point inside
  `activateChainSuccessorInternal` / `advanceTemplateTask` in
  `packages/db/src/workflow.ts` - the exact point where the existing code
  concludes the chain is complete - to resolve at most one bound successor:
  the unique Task whose `dispatchAfterTaskId` equals the completing task id.
  Because it lives on the shared server-owned path, all three completion
  entry points (run completion, approval-gate approval, operator PATCH to
  DONE) inherit it with no per-route code.
- Ordering and locking: runs under the predecessor chain row mutex after the
  completing task is re-read DONE; takes the successor chain row mutex second
  (predecessor-then-successor order is total because a binding can only point
  at a pre-existing chain); re-reads the successor first task under that lock
  and queues through the single shared `enqueueTaskRun` path so every
  existing Run-creation guard applies.
- Fail-closed refusals: a successor that is no longer queueable (not TODO,
  archived, active Run, assigneeType not AGENT, missing repo, archived
  assignee, missing grant) is parked in REVIEW with a specific failureReason
  and activity rows on both tasks; predecessor completion is preserved and
  committed, mirroring the stopped-integrator precedent. A bound successor
  found while the predecessor chain still has unfinished layers is parked
  with the bound-predecessor-no-longer-terminal reason. A unique conflict
  from concurrent Run creation is caught at a savepoint, treated as already
  queued, recorded in activity, and never rolls back the completion. Any
  other error propagates.
- Activity: successor first task records predecessor-completed-and-queued
  with predecessor task id and chain id in metadata; predecessor records
  bound-chain-dispatched with the successor chainId in metadata. The binding
  column is never cleared. With no binding the path is byte-identical to
  today, including the Chain complete line.

## Acceptance

All red at the frozen base: no code reads `dispatchAfterTaskId` and every test
below is new. Fixtures create both chains via the existing instantiation
helper, then set the binding column directly on the successor first task.

1. New dbtest file `packages/api/src/dispatch-activation.dbtest.ts` proves
   spec 12.2.1: terminal completion queues exactly one Run (runNumber 1) for
   the bound first task with the same run configuration a plain autoStart
   instantiation produces, and both activity rows carry the binding metadata.
2. Concurrency (spec 12.2.2): two transactions completing or advancing the
   same predecessor concurrently produce exactly one Run for the successor
   first task, asserted by counting Run rows.
3. No queue before terminal DONE (spec 12.2.3): completing every non-terminal
   predecessor step, a failed terminal run, and a retry leave the bound chain
   with zero Runs; dispatch fires once on the completion that reaches DONE.
4. Entry points (spec 12.2.4): run completion, approval-gate approval, and
   operator PATCH to DONE applied in sequence to one bound chain produce one
   Run in total.
5. Unstartable successor (spec 12.2.5, edge cases 8.6-8.8): archived
   successor task, archived assignee, and revoked grant each park the
   successor in REVIEW with the specific failureReason, write both activity
   rows, and leave the predecessor DONE.
6. Regressions (spec 12.2.6-12.2.7): an unbound chain completes with the
   Chain complete activity line and no additional row; the legacy fixture
   with a DONE gap and null chainLayer advances exactly as before.

Verification: `npm run typecheck`,
`npm run test:db -w @agentos/api -- src/dispatch-activation.dbtest.ts`,
`npm run test -w @agentos/api` and the existing chain dbtest suite
(`npm run test:db -w @agentos/api -- src/chain.dbtest.ts`) for regressions.
