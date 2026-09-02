---
id: 09-merge-gate-rejection
title: "Merge gate rejection ends the chain and leaves the pull request open"
blocked_by: [07-merge-gate-opens]
risk: true
---

# 09: Merge gate rejection ends the chain and leaves the pull request open

**What to build:** Make rejection at the merge slot terminal rather than a
request to redo regression. Reuse the existing chain-abandonment disposition:
never activate merge execution, close its open Inbox cards, record an abandoned
merge result, close the integrator terminal, and record the operator rejection
on readiness. The pull request remains open and the path performs no GitHub
mutation. Specification-gate rejection continues to requeue specification.
Inbox and task-PATCH decisions must share the same merge-slot disposition.

**Blocked by:** 07-merge-gate-opens

## Acceptance

- [ ] Inbox rejection leaves merge execution never activated and with no run,
  closes the integrator terminal with a merge result naming operator
  abandonment, closes its remaining open cards, records the readiness rejection,
  and makes no GitHub call.
- [ ] Task-PATCH rejection produces the identical terminal state.
- [ ] Regression is not requeued, readiness does not reopen, and the pull
  request remains open and unmerged.
- [ ] The same decision-surface scenario contrasts the new terminal merge-slot
  result with a specification-slot rejection that still requeues specification
  and consumes ordinary run budget.

## Verification

- New dbtest: `packages/api/src/merge-readiness-gate-rejection.dbtest.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test:db -w @anneal/api -- src/merge-readiness-gate-rejection.dbtest.ts`
- Scoped controls: `npm run typecheck -w @anneal/db`,
  `npm run typecheck -w @anneal/api`, `npm run lint -w @anneal/db`, and
  `npm run lint -w @anneal/api`.
