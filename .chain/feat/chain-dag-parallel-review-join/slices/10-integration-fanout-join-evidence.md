---
id: 10-integration-fanout-join-evidence
title: End-to-end fan-out, claim, and join evidence at the candidate head
blocked_by:
  - 04-layer-scheduler
  - 05-canonical-sync-replacement
  - 06-api-layer-surface
  - 07-review-authority-guards
  - 08-chain-ui-layers
  - 09-schema-contract-drop-followup
  - 11-runtime-graph-identity
files_hint:
  - packages/api/src/parallel-review.dbtest.ts
  - packages/api/src/template-base-pinning.dbtest.ts
  - packages/api/src/dbtest-plan.ts
  - packages/runner/src/api.ts
risk: false
---

# Slice 10: Integration evidence

## Delivers

The cross-slice acceptance evidence (spec 8.2 claim path, 8.3, 8.4, 8.5,
8.10) in a new `packages/api/src/parallel-review.dbtest.ts` suite against a
scratch database/API environment. Each implementation slice carries its own
unit and dbtest proof; this slice proves the composed path through the real
HTTP claim route with real synced templates. It is the terminal join: it
blocks on every other slice, including 08 and 09, so the exact head it
verifies is the final candidate head containing the UI and the schema
contract (review finding PLAN-004). This turns the previous three-way
terminal frontier into 08/09 followed by this join and lengthens the
critical path by one layer; exact-head acceptance outweighs that loss.

- Full-path test: sync canonical prompts, instantiate the new Direct
  template, complete implementation, and prove both review Runs become
  claimable together through `POST /runner/tasks/claim` (app.ts:4350). Two
  distinct runner identities claim the two Runs, and both claim responses
  carry the same pinned `implementationBaseSha`/`implementationHeadSha`
  (spec 8.3).
- Join evidence at the HTTP level: completing the first review through the
  API creates no adjudication Run; completing the second creates exactly
  one; a simultaneous-completion test drives concurrent completion
  transactions and asserts one Run (spec 8.4).
- The parameterized failed/parked/archived-sibling matrix replayed through
  the API surface: each blocks the join and repair activates adjudication
  exactly once (spec 8.5).
- The same full path for the Full Assurance template through its layer-6
  review pair (spec 8.2).
- Verifies correctness with one claiming runner: a single identity can claim
  both Runs sequentially and the join still fires once (capacity is
  eligibility, not correctness).
- Runs the repository exact-head merge gate at the candidate head
  (spec 8.10).

## Acceptance

All red at frozen base 5f5aad1: the suite does not exist and the templates
it instantiates do not exist.

1. `parallel-review.dbtest.ts` passes, covering the claims above with
   assertions on runner identity, pinned base/head equality, and Run counts.
   Verification: `npm run test:db -w @agentos/api`.
2. Both workspace test trees pass at the candidate head:
   `npm run test --workspaces --if-present` and
   `npm run test:db -w @agentos/api` plus `npm run test:db -w @agentos/db`.
3. The merge gate passes at the exact candidate head. Verification:
   `npm run merge-gate`.
