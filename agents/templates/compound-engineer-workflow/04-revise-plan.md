---
stepIndex: 4
agent: plan-reviser
approvalGate: true
outputKind: revised-plan
attachmentsFromPrevious: true
opensPullRequest: false
spawnPolicy: null
---
Attempt to resume the planning session with the run id labelled `plan_authoring` in `.chain/{{branchName}}/sessions.md`; if exact resume is unavailable, follow your role's new-session fallback. Revise the slice set against the plan-review findings by editing the slice files in place under `.chain/{{branchName}}/slices/`, preserving the planning invariants — tracer-bullet cut, acyclic true blocked_by, wide frontier and shallow critical path, rare files_hint overlap between independent slices, risk true exactly for persisted data or an irreversible external action, every acceptance criterion red at the frozen base. On a successful resume the `plan_authoring` id stands; in a new session add this session's id under `plan_revision`. Commit to {{branchName}}. The revised slice set is the implementation authority: complete when every must-fix finding has a resolving slice edit, every should-fix a recorded decision, and every spec requirement still maps to exactly one slice.
