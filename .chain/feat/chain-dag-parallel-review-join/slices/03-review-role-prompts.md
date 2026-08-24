---
id: 03-review-role-prompts
title: Rewrite review role prompts and add the adjudicator role source
blocked_by: []
files_hint:
  - agents/roles/review-coordinator-sol.md
  - agents/roles/review-coordinator-opus.md
  - agents/roles/review-adjudicator-opus.md
  - packages/db/src/agent-sources.ts
  - packages/db/prisma/agent-contract.test.ts
risk: false
---

# Slice 03: Review role authority split

## Delivers

Role prompt sources only (spec 5.1, 5.2). Independently mergeable; the new
role name is referenced by slice 02 step files as a plain string and by
slice 05 sync as a source lookup.

- `agents/roles/review-coordinator-sol.md`: one gpt-5.6-sol:high main session
  covers both the Standards and Specification axes and emits one immutable
  `sol-findings` output. Any nested `codex exec` review subprocess
  instruction and any stale service-tier override wording is removed; no
  internal-parallel exception for Full or large diffs.
- `agents/roles/review-coordinator-opus.md`: narrowed to blind independent
  review only. It emits one immutable `blind-findings` output, never reads
  predecessor or sibling review evidence, and contains no adjudication or
  merge-matrix language.
- New `agents/roles/review-adjudicator-opus.md`: adjudication-only role that
  always runs in a fresh provider Session, requires both immutable sibling
  reports bound to its pinned implementation base/head, applies the existing
  canonical merge matrix, and emits the final `must-fix` output with
  dispositions covering every finding id from both reports. It states it
  never resumes the blind conversation and needs no continuation proof.
- `packages/db/src/agent-sources.ts` recognizes the new role source in
  `loadAgentSources` and structural comparison.

## Acceptance

All red at frozen base 5f5aad1: the adjudicator source does not exist and the
opus role still combines review and adjudication.

1. `packages/db/prisma/agent-contract.test.ts` extended: no review role or
   canonical review step source contains `codex exec` or a service-tier
   override; the sol role names both axes in one session; the opus blind role
   contains no adjudication language; the adjudicator role exists and states
   fresh-session, both-reports, head-binding requirements. Verification:
   `npm test -w @agentos/db`.
2. `agent-sources` unit tests load the three role sources and assert the
   adjudicator appears in the canonical role set exactly once.
   Verification: `npm test -w @agentos/db`.
