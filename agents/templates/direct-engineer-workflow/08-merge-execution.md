---
stepIndex: 8
layer: 7
agent: merge-integrator
approvalGate: false
outputKind: merge-result
priorOutputKinds: []
attachmentsFromPrevious: true
opensPullRequest: false
requiresCommit: false
provisionDependencies: true
baseFromStepIndex: null
spawnPolicy: null
---
Execute the authorized merge mechanically. No model runs this step:
@anneal/merge-executor claims it after the runner has created and read back the
pull request; an absent PR identity is a loud stop. It re-verifies every
precondition against the live pull request and the exact-head
mechanical authorization, strips `.chain/` from the merge commit tree, and
merges. The chain branch retains its `.chain/` artifacts.
