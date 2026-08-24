---
id: 09-schema-contract-drop-followup
title: Tighten layer constraints, drop followUpTaskId, and run the removal census
blocked_by:
  - 02-template-sources-layer-split
  - 03-review-role-prompts
  - 04-layer-scheduler
  - 05-canonical-sync-replacement
  - 06-api-layer-surface
  - 08-chain-ui-layers
files_hint:
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/
  - packages/db/src/schema-census.ts
  - packages/api/src/migration.dbtest.ts
risk: true
---

# Slice 09: Contract step and census

## Delivers

The contract half of the staging (spec 3.1 constraints and removal, 3.2
steps 1, 4, and 5, 8.9). Runs after every writer and reader has migrated:
templates.ts and public routes (slice 06), workflow.ts plus app.ts
activation/merge-tail and scheduler.ts (slice 04), seed and sync writers
(slice 05), web types and board (slice 08); sources are clean after slices
02 and 03; runtime predicates after slice 11 (transitively via 05). The
dependency on 08 serializes this slice behind the UI slice; that
terminal-frontier cost is priced in the plan summary and accepted because
the census must be repository-wide.

- Constraint tightening deferred from slice 01 (review finding PLAN-001),
  now that no writer creates rows without layer values:
  - `TaskTemplateStep.layer` becomes non-null;
  - the database `CHECK` requiring `chainId`, `chainIndex`, and `chainLayer`
    all `NULL` or all non-`NULL` is added and validated (spec 3.2 step 4).
- Second migration fence (the first ran in slice 01 before backfill): the
  drop migration re-refuses any `followUpTaskId` relationship whose source
  and target are not already members of the same project and chain in
  increasing `chainIndex` order; an inconsistent legacy relationship aborts
  before the column is dropped.
- `Task.followUpTaskId`, its self-relation `TaskFollowUp`
  (schema.prisma:559), and its unique index (schema.prisma:510) are dropped
  from the schema in the same migration, after the fence and tightening.
  There is one successor authority: the layer scheduler.
- Complete reference retirement (review finding PLAN-009): the full frozen-
  base inventory is `packages/db/src/workflow.ts` and
  `packages/api/src/app.ts` activation/merge-tail semantics (slice 04),
  `packages/api/src/scheduler.ts` standalone creation (slice 04),
  `packages/api/src/templates.ts` (slice 06),
  `packages/api/src/merge-integrator-fixture.ts` step identities (slice 11)
  with its follow-up write removed via the slice 06 instantiation change,
  `apps/web/src/lib/types.ts` and `apps/web/src/lib/board.ts` (slice 08),
  plus API/web tests owned by each slice above. This slice removes only
  what remains after those slices: the Prisma field, generated client
  types, and any residual test fixtures, then proves completeness.
- Source and schema census (spec 8.9): a test proves no remaining
  `followUpTaskId` reference in source or schema, no `ChainContinuation`
  table or type, no public dependency input, no nested review subprocess in
  any review role or canonical review step source, and no old combined
  review-step source file. `packages/db/src/schema-census.ts` is updated to
  the final shape (non-null layer, validated CHECK, no follow-up column).

## Acceptance

All red at frozen base 5f5aad1: the column, relation, and combined sources
all exist, `layer` is absent, and no CHECK exists.

1. A migration dbtest seeds a consistent legacy follow-up chain, runs the
   contract migration, and asserts non-null `layer`, the validated
   all-or-none `CHECK` (partial chain-identity inserts are rejected by the
   database; all-NULL standalone tasks still insert), and that the column
   and index are gone while chain rows and behavior survive. Verification:
   `npm run test:db -w @agentos/api`.
2. A dbtest seeds an inconsistent follow-up relationship (cross-chain or
   decreasing index) and asserts the migration aborts by name before
   tightening or dropping anything.
3. After Prisma client regeneration, repository-wide build and typecheck
   pass with zero `followUpTaskId` references: the census test greps source
   and generated schema for `followUpTaskId`, `ChainContinuation`,
   dependency-input field names, `codex exec` in review prompts, and
   `code-review-and-adjudication` sources, and asserts zero hits.
   Verification: `npm test -w @agentos/db` and the workspace typecheck.
