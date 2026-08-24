---
id: 01-schema-expand-chain-layer
title: Expand schema with TaskTemplateStep.layer and Task.chainLayer plus legacy backfill
blocked_by: []
files_hint:
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/
  - packages/db/src/schema-census.ts
  - packages/api/src/migration.dbtest.ts
risk: true
---

# Slice 01: Schema expand for chain layers

## Delivers

The expand half of the expand-migrate-contract staging (spec 3.1, 3.2 steps
2-4). `Task.followUpTaskId` is NOT touched here; slice 09 contracts it after
all writers and readers have migrated.

- `TaskTemplateStep.layer Int` added to `packages/db/prisma/schema.prisma`
  (model at schema.prisma:480) and made non-null by backfilling every existing
  template with a dense rank of `stepIndex` (one step per layer).
- `Task.chainLayer Int?` added (model at schema.prisma:503). Every existing
  chained task is backfilled with a dense rank of `chainIndex` within
  `(projectId, chainId)`, so existing chains keep sequential behavior.
- `@@unique([chainId, chainIndex])` is preserved as the node identity.
- A database `CHECK` constraint requiring `chainId`, `chainIndex`, and
  `chainLayer` all `NULL` or all non-`NULL`, added and validated after
  backfill.
- The migration is fail-loud: it aborts on any pre-existing partial chain
  identity (`chainId` without `chainIndex` or vice versa) instead of patching
  rows.
- `packages/db/src/schema-census.ts` extended so the census knows the new
  columns and the `CHECK`.

## Acceptance

All red at frozen base 5f5aad1 because neither column exists.

1. Prisma validates and migrates cleanly on a scratch database:
   `npm run db:validate` and the migration dbtest suite pass with the new
   migration applied. Verification: `npm run test:db -w @agentos/api`
   (`packages/api/src/migration.dbtest.ts`).
2. A migration dbtest seeds a pre-migration-shaped template (linear steps) and
   chain (distinct chainIndex values), runs the migration path, and asserts
   dense-rank `layer` and `chainLayer` values equal the rank of
   `stepIndex`/`chainIndex`.
3. A dbtest proves the `CHECK`: inserting a task with `chainId` and
   `chainIndex` but `chainLayer` NULL is rejected by the database, as is any
   other partial combination; all-NULL standalone tasks still insert.
4. A dbtest proves the fail-loud precondition: a seeded partial chain identity
   makes the migration abort with a named error and no rows changed.
