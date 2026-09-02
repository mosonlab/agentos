---
id: 03-project-gate-defaults
title: "Project gate defaults: persisted settings, API, and project toggles"
blocked_by: []
risk: true
---

# 03: Project gate defaults: persisted settings, API, and project toggles

**What to build:** Give every project two independent boolean defaults for the
specification and merge gate, both false unless changed. Deliver the additive
schema migration, shared project read contract, project PATCH validation and
round-trip, and two instant-save controls on project detail with complete
English and Chinese copy. Project creation continues to rely on database
defaults; the create input is not widened. Per the specification’s migration
decision, the new migration sorts after the recorded release candidate tail and
does not change the release-candidate migration pin.

The upgrade proof must stage the real migration history immediately before this
feature, seed an existing project and chain with explicit stored gate values,
apply this migration through the real deploy path, and inspect the upgraded
rows. Runtime consumption of the project defaults belongs to slice 06.

**Blocked by:** None (can start immediately)

## Acceptance

- [ ] A fresh migrated database gives a newly created project false for both
  defaults, and project list and detail reads through the real API entrypoint
  return both fields.
- [ ] Applying the migration to the immediately preceding migration tail gives
  an existing project non-null false defaults while preserving every stored
  `approvalGate` value on its existing chain tasks.
- [ ] Project PATCH round-trips either default independently; omitting a field
  preserves it, and changing one never changes the other.
- [ ] Project detail renders both fetched values as toggles; changing one sends
  only that field and reloads the persisted result.
- [ ] Both toggle labels are present in English and Chinese.

## Verification

- New focused upgrade dbtest: `packages/api/src/project-gate-defaults-migration.dbtest.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test:db -w @anneal/api -- src/project-gate-defaults-migration.dbtest.ts`
- New fresh-schema/HTTP dbtest, starting the real API through the repository's
  test startup environment helper: `packages/api/src/project-gate-defaults.dbtest.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test:db -w @anneal/api -- src/project-gate-defaults.dbtest.ts`
- New web test: `apps/web/src/tests/project-gate-defaults.test.tsx` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --conditions=development --import tsx --test apps/web/src/tests/project-gate-defaults.test.tsx`
- Existing locale sweep: `apps/web/src/tests/i18n-sweep.test.tsx` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" TSX_TSCONFIG_PATH=apps/web/tsconfig.app.json node --conditions=development --import tsx --test apps/web/src/tests/i18n-sweep.test.tsx`
- Scoped controls: `npm run typecheck -w @anneal/db`,
  `npm run typecheck -w @anneal/api`, `npm run typecheck -w @anneal/web`,
  `npm run lint -w @anneal/db`, `npm run lint -w @anneal/api`, and
  `npm run lint -w @anneal/web`.
