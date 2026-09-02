---
id: 04-governance-docs
title: "Documentation: routing contract, agents README, operator API handbook"
blocked_by: []
risk: false
---

# 04: Documentation: routing contract, agents README, operator API handbook

**What to build:** A reader of the governing documents learns exactly what
configurable gates do, before or independently of reading the code. The contract
is fully fixed by the spec (D12, corrected by A1), so this slice needs no code
slice to land first:

- `docs/governance/task-routing-v1.md`: the "Human approval placement" section
  rewritten — chains run without human gates by default; a project may enable a
  specification gate, a merge gate, or both; a dispatch may override either per
  chain; an operator may toggle a not-yet-reached slot. The sentence "No human
  gate guards the merge tail" is replaced with the exact-head semantics of
  D5–D8 (gate opens on regression completion with server-read evidence,
  approval releases the readiness worker and the merge still requires the
  worker's exact-head re-verification, drift reopens the gate on a fresh card
  without merging, rejection ends the chain with the pull request left open).
  Version header bumped to the next version above the current one (1.8 per A1,
  not the brief's stale 1.5) with a change note naming this feature.
- `agents/README.md`: the approval-metadata paragraph names the two slots, how
  each is recognised (`stepRole`), and the resolution order (dispatch override,
  project default, template frontmatter).
- `docs/operator-api.md`: the two project booleans on the project PATCH; the
  optional `gates` object with its two booleans, the resolution order, and the
  two 400 refusal codes on the instantiate route; the `approvalGate` rule on the
  task PATCH — accepted on a TODO gate-slot chain task, 409 otherwise —
  documenting the previously undocumented "controlled by the chain" refusal it
  replaces.

**Blocked by:** None (can start immediately)

- [ ] `docs/governance/task-routing-v1.md` no longer contains the sentence "No human gate guards the merge tail" (verified by grep), carries the bumped version header with a change note naming this feature, and its rewritten section states the default-off behaviour, the two per-project gates, the per-chain override, the TODO-slot toggle, and the exact-head merge-gate semantics.
- [ ] `agents/README.md` names both slots, their recognition via step role, and the three-tier resolution order.
- [ ] `docs/operator-api.md` documents the two project fields, the `gates` instantiate field with both refusal codes, and the chain-task `approvalGate` PATCH rule including the 409; the handbook's route-coverage test still passes (no route added or removed).
- [ ] No emoji or decorative symbols in the edited files; `npm run lint` passes if it covers docs, otherwise the docs build/scan the repository already runs on these files passes.
