---
id: 01-dispatch-binding-schema
title: Task dispatch binding column, migration, and storage-layer invariants
blocked_by: []
files_hint:
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260825120000_task_dispatch_binding/migration.sql
  - packages/db/src/schema-census.ts
  - packages/api/src/migration.dbtest.ts
risk: true
---

## Delivers

Spec section 5 in full: the one and only schema change of the feature.

- Prisma model `Task` gains `dispatchAfterTaskId String? @unique` plus the
  `TaskDispatchBinding` self-relation pair: `dispatchAfter` with a composite
  foreign key over `(dispatchAfterTaskId, projectId)` referencing the existing
  `(id, projectId)` unique pair, `onDelete: Restrict`, and the inverse
  `dispatchedChainFirstTask` relation. This makes a cross-project binding
  unrepresentable and matches the `goalPredecessorTaskId` Restrict precedent.
- A new additive migration that only adds the column, the unique index, the
  composite foreign key, and the check constraint
  `Task_dispatch_binding_shape_check`:
  `dispatchAfterTaskId IS NULL OR (chainId IS NOT NULL AND goalId IS NULL AND
  dispatchAfterTaskId <> id)`. No backfill, no rewrite of existing rows, no
  change to `Task_goal_runtime_shape_check` or
  `Task_chain_identity_all_or_none_check`.
- Schema census / schema contract updates so the generated client and any
  column inventory acknowledge the new column (follow whatever
  `packages/db/src/schema-census.ts` and its test require for a new Task
  column).
- Prisma client regeneration so `dispatchAfterTaskId` is selectable and
  writable by later slices.

This slice writes no application logic. The column exists, defaults to null on
every existing and newly created row, and nothing reads it yet. Later slices
(02-07) build on the column; dbtest fixtures in those slices may write it
directly without going through the instantiate route.

## Acceptance

All red at the frozen base because neither the column nor the migration exists.

1. `npx prisma migrate deploy` (per CONTRIBUTING, against the throwaway
   TEST_DATABASE_URL schema) applies the new migration cleanly forward on a
   database carrying all prior migrations; applying it changes no existing row
   (assert row counts and a checksum of a pre-created Task row before and
   after in the migration dbtest).
2. New dbtest cases in `packages/api/src/migration.dbtest.ts` (or a sibling
   dbtest file if that file's shape does not fit) prove at the SQL layer:
   - inserting a Task with `dispatchAfterTaskId` set while `chainId IS NULL`
     is rejected by `Task_dispatch_binding_shape_check`;
   - a Goal-linked task (`goalId` set) cannot carry a binding;
   - a self-binding (`dispatchAfterTaskId = id`) is rejected;
   - two rows pointing at the same predecessor violate the unique index;
   - a cross-project pointer violates the composite foreign key;
   - deleting a predecessor with a bound successor is refused (Restrict);
   - existing Goal safety kernel constraint tests still pass unchanged
     (spec 12.2.8).
3. `npm run test -w @agentos/db` passes, including the schema contract test,
   with the census updated.
4. `npm run typecheck` passes with the regenerated client.

Verification: `npm run typecheck`, `npm run test -w @agentos/db`,
`npm run test:db -w @agentos/api -- src/migration.dbtest.ts`.
