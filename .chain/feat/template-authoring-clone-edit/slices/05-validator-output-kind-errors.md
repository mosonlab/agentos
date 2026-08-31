---
id: 05-validator-output-kind-errors
title: Validator errors for output kind production and duplication
blocked_by: [03-replace-step-graph]
risk: false
---

# 05: Validator errors for output kind production and duplication

**What to build:** A structure replace is refused with `422` and a stable code when the output-kind wiring is broken: `prior_kind_unproduced` (a consumed prior output kind is produced by no step in a strictly earlier layer; a producer in the same layer does not count), `output_kind_duplicate` (two steps declare the same output kind), `prior_kind_duplicate` (one step lists the same prior output kind twice). The checks sit at spec positions 6 to 8 in the validator's fixed order; unknown output kinds remain legal. `stepIndex` names the consuming or later duplicate step. Each code is added to the handbook's replace entry.

**Blocked by:** 03-replace-step-graph

- [ ] A step consuming a kind nobody produces, and a step consuming a kind produced only by a sibling in its own layer, both answer `422 prior_kind_unproduced` naming the consumer; the same kind produced in an earlier layer is accepted; verified by a new validator-output-kind dbtest at the HTTP seam using the shared fixture.
- [ ] Two steps with the same `outputKind` answer `422 output_kind_duplicate` naming the later step; verified by the same dbtest.
- [ ] A step whose `priorOutputKinds` repeats a kind answers `422 prior_kind_duplicate` naming that step; verified by the same dbtest.
- [ ] A graph with a free-form output kind (unknown to the platform role mapping) and consistent wiring is accepted with `200`; step rows are unchanged after every refusal; verified by the same dbtest.
- [ ] The three codes appear in the handbook's replace entry with status `422`; verified by reading the section.
