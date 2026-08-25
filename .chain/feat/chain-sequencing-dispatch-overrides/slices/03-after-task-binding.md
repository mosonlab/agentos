---
id: 03-after-task-binding
title: afterTaskId binding on the instantiate route
blocked_by:
  - 01-dispatch-binding-schema
  - 02-step-overrides
files_hint:
  - packages/api/src/app.ts
  - packages/api/src/templates.ts
  - packages/api/src/template-dispatch-binding.dbtest.ts
risk: false
---

## Delivers

Spec sections 6.1 (afterTaskId half), 6.2, 6.3 (the after_task_* codes and
dispatch_conflicts_with_auto_start), 6.4, and scenarios S1, S4-S10, plus edge
cases 8.9, 8.10, 8.12, 8.13. Blocked by 01 for the column and by 02 because
both slices rewrite the body of `instantiateTemplate` and share the typed
refusal module.

- `instantiateTemplateInput` gains optional `afterTaskId` (same id schema as
  path parameters). `afterTaskId` together with `autoStart: true` is refused
  at the schema layer with code dispatch_conflicts_with_auto_start, before
  any database work.
- Inside the existing serializable instantiation transaction, in order: lock
  the predecessor chain rows with the same full-chain row mutex the
  completion path takes (reuse `lockChainRows` from @agentos/db); re-read and
  re-validate the predecessor under that lock (same project, chainId present,
  sole occupant of its terminal layer using the chainLayer-with-chainIndex
  fallback the code already applies, not archived, not DONE); create the
  chain rows exactly as today with `dispatchAfterTaskId` written on the first
  task inside the same transaction; enqueue no Run; write the first-task
  activity line naming the predecessor and one activity row on the
  predecessor task carrying the new chainId in metadata.
- Refusal codes implemented through the slice-02 typed error module:
  after_task_not_found (also for cross-project, spec A5), after_task_not_chained,
  after_task_not_terminal, after_task_already_bound, after_task_already_done,
  after_task_archived. An occupied-pointer unique conflict (P2002 on the new
  unique index) is classified as after_task_already_bound and is not retried
  by the bounded serialization-retry loop.
- Response shape: Task rows in the 201 body carry `dispatchAfterTaskId`, null
  everywhere except the bound first task. Unbound instantiation, including
  autoStart and the trigger/webhook callers, is byte-unchanged.

## Acceptance

All red at the frozen base: the input property, column write, and every test
below are new.

1. New dbtest file `packages/api/src/template-dispatch-binding.dbtest.ts`
   proves spec 12.1.1-12.1.5 through the HTTP route: valid bind creates all
   thirteen tasks in one transaction, binding on the first task only, zero
   Run rows, 201; each after_task_* refusal returns 400 with its code and a
   follow-up query proves zero Task, TaskActivity, Run and TriggerFire rows
   for the attempted chain; two sequential binds to one predecessor leave the
   first binding unchanged and refuse the second with
   after_task_already_bound; afterTaskId plus autoStart true is refused
   before any write.
2. The same file asserts the unchanged-unbound contract: autoStart true still
   queues run 1 inside the transaction and autoStart false still queues
   nothing, asserted against the exact activity strings the code writes
   today (spec S4).
3. Race coverage at the transaction layer: two concurrent instantiate calls
   for one free predecessor produce exactly one chain and one
   after_task_already_bound (spec 8.9); an instantiate racing a predecessor
   completion yields either a resolvable binding or after_task_already_done,
   never a binding no completion will see (spec 8.10) - drive both sides
   through the same chain-mutex serialization the dbtest harness already
   uses for concurrency tests.
4. Binding activity rows exist on both the first task and the predecessor
   with the ids in metadata (spec 6.4.5-6.4.6).

Verification: `npm run typecheck`,
`npm run test:db -w @agentos/api -- src/template-dispatch-binding.dbtest.ts`,
`npm run test -w @agentos/api`.
