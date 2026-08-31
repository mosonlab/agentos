---
id: 04-validator-order-and-base-errors
title: Validator errors for first step, first layer, layer order and base step
blocked_by: [03-replace-step-graph]
risk: false
---

# 04: Validator errors for first step, first layer, layer order and base step

**What to build:** A structure replace is refused with `422` and a stable code when the graph cannot start or cannot branch: `first_step_not_agent` (first step's assignee type is not `AGENT`), `first_layer_not_single` (the first layer holds more than one step), `layer_order_invalid` (layers not non-decreasing by step index), `base_step_invalid` (`baseFromStepIndex` does not name an earlier step in a strictly lower layer, including an out-of-range position). The checks sit at spec positions 2 to 5 in the validator's fixed order, first error wins, the lowest offending step index is reported as `stepIndex` where a single step is at fault, and nothing is persisted on refusal. Each code is added to the handbook's replace entry.

**Blocked by:** 03-replace-step-graph

- [ ] A graph whose first step is `HUMAN` answers `422 first_step_not_agent` with `stepIndex: 1`; verified by a new validator-order dbtest at the HTTP seam using the shared fixture.
- [ ] Two steps in layer 1 answer `422 first_layer_not_single`; a graph whose second step has a lower layer than its first answers `422 layer_order_invalid` naming the offending step; verified by the same dbtest.
- [ ] A step whose `baseFromStepIndex` points to a later position, to a step in the same layer, or beyond the array answers `422 base_step_invalid` naming that step; a valid base in a strictly lower layer is accepted; verified by the same dbtest.
- [ ] A graph that violates two of these rules at once reports only the earlier rule in spec order, and resubmitting gives the same answer; the step rows are unchanged after every refusal; verified by the same dbtest.
- [ ] The four codes appear in the handbook's replace entry with status `422`; verified by reading the section.
