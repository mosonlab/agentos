---
id: 05-validator-gate-assignee-integrator-errors
title: Validator errors for parallel gates, assignees and the integrator binding
blocked_by: [02-replace-step-graph]
risk: false
requirements: [parallel-gate, valid-assignee, integrator-binding, authoring-no-repo-grant-check]
verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:db -w @anneal/api -- src/template-authoring-validator-assignees.dbtest.ts"
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:operator-api-docs"
---

# 05: Validator errors for parallel gates, assignees and the integrator binding

**What to build:** A structure replace is refused with `422` when activation or claiming would violate `approval_gate_in_parallel_layer`, `assignee_invalid`, or `integrator_binding_invalid`. These checks occupy positions 9 through 11. Agent facts are resolved inside the replace transaction and handed to the pure validator; the existing bidirectional sentinel rule is reused verbatim. Repo grants remain an instantiation concern. The three handbook codes and their automated assertions land here.

**Blocked by:** 02-replace-step-graph

**Verification:** The first command in frontmatter owns the HTTP and atomicity criteria; the second owns the handbook criterion.

- [ ] A gated step with a same-layer sibling answers `422 approval_gate_in_parallel_layer` naming the gated step; a gated step alone in its layer succeeds.
- [ ] Missing, nonexistent, archived and other-project Agent assignments, plus a human step naming an Agent, each answer `422 assignee_invalid` naming the step.
- [ ] A mechanical integrator step bound to a model Agent and an ordinary step bound to the sentinel each answer `422 integrator_binding_invalid`; the valid sentinel binding succeeds.
- [ ] A valid same-project Agent without a Repo grant is accepted for authoring. When assignee and integrator faults coexist, `assignee_invalid` wins; every refusal leaves the saved steps unchanged.
- [ ] The new handbook assertions are red against the frozen handbook and pass only when all three codes appear under replace with status `422` and Repo-grant timing is described correctly.
