---
id: 01-schema-expand-chain-layer
title: Expand schema with nullable layer columns, preflights, and legacy backfill
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

The expand half of the expand-migrate-contract staging (spec 3.1 additions,
3.2 steps 1-3). This slice adds no constraint that a current writer violates:
at the frozen base `packages/api/src/templates.ts`, the public creation routes
in `packages/api/src/app.ts`, and `packages/db/prisma/seed.ts` all create
template-step and chained-task rows without layer values, and they keep
working unchanged until slices 04/05/06 migrate them. `Task.followUpTaskId`
is NOT touched here; slice 09 tightens and contracts after every writer and
reader has migrated.

- Fail-loud preflights run before any backfill, per spec 3.2 step 1:
  - abort on any pre-existing partial chain identity (`chainId` without
    `chainIndex` or vice versa);
  - abort on any `followUpTaskId` relationship whose source and target are
    not already members of the same project and chain in increasing
    `chainIndex` order.
  A preflight failure aborts the migration with a named error and changes no
  rows. Slice 09 repeats the follow-up consistency check as a second fence
  immediately before the column drop.
- `TaskTemplateStep.layer Int?` added nullable to
  `packages/db/prisma/schema.prisma` (model at schema.prisma:480). Every
  existing template step is backfilled with a dense rank of `stepIndex` (one
  step per layer). The non-null tightening happens in slice 09, after the
  writers in slices 05/06 persist `layer` on every new row.
- `Task.chainLayer Int?` added (model at schema.prisma:503). Every existing
  chained task is backfilled with a dense rank of `chainIndex` within
  `(projectId, chainId)`, so existing chains keep sequential behavior.
- `@@unique([chainId, chainIndex])` is preserved as the node identity.
- The all-or-none `CHECK` over `chainId`/`chainIndex`/`chainLayer` is NOT
  added here, because base-state writers still create chained tasks without
  `chainLayer`. It is added and validated in slice 09 (spec 3.2 step 4),
  after slices 04/06 migrate all writers.
- `packages/db/src/schema-census.ts` extended so the census knows the new
  nullable columns; the final-shape census update belongs to slice 09.

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
3. A dbtest proves both preflights fail loud and change nothing: (a) a seeded
   partial chain identity and (b) a seeded inconsistent `followUpTaskId`
   relationship (cross-chain or decreasing index) each abort the migration
   with a named error, and a full row snapshot before/after proves no row
   changed.
4. A dbtest proves base-shaped writers still work post-expand: creating a
   chained task without `chainLayer` and a template step without `layer`
   succeeds (columns are nullable; no premature constraint).
