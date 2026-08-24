---
id: 11-runtime-graph-identity
title: Migrate canonical step-index predicates to the 8/13 graphs with legacy-v1 compatibility
blocked_by: []
files_hint:
  - packages/db/src/merge-integrator.ts
  - packages/db/src/merge-tail.ts
  - packages/api/src/canonical-task-output.ts
  - packages/api/src/merge-integrator-fixture.ts
  - packages/db/src/merge-integrator.test.ts
  - packages/api/src/canonical-task-output.test.ts
risk: true
---

# Slice 11: Runtime canonical graph identity

## Delivers

The runtime owner of canonical step-identity predicates for the renumbered
graphs (review finding PLAN-002; supports spec 3.3 legacy preservation and
acceptance 7). Added as a fourth root: the predicates are name/index
constants and need no code from the other slices. Risk true: these
predicates gate canonical output authority, merge readiness, and mechanical
merge execution, which is an irreversible external action.

- `packages/db/src/merge-integrator.ts` (merge-integrator.ts:31-36):
  integrator binding moves from Full step 12 / Direct step 7 to Full step 13
  / Direct step 8 for the new canonical templates, and gains exact
  compatibility entries for `compound-engineer-workflow-legacy-v1` step 12
  and `direct-engineer-workflow-legacy-v1` step 7, following the existing
  legacy-prefix pattern already present in this file.
- `packages/db/src/merge-tail.ts` (`isMergeReadinessStep`,
  merge-tail.ts:165-170): readiness recognition moves to Direct step 7 /
  Full step 12 under the canonical names and keeps Direct step 6 / Full
  step 11 under the exact `-legacy-v1` names.
- `packages/api/src/canonical-task-output.ts` (canonical-task-output.ts:48-58
  and the step/kind identity map): `isCanonicalAgentStep` ranges extend to
  the new node counts; the combined blind-review predicate
  (`must-fix` at Direct 3 / Full 7) is split into `blind-findings` at the
  blind node and `must-fix` at the adjudication node for the new templates,
  while the old combined identity remains recognized only under the
  `-legacy-v1` template names so instantiated legacy chains retain their
  output authority. Slice 07 builds its sibling read-blocking and claim
  guard on these identities.
- `packages/api/src/merge-integrator-fixture.ts`: fixture updated to the new
  graph positions (its `followUpTaskId` write is removed by the slice 09
  contract via the slice 06 instantiation change; this slice only moves its
  step identities).
- Every other name/index predicate found by a census over
  `direct-engineer-workflow`/`compound-engineer-workflow` plus hard-coded
  step indexes is either migrated here or explicitly listed as
  layer-scheduler scope (slice 04) in the code review.

## Acceptance

All red at frozen base 5f5aad1: no predicate recognizes an 8/13-position
graph or a `-legacy-v1` template name suffix.

1. Unit tests assert integrator binding and readiness recognition at Direct
   8/7 and Full 13/12 under the canonical names, and at Direct 7/6 and Full
   12/11 under the exact `-legacy-v1` names; all other combinations are
   refused. Verification: `npm test -w @agentos/db`.
2. Unit tests assert `isCanonicalAgentStep` and the output-identity
   predicates accept the new ranges, place `blind-findings` and `must-fix`
   at the new blind/adjudication positions, and keep the old combined
   `must-fix` identity only for `-legacy-v1` templates. Verification:
   `npm test -w @agentos/api`.
3. A census-style test greps for hard-coded canonical step indexes and
   template-name predicates outside the files owned here and by slice 04
   and asserts zero unmigrated hits. Verification: `npm test -w @agentos/api`.
