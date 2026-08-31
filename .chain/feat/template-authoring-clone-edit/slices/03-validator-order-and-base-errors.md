---
id: 03-validator-order-and-base-errors
title: Validator errors for first step, first layer, layer order and base step
blocked_by: [02-replace-step-graph]
risk: false
requirements: [first-step-not-agent, first-layer-single, layer-order, base-step]
verification:
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:db -w @anneal/api -- src/template-authoring-validator-order.dbtest.ts"
  - "export RUNNER_WORKSPACE_ROOT=$(mktemp -d) && npm run test:operator-api-docs"
---

# 03: Validator errors for first step, first layer, layer order and base step

**What to build:** A structure replace is refused with `422` and a stable code when the graph cannot start or branch: `first_step_not_agent`, `first_layer_not_single`, `layer_order_invalid`, or `base_step_invalid`. These checks occupy positions 2 through 5 in the fixed order; first error wins, the lowest offending step index is reported where one step owns the fault, and refusal persists nothing. The four handbook codes and their automated assertions land here.

**Blocked by:** 02-replace-step-graph

**Verification:** The first command in frontmatter owns the HTTP and atomicity criteria; the second owns the handbook criterion.

- [ ] A graph whose first step is human-assigned answers `422 first_step_not_agent` with `stepIndex: 1`.
- [ ] Two steps in the first layer answer `422 first_layer_not_single`; a later step whose layer decreases answers `422 layer_order_invalid` naming that step.
- [ ] A base position that points later, into the same layer, or outside the array answers `422 base_step_invalid` naming the consumer; an earlier strictly lower-layer base succeeds.
- [ ] A graph violating multiple rules reports only the earliest rule in specification order on repeated submissions, and every refusal leaves the saved steps unchanged.
- [ ] The new handbook assertions are red against the frozen handbook and pass only when all four codes appear under replace with status `422`.
