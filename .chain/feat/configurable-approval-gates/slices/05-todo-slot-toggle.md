---
id: 05-todo-slot-toggle
title: "TODO-slot gate toggle through task PATCH and chain view"
blocked_by: [01-gate-slot-helper]
risk: true
---

# 05: TODO-slot gate toggle through task PATCH and chain view

**What to build:** Let an operator change `approvalGate` on either gate-slot
task only while its stored status is TODO. The write path re-reads status under
the task-row mutex, persists the new value, and records an operator activity
naming the slot and value. A non-slot chain task remains forbidden; a slot in
DOING, REVIEW, or DONE is refused with 409 and its actual state. Standalone task
behaviour remains unchanged.

In chain detail, each slot uses the `gateSlot` projection from slice 01 to show
its current value as a toggle. It is enabled only in TODO and otherwise disabled
with the same state-specific reason the server returns. Non-slot rows retain
their current rendering, and the standalone task editor remains the only editor
for a non-chain task.

**Blocked by:** 01-gate-slot-helper

## Acceptance

- [ ] A table-driven PATCH scenario shows both TODO slot types newly accepting
  on/off changes with operator activity while the standalone-task row in the
  same scenario keeps its existing gate-edit behaviour.
- [ ] A slot in each of DOING, REVIEW, and DONE returns 409 naming that state;
  a non-slot chain task returns 409 naming the slot restriction.
- [ ] A slot that passes the initial TODO eligibility check but leaves TODO
  before the locked re-read receives a state-named 409 and is not patched.
- [ ] Chain detail renders the current value for both slot types, enables only a
  TODO slot, displays the shared refusal reason on a disabled slot, sends the
  task PATCH when changed, and preserves the non-slot row rendering in that same
  feature scenario.

## Verification

- Existing API unit test extended: `packages/api/src/task-patch.test.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" node --conditions=development --import tsx --test packages/api/src/task-patch.test.ts`
- Existing API dbtest extended: `packages/api/src/task-patch.dbtest.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test:db -w @anneal/api -- src/task-patch.dbtest.ts`
- Existing chain-view test extended: `apps/web/src/tests/chain-list.test.tsx` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --conditions=development --import tsx --test apps/web/src/tests/chain-list.test.tsx`
- Existing locale sweep: `apps/web/src/tests/i18n-sweep.test.tsx` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --conditions=development --import tsx --test apps/web/src/tests/i18n-sweep.test.tsx`
- Scoped controls: `npm run typecheck -w @anneal/db`,
  `npm run typecheck -w @anneal/api`, `npm run typecheck -w @anneal/web`,
  `npm run lint -w @anneal/db`, `npm run lint -w @anneal/api`, and
  `npm run lint -w @anneal/web`.
