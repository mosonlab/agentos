---
id: 06-instantiate-gate-resolution
title: "Instantiate gate resolution, refusals, and the spec gate end to end"
blocked_by: [01-gate-slot-helper, 03-project-gate-defaults]
risk: false
---

# 06: Instantiate gate resolution, refusals, and the spec gate end to end

**What to build:** Dispatching a chain now respects gates. An operator (or API
client) instantiates a template with an optional `gates` object
(`{ spec?: boolean; merge?: boolean }`); each slot's `approvalGate` on the
created task resolves as dispatch override, then project default, then the
template step's frontmatter value — "present" including an explicit `false` —
and every non-slot step keeps its frontmatter value unconditionally. The project
row is read inside the chain-materialising transaction. Supplying `gates.spec`
for a template without a specification step, or `gates.merge` for one without a
merge readiness step, returns 400 with a named refusal (two new instantiation
refusal codes wired through the existing exhaustive `refusalResponse` switch)
before any task is created; when both are wrong, the spec slot is named first.
Spec stories 10–11 and 14–20, decision D4.

The slice is demoable end to end through the specification gate, which needs no
new runtime machinery (stories 29–34 ride existing `approvalGate` behaviour):
dispatch a compound chain with the spec gate on, complete the spec step, and the
task moves to REVIEW with an Inbox card carrying the spec preview; approval
activates the plan step, rejection requeues the spec step consuming run budget.

**Blocked by:** 01-gate-slot-helper, 03-project-gate-defaults

- [ ] An instantiate dbtest (seam: `instantiateTemplate`, run by named file) covers the spec's eight-row matrix on the compound template — asserting `approvalGate` on the specification and merge readiness steps and false on every other step in every row — plus the two "override present and equal to the default" rows.
- [ ] The same seam shows the direct template resolving the merge slot only (its readiness step follows the same three-tier order; no other step is affected), `gates.spec` on the direct template refused with the spec-slot-absent code, and both refusals on the pull-request template, with messages naming the slot and the template; no task exists after a refusal.
- [ ] The 400 mapping for both new refusal codes is asserted at the existing `refusalResponse` unit surface, and the zod input schema rejects unknown keys inside `gates`.
- [ ] A dbtest drives a gated specification step through its lifecycle: completion parks it in REVIEW with an OPEN card carrying the spec preview; approval marks it DONE and activates the plan step; rejection requeues the spec step with run budget consumed; and an ungated spec step behaves exactly as today.
- [ ] Typecheck of `@anneal/api` (and `@anneal/db` if touched) passes; `npm run lint` passes on touched files.
