---
id: 08-merge-gate-approval
title: "Merge approval releases readiness with exact-head and drift safety"
blocked_by: [07-merge-gate-opens]
risk: true
---

# 08: Merge approval releases readiness with exact-head and drift safety

**What to build:** Give a merge-slot approval one shared disposition across the
Inbox and task-PATCH channels. Approval records the existing exact-head operator
authorization, returns readiness to TODO with its ordinary queued marker, and
does not mark readiness DONE or activate integration directly. The readiness
worker then performs its existing head, base, ancestry, defense, and lease
checks and produces the sole integrator authorization.

For a gated readiness task, add a fail-closed comparison between the persisted
operator authorization and the head and base the worker just verified. Missing
or mismatched approval stops with a named gate reason. Live head or base drift
after approval takes the existing regression-requeue settlement; after fresh
regression evidence, the gate opens a new card for the changed state and the old
authorization cannot be reused. Existing authorization production, drift
evaluation, and lease semantics remain the single downstream path.

**Blocked by:** 07-merge-gate-opens

## Acceptance

- [ ] Inbox approval records the operator’s exact head/base authorization,
  returns readiness to TODO with a queued marker, leaves the integrator
  inactive, then permits the readiness worker and integrator to complete the
  merge for exactly that state.
- [ ] The task-PATCH approval channel produces the same states and final result.
- [ ] A parameterized live-drift scenario covers both head movement and base
  movement after approval. In each case no integrator activation or merge
  occurs, readiness and regression take the requeue path, fresh regression
  completion opens a new card carrying the new head or base SHA, and the prior
  operator authorization is not reusable.
- [ ] A gated readiness task with no operator authorization, with a mismatched
  head, or with a mismatched base stops closed with a gate-specific reason and
  produces no merge authorization.
- [ ] An approval whose card head has no regression attestation is refused on
  the real gated-readiness shape.

## Verification

- New dbtest: `packages/api/src/merge-readiness-gate-approval.dbtest.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test:db -w @anneal/api -- src/merge-readiness-gate-approval.dbtest.ts`
- Existing attestation control: `packages/api/src/merge-gate-attestation.dbtest.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test:db -w @anneal/api -- src/merge-gate-attestation.dbtest.ts`
- Scoped controls: `npm run typecheck -w @anneal/db`,
  `npm run typecheck -w @anneal/api`, `npm run lint -w @anneal/db`, and
  `npm run lint -w @anneal/api`; implementation review confirms no second
  authorization, drift-evaluation, or lease path was added.
