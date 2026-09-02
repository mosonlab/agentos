---
id: 07-merge-gate-opens
title: "Merge gate opens at readiness activation and holds the tail closed"
blocked_by: []
risk: true
---

# 07: Merge gate opens at readiness activation and holds the tail closed

**What to build:** Extend the real readiness-tail fixture only as support for
this vertical: an explicit gated-readiness option produces a gated readiness
task before activation with a completable regression predecessor, and rejects a
shape with no readiness slot. Existing fixture callers keep their current
default shape.

Then make regression completion on a gated readiness successor atomically park
readiness in REVIEW and open the existing integrator-feeding evidence question,
rather than queueing the worker. The evidence worker fills head SHA, base ref,
base SHA, and required-check conclusions. A readiness worker tick cannot claim
the REVIEW task. An ungated readiness successor keeps the existing queued path.
No alternate evidence-card or worker-claim path is introduced.

**Blocked by:** None (can start immediately)

## Acceptance

- [ ] The fixture’s gated-readiness option creates the real readiness-tail shape
  with gate metadata on template and task, readiness not DONE, and regression
  ready to complete; requesting it on a shape without readiness fails loudly.
- [ ] Completing regression on paired readiness chains leaves the gated task in
  REVIEW with exactly one open gate-purpose card bound to the completing run and
  no queued marker, while the otherwise-identical ungated task takes the queued
  path with no card.
- [ ] The evidence worker fills that card with exact head, base ref, base SHA,
  and required-check conclusions before it is decidable.
- [ ] A readiness worker tick while the gate is open claims nothing, produces no
  authorization, and cannot activate the integrator.

## Verification

- New dbtest: `packages/api/src/merge-readiness-gate-open.dbtest.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test:db -w @anneal/api -- src/merge-readiness-gate-open.dbtest.ts`
- Existing focused ungated control: `packages/api/src/merge-tail-readiness.dbtest.ts` —
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" npm run test:db -w @anneal/api -- src/merge-tail-readiness.dbtest.ts`
- Scoped controls: `npm run typecheck -w @anneal/db`,
  `npm run typecheck -w @anneal/api`, `npm run lint -w @anneal/db`, and
  `npm run lint -w @anneal/api`.
