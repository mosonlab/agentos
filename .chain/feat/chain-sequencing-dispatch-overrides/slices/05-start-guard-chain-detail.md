---
id: 05-start-guard-chain-detail
title: Manual-start refusal and chain-detail blockedOn projection
blocked_by:
  - 01-dispatch-binding-schema
files_hint:
  - packages/api/src/chain.ts
  - packages/api/src/app.ts
  - packages/api/src/chain.test.ts
  - packages/api/src/chain.dbtest.ts
risk: true
---

## Delivers

Spec sections 6.6 and 6.8, and the API half of S18. Depends only on the
column; test fixtures seed the binding directly. Touches `app.ts` only in the
`/tasks/:taskId/start`, `/tasks/:taskId/startability`, and
`/tasks/:taskId/chain` route region (around lines 3333-3921 at base), disjoint
from the instantiate region slice 03 edits.

- Extend the start-decision ladder in `packages/api/src/chain.ts` (the
  `startable` / `startAction` computation): a task whose `dispatchAfterTaskId`
  is set and whose predecessor status is not DONE reports startable false and
  startAction null, in the same reason ladder that already refuses a task
  whose in-chain predecessor is not done.
- POST `/tasks/:taskId/start` refuses such a task with 409 and a message
  naming the bound predecessor, evaluated under the chain row lock the route
  already takes so it cannot race a dispatch. Once the predecessor is DONE
  the route behaves exactly as today, including the Backlog recover path.
  POST `/tasks/:taskId/retry` is unchanged.
- GET `/tasks/:taskId/chain` gains
  `blockedOn: { taskId, name, status } | null` on each step entry, non-null
  only on the bound first task of a chain with an unresolved binding,
  resolved in one additional query issued only when the chain first task
  carries a binding. Nothing else in the chain response changes: total, done,
  layer, position, executionOwner, mergeRecovery and per-step start decisions
  keep their current meaning for every chain, bound or historical.

## Acceptance

All red at the frozen base: no route reads the column and `blockedOn` does not
exist in the chain response.

1. Unit tests in `packages/api/src/chain.test.ts` cover the new ladder rung:
   unresolved binding yields startable false and startAction null; resolved
   binding (predecessor DONE) restores today's decision; unbound rows are
   untouched (assert against existing expectations).
2. Dbtest cases (in `packages/api/src/chain.dbtest.ts` or a focused sibling)
   prove spec 12.1.7 over HTTP: starting the bound first task returns 409
   naming the predecessor and creates no Run; after the predecessor is DONE
   the same call behaves as for any chain first step; retry of a dispatched
   task is ungated.
3. Chain-detail dbtest: the bound first task step entry carries blockedOn
   with the predecessor id, name and status while unresolved, and null once
   the predecessor is DONE; every other step and every unbound chain carries
   blockedOn null with the rest of the response byte-identical to today; the
   predecessor lookup is bounded by a deterministic executable assertion: a
   dbtest Prisma client with a query-event listener (`$on("query")`, or an
   equivalent counted adapter around the extracted lookup) counts statements
   across the chain-detail request and asserts an unbound chain issues zero
   predecessor-lookup queries and a bound chain exactly one. No code-review
   fallback is acceptable.
4. Legacy-chain display regression: an existing chain fixture renders the
   same chain response as before the feature.

Verification: `npm run typecheck`, `npm run test -w @agentos/api`,
`npm run test:db -w @agentos/api -- src/chain.dbtest.ts`.
