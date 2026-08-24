---
id: 03-review-role-prompts
title: Split review role prompts, canonical agent contract entry, and doc flow
blocked_by: []
files_hint:
  - agents/roles/review-coordinator-sol.md
  - agents/roles/review-coordinator-opus.md
  - agents/roles/review-adjudicator-opus.md
  - agents/REVIEW-PACKAGE.md
  - packages/db/src/agent-sources.ts
  - packages/db/src/agent-contract.ts
  - packages/db/prisma/agent-contract.test.ts
risk: false
---

# Slice 03: Review role authority split

## Delivers

Role prompt sources and the canonical agent contract (spec 5.1, 5.2).
Independently mergeable; the new role name is referenced by slice 02 step
files as a plain string and by slice 05 sync as a source lookup.

The independently demonstrable red result of this slice is the Opus split:
the blind-only opus role plus the new adjudicator role and its contract
entry. The Sol role is already compliant at the frozen base
(`agents/roles/review-coordinator-sol.md` already mandates one gpt-5.6-sol:high
session, both axes, one `sol-findings` output, and contains no `codex exec`
or service-tier override; `packages/db/prisma/agent-contract.test.ts` already
asserts no codex review command). Sol work here is preservation, not
implementation.

- `agents/roles/review-coordinator-sol.md`: preservation regressions only.
  Assert (do not re-implement) that one gpt-5.6-sol:high main session covers
  both the Standards and Specification axes, emits one immutable
  `sol-findings` output, and that no nested `codex exec` review subprocess,
  service-tier override, or internal-parallel exception for Full or large
  diffs is reintroduced.
- `agents/roles/review-coordinator-opus.md`: narrowed to blind independent
  review only. It emits one immutable `blind-findings` output, never reads
  predecessor or sibling review evidence at any point in its task/session
  lifetime, and contains no adjudication or merge-matrix language.
- New `agents/roles/review-adjudicator-opus.md`: adjudication-only role that
  always runs in a fresh provider Session, requires both immutable sibling
  reports bound to its pinned implementation base/head, applies the existing
  canonical merge matrix, and emits the final `must-fix` output with
  dispositions covering every finding id from both reports. It states it
  never resumes the blind conversation and needs no continuation proof.
- `packages/db/src/agent-contract.ts`: add `review-adjudicator-opus` with
  model `claude-opus-5:medium` and runner `CLAUDE` to
  `CANONICAL_AGENT_DEFAULTS` (agent-contract.ts:3-27), so
  `assertCanonicalAgentSources` accepts the new role instead of rejecting it
  as an unknown extra (review finding PLAN-007).
- `packages/db/src/agent-sources.ts` recognizes the new role source in
  `loadAgentSources` and structural comparison.
- `agents/REVIEW-PACKAGE.md` (REVIEW-PACKAGE.md:31-40) rewritten from the
  serialized combined blind/adjudication flow to the parallel review layer
  plus fresh-session adjudication (review finding PLAN-010, role-flow half;
  the template-count half lands in slice 02).

## Acceptance

Red at frozen base 5f5aad1 because the adjudicator source and its
`CANONICAL_AGENT_DEFAULTS` entry do not exist and the opus role still
combines review and adjudication. Sol assertions are regression guards and
are expected green at base.

1. `packages/db/prisma/agent-contract.test.ts` extended: the adjudicator role
   exists, appears in `CANONICAL_AGENT_DEFAULTS` with runner `CLAUDE` and
   model `claude-opus-5:medium`, and states fresh-session, both-reports, and
   head-binding requirements; the opus blind role contains no adjudication
   language and states lifetime sibling blindness. Verification:
   `npm test -w @agentos/db`.
2. Preservation regressions in the same suite: no review role or canonical
   review step source contains `codex exec` or a service-tier override; the
   sol role names both axes in one session (green at base, guarded against
   regression). Verification: `npm test -w @agentos/db`.
3. `agent-sources` unit tests load the three role sources and assert the
   adjudicator appears in the canonical role set exactly once, and
   `assertCanonicalAgentSources` passes with the enlarged contract.
   Verification: `npm test -w @agentos/db`.
