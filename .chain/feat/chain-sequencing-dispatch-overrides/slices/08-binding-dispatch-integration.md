---
id: 08-binding-dispatch-integration
title: Route-to-dispatch integration and the instantiate-versus-completion race
blocked_by:
  - 03-after-task-binding
  - 04-terminal-dispatch
files_hint:
  - packages/api/src/dispatch-lifecycle.dbtest.ts
risk: true
---

## Delivers

The executable cross-path proof neither 03 nor 04 can supply alone: spec edge
case 8.10 and one public-route-to-terminal-completion lifecycle. Slice 03
proves the instantiate side with no dispatcher on the other end; slice 04
proves the dispatcher against directly seeded bindings. This join slice
drives both through the production entry points only - the instantiate HTTP
route creates the binding, the server-owned completion path resolves it - and
proves the predecessor chain mutex actually makes the two paths mutually
exclusive. Test-only: it adds no application code and edits no file another
slice owns.

- Lifecycle: instantiate chain A (autoStart), instantiate chain B over the
  route with afterTaskId naming the chain A terminal task, complete chain A
  through a production completion path, and observe exactly one first Run on
  chain B with the S1/S2 activity rows - no direct column seeding anywhere.
- Race, both outcomes (spec 8.10): an instantiate call and the predecessor
  terminal completion serialised on the same predecessor chain mutex. When
  instantiation wins, the following completion resolves the binding and
  dispatches exactly once. When completion wins, the instantiate call returns
  400 after_task_already_done and creates no chain. A binding is never
  created that no completion will ever see.

## Acceptance

All red at the frozen base: neither the route input nor the dispatch code
exists, and the test file is new.

1. New dbtest file `packages/api/src/dispatch-lifecycle.dbtest.ts` proves the
   full lifecycle above through the HTTP route and the production completion
   path: 201 with the binding on the first task only, zero Runs while inert,
   exactly one Run (runNumber 1) for the bound first task after terminal
   completion, and the binding column retained afterwards.
2. Race outcome one: begin the instantiate transaction so it holds the
   predecessor chain mutex, run the completion concurrently, and assert the
   completion observes and dispatches the committed binding - exactly one Run
   for chain B, counted by Run rows.
3. Race outcome two: complete the predecessor first, then instantiate with
   afterTaskId naming it; assert 400 after_task_already_done and a follow-up
   query proving zero Task, TaskActivity, Run and TriggerFire rows for the
   attempted chain.
4. Both race tests drive ordering through the same chain-mutex serialization
   the dbtest harness already uses for concurrency tests, so outcomes are
   deterministic, not timing-dependent.

Verification: `npm run typecheck`,
`npm run test:db -w @agentos/api -- src/dispatch-lifecycle.dbtest.ts`.
