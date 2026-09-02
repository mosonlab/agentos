---
id: 04-governance-docs
title: "Documentation: routing contract, agent guidance, and operator API"
blocked_by: []
risk: false
---

# 04: Documentation: routing contract, agent guidance, and operator API

**What to build:** Make the governing documents describe the fixed contract.
The routing contract moves to its next actual version, states that both gates
are off by default, covers project defaults, per-dispatch overrides and the
TODO-only operator toggle, and replaces the obsolete no-merge-gate statement
with the exact-head semantics: regression evidence is shown before approval,
approval releases ordinary readiness re-verification, head or base drift
reopens a fresh gate without merging, and rejection ends the chain with its pull
request open.

The canonical-agent guidance names the two structural slots and their dispatch
override → project default → template frontmatter resolution order. The operator
API handbook documents both project fields, the optional instantiate gates,
their named 400 refusals, and the TODO-slot-only task PATCH rule with named 409
conflicts. No route is added or removed.

**Blocked by:** None (can start immediately)

## Acceptance

- [ ] The routing contract carries the next version and a feature change note,
  contains no obsolete “No human gate guards the merge tail” sentence, and
  states every default, override, toggle, exact-head, drift, and rejection
  rule above.
- [ ] The canonical-agent guidance names both structural slots and the exact
  three-tier resolution order.
- [ ] The operator API handbook documents the complete new request/read shapes,
  both missing-slot 400 reasons, and both classes of task PATCH 409 refusal.

## Verification

- Content check: `! rg -F "No human gate guards the merge tail" docs/governance/task-routing-v1.md && rg -F "Version 1.8" docs/governance/task-routing-v1.md && rg -F "specGateDefault" docs/operator-api.md && rg -F "mergeGateDefault" docs/operator-api.md && rg -F "gates_spec_step_absent" docs/operator-api.md && rg -F "gates_merge_step_absent" docs/operator-api.md`.
- Existing handbook contract test:
  `RUNNER_WORKSPACE_ROOT="$(mktemp -d)" node --test scripts/operator-api-docs.test.mjs`.
- No repository-wide lint or Merge Gate command is part of this slice; those are
  chain-level evidence.
