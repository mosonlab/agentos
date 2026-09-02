---
id: 09-merge-gate-rejection
title: "Merge gate rejection ends the chain with the pull request left open"
blocked_by: [07-merge-gate-opens]
risk: true
---

# 09: Merge gate rejection ends the chain with the pull request left open

**What to build:** Rejecting the merge evidence card means "do not merge this,
ever, on this chain" — not "try again". The merge execution task is never
activated and no merge run opens; every still-OPEN Inbox card on the integrator
task is closed so the aggregate card can be archived; a merge-result step output
on the integrator task records that the chain was abandoned without a merge at
the operator's rejection, and the integrator task closes terminal (DONE, no
failure reason); the readiness task closes with an operator-actor activity
naming the rejection; the pull request stays open and unmerged, with nothing in
the path touching GitHub. The rejection disposition replaces, for merge-slot
gates only, the existing redo-target search that would loop the chain back to
regression; the specification slot's reject path is untouched. Spec stories
45–49, decision D8, reusing the existing chain-abandonment disposition the
operator-closed integrator path already implements.

Like approval, rejection must behave identically through the Inbox decision
channel and the task PATCH decision channel.

**Blocked by:** 07-merge-gate-opens

- [ ] A dbtest (seam: the extended fixture plus the production decision entry points, run by named file) shows rejection through the Inbox channel ending with: the merge execution task never activated and owning no run, the integrator task DONE with a null failure reason and a merge-result step output recording abandonment at the operator's rejection, no OPEN Inbox card remaining on the integrator task, the readiness task closed with an operator-actor activity naming the rejection, and no call into GitHub made by the path.
- [ ] The same rejection scenario run through the task PATCH decision channel produces the identical end state.
- [ ] The dbtest asserts the absence of looping: after rejection, the regression task is not requeued and no readiness gate card reopens.
- [ ] Typecheck of `@anneal/db` and `@anneal/api` passes; `npm run lint` passes on touched files.
