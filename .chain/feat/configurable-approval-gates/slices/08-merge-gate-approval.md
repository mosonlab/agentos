---
id: 08-merge-gate-approval
title: "Merge gate approval releases the worker with exact-head binding; drift reopens"
blocked_by: [07-merge-gate-opens]
risk: true
---

# 08: Merge gate approval releases the worker with exact-head binding; drift reopens

**What to build:** Approving the filled merge evidence card lets the mechanical
tail run — without ever letting it merge a commit the human did not see.
Approval records the operator's exact-head authorization on the readiness task
(via the unchanged `produceMergeAuthorization`, still guarded by the existing
regression-attestation check), then returns the readiness task to TODO with the
ordinary queued marker instead of marking it DONE and activating the integrator
directly — the readiness worker claims it, re-verifies head, base and ancestry
as today, produces the one and only merge authorization, and the merge
completes. If the head or base moved after approval, the existing drift
settlement requeues regression, and when regression completes again the gate
reopens with a fresh evidence card carrying the new state; no merge happens and
the stale approval is not reusable. Spec stories 38–43 and 51, decisions D6–D7
and assumption A3.

Three coordinated changes: a third approve disposition for merge-slot gate
tasks, selected by one shared predicate so the Inbox decision channel and the
task PATCH channel cannot diverge (the predicate must be evaluable from
persisted state, since the Inbox process cannot reach the API's GitHub client);
the operator authorization recorded as a `TaskActivity` the readiness worker
reads later; and the new fail-closed assertion in the readiness worker — a
gated readiness task with no operator authorization, or one naming a different
head or base than just verified, stops the tail through the existing stop path
with a named reason.

**Blocked by:** 07-merge-gate-opens

- [ ] A dbtest (seam: the extended fixture plus the production decision and worker entry points, run by named file) shows approval through the Inbox channel leaving an operator exact-head authorization activity on the readiness task, the task back in TODO with the queued marker (not DONE, integrator not directly activated), then the worker tick authorizing, the integrator activating, and the merge completing.
- [ ] The same approval scenario run through the task PATCH decision channel produces the identical end state, proving the two channels share one disposition.
- [ ] A drift scenario — pull-request head changed after approval, before integration — ends with no merge, the readiness task not DONE, the existing requeue-regression settlement taken, and, after regression completes again, a fresh OPEN evidence card carrying the new head.
- [ ] The fail-closed assertion: a gated readiness task reaching the worker with no operator authorization activity, and one whose authorization names a mismatched head or base, each stop the tail through the existing stop path with a reason naming the gate; no authorization is produced and no merge happens.
- [ ] An approval whose card head carries no regression attestation is refused by the existing attestation guard (asserted to still hold on the gated readiness shape).
- [ ] `produceMergeAuthorization`, `evaluateReadiness`'s drift and ancestry logic, and merge lease handling are unmodified (no diff in those functions beyond the worker's new gated assertion); typecheck of `@anneal/db` and `@anneal/api` passes; `npm run lint` passes on touched files.
