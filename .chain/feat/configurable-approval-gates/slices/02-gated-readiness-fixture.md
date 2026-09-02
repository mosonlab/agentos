---
id: 02-gated-readiness-fixture
title: "Prefactor: gated readiness option in the merge integrator fixture"
blocked_by: []
risk: false
---

# 02: Prefactor: gated readiness option in the merge integrator fixture

**What to build:** The test fixture capability the whole merge-gate slice family
stands on. Today `merge-integrator-fixture.ts` can seed every readiness-tail
chain shape, but only with an ungated readiness task already in `DONE`; nothing
in the suite has ever produced a chain whose server-owned readiness step carries
`approvalGate: true` and has not yet been reached. After this slice, a test can
ask the fixture for exactly that state and drive the real readiness tail from
regression completion onward.

The fixture gains one boolean option (per spec Testing Decisions, "Fixture
extension"): on a readiness-tail shape it sets `approvalGate: true` on both the
readiness template step and the readiness task, and leaves the readiness task in
the pre-activation state (its predecessor regression step positioned so a test
can complete it) instead of `DONE`. Requesting the option on a shape without a
real readiness step fails loudly as a fixture error. No production code changes
in this slice.

**Blocked by:** None (can start immediately)

- [ ] A dbtest (run by named file) seeds a readiness-tail shape with the new option and observes: the readiness task has `approvalGate: true`, status is pre-activation (not DONE), the readiness template step records `approvalGate: true`, and the regression predecessor is in a state a test can complete.
- [ ] The same dbtest shows the option on a non-readiness shape throwing a loud fixture error, not being silently ignored.
- [ ] Every existing dbtest file that calls `seedIntegratorChain` still passes when run by named file, proving existing callers keep their behaviour byte for byte.
