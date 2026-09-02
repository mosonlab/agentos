---
id: 07-merge-gate-opens
title: "Merge gate opens at readiness activation and holds the tail closed"
blocked_by: [02-gated-readiness-fixture]
risk: true
---

# 07: Merge gate opens at readiness activation and holds the tail closed

**What to build:** On a chain whose merge readiness task carries
`approvalGate: true`, the moment regression verification completes the operator
gets an evidence card instead of an autonomous merge tail: the readiness task
enters REVIEW, a gate-purpose Inbox card opens through the existing
integrator-feeding branch, the merge evidence worker fills it with the pull
request's head SHA, base ref, base SHA and required-check conclusions, and the
readiness worker cannot claim the task while the card is open. An ungated
readiness task behaves byte for byte as today. Spec stories 35–37, 44 and 50,
decision D5.

The change point is the readiness-successor branch of chain activation: when the
readiness successor is gated and the completing regression run is available, set
the task to REVIEW and open the gate question in the same transaction as the
regression completion, instead of writing the "queued" readiness marker;
otherwise the existing path is untouched. No change to `gateQuestion`, the
evidence worker, or readiness claiming — REVIEW is already unclaimable.

**Blocked by:** 02-gated-readiness-fixture

- [ ] A dbtest (seam: the extended fixture plus the production completion entry points, run by named file) shows regression completion on a gated readiness chain leaving the readiness task in REVIEW with exactly one OPEN gate-purpose Inbox card bound to the completing regression run, and no "queued" readiness marker written.
- [ ] The same dbtest shows the merge evidence worker filling that card with head SHA, base ref, base SHA and required-check conclusions.
- [ ] The same dbtest shows a readiness worker tick while the task is in REVIEW claiming nothing and producing no authorization and no integrator activation.
- [ ] The same dbtest shows the ungated control: an identical chain with `approvalGate: false` on readiness gets the existing queued-marker path, the worker claims it, and no Inbox card opens.
- [ ] Typecheck of `@anneal/db` and `@anneal/api` passes; `npm run lint` passes on touched files.
