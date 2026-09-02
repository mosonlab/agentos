---
id: 01-gate-slot-helper
title: "Prefactor: shared gateSlotOf helper in @anneal/db"
blocked_by: []
risk: false
---

# 01: Prefactor: shared gateSlotOf helper in @anneal/db

**What to build:** One shared authority that answers "is this template step a
configurable gate slot, and which one?" so that the instantiate route, the task
PATCH rule, and the chain read shape can never disagree about slot identity.
This is a prefactor: it makes slices 05 and 06 a matter of calling one function
instead of each re-deriving slot identity from `stepRole` and
`isMergeReadinessStep`.

The helper lives in `@anneal/db` beside the existing step-role authority and is
exported from the package surface. Its contract comes from a prototype in the
spec (D1) and is inlined here because it fixes the decision precisely:

```ts
export type GateSlot = "spec" | "merge";
export const gateSlotOf = (step: TemplateStepLike | null | undefined): GateSlot | null =>
  step == null ? null : stepRole(step) === "spec" ? "spec" : isMergeReadinessStep(step) ? "merge" : null;
```

**Blocked by:** None (can start immediately)

- [ ] A new unit test file in `@anneal/db` (run by named file with the workspace test script) shows `gateSlotOf` returning `"spec"` for a specification step, `"merge"` for a merge readiness step (both canonical and versioned/legacy `outputKind` forms, reusing the fixtures the existing step-role tests use), `null` for every other canonical step role, and `null` for `null`/`undefined` input.
- [ ] The `GateSlot` type and `gateSlotOf` are importable from the `@anneal/db` package surface by another workspace; `@anneal/db` typecheck passes.
