---
id: 06-validator-gate-assignee-integrator-errors
title: Validator errors for parallel gates, assignees and the integrator binding
blocked_by: [03-replace-step-graph]
risk: false
---

# 06: Validator errors for parallel gates, assignees and the integrator binding

**What to build:** A structure replace is refused with `422` and a stable code when a step could not be activated or claimed: `approval_gate_in_parallel_layer` (an Approval gate on a step whose layer holds more than one step), `assignee_invalid` (an `AGENT` step with no Agent, or an Agent that is missing, archived or in another project; or a `HUMAN` step naming an Agent), `integrator_binding_invalid` (the merge-integrator sentinel binding fails in either direction, evaluated with the platform's existing canonical binding rule and the template's own name). The checks sit at spec positions 9 to 11; Repo grants are not checked. Agent facts are resolved by id inside the replace transaction and handed to the pure validator. Each code is added to the handbook's replace entry.

**Blocked by:** 03-replace-step-graph

- [ ] A gated step sharing its layer with a sibling answers `422 approval_gate_in_parallel_layer` naming the gated step; a gated step alone in its layer is accepted; verified by a new validator-assignee dbtest at the HTTP seam using the shared fixture.
- [ ] An `AGENT` step with `assigneeAgentId: null`, one naming a nonexistent id, one naming an archived Agent, one naming an Agent from another project, and a `HUMAN` step naming an Agent each answer `422 assignee_invalid` naming that step; verified by the same dbtest.
- [ ] A `merge-result` step assigned to an ordinary Agent, and an ordinary step assigned to the Agent named `merge-integrator`, each answer `422 integrator_binding_invalid` naming that step; a `merge-result` step bound to `merge-integrator` is accepted; verified by the same dbtest.
- [ ] `assignee_invalid` is reported before `integrator_binding_invalid` when both apply; step rows are unchanged after every refusal; verified by the same dbtest.
- [ ] The three codes appear in the handbook's replace entry with status `422`; verified by reading the section.
