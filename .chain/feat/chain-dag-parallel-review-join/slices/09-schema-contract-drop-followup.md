---
id: 09-schema-contract-drop-followup
title: Drop followUpTaskId and run the removal census
blocked_by:
  - 02-template-sources-layer-split
  - 03-review-role-prompts
  - 04-layer-scheduler
  - 06-api-layer-surface
files_hint:
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/
  - packages/db/src/schema-census.ts
  - packages/api/src/migration.dbtest.ts
risk: true
---

# Slice 09: Contract step and census

## Delivers

The contract half of the staging (spec 3.1 removal, 3.2 steps 1 and 5, 8.9).
Runs after every writer (templates.ts, slice 06) and reader (workflow.ts,
slice 04) has migrated off the column; sources are clean after slices 02
and 03.

- Migration preflight refuses any `followUpTaskId` relationship whose source
  and target are not already members of the same project and chain in
  increasing `chainIndex` order; an inconsistent legacy relationship aborts
  before the column is dropped.
- `Task.followUpTaskId`, its self-relation `TaskFollowUp`
  (schema.prisma:559), and its unique index (schema.prisma:510) are dropped
  from the schema in a new migration. There is one successor authority: the
  layer scheduler.
- Source and schema census (spec 8.9): a test proves no remaining
  `followUpTaskId` reference in source or schema, no `ChainContinuation`
  table or type, no public dependency input, no nested review subprocess in
  any review role or canonical review step source, and no old combined
  review-step source file. `packages/db/src/schema-census.ts` is updated to
  the final shape.

## Acceptance

All red at frozen base 5f5aad1: the column, relation, and combined sources
all exist.

1. A migration dbtest seeds a consistent legacy follow-up chain, runs the
   drop migration, and asserts the column and index are gone while chain
   rows and behavior survive. Verification: `npm run test:db -w @agentos/api`.
2. A dbtest seeds an inconsistent follow-up relationship (cross-chain or
   decreasing index) and asserts the migration aborts by name before
   dropping anything.
3. The census test greps source and generated schema for `followUpTaskId`,
   `ChainContinuation`, dependency-input field names, `codex exec` in review
   prompts, and `code-review-and-adjudication` sources, and asserts zero
   hits. Verification: `npm test -w @agentos/db`.
