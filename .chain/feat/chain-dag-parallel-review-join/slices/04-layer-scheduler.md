---
id: 04-layer-scheduler
title: Layered activation with full-chain lock, join semantics, and gate rules
blocked_by:
  - 01-schema-expand-chain-layer
files_hint:
  - packages/db/src/workflow.ts
  - packages/api/src/chain.ts
  - packages/api/src/app.ts
  - packages/api/src/scheduler.ts
  - packages/api/src/workflow.test.ts
  - packages/api/src/chain.dbtest.ts
  - packages/api/src/claim-activation-isolation.dbtest.ts
risk: true
---

# Slice 04: Layer scheduler and join

## Delivers

The runtime core (spec 4.1, 4.2, 4.3, 7). Risk true: this slice rewrites the
transactions that lock and mutate persisted Task and Run state and owns
exactly-once Run enqueueing. Runtime code stops reading or writing
`followUpTaskId` here; the column itself is dropped by slice 09.

Scheduler-side `followUpTaskId` semantics beyond workflow.ts are owned here
(review finding PLAN-009): the activation predicates and auxiliary
merge-tail follow-up activation in `packages/api/src/app.ts`, and the
standalone-creation path in `packages/api/src/scheduler.ts`, are migrated to
layer semantics or deleted with their behavior reassigned to the layer
scheduler — not left for the slice 09 census to discover. Coordination note:
slices 06 and 07 touch other regions of app.ts (input/read routes and
claim/session-scope routes respectively); this slice keeps to activation and
merge-tail follow-up regions.

- One lock protocol in `packages/db/src/workflow.ts`: Run first when the
  mutation belongs to a Run, then every Task row of `(projectId, chainId)` in
  `(chainLayer, chainIndex, id)` order, then re-read and mutate.
  `lockChainPrefixRows` (workflow.ts:299), the successor `updatedAt`
  compare-and-swap, recursive re-read, and per-`followUpTaskId` locking in
  `activateChainSuccessor` (workflow.ts:1119) are removed, not bypassed.
- Layer activation after a task becomes `DONE`: stop unless every task in the
  same `chainLayer` is exactly `DONE`; find the smallest higher layer; for
  each of its tasks enqueue at most one Run when it has no active Run and is
  eligible. First review completion cannot activate adjudication; the second
  activates it exactly once; `(taskId, runNumber)` and active-run constraints
  stay the duplicate backstop. All non-`DONE` statuses block the join; no
  partial, timeout, or degraded join. An expected eligibility problem on one
  next-layer task (for example an archived Agent) records that task's
  existing stopped/parked reason while eligible siblings still enqueue; the
  following layer stays blocked until it is repaired and completed.
- Manual start and retry go through the same locked layer-eligibility check
  (`taskStartability`/`blockingPredecessor` in `packages/api/src/chain.ts`
  generalized from index-predecessor to layer-predecessor semantics).
- Approval gates: a canonical multi-node layer cannot contain an approval
  gate; a server-owned gate may follow only a single executable node in the
  preceding layer; rejecting an Agent approval gate requeues that same gated
  task with its previous output handoff, and approving the replacement output
  activates the next layer once (existing spec-revision loop preserved,
  `applyInboxDecisionTx` at workflow.ts:1383).
- Existing chains keep executing sequentially from their backfilled
  one-node-per-layer data; their descriptions, assignments, runs, and
  sessions are not mutated.

## Acceptance

All red at frozen base 5f5aad1: activation follows `followUpTaskId` and no
layer semantics exist.

1. dbtests build a chain with a two-node layer and prove: first completion
   enqueues nothing for the join; second completion enqueues exactly one Run;
   two concurrent completing transactions still produce exactly one Run.
   Verification: `npm run test:db -w @agentos/api`.
2. Parameterized dbtests cover a failed, parked, and archived-Agent sibling:
   each blocks the join with the existing named reason, the healthy sibling
   report stays valid, and repair plus retry activates the join exactly once
   (spec 7 table rows). Verification: `npm run test:db -w @agentos/api`.
3. A dbtest proves an eligible next-layer sibling enqueues while an invalid
   sibling keeps the following layer blocked.
4. Approval-gate regression dbtests prove reject requeues the same gated
   task, supplies the prior output through `previousRunHandoff`, and approval
   of the replacement output activates the next layer once (spec 8.7).
5. A legacy-shape dbtest instantiates a backfilled linear chain and proves
   sequential activation is unchanged with no `followUpTaskId` reads
   (spec 8.7 first sentence). A dbtest covers the migrated app.ts auxiliary
   merge-tail follow-up activation and the scheduler.ts standalone path
   under layer semantics.
6. Unit tests in `packages/api/src/workflow.test.ts` and `chain.test.ts`
   cover the pure layer-eligibility decisions. Verification:
   `npm test -w @agentos/api`.
