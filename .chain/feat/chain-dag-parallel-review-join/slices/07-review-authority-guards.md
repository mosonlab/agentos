---
id: 07-review-authority-guards
title: Blind read-blocking and adjudication claim refusal
blocked_by:
  - 01-schema-expand-chain-layer
files_hint:
  - packages/api/src/canonical-task-output.ts
  - packages/api/src/app.ts
  - packages/api/src/blind-claim.dbtest.ts
risk: false
---

# Slice 07: Review authority guards

## Delivers

Session-scope enforcement (spec 5.1 blindness, 5.2 claim refusal). Depends
only on the schema slice: siblings are identified by shared `chainId` and
`chainLayer`, not by scheduler internals. Coordination note: touches
different regions of `packages/api/src/app.ts` than slice 06 (claim handler
at app.ts:4350 and session-scoped read routes).

- The blind review task cannot read its Sol sibling before persisting its
  own `blind-findings` output: attachments, task-output responses, chain
  activity (app.ts:5095), and every other session-scoped read route refuse
  sibling review evidence for the blind role, extending the existing
  blind-independence enforcement in
  `packages/api/src/canonical-task-output.ts` (blind event at
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
   sibling output or its chain activity before persisting `blind-findings`,
   and can proceed normally afterward (spec 8.6 first half).
   Verification: `npm run test:db -w @agentos/api`.
2. Claim dbtests prove adjudication claim refusal when either report is
   missing, when a source task is not `DONE`, and when a report is bound to
   a different head; with both valid reports the claim succeeds and both
   outputs are readable in the fresh session (spec 8.6 second half).
   Verification: `npm run test:db -w @agentos/api`.
3. Output-contract unit tests accept a valid `blind-findings` payload and
   reject it on a non-blind step. Verification: `npm test -w @agentos/api`.
