---
id: 07-review-authority-guards
title: Blind read-blocking and adjudication claim refusal
blocked_by:
  - 01-schema-expand-chain-layer
  - 11-runtime-graph-identity
files_hint:
  - packages/api/src/canonical-task-output.ts
  - packages/api/src/app.ts
  - packages/api/src/blind-claim.dbtest.ts
risk: true
---

# Slice 07: Review authority guards

## Delivers

Session-scope enforcement (spec 5.1 blindness, 5.2 claim refusal). Risk
true: it changes persisted TaskStepOutput contracts and claim
refusal/status behavior. Depends on the schema slice (siblings are
identified by shared `chainId` and `chainLayer`, not by scheduler
internals) and on slice 11, which owns the step-identity predicates in
`canonical-task-output.ts` that this slice's guards key on. Coordination
note: touches different regions of `packages/api/src/app.ts` than slices 04
and 06 (claim handler at app.ts:4350 and session-scoped read routes).

- The blind review task can never read its Sol sibling: for the entire
  blind task/session lifetime, before and after its own `blind-findings`
  output is persisted, attachments, task-output responses, chain activity
  (app.ts:5095), and every other session-scoped read route refuse sibling
  and predecessor review evidence for the blind role (spec 5.1: the blind
  role never unlocks predecessor or sibling evidence). Persisting
  `blind-findings` makes the report immutable; it does not unlock anything.
  Only the fresh adjudication task reads both reports, after its claim
  guard succeeds. This extends the existing blind-independence enforcement
  in `packages/api/src/canonical-task-output.ts` (blind event at
  canonical-task-output.ts:380).
- Adjudication claim guard: a claim for the adjudication task is refused by
  name unless both sibling outputs (`sol-findings`, `blind-findings`) exist
  as immutable outputs of `DONE` tasks and match the claim's pinned
  `implementationBaseSha`/`implementationHeadSha`. A missing report or a
  head mismatch is a named refusal, never a silent pass.
- `blind-findings` is registered in the canonical output kind map
  (canonical-task-output.ts:155-190) with the same immutability and
  step/kind match enforcement as `sol-findings`.
- Adjudication runs in a fresh Session and reads both immutable reports only
  after a successful claim; its `must-fix` output cannot rewrite either
  report (existing immutability preserved).

## Acceptance

All red at frozen base 5f5aad1: no `blind-findings` kind, no sibling
read-blocking across a layer, no adjudication claim precondition.

1. Session-scope dbtests prove a blind Run's session cannot fetch the Sol
   sibling output or its chain activity at any point: the same reads are
   refused both before and after `blind-findings` is persisted, while the
   blind session's own output writes and unrelated reads still work
   (spec 8.6 first half; review finding PLAN-003).
   Verification: `npm run test:db -w @agentos/api`.
2. Claim dbtests prove adjudication claim refusal when either report is
   missing, when a source task is not `DONE`, and when a report is bound to
   a different head; with both valid reports the claim succeeds and both
   outputs are readable in the fresh session (spec 8.6 second half).
   Verification: `npm run test:db -w @agentos/api`.
3. Output-contract unit tests accept a valid `blind-findings` payload and
   reject it on a non-blind step. Verification: `npm test -w @agentos/api`.
