---
id: 05-canonical-sync-replacement
title: Canonical sync legacy rename, new templates, and one-time adjudicator agent
blocked_by:
  - 01-schema-expand-chain-layer
  - 02-template-sources-layer-split
  - 03-review-role-prompts
  - 11-runtime-graph-identity
files_hint:
  - packages/db/prisma/sync-canonical-prompts.ts
  - packages/db/src/canonical-prompt-sync.dbtest.ts
  - packages/db/prisma/seed.ts
risk: true
---

# Slice 05: Canonical sync replacement transition

## Delivers

The persisted-data transition (spec 3.3). Risk true: it renames live template
rows and creates a live Agent on existing installations.

- Canonical sync recognizes only the exact old persisted shapes
  (`direct-engineer-workflow` with 7 steps, `compound-engineer-workflow` with
  12 steps), renames them to `direct-engineer-workflow-legacy-v1` and
  `compound-engineer-workflow-legacy-v1` preserving every `TaskTemplateStep`
  row and instantiated task reference, then creates the new 8-step and
  13-step canonical templates from the slice-02 sources with `layer`
  persisted per step. Any different persisted shape is structural drift and
  sync refuses by name; no generic template versioning.
- One-time Agent transition: sync creates `review-adjudicator-opus` from its
  canonical role source, copying the active `review-coordinator-opus` Agent's
  environment, repository grants, and disabled-tool boundary. A missing or
  archived source Agent, or an archived target, is a named refusal.
- Sync stays idempotent: a second run changes nothing and re-refuses nothing.
- Template-step rows referenced by instantiated tasks are never mutated; the
  live Event ingestion NUL safety and heartbeat isolation chain is byte
  unchanged.
- Existing-chain preservation is proven behaviorally, not just structurally
  (review finding PLAN-008): the sync fixtures snapshot legacy Task
  descriptions, assignees, statuses, Runs, Sessions, and step references
  before sync and compare byte-for-byte after, and representative old 7/12
  chains renamed to `-legacy-v1` are executed through their old combined
  review output, merge readiness, and integrator identities using the
  `-legacy-v1` runtime compatibility delivered by slice 11 (hence the new
  dependency on 11-runtime-graph-identity).

## Acceptance

All red at frozen base 5f5aad1: sync knows nothing of layers, renames, or the
adjudicator agent.

1. `canonical-prompt-sync.dbtest.ts` seeds the old 7/12-step templates with
   instantiated tasks (descriptions, assignees, statuses, Runs, Sessions,
   step references), runs sync, and asserts the legacy `-legacy-v1`
   renames, a byte-identical before/after snapshot of every instantiated
   Task and its Runs/Sessions, preserved step rows and task references, and
   new canonical templates with the exact layer vectors `1,2,2,3,4,5,6,7`
   and `1,2,3,4,5,6,6,7,8,9,10,11,12`. Verification:
   `npm run test:db -w @agentos/db`.
2. A dbtest drives a renamed `-legacy-v1` chain through its old combined
   review output, readiness, and integrator step identities and asserts
   canonical output acceptance and merge-tail recognition still hold
   (spec acceptance 7, behavioral half; runtime predicates from slice 11).
3. A dbtest seeds a drifted persisted shape (for example 8 steps under the
   canonical name) and asserts sync refuses with a named error and changes
   nothing.
4. A dbtest proves the one-time agent creation copies environment, grants,
   and disabled tools from `review-coordinator-opus`, and that a missing or
   archived source or archived target refuses by name.
5. Running sync twice yields identical database state (idempotency assert in
   the same suite).
