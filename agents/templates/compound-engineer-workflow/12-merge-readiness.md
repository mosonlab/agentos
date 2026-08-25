---
stepIndex: 12
layer: 11
agent: review-coordinator
approvalGate: false
outputKind: merge-authorization
attachmentsFromPrevious: true
opensPullRequest: false
baseFromStepIndex: null
spawnPolicy: null
---
This is a server-owned mechanical readiness step. No model run executes it.
The control plane recomputes the pull-request head and defense-list triggers,
requires any open independent review to approve, and emits an exact-head merge
authorization. Missing or stale PASS evidence leaves this step blocked at
regression verification with a named reason.
